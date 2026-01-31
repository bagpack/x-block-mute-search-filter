(() => {
  if (window.__xBmsfHooked) {
    return;
  }
  window.__xBmsfHooked = true;

  const SOURCE = "x-bmsf";
  const ACTION_TYPE = "action";
  const TIMELINE_TYPE = "timeline";
  const actionTargets = [
    { path: "/i/api/1.1/mutes/users/create.json", list: "muted", action: "add" },
    { path: "/i/api/1.1/mutes/users/destroy.json", list: "muted", action: "remove" },
    { path: "/i/api/1.1/blocks/create.json", list: "blocked", action: "add" },
    { path: "/i/api/1.1/blocks/destroy.json", list: "blocked", action: "remove" },
  ];
  const timelineTargets = [{ path: "/SearchTimeline", name: "SearchTimeline" }];

  function matchActionTarget(url) {
    if (!url) {
      return null;
    }
    const urlText = String(url);
    for (const target of actionTargets) {
      if (urlText.includes(target.path)) {
        return target;
      }
    }
    return null;
  }

  function matchTimelineTarget(url) {
    if (!url) {
      return null;
    }
    const urlText = String(url);
    for (const target of timelineTargets) {
      if (urlText.includes(target.path)) {
        return target;
      }
    }
    return null;
  }

  function emitAction(target, json) {
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
        type: ACTION_TYPE,
        list: target.list,
        action: target.action,
        screenName,
      },
      "*"
    );
  }

  function emitTimeline(target) {
    if (!target) {
      return;
    }
    window.postMessage(
      {
        source: SOURCE,
        type: TIMELINE_TYPE,
        name: target.name,
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
        const actionTarget = matchActionTarget(url);
        const timelineTarget = matchTimelineTarget(url);
        if (timelineTarget) {
          emitTimeline(timelineTarget);
        }
        if (actionTarget) {
          const cloned = response.clone();
          const text = await cloned.text();
          if (text) {
            emitAction(actionTarget, JSON.parse(text));
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
        const actionTarget = matchActionTarget(this.__xBmsfUrl);
        const timelineTarget = matchTimelineTarget(this.__xBmsfUrl);
        if (timelineTarget) {
          emitTimeline(timelineTarget);
        }
        if (actionTarget) {
          if (!this.responseText) {
            return;
          }
          emitAction(actionTarget, JSON.parse(this.responseText));
        }
      } catch (error) {
        // ignore hook errors
      }
    });
    return originalSend.apply(this, args);
  };
})();
