(() => {
  if (window.__xBmsfHooked) {
    return;
  }
  window.__xBmsfHooked = true;

  const SOURCE = "x-bmsf";
  const TYPE = "action";
  const targets = [
    { path: "/i/api/1.1/mutes/users/create.json", list: "muted", action: "add" },
    { path: "/i/api/1.1/mutes/users/destroy.json", list: "muted", action: "remove" },
    { path: "/i/api/1.1/blocks/create.json", list: "blocked", action: "add" },
    { path: "/i/api/1.1/blocks/destroy.json", list: "blocked", action: "remove" },
  ];

  function matchTarget(url) {
    if (!url) {
      return null;
    }
    const urlText = String(url);
    for (const target of targets) {
      if (urlText.includes(target.path)) {
        return target;
      }
    }
    return null;
  }

  function emit(target, json) {
    if (!target || !json) {
      return;
    }
    const screenName = json.screen_name;
    if (typeof screenName !== "string" || screenName.length === 0) {
      return;
    }
    window.postMessage(
      {
        source: SOURCE,
        type: TYPE,
        list: target.list,
        action: target.action,
        screenName,
      },
      "*"
    );
  }

  const originalFetch = window.fetch;
  if (originalFetch) {
    window.fetch = async (...args) => {
      const response = await originalFetch(...args);
      try {
        const input = args[0];
        const url = typeof input === "string" ? input : input && input.url;
        const target = matchTarget(url);
        if (target) {
          const cloned = response.clone();
          const text = await cloned.text();
          if (text) {
            emit(target, JSON.parse(text));
          }
        }
      } catch (error) {
        // ignore hook errors
      }
      return response;
    };
  }

  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__xBmsfUrl = url;
    return originalOpen.call(this, method, url, ...rest);
  };

  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener("load", () => {
      try {
        const target = matchTarget(this.__xBmsfUrl);
        if (!target) {
          return;
        }
        if (!this.responseText) {
          return;
        }
        emit(target, JSON.parse(this.responseText));
      } catch (error) {
        // ignore hook errors
      }
    });
    return originalSend.apply(this, args);
  };
})();
