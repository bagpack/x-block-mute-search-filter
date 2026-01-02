const ACTION_MESSAGE_SOURCE = "x-bmsf";
const ACTION_MESSAGE_TYPE = "action";

function injectNetworkHook() {
  const script = document.createElement("script");
  script.src = chrome.runtime.getURL("hook.js");
  script.async = false;
  script.onload = () => {
    script.remove();
  };
  document.documentElement.appendChild(script);
}

function handleActionMessage(payload) {
  const list = payload?.list;
  const action = payload?.action;
  const screenName = payload?.screenName;
  if (!list || !action || !screenName) {
    return;
  }
  try {
    chrome.runtime.sendMessage(
      {
        type: "updateListFromAction",
        list,
        action,
        handle: screenName,
      },
      () => {
        void chrome.runtime.lastError;
      }
    );
  } catch (error) {
    // Extension context can be invalidated after reload; ignore.
  }
}

injectNetworkHook();
window.addEventListener("message", (event) => {
  if (event.source !== window) {
    return;
  }
  const data = event.data;
  if (data?.source !== ACTION_MESSAGE_SOURCE || data?.type !== ACTION_MESSAGE_TYPE) {
    return;
  }
  handleActionMessage(data);
});
