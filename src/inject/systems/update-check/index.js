(() => {
  const runtime = window.__codexProRuntime;
  if (!runtime) return;

  const updateCheck = runtime.systemModules.updateCheck ??= {};
  const storageKey = "codex-pro:update-check";
  const updateStatusEventName = "codex-pro:update-check-status";
  const startupCheckDelayMs = 3500;
  const refreshIntervalMs = 10 * 60 * 1000;
  const maxReleaseSummaryLength = 1200;

  let state = normalizeState(readCachedState());
  let checkPromise = null;

  function isSafeExternalUrl(value) {
    // 这一段只允许 https/http 本机 URL 作为打开目标，避免坏缓存触发任意协议。
    // Allow only HTTPS or local HTTP URLs as open targets so bad cache data cannot trigger arbitrary protocols.
    if (typeof value !== "string" || !value.trim()) return false;
    try {
      const url = new URL(value.trim());
      const isLocalHttp =
        url.protocol === "http:" &&
        ["127.0.0.1", "::1", "[::1]", "localhost"].includes(url.hostname);
      return url.protocol === "https:" || isLocalHttp;
    } catch {
      return false;
    }
  }

  function normalizeString(value, maxLength = 500) {
    // 这一段限制远端文本长度并移除控制字符，避免状态写入 DOM 或缓存时膨胀。
    // Bound remote text and strip control characters before writing status into DOM or cache.
    return typeof value === "string"
      ? value.replace(/[\0-\x08\x0b\x0c\x0e-\x1f]/gu, " ").trim().slice(0, maxLength)
      : "";
  }

  function normalizeCheckedAt(value) {
    // 这一段接受 ISO 时间和 native bridge 的毫秒时间戳，坏缓存会回到未检查状态。
    // Accept ISO timestamps and native-bridge millisecond timestamps so bad cache data returns to the unchecked state.
    const text = normalizeString(value, 40);
    if (!text) return "";
    const numericTimestamp = Number(text);
    const timestamp =
      Number.isFinite(numericTimestamp) && numericTimestamp > 0
        ? numericTimestamp
        : Date.parse(text);
    return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : "";
  }

  function normalizeState(value = {}) {
    // 这一段把 native bridge 响应和缓存统一成页面可直接渲染的状态。
    // Normalize native-bridge responses and cache into one state shape the page can render directly.
    const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    const releaseUrl = normalizeString(source.releaseUrl || source.url);
    const assetUrl = normalizeString(source.assetUrl);
    return {
      assetName: normalizeString(source.assetName, 240),
      assetUrl: isSafeExternalUrl(assetUrl) ? assetUrl : "",
      checkedAt: normalizeCheckedAt(source.checkedAt),
      checking: source.checking === true,
      currentVersion: normalizeString(source.currentVersion || runtime.version, 40),
      error: normalizeString(source.error, 300),
      latestVersion: normalizeString(source.latestVersion, 40),
      releaseSummary: normalizeString(source.releaseSummary, maxReleaseSummaryLength),
      releaseUrl: isSafeExternalUrl(releaseUrl) ? releaseUrl : "",
      updateAvailable: source.updateAvailable === true,
    };
  }

  function readCachedState() {
    // 这一段读取上次更新检查结果；版本变化后的旧缓存不能继续点亮升级角标。
    // Read the last update-check result, but never let a different-version cache keep the badge lit.
    try {
      const parsed = JSON.parse(window.localStorage.getItem(storageKey) || "{}");
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
      const cachedVersion = normalizeString(parsed.currentVersion, 40);
      if (!cachedVersion || cachedVersion !== normalizeString(runtime.version, 40)) return {};
      return parsed;
    } catch {
      return {};
    }
  }

  function writeCachedState(nextState) {
    // 这一段只缓存非瞬时字段，不把 checking 和错误状态长期保留。
    // Cache only durable fields so checking and transient errors are not persisted.
    if (!nextState.checkedAt) return;
    try {
      window.localStorage.setItem(storageKey, JSON.stringify({
        assetName: nextState.assetName,
        assetUrl: nextState.assetUrl,
        checkedAt: nextState.checkedAt,
        currentVersion: nextState.currentVersion,
        latestVersion: nextState.latestVersion,
        releaseSummary: nextState.releaseSummary,
        releaseUrl: nextState.releaseUrl,
        updateAvailable: nextState.updateAvailable,
      }));
    } catch {
      // 这一段忽略本地缓存失败，更新提示仍可在内存中显示。
      // Ignore local cache failures because the update indicator can still live in memory.
    }
  }

  function notifyState(nextState) {
    // 这一段同步设置入口角标、设置页订阅者和自定义事件。
    // Sync the settings-entry badge, settings-page subscribers, and custom status event.
    runtime.systemModules.settingsMenu?.view?.setUpdateCheckState?.(nextState);
    window.dispatchEvent(new CustomEvent(updateStatusEventName, { detail: nextState }));
    for (const listener of updateCheck.listeners) {
      try {
        listener(nextState);
      } catch (error) {
        console.warn("[Codex-Pro] update-check listener failed", error);
      }
    }
  }

  function setState(nextState) {
    // 这一段集中更新内存状态和缓存，避免角标、设置页和事件看到不同数据。
    // Update memory state and cache in one place so badge, settings page, and events see the same data.
    state = normalizeState(nextState);
    if (!state.checking && !state.error) writeCachedState(state);
    notifyState(state);
    return state;
  }

  function shouldRefreshCachedState() {
    // 这一段限制自动检查频率；本地版本变化会绕过缓存，避免旧升级状态粘住。
    // Limit automatic checks; local version changes bypass the cache so old update states cannot stick.
    if (state.currentVersion !== normalizeString(runtime.version, 40)) return true;
    const checkedAt = Date.parse(state.checkedAt || "");
    return !Number.isFinite(checkedAt) || Date.now() - checkedAt >= refreshIntervalMs;
  }

  async function checkForUpdate({ force = false } = {}) {
    // 这一段复用进行中的请求，避免设置页手动按钮和启动检查并发。
    // Reuse an in-flight request so manual clicks and startup checks do not run concurrently.
    if (checkPromise) return checkPromise;
    if (!force && !shouldRefreshCachedState()) {
      notifyState(state);
      return state;
    }
    if (!runtime.nativeBridge?.supportsUpdateCheck?.()) {
      setState({
        ...state,
        checking: false,
        error: state.checkedAt ? "" : "launcherUnsupported",
      });
      return state;
    }

    checkPromise = (async () => {
      setState({ ...state, checking: true, error: "" });
      const response = await runtime.nativeBridge.requestUpdateCheck({ force });
      if (response?.ok === true && response.data && typeof response.data === "object") {
        return setState({
          ...response.data,
          checking: false,
          error: "",
        });
      }
      const error = response?.error || "requestFailed";
      return setState({
        ...state,
        checkedAt: new Date().toISOString(),
        checking: false,
        error,
      });
    })().finally(() => {
      checkPromise = null;
    });
    return checkPromise;
  }

  function subscribe(listener, signal) {
    // 这一段登记状态订阅并在系统销毁时自动解除，避免重复注入泄漏监听。
    // Register a state subscriber and auto-remove it on teardown to avoid reinjection leaks.
    if (typeof listener !== "function") return () => {};
    updateCheck.listeners.add(listener);
    signal?.addEventListener(
      "abort",
      () => {
        updateCheck.listeners.delete(listener);
      },
      { once: true },
    );
    return () => updateCheck.listeners.delete(listener);
  }

  function openRelease() {
    // 这一段只打开已验证的 Release 页面或资产链接，不尝试自动下载或替换程序。
    // Open only the validated release page or asset URL, without auto-downloading or replacing the app.
    const targetUrl = state.releaseUrl || state.assetUrl;
    if (!isSafeExternalUrl(targetUrl)) return false;
    window.open(targetUrl, "_blank", "noopener,noreferrer");
    return true;
  }

  updateCheck.listeners ??= new Set();
  updateCheck.checkNow = () => checkForUpdate({ force: true });
  updateCheck.getState = () => state;
  updateCheck.openRelease = openRelease;
  updateCheck.subscribe = subscribe;

  runtime.registerSystem("update-check", () => {
    const controller = new AbortController();
    runtime.lifecycle.replaceController("update-check", controller);

    // 这一段先渲染缓存状态，再延迟做自动联网检查，减少启动界面抖动。
    // Render cached state first, then delay the automatic network check to reduce startup churn.
    notifyState(state);
    const startupTimer = window.setTimeout(() => {
      void checkForUpdate();
    }, startupCheckDelayMs);
    const refreshTimer = window.setInterval(() => {
      void checkForUpdate();
    }, refreshIntervalMs);

    controller.signal.addEventListener(
      "abort",
      () => {
        window.clearTimeout(startupTimer);
        window.clearInterval(refreshTimer);
      },
      { once: true },
    );
  });
})();
