# IG Follower Cleaner

Browser extension for Chrome and Edge that works on your logged-in Instagram account. It opens your followers list, chooses an account that is not protected, clicks **Remove**, confirms it, waits, and continues through the list.

> ⚠️ Instagram automation may violate its Terms of Use and can lead to limits, verification, or suspension. Use only on your own account and at your own risk.

## Installing from Github

1. Extract the extension folder. It must contain `manifest.json`, `content.js`, and `background.js`.
2. Open `chrome://extensions` in Chrome, or `edge://extensions` in Edge.
3. Turn on **Developer mode**.
4. Select **Load unpacked** and choose the extracted folder.
5. Open Instagram and click the extension icon in the browser toolbar to open the panel. The panel can also appear when Instagram is loaded.

## Care

- Keep the Instagram tab visible and keep the computer awake while it is running.
- Do not move or scroll the followers dialog while the extension is working.
- High removal limits and short waits are more aggressive. For example, 300 removals with 10–25 second waits carries substantially more risk than a low daily limit with longer waits.
- If Instagram shows “try again later”, asks for verification, or blocks an action, stop using the extension and resolve the issue in Instagram first.
- Settings are stored in this browser profile. Moving or reinstalling the extension can start with a new storage area; use **Download** to make a backup first.

## How to use

### Top of the panel

- **`0/300`** — removals made today / the configured removal limit.
- **–** minimizes the panel. **✕** closes it.

### Main buttons

- **Start** — starts the cycle: scroll the list → Remove → confirm → wait → repeat. Your profile’s followers list must be open.
- **Stop** — finishes the current action and stops. It is available only while the extension is running.
- **Status** (blue text) — shows the current activity, such as `Stopped`, `next in 20s`, or `scrolling through list...`.

### Configure

- **Choose File (`following.json`)** — loads the `following.json` file from your Instagram export. The unique accounts read from this file are protected and never removed. The line below the file picker reports the number loaded.
- **People to keep** — extra accounts that must never be removed, one username per line, without `@`.
- **Removal limit** — maximum removals for the day. When it is reached, the extension stays paused and writes a log entry. Increase the limit to let it continue.

Only a file named exactly `following.json` is accepted.

### Modes (speed)

- **Fast / Medium / Custom** — choose the wait interval between removals.
  - **Fast:** 10–25 seconds.
  - **Medium:** 20–50 seconds.
  - **Custom:** set your own minimum and maximum values.
- **Min / max wait (s)** — a random number between these values is used after each removal. The minimum allowed value is 5 seconds.

### Download / Upload

Use **Download** to save your settings in a JSON backup and **Upload** to load them again, including the following-list protection, People to keep, removal limit, selected mode, and custom wait values.

### Checkboxes

- **Continue without following.json** — permits starting without the file. ⚠️ Without it, no account is protected by the following list; only accounts in **People to keep** remain protected. If a `following.json` is loaded, it is still used.
- **Test mode (only lists, does not remove)** — scrolls and writes to the log who *would* be removed, without clicking **Remove**. Use it before a real run; uncheck it to remove followers.

### Log

The black box records what happened and why the process stopped or paused: daily limit reached, closed list, end of list, Instagram block, or an error.

## Protections

- Accounts from `following.json` and **People to keep** are skipped.
- Before confirming removal, the extension checks that Instagram’s confirmation dialog names the same account selected from the list.
- It refuses to run in the **Following** list instead of the **Followers** list.
- The daily limit is saved locally and is checked while the extension runs.
- Instagram block, verification, challenge, or rate-limit messages trigger a three-day safety cooldown.
- Three consecutive failures stop the run.

## Limitations

- Accounts are processed in the order Instagram displays them; there is no ranking or selection strategy.
- The extension uses scripted clicks, which Instagram can potentially distinguish from real mouse clicks.
- Instagram can change its interface at any time. If its labels or page structure change, the extension may stop working until its selectors are updated.
- A browser can slow down background tabs, which is why the Instagram tab must remain visible.

## Contact

- @yancyeet on instagram
- kaleb.araujo@proton.me