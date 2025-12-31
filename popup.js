const importBtn = document.getElementById("importBtn");
const statusEl = document.getElementById("status");
const importStatusEl = document.getElementById("importStatus");
const listCountsEl = document.getElementById("listCounts");
const hiddenEl = document.getElementById("hidden");
const IMPORT_STATUS_KEY = "importStatus";
const MUTED_KEY = "mutedHandles";
const BLOCKED_KEY = "blockedHandles";
const POPUP_OPEN_KEY = "popupOpen";

function setStatus(message) {
  statusEl.textContent = message || "";
}

function setHiddenCount(count) {
  const value = Number.isFinite(count) ? count : 0;
  hiddenEl.textContent = `非表示アカウント数(このタブ): ${value}`;
}

function setImportStatus(message) {
  importStatusEl.textContent = message || "";
}

function setListCounts(mutedCount, blockedCount) {
  const mutedValue = Number.isFinite(mutedCount) ? mutedCount : 0;
  const blockedValue = Number.isFinite(blockedCount) ? blockedCount : 0;
  listCountsEl.textContent = `ミュート件数: ${mutedValue} / ブロック件数: ${blockedValue}`;
}

async function loadHiddenCount() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const activeTab = tabs[0];
  if (!activeTab?.id) {
    setHiddenCount(0);
    return;
  }
  try {
    const response = await chrome.tabs.sendMessage(activeTab.id, {
      type: "getHiddenCount",
    });
    setHiddenCount(response?.count || 0);
  } catch (error) {
    setHiddenCount(0);
  }
}

async function loadImportStatus() {
  const stored = await chrome.storage.local.get([IMPORT_STATUS_KEY]);
  const message = stored[IMPORT_STATUS_KEY] || "";
  setImportStatus(message);
  if (message) {
    chrome.storage.local.remove(IMPORT_STATUS_KEY);
  }
}

async function loadListCounts() {
  const stored = await chrome.storage.local.get([MUTED_KEY, BLOCKED_KEY]);
  const muted = stored[MUTED_KEY] || [];
  const blocked = stored[BLOCKED_KEY] || [];
  setListCounts(muted.length, blocked.length);
}

async function requestImport() {
  importBtn.disabled = true;
  setStatus("一覧ページを開いて取得します...");
  try {
    await chrome.runtime.sendMessage({ type: "startImport" });
    setStatus("取得を開始しました。");
  } catch (error) {
    setStatus("取得に失敗しました。");
  } finally {
    importBtn.disabled = false;
  }
}

function setPopupOpen(isOpen) {
  chrome.storage.local.set({ [POPUP_OPEN_KEY]: Boolean(isOpen) });
}

importBtn.addEventListener("click", () => {
  requestImport();
});

setPopupOpen(true);
window.addEventListener("unload", () => {
  setPopupOpen(false);
});

loadHiddenCount();
loadImportStatus();
loadListCounts();

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") {
    return;
  }
  if (changes[IMPORT_STATUS_KEY]) {
    const message = changes[IMPORT_STATUS_KEY].newValue;
    if (typeof message === "string" && message.length > 0) {
      setImportStatus(message);
      chrome.storage.local.remove(IMPORT_STATUS_KEY);
    }
  }
  if (changes[MUTED_KEY] || changes[BLOCKED_KEY]) {
    const muted = changes[MUTED_KEY]?.newValue;
    const blocked = changes[BLOCKED_KEY]?.newValue;
    if (muted || blocked) {
      setListCounts((muted || []).length, (blocked || []).length);
    }
  }
});
