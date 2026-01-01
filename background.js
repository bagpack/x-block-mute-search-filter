importScripts("config.js");

const API_BASE = "https://x.com/i/api/graphql";

const MUTED_QUERY = {
  id: "",
  operation: "MutedAccounts",
};

const BLOCKED_QUERY = {
  id: "",
  operation: "BlockedAccountsAll",
};

const FEATURE_FLAGS = {
  rweb_video_screen_enabled: false,
  profile_label_improvements_pcf_label_in_post_enabled: true,
  responsive_web_profile_redirect_enabled: false,
  rweb_tipjar_consumption_enabled: true,
  verified_phone_label_enabled: false,
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_timeline_navigation_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  premium_content_api_read_enabled: false,
  communities_web_enable_tweet_community_results_fetch: true,
  c9s_tweet_anatomy_moderator_badge_enabled: true,
  responsive_web_grok_analyze_button_fetch_trends_enabled: false,
  responsive_web_grok_analyze_post_followups_enabled: true,
  responsive_web_jetfuel_frame: true,
  responsive_web_grok_share_attachment_enabled: true,
  articles_preview_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
  view_counts_everywhere_api_enabled: true,
  longform_notetweets_consumption_enabled: true,
  responsive_web_twitter_article_tweet_consumption_enabled: true,
  tweet_awards_web_tipping_enabled: false,
  responsive_web_grok_show_grok_translated_post: false,
  responsive_web_grok_analysis_button_from_backend: true,
  creator_subscriptions_quote_tweet_preview_enabled: false,
  freedom_of_speech_not_reach_fetch_enabled: true,
  standardized_nudges_misinfo: true,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  longform_notetweets_rich_text_read_enabled: true,
  longform_notetweets_inline_media_enabled: true,
  responsive_web_grok_image_annotation_enabled: true,
  responsive_web_grok_imagine_annotation_enabled: true,
  responsive_web_grok_community_note_auto_translation_is_enabled: false,
  responsive_web_enhance_cards_enabled: false,
};

const STORAGE_KEYS = {
  muted: "mutedHandles",
  blocked: "blockedHandles",
  updatedAt: "listsUpdatedAt",
  lastError: "lastError",
  queryConfig: "queryConfig",
  authBearer: "authBearer",
  importStatus: "importStatus",
  popupOpen: "popupOpen",
};

const MAX_PAGES = 50;
const COOLDOWN_MS = {
  rateLimited: 30 * 60 * 1000,
  serverError: 5 * 60 * 1000,
  badRequest: 60 * 60 * 1000,
  networkError: 2 * 60 * 1000,
};

let queryConfigCache = {
  muted: null,
  blocked: null,
};
let authBearerCache = null;
const LOG_PREFIX = "[x-bmsf]";
let cooldownUntil = 0;
let authRequired = false;
let refreshInFlight = false;
let refreshTimer = null;
let notifyOnNextRefresh = false;
let importTabIds = [];
const AUTH_REQUIRED_MESSAGE = "Xにログインしてください。ログイン後に再取得します。";
const REFRESH_REASON = Object.freeze({
  authBearer: "auth_bearer",
  ct0Changed: "ct0_changed",
  manualImport: "manual_import",
  queryConfig: "query_config",
});

async function getCsrfToken() {
  const cookie = await chrome.cookies.get({
    url: "https://x.com/",
    name: "ct0",
  });
  return cookie ? cookie.value : null;
}

function buildUrl(query, variables, features) {
  const params = new URLSearchParams();
  params.set("variables", JSON.stringify(variables));
  params.set("features", JSON.stringify(features || FEATURE_FLAGS));
  return `${API_BASE}/${query.id}/${query.operation}?${params.toString()}`;
}

function normalizeHandle(handle) {
  return handle.toLowerCase().replace(/^@/, "");
}

async function updateHandleList(listType, action, handle) {
  const storageKey = listType === "muted" ? STORAGE_KEYS.muted : listType === "blocked" ? STORAGE_KEYS.blocked : null;
  if (!storageKey) {
    return false;
  }

  if (typeof handle !== "string" || handle.length === 0) {
    return false;
  }

  const normalized = normalizeHandle(handle);
  const stored = await chrome.storage.local.get([storageKey]);
  const existing = Array.isArray(stored[storageKey]) ? stored[storageKey] : [];
  const nextSet = new Set(existing.map(normalizeHandle));

  if (action === "add") {
    if (nextSet.has(normalized)) {
      return false;
    }
    nextSet.add(normalized);
  } else if (action === "remove") {
    if (!nextSet.has(normalized)) {
      return false;
    }
    nextSet.delete(normalized);
  } else {
    return false;
  }

  await chrome.storage.local.set({
    [storageKey]: Array.from(nextSet),
    [STORAGE_KEYS.updatedAt]: Date.now(),
  });
  return true;
}

function extractScreenNames(json) {
  const screenNames = new Set();
  let nextCursor = null;

  function addHandle(handle) {
    if (typeof handle === "string" && handle.length > 0) {
      screenNames.add(normalizeHandle(handle));
    }
  }

  const instructions =
    json?.data?.viewer?.muting_timeline?.timeline?.instructions ||
    json?.data?.viewer?.timeline?.timeline?.instructions ||
    [];

  for (const instruction of instructions) {
    const entries = instruction.entries || [];
    for (const entry of entries) {
      if (entry?.content?.cursorType === "Bottom" && entry?.content?.value) {
        nextCursor = entry.content.value;
      }
      const handle = entry?.content?.itemContent?.user_results?.result?.core?.screen_name;
      addHandle(handle);
    }
  }

  return { screenNames, nextCursor };
}

function parseGraphQLUrl(url) {
  const parsed = new URL(url);
  const parts = parsed.pathname.split("/").filter(Boolean);
  const id = parts[3];
  const operation = parts[4];
  if (!id || !operation) {
    return null;
  }

  let features = null;
  const featuresRaw = parsed.searchParams.get("features");
  if (featuresRaw) {
    try {
      features = JSON.parse(featuresRaw);
    } catch {
      features = null;
    }
  }

  return { id, operation, features };
}

function normalizeValue(value) {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeValue(item));
  }
  if (value && typeof value === "object") {
    const sorted = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = normalizeValue(value[key]);
    }
    return sorted;
  }
  if (value === undefined) {
    return null;
  }
  return value;
}

function stableStringify(value) {
  return JSON.stringify(normalizeValue(value));
}

async function loadQueryConfig() {
  const stored = await chrome.storage.local.get([STORAGE_KEYS.queryConfig, STORAGE_KEYS.authBearer]);
  if (stored?.[STORAGE_KEYS.queryConfig]) {
    queryConfigCache = stored[STORAGE_KEYS.queryConfig];
    if (DEBUG) {
      console.log(LOG_PREFIX, "Loaded query config", queryConfigCache);
    }
  }
  if (stored?.[STORAGE_KEYS.authBearer]) {
    authBearerCache = stored[STORAGE_KEYS.authBearer];
    if (DEBUG) {
      console.log(LOG_PREFIX, "Loaded auth bearer", maskToken(authBearerCache));
    }
  }
}

function getQueryConfig(operation) {
  if (operation === MUTED_QUERY.operation) {
    return queryConfigCache.muted;
  }
  if (operation === BLOCKED_QUERY.operation) {
    return queryConfigCache.blocked;
  }
  return null;
}

async function storeQueryConfig(operation, config) {
  const current =
    operation === MUTED_QUERY.operation
      ? queryConfigCache.muted
      : operation === BLOCKED_QUERY.operation
        ? queryConfigCache.blocked
        : null;

  const currentFeatures = stableStringify(current?.features || {});
  const nextFeatures = stableStringify(config.features || {});

  if (current?.id === config.id && currentFeatures === nextFeatures) {
    return false;
  }

  if (operation === MUTED_QUERY.operation) {
    queryConfigCache.muted = config;
  } else if (operation === BLOCKED_QUERY.operation) {
    queryConfigCache.blocked = config;
  } else {
    return;
  }

  await chrome.storage.local.set({
    [STORAGE_KEYS.queryConfig]: queryConfigCache,
  });

  return true;
}

async function fetchJson(url, csrfToken) {
  if (!authBearerCache) {
    throw new ApiError("auth bearer not found", "auth", 0);
  }
  const bearer = authBearerCache;
  let res;
  try {
    res = await fetch(url, {
      method: "GET",
      credentials: "include",
      headers: {
        accept: "*/*",
        authorization: `Bearer ${bearer}`,
        "content-type": "application/json",
        "x-csrf-token": csrfToken,
        "x-twitter-active-user": "yes",
        "x-twitter-auth-type": "OAuth2Session",
      },
    });
  } catch (error) {
    throw new ApiError("Failed to fetch", "network_error", 0);
  }

  const text = await res.text();
  if (!res.ok) {
    const kind = classifyError(res.status, text);
    throw new ApiError(`API error ${res.status}: ${text.slice(0, 200)}`, kind, res.status);
  }

  if (!text) {
    return null;
  }

  let json = null;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new ApiError("Invalid JSON response", "parse_error", res.status);
  }

  if (json?.errors?.length) {
    const message = json.errors.map((err) => err.message).join(" | ");
    const kind = classifyMessage(message);
    throw new ApiError(message, kind, res.status);
  }

  return json;
}

async function fetchAllHandles(query, config) {
  if (!config?.id) {
    return { handles: new Set(), skipped: true, reason: "missing_query" };
  }
  if (authRequired) {
    return { handles: new Set(), skipped: true, reason: "auth_required" };
  }
  if (Date.now() < cooldownUntil) {
    return { handles: new Set(), skipped: true, reason: "cooldown" };
  }

  const csrfToken = await getCsrfToken();
  if (!csrfToken) {
    throw new ApiError("ct0 cookie not found", "auth", 0);
  }

  let cursor = null;
  const handles = new Set();

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const variables = { count: 200, includePromotedContent: false };
    if (cursor) {
      variables.cursor = cursor;
    }

    const url = buildUrl({ ...query, id: config.id }, variables, config.features);
    const json = await fetchJson(url, csrfToken);
    const { screenNames, nextCursor } = extractScreenNames(json);
    if (DEBUG) {
      console.log(LOG_PREFIX, "Page fetched", {
        operation: query.operation,
        page,
        screenNames: screenNames.size,
        hasCursor: Boolean(nextCursor),
      });
    }
    for (const handle of screenNames) {
      handles.add(handle);
    }

    if (!nextCursor || nextCursor === cursor) {
      break;
    }
    cursor = nextCursor;
  }

  return { handles, skipped: false };
}

async function refreshLists() {
  if (refreshInFlight) {
    return { ok: false, error: "in_flight" };
  }
  refreshInFlight = true;
  try {
    if (authRequired) {
      if (DEBUG) {
        console.warn(LOG_PREFIX, "Auth required. Skipping refresh.");
      }
      await chrome.storage.local.set({
        [STORAGE_KEYS.lastError]: AUTH_REQUIRED_MESSAGE,
        [STORAGE_KEYS.updatedAt]: Date.now(),
      });
      return { ok: false, error: "auth_required" };
    }
    if (Date.now() < cooldownUntil) {
      if (DEBUG) {
        console.warn(LOG_PREFIX, "Cooldown active. Skipping refresh.");
      }
      return { ok: false, error: "cooldown" };
    }

    const mutedConfig = getQueryConfig(MUTED_QUERY.operation);
    const blockedConfig = getQueryConfig(BLOCKED_QUERY.operation);
    const existing = await chrome.storage.local.get([STORAGE_KEYS.muted, STORAGE_KEYS.blocked]);

    const [mutedResult, blockedResult] = await Promise.all([
      fetchAllHandles(MUTED_QUERY, mutedConfig),
      fetchAllHandles(BLOCKED_QUERY, blockedConfig),
    ]);

    const updatePayload = {
      [STORAGE_KEYS.muted]: mutedResult.skipped ? existing[STORAGE_KEYS.muted] || [] : Array.from(mutedResult.handles),
      [STORAGE_KEYS.blocked]: blockedResult.skipped
        ? existing[STORAGE_KEYS.blocked] || []
        : Array.from(blockedResult.handles),
      [STORAGE_KEYS.updatedAt]: Date.now(),
      [STORAGE_KEYS.lastError]:
        mutedResult.reason === "missing_query" && blockedResult.reason === "missing_query"
          ? "ミュート/ブロック一覧に移動してAPI情報を取得してください。"
          : mutedResult.reason === "missing_query"
            ? "ミュート一覧に移動してAPI情報を取得してください。"
            : blockedResult.reason === "missing_query"
              ? "ブロック一覧に移動してAPI情報を取得してください。"
              : mutedResult.reason === "auth_required" || blockedResult.reason === "auth_required"
                ? "認証情報が不足しているため、一時停止しています。取得後に再開します。"
                : mutedResult.reason === "cooldown" || blockedResult.reason === "cooldown"
                  ? "API制限のため、一時停止しています。しばらく待ってから再開します。"
                  : null,
    };

    await chrome.storage.local.set(updatePayload);
    if (DEBUG) {
      console.log(LOG_PREFIX, "Lists refreshed", {
        mutedCount: updatePayload[STORAGE_KEYS.muted].length,
        blockedCount: updatePayload[STORAGE_KEYS.blocked].length,
        lastError: updatePayload[STORAGE_KEYS.lastError],
      });
    }
    if (shouldMarkImportComplete(mutedResult, blockedResult, updatePayload)) {
      const status = buildImportStatus(
        updatePayload[STORAGE_KEYS.muted].length,
        updatePayload[STORAGE_KEYS.blocked].length
      );
      const stored = await chrome.storage.local.get([STORAGE_KEYS.popupOpen]);
      if (stored[STORAGE_KEYS.popupOpen]) {
        await chrome.storage.local.set({ [STORAGE_KEYS.importStatus]: status });
      }
      await closeImportTabs();
      notifyOnNextRefresh = false;
    }
    return { ok: true, skippedBlocked: blockedResult.skipped };
  } catch (error) {
    handleApiError(error);
    const errorMessage = error instanceof ApiError && error.kind === "auth" ? AUTH_REQUIRED_MESSAGE : error.message;
    await chrome.storage.local.set({
      [STORAGE_KEYS.lastError]: errorMessage,
      [STORAGE_KEYS.updatedAt]: Date.now(),
    });
    if (DEBUG) {
      console.warn(LOG_PREFIX, "Refresh failed", errorMessage);
    }
    return { ok: false, error: errorMessage };
  } finally {
    refreshInFlight = false;
  }
}

chrome.runtime.onInstalled.addListener(() => {
  loadQueryConfig().then(refreshLists);
});

chrome.runtime.onStartup.addListener(() => {
  loadQueryConfig();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "refreshLists") {
    refreshLists().then(sendResponse);
    return true;
  }
  if (message?.type === "hiddenUpdate") {
    const count = Number(message?.count || 0);
    const tabId = _sender?.tab?.id;
    const badgeText = count ? String(count) : "";
    if (typeof tabId === "number") {
      chrome.action.setBadgeText({ tabId, text: badgeText });
      chrome.action.setBadgeBackgroundColor({ tabId, color: "#1d9bf0" });
    } else {
      chrome.action.setBadgeText({ text: badgeText });
      chrome.action.setBadgeBackgroundColor({ color: "#1d9bf0" });
    }
    sendResponse({ ok: true });
    return true;
  }
  if (message?.type === "startImport") {
    startImport();
    sendResponse({ ok: true });
    return true;
  }
  if (message?.type === "openImportTabs") {
    openImportTabs().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (message?.type === "updateListFromAction") {
    updateHandleList(message.list, message.action, message.handle).then((updated) =>
      sendResponse({ ok: true, updated })
    );
    return true;
  }
  return false;
});

function maskToken(token) {
  if (!token) {
    return "(missing)";
  }
  if (token.length <= 8) {
    return "***";
  }
  return `${token.slice(0, 4)}...${token.slice(-4)}`;
}

class ApiError extends Error {
  constructor(message, kind, status) {
    super(message);
    this.name = "ApiError";
    this.kind = kind;
    this.status = status;
  }
}

function classifyError(status, _text) {
  if (status === 401 || status === 403) {
    return "auth";
  }
  if (status === 429) {
    return "rate_limited";
  }
  if (status >= 500) {
    return "server_error";
  }
  if (status >= 400) {
    return "bad_request";
  }
  return "unknown";
}

function classifyMessage(message) {
  const lower = (message || "").toLowerCase();
  if (
    lower.includes("auth") ||
    lower.includes("authorization") ||
    lower.includes("csrf") ||
    lower.includes("token") ||
    lower.includes("login")
  ) {
    return "auth";
  }
  return "unknown";
}

function handleApiError(error) {
  if (!(error instanceof ApiError)) {
    return;
  }

  if (error.kind === "auth") {
    authRequired = true;
  } else if (error.kind === "rate_limited") {
    cooldownUntil = Date.now() + COOLDOWN_MS.rateLimited;
  } else if (error.kind === "server_error") {
    cooldownUntil = Date.now() + COOLDOWN_MS.serverError;
  } else if (error.kind === "bad_request") {
    cooldownUntil = Date.now() + COOLDOWN_MS.badRequest;
  } else if (error.kind === "network_error") {
    cooldownUntil = Date.now() + COOLDOWN_MS.networkError;
  }
}

function scheduleRefresh(reason) {
  if (Date.now() < cooldownUntil) {
    if (DEBUG) {
      console.warn(LOG_PREFIX, "Cooldown active. Skip scheduling.", reason);
    }
    return;
  }
  if (authRequired) {
    if (DEBUG) {
      console.warn(LOG_PREFIX, "Auth required. Skip scheduling.", reason);
    }
    return;
  }

  if (refreshTimer) {
    clearTimeout(refreshTimer);
  }

  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    refreshLists();
  }, 500);
}

async function openImportTabs() {
  const urls = ["https://x.com/settings/muted/all", "https://x.com/settings/blocked/all"];

  const createdIds = [];
  for (const url of urls) {
    const tab = await chrome.tabs.create({ url, active: false });
    if (tab?.id != null) {
      createdIds.push(tab.id);
    }
  }

  if (createdIds.length) {
    importTabIds = createdIds;
  }

  if (DEBUG) {
    console.log(LOG_PREFIX, "Opened import tabs");
  }
}

async function closeImportTabs() {
  if (!importTabIds.length) {
    return;
  }
  const ids = importTabIds.slice();
  importTabIds = [];
  const safeIds = [];
  for (const id of ids) {
    try {
      const tab = await chrome.tabs.get(id);
      if (
        tab?.url?.startsWith("https://x.com/settings/muted/all") ||
        tab?.url?.startsWith("https://x.com/settings/blocked/all")
      ) {
        safeIds.push(id);
      }
    } catch {
      // ignore missing tabs
    }
  }
  if (!safeIds.length) {
    return;
  }
  try {
    await chrome.tabs.remove(safeIds);
  } catch (error) {
    if (DEBUG) {
      console.warn(LOG_PREFIX, "Failed to close import tabs");
    }
  }
}

function startImport() {
  notifyOnNextRefresh = true;
  openImportTabs();
  scheduleRefresh(REFRESH_REASON.manualImport);
}

function shouldMarkImportComplete(mutedResult, blockedResult, updatePayload) {
  if (!notifyOnNextRefresh) {
    return false;
  }
  if (updatePayload[STORAGE_KEYS.lastError]) {
    return false;
  }
  if (mutedResult.skipped || blockedResult.skipped) {
    return false;
  }
  return true;
}

function buildImportStatus(mutedCount, blockedCount) {
  const now = new Date();
  const time = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  return `取得完了: ミュート${mutedCount}件、ブロック${blockedCount}件 (${time})`;
}

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    const parsed = parseGraphQLUrl(details.url);
    if (!parsed) {
      return;
    }
    if (parsed.operation !== MUTED_QUERY.operation && parsed.operation !== BLOCKED_QUERY.operation) {
      return;
    }

    const config = { id: parsed.id, features: parsed.features || FEATURE_FLAGS };
    storeQueryConfig(parsed.operation, config).then((updated) => {
      if (DEBUG) {
        console.log(LOG_PREFIX, "Captured query config", {
          operation: parsed.operation,
          id: parsed.id,
          updated,
        });
      }
      if (updated) {
        scheduleRefresh(REFRESH_REASON.queryConfig);
      }
    });
  },
  {
    urls: ["https://x.com/i/api/graphql/*/MutedAccounts*", "https://x.com/i/api/graphql/*/BlockedAccountsAll*"],
  }
);

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    if (!details?.requestHeaders) {
      return;
    }
    const authHeader = details.requestHeaders.find((header) => header.name.toLowerCase() === "authorization");
    if (!authHeader?.value) {
      return;
    }
    if (!authHeader.value.startsWith("Bearer ")) {
      return;
    }

    const bearer = authHeader.value.replace(/^Bearer\s+/i, "");
    if (!bearer) {
      return;
    }

    if (authBearerCache === bearer) {
      return;
    }

    authBearerCache = bearer;
    chrome.storage.local.set({ [STORAGE_KEYS.authBearer]: bearer });
    authRequired = false;
    cooldownUntil = 0;
    if (DEBUG) {
      console.log(LOG_PREFIX, "Captured auth bearer", maskToken(bearer));
    }

    scheduleRefresh(REFRESH_REASON.authBearer);
  },
  {
    urls: ["https://x.com/i/api/graphql/*"],
  },
  ["requestHeaders"]
);

chrome.cookies.onChanged.addListener((changeInfo) => {
  const cookie = changeInfo?.cookie;
  if (!cookie || cookie.name !== "ct0") {
    return;
  }
  if (!cookie.domain || !cookie.domain.includes("x.com")) {
    return;
  }

  if (changeInfo.removed) {
    authRequired = true;
    chrome.storage.local.set({
      [STORAGE_KEYS.lastError]: AUTH_REQUIRED_MESSAGE,
      [STORAGE_KEYS.updatedAt]: Date.now(),
    });
    return;
  }

  authRequired = false;
  cooldownUntil = 0;
  scheduleRefresh(REFRESH_REASON.ct0Changed);
});
