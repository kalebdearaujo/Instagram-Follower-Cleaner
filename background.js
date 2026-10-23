chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id || !tab.url?.startsWith('https://www.instagram.com/')) return;
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
});
