(() => {
  'use strict';
  if (window.__igcLoaded) {
    window.__igcShowPanel?.();
    return;
  }
  window.__igcLoaded = true;

  const TEST = window.__IGC_TEST__ || null;
  const T = TEST ? 0.001 : 1; // in tests, waits become ~1000x shorter
  const TO = TEST ? 0.05 : 1; // same for timeouts
  const POLL_MS = TEST ? 5 : 200;

  const DELAY_FLOOR_SEC = 5;
  const COOLDOWN_DAYS = 3;
  const MAX_CONSECUTIVE_FAILURES = 3;
  const SIMULATION_CAP = 15;

  const DEFAULTS = {
    perDay: null,
    delayMin: 20,
    delayMax: 50,
    speedMode: 'medium',
    allowWithoutFollowing: false,
    simulate: true, // starts in test mode on purpose
    keep: [], // @ of the people you follow (comes from following.json)
    whitelist: '', // extra @ that are never removed (one per line)
  };

  // ───────────────────────── utilities ─────────────────────────
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rand = (a, b) => a + Math.random() * (b - a);
  const randInt = (a, b) => Math.floor(rand(a, b + 1));
  const dateKey = (d = new Date()) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  let stopFlag = false;
  let running = false;
  let ui = null;
  const logs = [];

  function log(msg) {
    const line = `[${new Date().toLocaleTimeString('en-US')}] ${msg}`;
    logs.push(line);
    if (logs.length > 300) logs.shift();
    if (ui) ui.addLog(line);
    else if (!TEST) console.log('[IG Cleaner]', msg);
  }

  /** Waits `ms` (in chunks, so it can stop right away). */
  async function wait(ms, label) {
    const end = Date.now() + ms * T;
    while (!stopFlag && Date.now() < end) {
      await sleep(Math.min(500 * T + 1, Math.max(1, end - Date.now())));
      if (label && ui) ui.setStatus(`${label} ${Math.max(0, Math.ceil((end - Date.now()) / (1000 * T)))}s`);
    }
  }

  async function waitFor(fn, timeoutMs) {
    const end = Date.now() + timeoutMs * TO;
    while (!stopFlag && Date.now() < end) {
      const v = fn();
      if (v) return v;
      await sleep(POLL_MS);
    }
    return null;
  }

  // ───────────────────────── storage ─────────────────────────
  async function storeGet() {
    const r = await chrome.storage.local.get(['settings', 'daily', 'cooldownUntil']);
    return {
      settings: { ...DEFAULTS, ...(r.settings || {}) },
      daily: r.daily || { date: '', count: 0 },
      cooldownUntil: r.cooldownUntil || 0,
    };
  }
  const storeSet = (obj) => chrome.storage.local.set(obj);

  function normalizeSettings(s) {
    const n = { ...s };
    const perDay = Number(n.perDay);
    n.perDay = Number.isFinite(perDay) && perDay >= 1 ? perDay : null;
    const floor = TEST ? 0 : DELAY_FLOOR_SEC;
    n.delayMin = Math.max(floor, Number(n.delayMin) || DEFAULTS.delayMin);
    n.delayMax = Math.max(n.delayMin, Number(n.delayMax) || DEFAULTS.delayMax);
    n.speedMode = ['fast', 'medium', 'custom'].includes(n.speedMode) ? n.speedMode : 'custom';
    n.keep = Array.isArray(n.keep) ? n.keep : [];
    return n;
  }

  // ───────────────────────── @ lists ─────────────────────────
  const USER_RE = /^[A-Za-z0-9._]{1,30}$/;

  function usernameFromItem(item) {
    const first = item && item.string_list_data && item.string_list_data[0];
    let fromHref = null;
    if (first && typeof first.href === 'string') {
      const parts = first.href.split('?')[0].split('/').filter(Boolean).filter((p) => p !== '_u');
      const last = parts.pop();
      if (last && !last.includes('instagram.com')) fromHref = last;
    }
    for (const c of [item && item.title, first && first.value, fromHref]) {
      if (typeof c === 'string' && USER_RE.test(c)) return c.toLowerCase();
    }
    return null;
  }

  /** Reads the content of a following.json from the Instagram export. */
  function parseFollowingJson(text) {
    const json = JSON.parse(text.replace(/^﻿/, ''));
    const items = Array.isArray(json)
      ? json
      : json.relationships_following || json.following || Object.values(json || {}).find(Array.isArray) || [];
    const users = new Set();
    for (const item of items) {
      const u = usernameFromItem(item);
      if (u) users.add(u);
    }
    return [...users];
  }

  function parseWhitelist(text) {
    const out = [];
    for (const line of String(text || '').split(/\r?\n/)) {
      const clean = line.split('#')[0].trim().replace(/^@/, '').toLowerCase();
      if (clean && USER_RE.test(clean)) out.push(clean);
    }
    return out;
  }

  // ───────────────────────── Instagram DOM ─────────────────────────
  // If Instagram changes its layout and the extension stops working, only touch this part.
  const REMOVE_RE = /^\s*(remove|remover)\s*$/i;
  const CANCEL_RE = /^\s*(cancel|cancelar)\s*$/i;
  const CONFIRM_TITLE_RE = /remove follower|remover seguidor/i;
  const BLOCK_RE =
    /try again later|tente novamente mais tarde|action blocked|ação bloqueada|we limit how often|limitamos a frequência|confirm it's you|confirme que é você|suspicious activity|atividade suspeita/i;
  const USER_HREF = /^\/([A-Za-z0-9._]{1,30})\/$/;
  const RESERVED = new Set(['explore', 'reels', 'direct', 'accounts', 'p', 'stories', 'reel', 'tv']);

  const buttonsIn = (el) => [...el.querySelectorAll('button, [role="button"]')];
  const findRemoveButton = (el) => buttonsIn(el).find((b) => REMOVE_RE.test(b.textContent || '')) || null;

  function profileLinksIn(el) {
    const users = new Set();
    for (const a of el.querySelectorAll('a[href]')) {
      const m = USER_HREF.exec(a.getAttribute('href') || '');
      if (m && !RESERVED.has(m[1].toLowerCase())) users.add(m[1].toLowerCase());
    }
    return users;
  }

  /** The list dialog (the first dialog that has profile links). */
  function getFollowersDialog() {
    const dialogs = [...document.querySelectorAll('div[role="dialog"]')];
    return dialogs.find((d) => profileLinksIn(d).size > 0) || null;
  }

  function looksLikeFollowersList(dialog) {
    const head = (dialog.textContent || '').slice(0, 300);
    const hasFollowers = /followers|seguidores/i.test(head);
    const hasFollowing = /following|seguindo/i.test(head);
    return hasFollowers || !hasFollowing;
  }

  /** Each removable row: { user, row, btn }. The "row" is the smallest block that has a single @ and the Remove button. */
  function listRows(dialog) {
    const seen = new Set();
    const rows = [];
    for (const a of dialog.querySelectorAll('a[href]')) {
      const m = USER_HREF.exec(a.getAttribute('href') || '');
      if (!m) continue;
      const user = m[1].toLowerCase();
      if (RESERVED.has(user) || seen.has(user)) continue;

      let el = a;
      let btn = null;
      for (let i = 0; i < 8 && el.parentElement && el.parentElement !== dialog; i++) {
        el = el.parentElement;
        if (profileLinksIn(el).size > 1) break; // went up too far: would catch another person
        btn = findRemoveButton(el);
        if (btn) break;
      }
      if (!btn) continue;
      seen.add(user);
      rows.push({ user, row: el, btn });
    }
    return rows;
  }

  function findScroller(dialog) {
    let best = null;
    let bestH = 0;
    for (const el of dialog.querySelectorAll('div')) {
      const oy = getComputedStyle(el).overflowY;
      if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight + 5 && el.scrollHeight > bestH) {
        best = el;
        bestH = el.scrollHeight;
      }
    }
    return best;
  }

  async function scrollMore(scroller) {
    const beforeTop = scroller.scrollTop;
    const beforeH = scroller.scrollHeight;
    const step = Math.round(rand(300, 700));
    if (typeof scroller.scrollBy === 'function') scroller.scrollBy({ top: step, behavior: 'smooth' });
    else scroller.scrollTop = beforeTop + step;
    await wait(rand(1800, 3200)); // give Instagram time to load more people
    return scroller.scrollTop > beforeTop + 2 || scroller.scrollHeight > beforeH + 2;
  }

  /**
   * Antes de declarar o fim da lista, força uma segunda leitura no fim do
   * scroller. O Instagram pode demorar para carregar ou ignorar uma rolagem
   * suave, mesmo ainda havendo mais perfis abaixo.
   */
  async function confirmEndOfList(dialog, scroller, keep, tried) {
    const hasUnprocessedRow = () => {
      const currentDialog = getFollowersDialog() || dialog;
      return listRows(currentDialog).some((row) => !keep.has(row.user) && !tried.has(row.user));
    };

    // Força a posição final e dá tempo para a lista virtual carregar itens.
    scroller.scrollTop = scroller.scrollHeight;
    scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
    await wait(3500, '↕ checking for more accounts');
    if (hasUnprocessedRow()) return false;

    // Uma curta volta seguida de nova ida ao fim também dispara carregamento
    // em versões do Instagram que só observam mudanças reais de posição.
    scroller.scrollTop = Math.max(0, scroller.scrollTop - 240);
    scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
    await wait(900);
    scroller.scrollTop = scroller.scrollHeight;
    scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
    await wait(3500, '↕ checking for more accounts');
    return !hasUnprocessedRow();
  }

  /** The "Remove follower?" dialog (never returns a button from a list row). */
  function findConfirmDialog() {
    const rowButtons = new Set();
    const list = getFollowersDialog();
    if (list) for (const r of listRows(list)) rowButtons.add(r.btn);
    const dialogs = [...document.querySelectorAll('div[role="dialog"]')].reverse();
    for (const d of dialogs) {
      if (!CONFIRM_TITLE_RE.test(d.textContent || '')) continue;
      const btns = buttonsIn(d).filter((b) => !rowButtons.has(b));
      const confirm = btns.find((b) => REMOVE_RE.test(b.textContent || ''));
      if (confirm) return { dialog: d, confirm, cancel: btns.find((b) => CANCEL_RE.test(b.textContent || '')) || null };
    }
    return null;
  }

  function detectBlock() {
    if (/\/(challenge|checkpoint|suspended)\//.test(location.pathname)) return `page ${location.pathname}`;
    const text = document.body.innerText ?? document.body.textContent ?? '';
    const m = text.match(BLOCK_RE);
    return m ? `Instagram message: "${m[0]}"` : null;
  }

  // ───────────────────────── actions ─────────────────────────
  async function removeOne({ user, row, btn }) {
    if (typeof row.scrollIntoView === 'function') row.scrollIntoView({ block: 'center', behavior: 'smooth' });
    await wait(rand(700, 1500));
    btn.click();

    const found = await waitFor(findConfirmDialog, 8000);
    if (!found) throw new Error('the confirmation dialog did not appear');

    // safety lock: the confirmation must mention the SAME person we picked
    if (!(found.dialog.textContent || '').toLowerCase().includes(user)) {
      if (found.cancel) found.cancel.click();
      throw new Error(`the confirmation did not mention @${user}; I cancelled for safety`);
    }

    await wait(rand(600, 1500));
    found.confirm.click();

    const closed = await waitFor(() => !found.dialog.isConnected || !findConfirmDialog(), 8000);
    if (!closed) throw new Error('the confirmation dialog did not close');

    // Instagram's React does not always unmount the removed row: it may stay
    // in the DOM for a few seconds or be recycled by the virtual list. Re-querying
    // the list is more reliable than relying on the identity of the old element.
    const noLongerRemovable = await waitFor(() => {
      if (!row.isConnected) return true;
      const dialog = getFollowersDialog();
      return !dialog || !listRows(dialog).some((item) => item.user === user);
    }, 6000);
    return noLongerRemovable ? 'removed' : 'unverified';
  }

  async function startCooldown(reason) {
    const until = Date.now() + COOLDOWN_DAYS * 86400000;
    await storeSet({ cooldownUntil: until });
    log(`🛑 Possible block (${reason}). I stopped and will stay paused until ${new Date(until).toLocaleString('en-US')}.`);
    log('Open Instagram on your phone and clear any pending verification before coming back.');
  }

  async function runInner() {
    const state = await storeGet();
    const s = normalizeSettings(state.settings);
    const today = dateKey();
    const daily = state.daily.date === today ? { ...state.daily } : { date: today, count: 0 };

    if (state.cooldownUntil && Date.now() < state.cooldownUntil) {
      log(`⏸ Safety pause until ${new Date(state.cooldownUntil).toLocaleString('en-US')}.`);
      return;
    }
    if (s.keep.length === 0 && !s.allowWithoutFollowing) {
      log('First load following.json (under "Configure"). Without it I do not know who you follow and could remove those people.');
      return;
    }
    if (s.keep.length === 0) log('⚠ Running without following.json: nobody is protected by the list of people you follow.');
    if (s.perDay == null) {
      log('Set the removal limit manually under "Configure" before starting.');
      return;
    }
    const block0 = detectBlock();
    if (block0) return startCooldown(block0);

    let dialog = getFollowersDialog();
    if (!dialog) {
      log('Open your profile follower list (click "followers") and click Start again.');
      return;
    }
    if (!looksLikeFollowersList(dialog)) {
      log('This looks like the "following" list, not the followers list. Open "followers" and try again.');
      return;
    }

    const keep = new Set([...s.keep, ...parseWhitelist(s.whitelist)]);
    if (ui) ui.setDaily(daily.count, s.perDay);
    let removalGoal = Infinity;
    if (s.simulate) removalGoal = Math.min(removalGoal, SIMULATION_CAP);

    log(
      s.simulate
        ? `TEST MODE: I will only list up to ${removalGoal} people who would be removed. Nothing will be removed.`
        : `Starting: ${daily.count}/${s.perDay} done today.`,
    );

    const tried = new Set();
    let done = 0;
    let failures = 0;
    let endStrikes = 0;
    let limitPauseLogged = false;

    while (!stopFlag && done < removalGoal) {
      if (!s.simulate) {
        const liveState = await storeGet();
        const liveSettings = normalizeSettings(liveState.settings);
        const remaining = liveSettings.perDay == null ? 0 : Math.max(0, liveSettings.perDay - daily.count);
        if (ui) ui.setDaily(daily.count, liveSettings.perDay || 0);
        if (remaining <= 0) {
          if (!limitPauseLogged) {
            log(`Daily limit reached (${daily.count}/${liveSettings.perDay || 0}). Paused; raise the limit to continue.`);
            limitPauseLogged = true;
          }
          await wait(5000, '⏸ daily limit reached');
          continue;
        }
        limitPauseLogged = false;
        s.perDay = liveSettings.perDay;
      }
      dialog = getFollowersDialog();
      if (!dialog) {
        log('The follower list was closed; stopping.');
        break;
      }

      const next = listRows(dialog).find((r) => !keep.has(r.user) && !tried.has(r.user));

      if (next) {
        tried.add(next.user);
        endStrikes = 0;

        if (s.simulate) {
          log(`[test] would remove: @${next.user}`);
          done++;
          await wait(rand(300, 700));
          continue;
        }

        try {
          const res = await removeOne(next);
          failures = 0;
          if (res === 'removed') {
            daily.count++;
            done++;
            await storeSet({ daily });
            if (ui) ui.setDaily(daily.count, s.perDay);
            log(`✔ removed @${next.user} (${daily.count}/${s.perDay} today)`);
          } else {
            failures++;
            log(`? clicked remove on @${next.user}, but the row did not disappear; not counted.`);
          }
        } catch (err) {
          const blocked = detectBlock();
          if (blocked) {
            await startCooldown(blocked);
            return;
          }
          failures++;
          log(`✖ failed on @${next.user}: ${err.message}`);
        }
        if (failures >= MAX_CONSECUTIVE_FAILURES) {
          log('Too many failures in a row; I stopped. Instagram probably changed its layout (see the README).');
          return;
        }

        const blocked = detectBlock();
        if (blocked) {
          await startCooldown(blocked);
          return;
        }
        if (stopFlag || done >= removalGoal) break;

        await wait(rand(s.delayMin, s.delayMax) * 1000, '⏳ next in');
        continue;
      }

      // nothing removable in view: scroll the list to load more people
      const scroller = findScroller(dialog);
      if (!scroller) {
        log('I could not find the scroll area of the list; stopping.');
        break;
      }
      if (ui) ui.setStatus('↕ scrolling the list...');
      const moved = await scrollMore(scroller);
      if (!moved) {
        endStrikes++;
        if (endStrikes >= 3) {
          log('Checking once more before confirming the end of the list...');
          const confirmed = await confirmEndOfList(dialog, scroller, keep, tried);
          if (confirmed) {
            log('I reached the end of the list.');
            break;
          }
          log('More accounts loaded; continuing.');
          endStrikes = 0;
        }
      } else {
        endStrikes = 0;
      }
    }

    log(
      s.simulate
        ? `Test finished: ${done} people listed. If the list looks right, uncheck "Test mode" and click Start.`
        : `Finished: ${done} removed in this run · ${daily.count}/${s.perDay} today.`,
    );
  }

  async function run() {
    if (running) return;
    running = true;
    stopFlag = false;
    if (ui) ui.setRunning(true);
    try {
      await runInner();
    } catch (err) {
      log(`Unexpected error: ${err.message}`);
    } finally {
      running = false;
      if (ui) {
        ui.setRunning(false);
        ui.setStatus('Stopped');
      }
    }
  }

  function stop() {
    stopFlag = true;
    log('Stopping...');
  }

  // ───────────────────────── panel ─────────────────────────
  function createPanel() {
    const host = document.createElement('div');
    host.id = 'igc-host';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        .box{position:fixed;right:16px;bottom:16px;width:300px;z-index:2147483647;background:#1c1e21;color:#f0f0f0;
          font:13px/1.4 system-ui,Segoe UI,sans-serif;border:1px solid #444;border-radius:12px;padding:10px;box-shadow:0 6px 24px #0008}
        .top{display:flex;justify-content:space-between;align-items:center;font-weight:600;margin-bottom:6px;gap:8px}.brand{display:flex;align-items:baseline;gap:8px}.today{font-size:11px;font-weight:400;color:#9ecbff;white-space:nowrap}.window-actions{display:flex;gap:4px}.window-actions button{padding:3px 8px;font-size:16px;line-height:1}
        button{font:inherit;border:0;border-radius:8px;padding:6px 10px;cursor:pointer;background:#3a3d42;color:#fff}
        button.go{background:#2e7d32}button.no{background:#c62828}button:disabled{opacity:.4;cursor:default}
        .row{display:flex;gap:6px;margin:6px 0}.row>*{flex:1}
        #status{margin:6px 0;color:#9ecbff;min-height:18px}
        details{margin:6px 0}summary{cursor:pointer}
        label{display:block;margin:6px 0 2px;color:#bbb}
        input[type=number],textarea{width:100%;box-sizing:border-box;background:#111;color:#fff;border:1px solid #444;border-radius:6px;padding:4px}
        textarea{height:54px;resize:vertical}
        .two{display:flex;gap:6px}.two>div{flex:1}
        .modes{display:flex;gap:5px;margin:7px 0}.modes button{flex:1;padding:5px 2px;font-size:11px}.modes button.active{background:#2e7d32;outline:1px solid #78bd7b}
        .transfer{display:flex;gap:6px;margin-top:8px}.transfer button{flex:1}.help{margin:8px 0 2px;text-align:center}.help a{color:#9ecbff}.without{color:#ff6b6b;font-weight:700}
        #log{white-space:pre-wrap;max-height:140px;overflow:auto;background:#111;border-radius:6px;padding:6px;font:11px/1.35 ui-monospace,Consolas,monospace;margin-top:6px}
        .small{font-size:11px;color:#aaa}
      </style>
      <div class="box">
        <div class="top"><div class="brand"><span>IG Follower Cleaner</span><span id="today" class="today">0/0</span></div><div class="window-actions"><button id="min" title="minimize">–</button><button id="close" title="close">×</button></div></div>
        <div id="body">
          <div class="row"><button id="start" class="go">Start</button><button id="stop" class="no" disabled>Stop</button></div>
          <div id="status">Stopped</div>
          <details open>
            <summary>Configure</summary>
            <label></label>
            <input type="file" id="file" accept=".json,application/json">
            <div id="fileinfo" class="small">No file loaded.</div>
            <label></label>
            <label>People to keep</label>
            <textarea id="wl" placeholder="friend.1&#10;someone2"></textarea>
            <div class="two">
              <div><label>Removal limit</label><input type="number" id="perday" min="1"></div>
            </div>
            <div class="small">Keep this tab visible and prevent the PC from going to sleep.</div>
          </details>
          <details>
            <summary>Modes</summary>
            <div class="modes"><button type="button" data-mode="fast">Fast</button><button type="button" data-mode="medium">Medium</button><button type="button" data-mode="custom">Custom</button></div>
            <div class="two">
              <div><label>Min. wait (s)</label><input type="number" id="dmin" min="5"></div>
              <div><label>Max. wait (s)</label><input type="number" id="dmax" min="5"></div>
            </div>
          </details>
          <div class="transfer"><button id="download" type="button">Download</button><button id="upload" type="button">Upload</button><input type="file" id="backupfile" accept="application/json,.json" hidden></div>
          <div class="help">Doubts? <a href="https://github.com/kalebdearaujo/Instagram-Follower-Cleaner/blob/main/README.md" target="_blank" rel="noopener noreferrer">click here</a></div>
          <label><input type="checkbox" id="withoutfile"> Continue <span class="without">without</span> following.json</label>
          <label><input type="checkbox" id="sim"> Test mode (list only, no removal)</label>
          <div id="log"></div>
        </div>
      </div>`;
    document.documentElement.appendChild(host);

    const $ = (id) => root.getElementById(id);
    const api = {
      addLog(line) {
        const el = $('log');
        el.textContent += `${line}\n`;
        el.scrollTop = el.scrollHeight;
      },
      setStatus(t) {
        $('status').textContent = t;
      },
      setDaily(removed, limit) {
        $('today').textContent = `${removed}/${limit}`;
      },
      setRunning(r) {
        $('start').disabled = r;
        $('stop').disabled = !r;
      },
    };

    async function saveSettings(patch) {
      const { settings } = await storeGet();
      await storeSet({ settings: { ...settings, ...patch } });
    }

    const MODE_DELAYS = {
      fast: [10, 25],
      medium: [20, 50],
    };
    function showMode(mode) {
      for (const button of root.querySelectorAll('[data-mode]')) {
        button.classList.toggle('active', button.dataset.mode === mode);
      }
    }
    async function refreshDaily() {
      const { settings, daily } = await storeGet();
      const today = daily.date === dateKey() ? daily.count : 0;
      const limit = normalizeSettings(settings).perDay;
      api.setDaily(today, limit == null ? 0 : limit);
    }

    (async () => {
      const { settings, daily, cooldownUntil } = await storeGet();
      $('wl').value = settings.whitelist || '';
      $('perday').value = settings.perDay == null ? '' : settings.perDay;
      $('dmin').value = settings.delayMin;
      $('dmax').value = settings.delayMax;
      $('withoutfile').checked = Boolean(settings.allowWithoutFollowing);
      $('sim').checked = settings.simulate;
      showMode(normalizeSettings(settings).speedMode);
      if (settings.keep.length) $('fileinfo').textContent = `${settings.keep.length} unique accounts loaded from following.json.`;
      const today = daily.date === dateKey() ? daily.count : 0;
      const limit = normalizeSettings(settings).perDay;
      api.setDaily(today, limit == null ? 0 : limit);
      api.setStatus('Stopped');
      if (cooldownUntil > Date.now()) api.addLog(`⏸ Paused until ${new Date(cooldownUntil).toLocaleString('en-US')}.`);
    })();

    $('file').addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      try {
        if (file.name !== 'following.json') throw new Error('select exactly the following.json file');
        const users = parseFollowingJson(await file.text());
        if (users.length === 0) throw new Error('I found no @ inside the file');
        await saveSettings({ keep: users, allowWithoutFollowing: false });
        $('withoutfile').checked = false;
        $('fileinfo').textContent = `${users.length} unique accounts loaded from following.json.`;
      } catch (err) {
        $('fileinfo').textContent = `Error reading: ${err.message}`;
      }
    });
    $('withoutfile').addEventListener('change', async () => {
      await saveSettings({ allowWithoutFollowing: $('withoutfile').checked });
      if ($('withoutfile').checked) api.addLog('⚠ Continuing without following.json when no file is loaded.');
    });
    $('wl').addEventListener('input', () => saveSettings({ whitelist: $('wl').value }));
    $('perday').addEventListener('input', async () => {
      await saveSettings({ perDay: $('perday').value === '' ? null : Number($('perday').value) });
      await refreshDaily();
    });
    for (const id of ['dmin', 'dmax']) {
      $(id).addEventListener('input', async () => {
        await saveSettings({ [id === 'dmin' ? 'delayMin' : 'delayMax']: Number($(id).value) || DEFAULTS.delayMin, speedMode: 'custom' });
        showMode('custom');
      });
    }
    $('sim').addEventListener('change', () => saveSettings({ simulate: $('sim').checked }));
    for (const button of root.querySelectorAll('[data-mode]')) {
      button.addEventListener('click', async () => {
        const mode = button.dataset.mode;
        const delays = MODE_DELAYS[mode];
        const patch = { speedMode: mode };
        if (delays) {
          patch.delayMin = delays[0];
          patch.delayMax = delays[1];
          $('dmin').value = delays[0];
          $('dmax').value = delays[1];
        }
        await saveSettings(patch);
        showMode(mode);
      });
    }
    $('download').addEventListener('click', async () => {
      const { settings } = await storeGet();
      const backup = {
        settings: {
          keep: settings.keep,
          whitelist: settings.whitelist,
          perDay: settings.perDay,
          speedMode: settings.speedMode,
          delayMin: settings.delayMin,
          delayMax: settings.delayMax,
          allowWithoutFollowing: settings.allowWithoutFollowing,
        },
      };
      const url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = 'ig-follower-cleaner-backup.json';
      link.style.display = 'none';
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    $('upload').addEventListener('click', () => $('backupfile').click());
    $('backupfile').addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      try {
        const backup = JSON.parse(await file.text());
        if (!backup || typeof backup !== 'object' || Array.isArray(backup)) throw new Error('invalid file');
        await chrome.storage.local.set(backup);
        const imported = await storeGet();
        const settings = imported.settings;
        $('wl').value = settings.whitelist || '';
        $('perday').value = settings.perDay == null ? '' : settings.perDay;
        $('dmin').value = settings.delayMin;
        $('dmax').value = settings.delayMax;
        $('withoutfile').checked = Boolean(settings.allowWithoutFollowing);
        $('sim').checked = settings.simulate;
        $('fileinfo').textContent = settings.keep.length ? `${settings.keep.length} unique accounts loaded from following.json.` : 'No file loaded.';
        showMode(normalizeSettings(settings).speedMode);
        await refreshDaily();
        api.addLog('✔ Settings imported.');
      } catch (err) {
        api.addLog(`✖ Could not import: ${err.message}`);
      }
      e.target.value = '';
    });
    $('start').addEventListener('click', run);
    $('stop').addEventListener('click', stop);
    $('min').addEventListener('click', () => {
      const body = $('body');
      body.style.display = body.style.display === 'none' ? '' : 'none';
    });
    $('close').addEventListener('click', () => {
      stop();
      host.remove();
      ui = null;
    });
    return api;
  }

  function showPanel() {
    if (!ui) ui = createPanel();
  }

  if (TEST) {
    TEST.core = { run, stop, logs, listRows, findScroller, parseFollowingJson, parseWhitelist, normalizeSettings };
  } else {
    window.__igcShowPanel = showPanel;
    showPanel();
  }
})();
