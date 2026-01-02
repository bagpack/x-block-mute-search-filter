const STORAGE_KEYS = {
  muted: "mutedHandles",
  blocked: "blockedHandles",
  updatedAt: "listsUpdatedAt",
  lastError: "lastError",
};

const LOG_PREFIX = "[x-bmsf]";
let hiddenHandleSet = new Set();
let currentMuted = new Set();
let currentBlocked = new Set();

function normalizeHandle(handle) {
  return handle.toLowerCase().replace(/^@/, "");
}

function extractHandleFromHref(href) {
  if (!href || !href.startsWith("/")) {
    return null;
  }
  const parts = href.split("/");
  const handle = parts[1];
  if (!handle || handle === "status") {
    return null;
  }
  return normalizeHandle(handle);
}

function getHandleFromArticle(article) {
  const link = article.querySelector('[data-testid="User-Name"] a[href^="/"]');
  return extractHandleFromHref(link?.getAttribute("href"));
}

function getHandleFromUserCell(cell) {
  const link = cell.querySelector('a[href^="/"]');
  return extractHandleFromHref(link?.getAttribute("href"));
}

function hideNode(node, handle) {
  const container = node.closest('[data-testid="cellInnerDiv"]') || node;
  if (container.dataset.xBmsfHidden === "true") {
    if (handle && !hiddenHandleSet.has(handle)) {
      hiddenHandleSet.add(handle);
      notifyHiddenCount();
    }
    return;
  }
  container.dataset.xBmsfHidden = "true";
  if (handle) {
    container.dataset.xBmsfHandle = handle;
  }
  container.style.display = "none";
  if (handle && !hiddenHandleSet.has(handle)) {
    hiddenHandleSet.add(handle);
    notifyHiddenCount();
  }
}

function showNode(node) {
  const container = node.closest('[data-testid="cellInnerDiv"]') || node;
  if (container.dataset.xBmsfHidden !== "true") {
    return;
  }
  container.dataset.xBmsfHidden = "false";
  container.style.display = "";
}

function restoreVisible(root, mutedSet, blockedSet) {
  const hidden = root.querySelectorAll('[data-x-bmsf-hidden="true"]');
  for (const node of hidden) {
    const handle = node.dataset.xBmsfHandle;
    if (!handle) {
      continue;
    }
    if (!mutedSet.has(handle) && !blockedSet.has(handle)) {
      showNode(node);
    }
  }
}

function applyFilterToArticle(article, mutedSet, blockedSet) {
  const handle = getHandleFromArticle(article);
  if (!handle) {
    return;
  }
  if (mutedSet.has(handle) || blockedSet.has(handle)) {
    hideNode(article, handle);
  }
}

function applyFilterToUserCell(cell, mutedSet, blockedSet) {
  const handle = getHandleFromUserCell(cell);
  if (!handle) {
    return;
  }
  if (mutedSet.has(handle) || blockedSet.has(handle)) {
    hideNode(cell, handle);
  }
}

function scanAndFilter(root, mutedSet, blockedSet) {
  const articles = root.querySelectorAll('article[data-testid="tweet"]');
  for (const article of articles) {
    applyFilterToArticle(article, mutedSet, blockedSet);
  }

  const userCells = root.querySelectorAll('[data-testid="UserCell"]');
  for (const cell of userCells) {
    applyFilterToUserCell(cell, mutedSet, blockedSet);
  }
}

async function loadLists() {
  const stored = await chrome.storage.local.get([
    STORAGE_KEYS.muted,
    STORAGE_KEYS.blocked,
    STORAGE_KEYS.updatedAt,
    STORAGE_KEYS.lastError,
  ]);

  currentMuted = new Set((stored[STORAGE_KEYS.muted] || []).map(normalizeHandle));
  currentBlocked = new Set((stored[STORAGE_KEYS.blocked] || []).map(normalizeHandle));
  const updatedAt = stored[STORAGE_KEYS.updatedAt] || 0;
  const lastError = stored[STORAGE_KEYS.lastError] || null;
  hiddenHandleSet = new Set();

  if (DEBUG) {
    console.log(LOG_PREFIX, "Loaded lists", {
      muted: currentMuted.size,
      blocked: currentBlocked.size,
      updatedAt,
      lastError,
      hiddenAccounts: hiddenHandleSet.size,
    });
  }

  notifyHiddenCount();
  return { updatedAt };
}

function notifyHiddenCount() {
  try {
    chrome.runtime.sendMessage(
      {
        type: "hiddenUpdate",
        count: hiddenHandleSet.size,
      },
      () => {
        void chrome.runtime.lastError;
      }
    );
  } catch (error) {
    // Extension context can be invalidated after reload; ignore.
  }
}

async function startFiltering() {
  const { updatedAt } = await loadLists();
  void updatedAt;

  scanAndFilter(document, currentMuted, currentBlocked);

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) {
          continue;
        }
        scanAndFilter(node, currentMuted, currentBlocked);
      }
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") {
      return;
    }

    if (changes[STORAGE_KEYS.muted] || changes[STORAGE_KEYS.blocked]) {
      currentMuted = new Set((changes[STORAGE_KEYS.muted]?.newValue || []).map(normalizeHandle));
      currentBlocked = new Set((changes[STORAGE_KEYS.blocked]?.newValue || []).map(normalizeHandle));
      hiddenHandleSet = new Set();
      scanAndFilter(document, currentMuted, currentBlocked);
      restoreVisible(document, currentMuted, currentBlocked);
      notifyHiddenCount();
    }
  });
}

startFiltering();

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "getHiddenCount") {
    sendResponse({ count: hiddenHandleSet.size });
    return true;
  }
  return false;
});
