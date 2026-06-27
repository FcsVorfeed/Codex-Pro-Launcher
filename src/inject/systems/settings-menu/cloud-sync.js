(() => {
  const runtime = window.__codexProRuntime;
  if (!runtime) return;
  const settingsMenu = runtime.systemModules.settingsMenu ??= {};
  const i18n = runtime.i18n;

  const commonWeakSyncKeys = new Set([
    "0000000000000000",
    "1111111111111111",
    "1234567890123456",
    "1234567890abcdef",
    "abcdefghijklmnop",
    "codexprocodexpro",
    "passwordpassword",
    "qwertyuiopasdfgh",
  ]);
  const syncableSettingKeys = [
    "backgroundWallpaperImages",
    "backgroundWallpaperIntervalSeconds",
    "backgroundWallpaperOpacity",
    "backgroundWallpaperPosition",
    "backgroundWallpaperRandom",
    "backgroundWallpaperSize",
    "collapseSidebarOnStartup",
    "chatLineHoverDisplayMode",
    "chatWidthMode",
    "chatWidthPixels",
    "contextUsageDecimalPlaces",
    "contextUsageRingCriticalColor",
    "contextUsageRingCriticalThreshold",
    "contextUsageRingWarningColor",
    "contextUsageRingWarningThreshold",
    "diffHoverFileOpenMode",
    "diffHoverPreviewFontSize",
    "enableBackgroundWallpaper",
    "enableChatLineHover",
    "enableChatWidthResizer",
    "enableConversationArchiveSidebar",
    "conversationArchiveSidebarDirectoryPanelMode",
    "conversationArchiveSidebarPanelMode",
    "enableContextUsageInline",
    "enableContextUsageRingColors",
    "enableDiffHoverPreview",
    "enableEditedFileCardExternalDiffMiddleClick",
    "enableExternalDiffMiddleClick",
    "enableFileTreeActiveReveal",
    "enableFileTreeFilter",
    "enableMouseGestures",
    "enableStartupSidebar",
    "enableTabDragToChat",
    "enableUsagePanel",
    "expandChatLineHoverToLine",
    "hiddenFileTreePatterns",
    "mouseGestureShortcuts",
    "showContextUsageInline",
    "showUsageInLowerLeftPanel",
    "showUsageInEnvironmentPanel",
    "showUsagePanelTokenDetails",
    "showUsagePanelTotalInputTokens",
    "showUsagePanelPing",
    "showUsagePanelResetCredits",
    "usagePanelPingEndpoint",
    "usagePanelPingRefreshSeconds",
    "usagePanelResetCreditsRefreshSeconds",
    "usagePanelTodayTokenSource",
    "uiLanguage",
    "usagePanelAdaptiveWidth",
    "usageRefreshSeconds",
  ];
  const syncableUiLanguages = new Set(["zh-CN", "en-US", "ja-JP"]);
  const syncableChatLineHoverDisplayModes = new Set(["line", "full-line", "block"]);
  const syncableTodayTokenSources = new Set(["hidden", "observer", "official"]);
  const keyAcquisitionUrl = normalizeLocalConfigString(runtime.localConfig?.sync?.keyAcquisitionUrl);
  const syncLicenseMessageKeys = new Set([
    "sync.error.licenseInvalid",
    "sync.error.licenseExpired",
    "sync.error.licenseSuspended",
    "sync.error.licenseRevoked",
    "sync.error.licenseDeviceLimit",
    "sync.error.licenseActivationFailed",
    "sync.error.licenseValidationFailed",
  ]);
  const syncLicenseStatusEventName = "codex-pro:sync-license-status";
  const syncLicenseStartupValidationDelayMs = 800;
  const syncLicenseValidationRetryDelayMs = 1800;
  const syncLicenseValidationMaxRetries = 8;
  const syncLicenseHeartbeatIntervalMs = 30 * 60 * 1000;
  let syncLicenseState = {
    expiresAt: "",
    key: "",
    message: "",
    messageKey: "",
    status: "unknown",
  };
  let syncLicenseValidationPromise = null;
  let syncLicenseValidationKey = "";
  let syncLicenseValidationEndpoint = "";

  function createSyncError(message, status, data) {
    // 这一段把接口失败统一成带状态码的错误，UI 层只需要处理一种形态。
    // Normalize request failures into status-bearing errors so the UI handles one shape.
    const error = new Error(message);
    error.status = status;
    error.data = data;
    error.conflict = status === 409 || data?.conflict === true;
    return error;
  }

  function getDisplayResponseError(responseData, data, fallbackKey) {
    // 这一段避免把云函数或 native bridge 的原始错误文案直接透出到非中文 UI。
    // Avoid leaking raw cloud-function or native-bridge error copy directly into non-Chinese UI.
    const messageKey = String(data?.messageKey || "").trim();
    if (messageKey) return i18n.t(messageKey, { detail: String(data?.messageDetail || "").trim() });
    const rawMessage = String(responseData?.error || data?.message || "").trim();
    if (rawMessage && i18n.resolveLocale() === "zh-CN") return rawMessage;
    return i18n.t(fallbackKey);
  }

  function normalizeSyncLicenseKey(syncKey) {
    // 这一段只在内存中归一化当前输入，不记录或打印同步密钥。
    // Normalize the current input in memory only; never log or print the sync key.
    return typeof syncKey === "string" ? syncKey.trim() : "";
  }

  function normalizeLocalConfigString(value) {
    // 这一段只接受本机配置里的字符串值，避免任意对象被当作 URL 打开。
    // Accept only string values from local config so arbitrary objects cannot be opened as URLs.
    return typeof value === "string" ? value.trim() : "";
  }

  function normalizeSyncLicenseExpiresAt(value) {
    // 这一段只接受可解析的授权到期时间戳，避免把无关响应内容展示到设置页。
    // Accept only parseable license-expiry timestamps so unrelated response data is not shown in settings.
    const rawValue = typeof value === "string" ? value.trim() : "";
    if (!rawValue) return "";
    const timestamp = Date.parse(rawValue);
    if (!Number.isFinite(timestamp)) return "";
    return rawValue;
  }

  function readSyncLicenseMetadata(responseData) {
    // 这一段从 native bridge 顶层响应读取授权展示信息，不读取云端业务 data。
    // Read license display metadata from the native-bridge top-level response, not cloud business data.
    const license = responseData?.license && typeof responseData.license === "object" ? responseData.license : {};
    return {
      expiresAt: normalizeSyncLicenseExpiresAt(license.expiresAt),
    };
  }

  function hasSyncLicenseMetadata(responseData) {
    // 这一段用顶层 license 对象判断 native bridge 已经通过本机授权。
    // Use the top-level license object to tell when the native bridge has already authorized this device.
    return Boolean(responseData?.license && typeof responseData.license === "object");
  }

  function emitSyncLicenseStatus() {
    // 这一段广播授权状态变化，让宠物同步和会话侧栏能即时刷新灰态。
    // Broadcast license-status changes so pet sync and the archive sidebar can refresh disabled states.
    if (typeof window.dispatchEvent !== "function" || typeof window.CustomEvent !== "function") return;
    window.dispatchEvent(new CustomEvent(syncLicenseStatusEventName, {
      detail: {
        expiresAt: syncLicenseState.expiresAt,
        message: syncLicenseState.message,
        messageKey: syncLicenseState.messageKey,
        status: syncLicenseState.status,
      },
    }));
  }

  function resetSyncLicenseState(syncKey = "") {
    // 这一段在用户改密钥时把旧失败状态清掉，新密钥回到待验证状态。
    // Clear the old failure when the user edits the key; the new key returns to pending validation.
    const normalizedKey = normalizeSyncLicenseKey(syncKey);
    if (syncLicenseState.key === normalizedKey && syncLicenseState.status !== "invalid") return;
    syncLicenseState = {
      expiresAt: "",
      key: normalizedKey,
      message: "",
      messageKey: "",
      status: normalizedKey ? "unknown" : "missing",
    };
    emitSyncLicenseStatus();
  }

  function markSyncLicensePending(syncKey = "") {
    // 这一段在主动验证开始时把当前密钥标为待验证，让所有同步入口先锁住直到后端返回。
    // Mark the current key as pending when validation starts so every sync entry stays locked until the backend replies.
    const normalizedKey = normalizeSyncLicenseKey(syncKey);
    if (normalizedKey.length < 16) {
      resetSyncLicenseState(normalizedKey);
      return;
    }
    syncLicenseState = {
      expiresAt: "",
      key: normalizedKey,
      message: i18n.t("sync.licenseStatus.pending"),
      messageKey: "sync.licenseStatus.pending",
      status: "unknown",
    };
    emitSyncLicenseStatus();
  }

  function isSyncLicenseError(error) {
    // 这一段只识别授权相关错误，不把普通网络冲突误标成密钥失效。
    // Recognize only license errors so normal conflicts are not marked as invalid keys.
    const data = error?.data && typeof error.data === "object" ? error.data : error;
    const messageKey = String(data?.messageKey || "").trim();
    return data?.licenseInvalid === true || syncLicenseMessageKeys.has(messageKey);
  }

  function markSyncLicenseInvalid(syncKey, error) {
    // 这一段把后端授权失败记为“已知无效”，后续同步按钮会灰掉直到用户修改密钥。
    // Mark backend authorization failures as known-invalid; sync buttons stay disabled until the key changes.
    if (!isSyncLicenseError(error)) return false;
    const normalizedKey = normalizeSyncLicenseKey(syncKey);
    const data = error?.data && typeof error.data === "object" ? error.data : {};
    const messageKey = String(data.messageKey || "sync.error.licenseInvalid").trim();
    syncLicenseState = {
      expiresAt: "",
      key: normalizedKey,
      message: error?.message || i18n.t(messageKey),
      messageKey,
      status: "invalid",
    };
    emitSyncLicenseStatus();
    return true;
  }

  function markSyncLicenseAuthorized(syncKey, metadata = {}) {
    // 这一段在同步成功后记住当前密钥已通过本机授权，并保留可展示的到期时间。
    // Remember an authorized key after a successful sync and keep safe expiry metadata for display.
    const normalizedKey = normalizeSyncLicenseKey(syncKey);
    if (!normalizedKey) return;
    syncLicenseState = {
      expiresAt: normalizeSyncLicenseExpiresAt(metadata.expiresAt),
      key: normalizedKey,
      message: i18n.t("sync.licenseStatus.authorized"),
      messageKey: "sync.licenseStatus.authorized",
      status: "authorized",
    };
    emitSyncLicenseStatus();
  }

  function getSyncLicenseGate(syncKey) {
    // 这一段给各同步入口返回统一的可用性和提示，不让每个模块各自猜授权状态。
    // Return one shared availability contract so each sync entry does not guess license state independently.
    const normalizedKey = normalizeSyncLicenseKey(syncKey);
    if (normalizedKey.length < 16) {
      return {
        canSync: false,
        expiresAt: "",
        message: i18n.t("sync.licenseStatus.required"),
        messageKey: "sync.licenseStatus.required",
        status: "missing",
        tone: "error",
      };
    }
    if (syncLicenseState.key === normalizedKey && syncLicenseState.status === "invalid") {
      return {
        canSync: false,
        expiresAt: "",
        message: syncLicenseState.message || i18n.t("sync.licenseStatus.invalid"),
        messageKey: syncLicenseState.messageKey || "sync.licenseStatus.invalid",
        status: "invalid",
        tone: "error",
      };
    }
    if (syncLicenseState.key === normalizedKey && syncLicenseState.status === "authorized") {
      return {
        canSync: true,
        expiresAt: syncLicenseState.expiresAt,
        message: syncLicenseState.message,
        messageKey: syncLicenseState.messageKey,
        status: "authorized",
        tone: "success",
      };
    }
    return {
      canSync: false,
      expiresAt: "",
      message: i18n.t("sync.licenseStatus.pending"),
      messageKey: "sync.licenseStatus.pending",
      status: "unknown",
      tone: "",
    };
  }

  function getSyncableSettings(sourceSettings) {
    // 这一段只抽取云端允许同步的安全白名单字段，避免本机路径、密钥和图片地址进入 payload。
    // Extract only the safe cloud-sync allow-list so local paths, keys, and image URLs never enter the payload.
    const payload = {};
    const source = sourceSettings && typeof sourceSettings === "object" ? sourceSettings : {};
    for (const key of syncableSettingKeys) {
      if (Object.hasOwn(source, key)) payload[key] = source[key];
    }
    if (Object.hasOwn(payload, "backgroundWallpaperImages")) {
      const backgroundWallpaperImages = normalizeSyncableBackgroundWallpaperImages(payload.backgroundWallpaperImages);
      if (backgroundWallpaperImages) {
        payload.backgroundWallpaperImages = backgroundWallpaperImages;
      } else {
        delete payload.backgroundWallpaperImages;
      }
    }
    if (Object.hasOwn(payload, "uiLanguage") && !syncableUiLanguages.has(payload.uiLanguage)) {
      delete payload.uiLanguage;
    }
    if (Object.hasOwn(payload, "chatLineHoverDisplayMode") && !syncableChatLineHoverDisplayModes.has(payload.chatLineHoverDisplayMode)) {
      delete payload.chatLineHoverDisplayMode;
    }
    if (Object.hasOwn(payload, "usagePanelTodayTokenSource") && !syncableTodayTokenSources.has(payload.usagePanelTodayTokenSource)) {
      delete payload.usagePanelTodayTokenSource;
    }
    return payload;
  }

  function normalizeSyncableBackgroundWallpaperImages(value) {
    // 这一段只同步跨设备可用的 HTTPS 图片地址，避免 file/data/localhost 泄露或换机不可用。
    // Sync only cross-device HTTPS image URLs so file/data/localhost values do not leak or break on another machine.
    const rawValue = typeof value === "string" ? value : "";
    const urls = rawValue
      .split("\n")
      .map((url) => url.trim())
      .filter(isSyncableBackgroundWallpaperImageUrl);
    return Array.from(new Set(urls)).join("\n");
  }

  function isSyncableBackgroundWallpaperImageUrl(value) {
    // 这一段拒绝本机和内网 HTTPS 地址，避免把只在当前电脑可用的图片源同步到云端。
    // Reject local and private HTTPS URLs so machine-only image sources are not synced to the cloud.
    try {
      const url = new URL(value);
      const hostname = url.hostname.toLowerCase();
      const normalizedHostname = hostname.replace(/^\[(.*)\]$/u, "$1");
      if (url.protocol !== "https:") return false;
      if (normalizedHostname === "localhost" || normalizedHostname === "::1") return false;
      if (/^127\./.test(hostname) || /^10\./.test(hostname) || /^192\.168\./.test(hostname)) return false;
      if (/^169\.254\./.test(hostname) || /^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname)) return false;
      if (/^f[cd][0-9a-f]{2}:/u.test(normalizedHostname) || /^fe80:/u.test(normalizedHostname)) return false;
      return true;
    } catch {
      return false;
    }
  }

  function openKeyAcquisitionPage() {
    // 这一段只打开本机配置里的固定获取地址，避免设置页把任意 URL 交给浏览器。
    // Open only the fixed local-config acquisition page so the settings page never hands arbitrary URLs to the browser.
    if (!keyAcquisitionUrl) return false;
    window.open(keyAcquisitionUrl, "_blank", "noopener,noreferrer");
    return true;
  }

  function normalizeEndpoint(endpoint) {
    // 这一段规范化请求地址；设置模块已经做过校验，这里再兜底避免空地址发请求。
    // Normalize the endpoint; settings already validates it, and this guards against empty request URLs.
    const value = typeof endpoint === "string" ? endpoint.trim() : "";
    if (!value) throw createSyncError(i18n.t("settings.cloudSync.error.endpointRequired"), 0, null);
    return value;
  }

  function validateSyncKey(syncKey) {
    // 这一段在请求前校验同步密钥长度和常见弱口令，密钥只留在请求体里，不写日志。
    // Validate sync-key length and common weak values before requests; the key stays only in the request body.
    const value = typeof syncKey === "string" ? syncKey.trim() : "";
    const compactValue = value.replace(/[\s_-]+/g, "").toLowerCase();
    const hasSingleRepeatedChar = compactValue.length > 0 && /^(.)(\1)+$/.test(compactValue);
    if (value.length < 16) {
      throw createSyncError(i18n.t("sync.error.keyTooShort"), 0, null);
    }
    if (commonWeakSyncKeys.has(compactValue) || hasSingleRepeatedChar) {
      throw createSyncError(i18n.t("sync.error.weakKey"), 0, null);
    }
    return value;
  }

  function readResponseData(response) {
    // 这一段统一解析云同步响应；native bridge 和页面 fetch 都会转成这个结构。
    // Normalize cloud-sync responses; both native bridge and page fetch are converted into this shape.
    const responseData = response && typeof response === "object" ? response : {};
    const data = responseData?.data || null;
    if (!responseData.ok) {
      throw createSyncError(getDisplayResponseError(responseData, data, "settings.cloudSync.error.requestFailed"), responseData?.status || 0, data);
    }
    return data || {};
  }

  async function postJson(endpoint, body) {
    // 这一段统一发起 JSON 请求，并把 HTTP 错误和后端错误都转成交互层可读错误。
    // Send JSON requests and convert both HTTP and backend errors into UI-readable errors.
    const requestEndpoint = normalizeEndpoint(endpoint);
    const bridgeResponse = await runtime.nativeBridge?.requestCloudSync?.({
      body,
      endpoint: requestEndpoint,
    });
    if (bridgeResponse) {
      const licenseMetadata = readSyncLicenseMetadata(bridgeResponse);
      try {
        const data = readResponseData(bridgeResponse);
        markSyncLicenseAuthorized(body?.syncKey, licenseMetadata);
        return data;
      } catch (error) {
        if (hasSyncLicenseMetadata(bridgeResponse) && !isSyncLicenseError(error)) {
          markSyncLicenseAuthorized(body?.syncKey, licenseMetadata);
        }
        markSyncLicenseInvalid(body?.syncKey, error);
        throw error;
      }
    }
    throw createSyncError(i18n.t("settings.cloudSync.error.launcherUnsupported"), 0, null);
  }

  async function pullSettings({ endpoint, syncKey }) {
    // 这一段按同步密钥拉取云端快照；不存在时返回空设置和 revision 0。
    // Pull a cloud snapshot by sync key; missing documents return empty settings and revision 0.
    return postJson(endpoint, {
      action: "pull",
      syncKey: validateSyncKey(syncKey),
    });
  }

  async function validateSyncLicense({ endpoint, force = false, syncKey }) {
    // 这一段复用只读拉取请求触发 native bridge 授权校验，不把云端设置写回本机。
    // Reuse the read-only pull request to trigger native-bridge license validation without applying cloud settings.
    const body = {
      action: "pull",
      syncKey: validateSyncKey(syncKey),
    };
    if (force === true) body.forceLicenseValidation = true;
    await postJson(endpoint, body);
    return getSyncLicenseGate(syncKey);
  }

  function readSavedSyncLicenseConfig() {
    // 这一段只读取已保存的同步地址和密钥，用于启动验证和授权心跳，不读取表单草稿。
    // Read only saved endpoint and sync key for startup validation and license heartbeat, not form drafts.
    const settingsApi = settingsMenu.settings;
    const settings = settingsApi?.getSettings?.() || {};
    return {
      endpoint: typeof settings.cloudSyncEndpoint === "string" ? settings.cloudSyncEndpoint.trim() : "",
      syncKey: normalizeSyncLicenseKey(settings.cloudSyncKey),
    };
  }

  async function requestSyncLicenseValidation({ endpoint, force = false, syncKey } = {}) {
    // 这一段提供共享授权验证入口，手动按钮、设置页打开和启动心跳都复用同一条请求路径。
    // Provide one shared license-validation entrypoint for the manual button, settings-open validation, and startup heartbeat.
    const normalizedKey = normalizeSyncLicenseKey(syncKey);
    const normalizedEndpoint = typeof endpoint === "string" ? endpoint.trim() : "";
    if (normalizedKey.length < 16) {
      resetSyncLicenseState(normalizedKey);
      return getSyncLicenseGate(normalizedKey);
    }
    const currentGate = getSyncLicenseGate(normalizedKey);
    if (!force && currentGate.status === "authorized") return currentGate;
    if (
      syncLicenseValidationPromise &&
      syncLicenseValidationKey === normalizedKey &&
      syncLicenseValidationEndpoint === normalizedEndpoint
    ) {
      return syncLicenseValidationPromise;
    }
    markSyncLicensePending(normalizedKey);
    syncLicenseValidationKey = normalizedKey;
    syncLicenseValidationEndpoint = normalizedEndpoint;
    syncLicenseValidationPromise = (async () => {
      try {
        return await validateSyncLicense({
          endpoint: normalizedEndpoint,
          force,
          syncKey: normalizedKey,
        });
      } finally {
        syncLicenseValidationPromise = null;
        syncLicenseValidationKey = "";
        syncLicenseValidationEndpoint = "";
      }
    })();
    return syncLicenseValidationPromise;
  }

  function installSyncLicenseAutoValidation() {
    // 这一段在运行时启动后自动验证已保存密钥，并用低频心跳发现授权过期、撤销或续费变化。
    // Auto-validate the saved key after runtime startup and use a low-frequency heartbeat to detect expiry, revocation, or renewal.
    const settingsApi = settingsMenu.settings;
    if (!settingsApi?.getSettings || !settingsApi?.subscribe || !runtime.lifecycle?.replaceController) return;
    const controller = new AbortController();
    runtime.lifecycle.replaceController("settings-menu-sync-license", controller);
    let validationTimer = 0;
    let latestSavedConfig = readSavedSyncLicenseConfig();
    const clearValidationTimer = () => {
      if (validationTimer && typeof window.clearTimeout === "function") window.clearTimeout(validationTimer);
      validationTimer = 0;
    };
    const scheduleValidation = ({ attempt = 0, delay = syncLicenseStartupValidationDelayMs, force = false } = {}) => {
      if (controller.signal.aborted || typeof window.setTimeout !== "function") return;
      clearValidationTimer();
      validationTimer = window.setTimeout(async () => {
        validationTimer = 0;
        const config = readSavedSyncLicenseConfig();
        if (config.syncKey.length < 16) {
          resetSyncLicenseState(config.syncKey);
          return;
        }
        const gate = getSyncLicenseGate(config.syncKey);
        if (!force && gate.status === "authorized") return;
        if (!runtime.nativeBridge?.isAvailable?.()) {
          if (attempt < syncLicenseValidationMaxRetries) {
            scheduleValidation({
              attempt: attempt + 1,
              delay: syncLicenseValidationRetryDelayMs,
              force,
            });
          }
          return;
        }
        try {
          await requestSyncLicenseValidation({
            endpoint: config.endpoint,
            force,
            syncKey: config.syncKey,
          });
        } catch (error) {
          if (!isSyncLicenseError(error) && attempt < syncLicenseValidationMaxRetries) {
            scheduleValidation({
              attempt: attempt + 1,
              delay: syncLicenseValidationRetryDelayMs,
              force,
            });
          }
        }
      }, delay);
    };
    const heartbeatInterval = typeof window.setInterval === "function"
      ? window.setInterval(() => {
        scheduleValidation({ delay: 0, force: true });
      }, syncLicenseHeartbeatIntervalMs)
      : 0;
    const unsubscribe = settingsApi.subscribe((nextSettings) => {
      // 这一段在用户保存新密钥或同步地址后立即重新验证，不等下一次心跳。
      // Revalidate immediately after the user saves a new key or endpoint instead of waiting for the next heartbeat.
      const nextKey = normalizeSyncLicenseKey(nextSettings?.cloudSyncKey);
      const nextEndpoint = typeof nextSettings?.cloudSyncEndpoint === "string" ? nextSettings.cloudSyncEndpoint.trim() : "";
      const changed = nextKey !== latestSavedConfig.syncKey || nextEndpoint !== latestSavedConfig.endpoint;
      latestSavedConfig = { endpoint: nextEndpoint, syncKey: nextKey };
      if (!changed) return;
      if (syncLicenseState.key !== nextKey) resetSyncLicenseState(nextKey);
      scheduleValidation({ delay: 0, force: true });
    }, controller.signal);
    scheduleValidation({ delay: syncLicenseStartupValidationDelayMs, force: false });
    controller.signal.addEventListener("abort", () => {
      clearValidationTimer();
      if (heartbeatInterval) window.clearInterval(heartbeatInterval);
      unsubscribe?.();
    }, { once: true });
  }

  async function pushSettings({ endpoint, syncKey, sourceSettings, baseRevision }) {
    // 这一段上传白名单设置，并在有基准版本时交给后端做冲突保护。
    // Upload allow-listed settings and let the backend protect conflicts when a base revision is present.
    const body = {
      action: "push",
      settings: getSyncableSettings(sourceSettings),
      syncKey: validateSyncKey(syncKey),
    };
    if (Number.isInteger(baseRevision) && baseRevision >= 0) {
      body.baseRevision = baseRevision;
    }
    return postJson(endpoint, body);
  }

  settingsMenu.cloudSync = {
    getSyncableSettings,
    getSyncLicenseGate,
    keyAcquisitionUrl,
    markSyncLicenseAuthorized,
    markSyncLicenseInvalid,
    openKeyAcquisitionPage,
    pullSettings,
    pushSettings,
    requestSyncLicenseValidation,
    resetSyncLicenseState,
    syncableSettingKeys,
    syncLicenseStatusEventName,
    validateSyncLicense,
  };
  installSyncLicenseAutoValidation();
})();
