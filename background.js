chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg.action || !msg.files) return;
  // Stocker la tâche en session, puis ouvrir le popup
  chrome.storage.session.set({ pendingTask: { ...msg, tabId: sender.tab.id } }, () => {
    chrome.action.openPopup();
  });
});
