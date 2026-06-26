(() => {
  const runtime = window.__codexProRuntime;
  if (!runtime) return;
  const settingsMenu = runtime.systemModules.settingsMenu ??= {};

  const storageKey = "codex-pro:settings";
  const localConfig = runtime.localConfig && typeof runtime.localConfig === "object" ? runtime.localConfig : {};
  const localSyncConfig = localConfig.sync && typeof localConfig.sync === "object" ? localConfig.sync : {};
  const localAppearanceConfig = localConfig.appearance && typeof localConfig.appearance === "object" ? localConfig.appearance : {};
  const defaultCloudSyncEndpoint = normalizeLocalConfigString(localSyncConfig.cloudSyncEndpoint);
  const defaultPetSyncEndpoint = normalizeLocalConfigString(localSyncConfig.petSyncEndpoint)
    || (defaultCloudSyncEndpoint ? defaultCloudSyncEndpoint.replace("/settings-sync", "/pet-sync") : "");
  const defaultConversationArchiveEndpoint = normalizeLocalConfigString(localSyncConfig.conversationArchiveEndpoint)
    || (defaultCloudSyncEndpoint ? defaultCloudSyncEndpoint.replace("/settings-sync", "/conversation-archive-sync") : "");
  const defaultUsagePanelPingEndpoint = "https://status.openai.com/api/v2/status.json";
  const defaultChatWidthMode = "official";
  const defaultChatWidthPixels = 1100;
  const defaultConversationArchiveProfileName = "Default profile";
  const legacyDefaultConversationArchiveProfileName = "默认账号";
  const defaultBackgroundWallpaperImages = normalizeLocalConfigStringList(localAppearanceConfig.defaultBackgroundWallpaperImages).join("\n");
  const defaultMouseGestureShortcuts = {
    D: "Ctrl+PageDown",
    DL: "Ctrl+W",
    DR: "Ctrl+W",
    L: "Ctrl+Alt+B",
    LR: "Ctrl+N",
    R: "Ctrl+Alt+B",
    RL: "Ctrl+N",
    U: "Ctrl+PageUp",
  };
  const supportedUiLanguages = new Set(["zh-CN", "en-US", "ja-JP"]);
  const conversationArchiveSidebarPanelModes = new Set(["click", "hover"]);
  const usagePanelTodayTokenSources = new Set(["hidden", "observer", "official"]);
  const petEventSoundStateIds = Object.freeze([
    "idle",
    "waving",
    "running",
    "waiting",
    "failed",
    "review",
    "jumping",
    "running-left",
    "running-right",
  ]);
  const petEventSoundStateIdSet = new Set(petEventSoundStateIds);

  function normalizeLocalConfigString(value) {
    // 这一段只接受本机配置里的字符串值，避免数组或对象意外进入设置默认值。
    // Accept only string values from local config so arrays or objects cannot enter setting defaults.
    return typeof value === "string" ? value.trim() : "";
  }

  function normalizeLocalConfigStringList(value) {
    // 这一段把本机配置里的 URL 列表规整成去空白后的字符串数组。
    // Normalize URL lists from local config into trimmed string arrays.
    if (!Array.isArray(value)) return [];
    return value.map(normalizeLocalConfigString).filter(Boolean);
  }

  const defaultSettings = {
    backgroundWallpaperImages: defaultBackgroundWallpaperImages,
    backgroundWallpaperIntervalSeconds: 30,
    backgroundWallpaperOpacity: 0.12,
    backgroundWallpaperPosition: "bottom right",
    backgroundWallpaperRandom: true,
    backgroundWallpaperSize: "auto",
    cloudSyncEndpoint: defaultCloudSyncEndpoint,
    cloudSyncKey: "",
    cloudSyncLastSyncAt: "",
    cloudSyncRevision: 0,
    collapseSidebarOnStartup: false,
    conversationArchiveDeviceName: "",
    conversationArchiveEndpoint: defaultConversationArchiveEndpoint,
    conversationArchiveLastSyncAt: "",
    conversationArchiveProfileName: defaultConversationArchiveProfileName,
    conversationArchiveRevision: 0,
    conversationArchiveSidebarDirectoryPanelMode: "click",
    conversationArchiveSidebarPanelMode: "hover",
    contextUsageRingCriticalColor: "#ef4444",
    contextUsageRingCriticalThreshold: 80,
    contextUsageDecimalPlaces: 0,
    contextUsageRingWarningColor: "#f59e0b",
    contextUsageRingWarningThreshold: 60,
    chatWidthMode: defaultChatWidthMode,
    chatWidthPixels: defaultChatWidthPixels,
    diffHoverFileOpenMode: "review",
    diffHoverPreviewFontSize: "",
    enableBackgroundWallpaper: false,
    enableChatLineHover: true,
    enableChatWidthResizer: true,
    enableCloudSettingsSync: false,
    enableConversationArchiveSync: false,
    enableConversationArchiveSidebar: true,
    enableContextUsageInline: true,
    enableContextUsageRingColors: false,
    enableCodexSqliteLogInsertBlocker: false,
    enableDiffHoverPreview: true,
    enableEditedFileCardExternalDiffMiddleClick: true,
    enableExternalDiffMiddleClick: true,
    enableFileTreeActiveReveal: true,
    enableFileTreeFilter: true,
    enableMouseGestures: false,
    enableNativeThreadDragToChat: true,
    enablePetEventSounds: false,
    enableSplitItemsHotpathPatch: true,
    enableStartupSidebar: false,
    enableTabDragToChat: true,
    enableUsagePanel: true,
    externalDiffToolPath: "",
    hiddenFileTreePatterns: "*.meta",
    mouseGestureShortcuts: defaultMouseGestureShortcuts,
    petEventSoundCooldownMs: 350,
    petEventSoundPaths: {},
    petEventSoundVolumes: {},
    petSyncEndpoint: defaultPetSyncEndpoint,
    petSyncLastSyncAt: "",
    petSyncRevision: 0,
    showContextUsageInline: true,
    showUsageInLowerLeftPanel: false,
    showUsageInEnvironmentPanel: true,
    showUsagePanelTokenDetails: false,
    showUsagePanelTotalInputTokens: false,
    showUsagePanelPing: true,
    usagePanelPingEndpoint: defaultUsagePanelPingEndpoint,
    usagePanelPingRefreshSeconds: 10,
    usagePanelTodayTokenSource: "hidden",
    uiLanguage: "en-US",
    usagePanelAdaptiveWidth: false,
    usageRefreshSeconds: 30,
  };
  const backgroundWallpaperPositions = new Set([
    "bottom",
    "bottom left",
    "bottom right",
    "center",
    "left",
    "right",
    "top",
    "top left",
    "top right",
  ]);
  const backgroundWallpaperSizes = new Set(["auto", "contain", "cover"]);
  const chatWidthModes = new Set(["official", "custom"]);
  const maxBackgroundWallpaperImagesLength = 4000;
  const maxCloudSyncEndpointLength = 500;
  const maxCloudSyncKeyLength = 160;
  const maxChatWidthPixels = 2200;
  const maxConversationArchiveDisplayNameLength = 120;
  const maxContextUsageDecimalPlaces = 3;
  const maxContextUsageRingThreshold = 100;
  const maxDiffHoverPreviewFontSize = 32;
  const maxBackgroundWallpaperOpacity = 0.5;
  const maxExternalDiffToolPathLength = 1000;
  const maxHiddenFileTreePatternsLength = 2000;
  const maxMouseGestureShortcutLength = 80;
  const maxPetEventSoundCooldownMs = 5000;
  const maxPetEventSoundPathLength = 1000;
  const maxPetEventSoundVolume = 100;
  const maxUsagePanelPingEndpointLength = 500;
  const minBackgroundWallpaperIntervalSeconds = 5;
  const minBackgroundWallpaperOpacity = 0;
  const minChatWidthPixels = 560;
  const minContextUsageDecimalPlaces = 0;
  const minContextUsageRingThreshold = 0;
  const minDiffHoverPreviewFontSize = 8;
  const minPetEventSoundCooldownMs = 0;
  const minPetEventSoundVolume = 0;
  const minUsagePanelPingRefreshSeconds = 5;
  const minUsageRefreshSeconds = 10;
  const mouseGestureShortcutCodes = Object.keys(defaultMouseGestureShortcuts);
  const shortcutModifierOrder = ["Ctrl", "Alt", "Shift", "Meta"];
  const shortcutModifierAliases = {
    alt: "Alt",
    cmd: "Meta",
    command: "Meta",
    control: "Ctrl",
    ctrl: "Ctrl",
    meta: "Meta",
    option: "Alt",
    shift: "Shift",
    super: "Meta",
    win: "Meta",
    windows: "Meta",
  };
  const shortcutKeyAliases = {
    arrowdown: "Down",
    arrowleft: "Left",
    arrowright: "Right",
    arrowup: "Up",
    backspace: "Backspace",
    del: "Delete",
    delete: "Delete",
    down: "Down",
    end: "End",
    enter: "Enter",
    esc: "Escape",
    escape: "Escape",
    home: "Home",
    ins: "Insert",
    insert: "Insert",
    left: "Left",
    pagedown: "PageDown",
    pageup: "PageUp",
    pgdn: "PageDown",
    pgup: "PageUp",
    return: "Enter",
    right: "Right",
    space: "Space",
    spacebar: "Space",
    tab: "Tab",
    up: "Up",
  };
  const shortcutPunctuationKeys = {
    "`": "Backquote",
    "-": "Minus",
    "=": "Equal",
    "[": "BracketLeft",
    "]": "BracketRight",
    "\\": "Backslash",
    ";": "Semicolon",
    "'": "Quote",
    ",": "Comma",
    ".": "Period",
    "/": "Slash",
  };
  const listeners = new Set();

  function isAllowedBackgroundWallpaperImageUrl(url) {
    // 这一段只允许图片来源使用明确的 URL 形态，避免把任意文本写进 CSS url()。
    // Allow only explicit image URL shapes so arbitrary text is not written into CSS url().
    return /^https:\/\//i.test(url) ||
      /^file:\/\//i.test(url) ||
      /^data:image\//i.test(url) ||
      /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/i.test(url);
  }

  function normalizeBackgroundWallpaperImages(value) {
    // 这一段把背景图片列表规整成换行 URL，过滤空值、重复值和不支持的来源。
    // Normalize wallpaper images into newline-separated URLs, filtering empty, duplicate, and unsupported sources.
    const rawValue = typeof value === "string" ? value : "";
    const urls = rawValue
      .slice(0, maxBackgroundWallpaperImagesLength)
      .split("\n")
      .flatMap((line) => (/^\s*data:image\//i.test(line) ? [line] : line.split(",")))
      .map((url) => url.trim())
      .filter((url) => url && isAllowedBackgroundWallpaperImageUrl(url));
    return Array.from(new Set(urls)).join("\n");
  }

  function normalizeBackgroundWallpaperIntervalSeconds(value) {
    // 这一段限制轮播间隔，避免过短间隔造成图片频繁重绘。
    // Clamp the carousel interval so very short values do not cause frequent image repaints.
    const seconds = Number(value);
    if (!Number.isFinite(seconds)) return defaultSettings.backgroundWallpaperIntervalSeconds;
    return Math.max(minBackgroundWallpaperIntervalSeconds, Math.round(seconds));
  }

  function normalizeBackgroundWallpaperOpacity(value) {
    // 这一段把背景透明度限制在低干扰范围内，避免影响 Codex 文本可读性。
    // Keep wallpaper opacity in a low-impact range so Codex text remains readable.
    const opacity = Number(value);
    if (!Number.isFinite(opacity)) return defaultSettings.backgroundWallpaperOpacity;
    return Math.min(Math.max(opacity, minBackgroundWallpaperOpacity), maxBackgroundWallpaperOpacity);
  }

  function normalizeBackgroundWallpaperPosition(value) {
    // 这一段只接受预设位置，避免把任意 CSS 值写入背景层。
    // Accept only preset positions so arbitrary CSS values are not written into the wallpaper layer.
    const position = String(value || "").trim().toLowerCase();
    return backgroundWallpaperPositions.has(position) ? position : defaultSettings.backgroundWallpaperPosition;
  }

  function normalizeBackgroundWallpaperRandom(value) {
    // 这一段把随机轮播开关统一成布尔值，缺省时默认随机切换。
    // Normalize the random carousel switch into a boolean, defaulting to random playback.
    return value === false ? false : defaultSettings.backgroundWallpaperRandom;
  }

  function normalizeBackgroundWallpaperSize(value) {
    // 这一段只接受常用背景尺寸，避免输入破坏整体界面观感。
    // Accept only common background sizes so user input cannot break the overall interface.
    const size = String(value || "").trim().toLowerCase();
    return backgroundWallpaperSizes.has(size) ? size : defaultSettings.backgroundWallpaperSize;
  }

  function normalizeCollapseSidebarOnStartup(value) {
    // 这一段把本地配置统一成双向布尔开关，缺省时回到当前启动侧栏默认策略。
    // Normalize the local setting into a two-way boolean switch, falling back to the current startup-sidebar default.
    if (value === true || value === false) return value;
    return defaultSettings.collapseSidebarOnStartup;
  }

  function normalizeCloudSettingsSyncEnabled(value) {
    // 这一段把保存后自动同步开关统一成布尔值，缺省时保持关闭。
    // Normalize the save-time cloud sync switch into a boolean, defaulting to disabled.
    return value === true ? true : defaultSettings.enableCloudSettingsSync;
  }

  function normalizeSyncEndpoint(value, defaultEndpoint) {
    // 这一段把同步地址限制为 HTTPS 或本机 HTTP，避免保存明显不安全的远程明文地址。
    // Restrict sync endpoints to HTTPS or local HTTP so obvious insecure remote URLs are not stored.
    const rawValue = typeof value === "string" ? value.trim().slice(0, maxCloudSyncEndpointLength) : "";
    if (!rawValue) return defaultEndpoint;
    try {
      const url = new URL(rawValue);
      const isLocalHttp =
        url.protocol === "http:" &&
        ["127.0.0.1", "::1", "[::1]", "localhost"].includes(url.hostname);
      if (url.protocol !== "https:" && !isLocalHttp) return defaultEndpoint;
      return url.href.replace(/\/+$/, "");
    } catch {
      return defaultEndpoint;
    }
  }

  function normalizeCloudSyncEndpoint(value) {
    // 这一段规范化设置同步地址，默认回到 settings-sync 云函数入口。
    // Normalize the settings-sync endpoint and fall back to the settings-sync cloud function.
    return normalizeSyncEndpoint(value, defaultSettings.cloudSyncEndpoint);
  }

  function normalizePetSyncEndpoint(value) {
    // 这一段规范化宠物同步地址，默认回到独立的 pet-sync 云函数入口。
    // Normalize the pet-sync endpoint and fall back to the separate pet-sync cloud function.
    return normalizeSyncEndpoint(value, defaultSettings.petSyncEndpoint);
  }

  function normalizeConversationArchiveEndpoint(value) {
    // 这一段规范化会话归档地址；空值回默认地址，非法自定义地址保留原值以持续失败关闭。
    // Normalize the archive endpoint; blank falls back to default, invalid custom values are preserved so they keep failing closed.
    const rawValue = typeof value === "string" ? value.trim().slice(0, maxCloudSyncEndpointLength) : "";
    if (!rawValue) return defaultSettings.conversationArchiveEndpoint;
    try {
      const url = new URL(rawValue);
      const isLocalHttp =
        url.protocol === "http:" &&
        ["127.0.0.1", "::1", "[::1]", "localhost"].includes(url.hostname);
      if (url.protocol !== "https:" && !isLocalHttp) return rawValue;
      return url.href.replace(/\/+$/, "");
    } catch {
      return rawValue;
    }
  }

  function normalizeConversationArchiveSyncEnabled(value) {
    // 这一段把会话归档自动上传开关统一成双向布尔值，缺省时回到当前默认策略。
    // Normalize the auto archive-upload switch into a two-way boolean, falling back to the current default policy.
    if (value === true || value === false) return value;
    return defaultSettings.enableConversationArchiveSync;
  }

  function normalizeConversationArchiveDisplayName(value, fallback) {
    // 这一段清理设备和账号显示名，避免控制字符进入远端 manifest。
    // Clean device/profile display names so control characters do not enter remote manifests.
    const rawValue = typeof value === "string" ? value.replace(/[\0-\x1f]/gu, " ").trim() : "";
    return (rawValue || fallback).slice(0, maxConversationArchiveDisplayNameLength);
  }

  function normalizeCloudSyncKey(value) {
    // 这一段只做本机长度和空白清理，强度校验由同步请求前的云同步模块负责。
    // Keep local cleanup to length and whitespace; the cloud-sync module validates strength before requests.
    return typeof value === "string" ? value.trim().slice(0, maxCloudSyncKeyLength) : "";
  }

  function normalizeCloudSyncLastSyncAt(value) {
    // 这一段把上次同步时间保存为 ISO 字符串，坏数据回落为空。
    // Store the last sync timestamp as an ISO string and fall back to empty on invalid data.
    const rawValue = typeof value === "string" ? value.trim() : "";
    if (!rawValue) return defaultSettings.cloudSyncLastSyncAt;
    const timestamp = Date.parse(rawValue);
    if (!Number.isFinite(timestamp)) return defaultSettings.cloudSyncLastSyncAt;
    return new Date(timestamp).toISOString();
  }

  function normalizeCloudSyncRevision(value) {
    // 这一段把云端版本号钳制为非负整数，避免冲突检测使用无效基准版本。
    // Clamp the cloud revision to a non-negative integer so conflict checks use a valid base revision.
    const revision = Number(value);
    if (!Number.isFinite(revision) || revision < 0) return defaultSettings.cloudSyncRevision;
    return Math.floor(revision);
  }

  function normalizePetSyncLastSyncAt(value) {
    // 这一段把宠物资源上次同步时间保存为 ISO 字符串，坏数据回落为空。
    // Store the last pet-resource sync timestamp as ISO and fall back to empty on invalid data.
    const rawValue = typeof value === "string" ? value.trim() : "";
    if (!rawValue) return defaultSettings.petSyncLastSyncAt;
    const timestamp = Date.parse(rawValue);
    if (!Number.isFinite(timestamp)) return defaultSettings.petSyncLastSyncAt;
    return new Date(timestamp).toISOString();
  }

  function normalizePetSyncRevision(value) {
    // 这一段把宠物资源云端版本号钳制为非负整数，避免冲突检测使用无效基准版本。
    // Clamp the pet-resource cloud revision to a non-negative integer for valid conflict baselines.
    const revision = Number(value);
    if (!Number.isFinite(revision) || revision < 0) return defaultSettings.petSyncRevision;
    return Math.floor(revision);
  }

  function normalizeEnabledSetting(value, defaultValue = true) {
    // 这一段把功能启停开关统一成双向布尔值，缺省时回到字段自己的默认策略。
    // Normalize feature enable switches into two-way booleans, falling back to each field's own default policy.
    if (value === true || value === false) return value;
    return defaultValue;
  }

  function normalizeUsageRefreshSeconds(value) {
    // 这一段把用户输入统一成安全秒数，保证刷新间隔不会低于最低限制。
    // Normalize user input into safe seconds so the refresh interval never drops below the limit.
    const seconds = Number(value);
    if (!Number.isFinite(seconds)) return defaultSettings.usageRefreshSeconds;
    return Math.max(minUsageRefreshSeconds, Math.round(seconds));
  }

  function isLocalHttpUsagePanelPingUrl(url) {
    // 这一段只允许本机 HTTP 作为 Ping 调试目标，避免保存远程明文检测地址。
    // Allow HTTP only for local Ping debug targets so remote cleartext endpoints are not stored.
    const hostname = url.hostname.toLowerCase();
    return url.protocol === "http:" && ["127.0.0.1", "::1", "[::1]", "localhost"].includes(hostname);
  }

  function normalizeUsagePanelPingEndpoint(value) {
    // 这一段把 Ping 地址限制为 HTTPS 或本机 HTTP，空值和非法值回到默认 OpenAI 状态接口。
    // Restrict Ping endpoints to HTTPS or local HTTP; empty and invalid values fall back to the default OpenAI status endpoint.
    const rawValue = typeof value === "string" ? value.trim().slice(0, maxUsagePanelPingEndpointLength) : "";
    if (!rawValue) return defaultSettings.usagePanelPingEndpoint;
    try {
      const url = new URL(rawValue);
      url.hash = "";
      if (url.protocol !== "https:" && !isLocalHttpUsagePanelPingUrl(url)) return defaultSettings.usagePanelPingEndpoint;
      return url.href;
    } catch {
      return defaultSettings.usagePanelPingEndpoint;
    }
  }

  function normalizeUsagePanelPingRefreshSeconds(value) {
    // 这一段把 Ping 刷新间隔限制到安全下限，避免用户误设极短周期造成后台请求过密。
    // Clamp the Ping refresh interval to a safe lower bound so accidental tiny values do not create request pressure.
    const seconds = Number(value);
    if (!Number.isFinite(seconds)) return defaultSettings.usagePanelPingRefreshSeconds;
    return Math.max(minUsagePanelPingRefreshSeconds, Math.round(seconds));
  }

  function normalizeUsagePanelAdaptiveWidth(value) {
    // 这一段把用量面板自适应宽度开关统一成布尔值，缺省时保持旧版固定宽度。
    // Normalize the usage-panel adaptive-width switch into a boolean, defaulting to the old fixed width.
    return value === true ? true : defaultSettings.usagePanelAdaptiveWidth;
  }

  function normalizeShowContextUsageInline(value) {
    // 这一段把输入框上下文用量显示开关统一成布尔值，缺省时默认显示。
    // Normalize the inline context usage switch into a boolean, defaulting to visible.
    return value === false ? false : defaultSettings.showContextUsageInline;
  }

  function normalizeShowUsageInEnvironmentPanel(value) {
    // 这一段把右上环境面板用量显示开关统一成布尔值，缺省时默认显示。
    // Normalize the environment-panel usage switch into a boolean, defaulting to visible.
    return value === false ? false : defaultSettings.showUsageInEnvironmentPanel;
  }

  function normalizeShowUsageInLowerLeftPanel(value) {
    // 这一段把左下角用量面板显示开关统一成双向布尔值，缺省时回到当前默认显示策略。
    // Normalize the lower-left usage-panel switch into a two-way boolean, falling back to the current display default.
    if (value === true || value === false) return value;
    return defaultSettings.showUsageInLowerLeftPanel;
  }

  function normalizeShowUsagePanelTokenDetails(value) {
    // 这一段把对话 token 明细开关统一成双向布尔值，缺省时回到当前默认显示策略。
    // Normalize the conversation token-detail switch into a two-way boolean, falling back to the current display default.
    if (value === true || value === false) return value;
    return defaultSettings.showUsagePanelTokenDetails;
  }

  function normalizeShowUsagePanelTotalInputTokens(value) {
    // 这一段把输入 token 总量显示开关统一成布尔值，缺省时只显示实际输入。
    // Normalize the input-token total switch into a boolean, defaulting to actual input only.
    return value === true ? true : defaultSettings.showUsagePanelTotalInputTokens;
  }

  function normalizeShowUsagePanelPing(value) {
    // 这一段把 Ping 行开关统一成双向布尔值，缺省时默认显示网络读数。
    // Normalize the Ping row switch into a two-way boolean, defaulting to visible network timing.
    if (value === true || value === false) return value;
    return defaultSettings.showUsagePanelPing;
  }

  function normalizeUsagePanelTodayTokenSource(value) {
    // 这一段只接受内置 Today token 数据源，未知值回到默认不显示。
    // Accept only built-in Today-token sources, falling back to hidden by default.
    const source = String(value || "").trim();
    return usagePanelTodayTokenSources.has(source) ? source : defaultSettings.usagePanelTodayTokenSource;
  }

  function normalizeUiLanguage(value) {
    // 这一段只接受内置界面语言，避免同步或本地存储写入任意 locale。
    // Accept only bundled UI languages so sync or local storage cannot inject arbitrary locales.
    const language = String(value || "").trim();
    return supportedUiLanguages.has(language) ? language : defaultSettings.uiLanguage;
  }

  function normalizeConversationArchiveSidebarPanelMode(value) {
    // 这一段只接受同步侧栏内置显示方式，避免本地或云端旧值破坏面板行为。
    // Accept only built-in sync-sidebar display modes so stale local or cloud values cannot break panel behavior.
    const mode = String(value || "").trim();
    return conversationArchiveSidebarPanelModes.has(mode) ? mode : defaultSettings.conversationArchiveSidebarPanelMode;
  }

  function normalizeConversationArchiveSidebarDirectoryPanelMode(value) {
    // 这一段只接受左侧目录面板显示方式，未知值回到点击固定以保持旧行为。
    // Accept only directory-panel display modes, falling back to click-pinned mode to preserve old behavior.
    const mode = String(value || "").trim();
    return conversationArchiveSidebarPanelModes.has(mode) ? mode : defaultSettings.conversationArchiveSidebarDirectoryPanelMode;
  }

  function normalizeContextUsageDecimalPlaces(value) {
    // 这一段把小数位设置限制在安全范围，避免输入异常导致展示过长。
    // Clamp decimal places to a safe range so invalid input cannot make the display too long.
    const decimalPlaces = Number(value);
    if (!Number.isFinite(decimalPlaces)) return defaultSettings.contextUsageDecimalPlaces;
    return Math.min(
      Math.max(Math.round(decimalPlaces), minContextUsageDecimalPlaces),
      maxContextUsageDecimalPlaces,
    );
  }

  function normalizeContextUsageRingThreshold(value, defaultValue) {
    // 这一段把圆圈变色阈值限制在 0-100 的整数百分比，避免异常值打乱状态判断。
    // Clamp ring color thresholds to integer percentages from 0-100 so invalid values cannot break tone decisions.
    const threshold = Number(value);
    if (!Number.isFinite(threshold)) return defaultValue;
    return Math.min(
      Math.max(Math.round(threshold), minContextUsageRingThreshold),
      maxContextUsageRingThreshold,
    );
  }

  function normalizeContextUsageRingWarningThreshold(value, source, fallbackSource) {
    // 这一段让警告阈值不高于危险阈值，保存后仍保持单调递进的用量状态。
    // Keep the warning threshold no higher than the critical threshold so saved usage states remain monotonic.
    const warningThreshold = normalizeContextUsageRingThreshold(value, defaultSettings.contextUsageRingWarningThreshold);
    const criticalThreshold = normalizeContextUsageRingThreshold(
      getSettingSourceValue({ key: "contextUsageRingCriticalThreshold" }, source, fallbackSource),
      defaultSettings.contextUsageRingCriticalThreshold,
    );
    return Math.min(warningThreshold, criticalThreshold);
  }

  function normalizeContextUsageRingCriticalThreshold(value) {
    // 这一段单独规范危险阈值，警告阈值会在自己的归一化里向它收敛。
    // Normalize the critical threshold on its own; the warning threshold converges to it in its own normalizer.
    return normalizeContextUsageRingThreshold(value, defaultSettings.contextUsageRingCriticalThreshold);
  }

  function normalizeContextUsageRingColor(value, defaultValue) {
    // 这一段只接受十六进制颜色，避免把任意 CSS 内容写入运行时样式或同步快照。
    // Accept only hex colors so arbitrary CSS content cannot enter runtime styles or sync snapshots.
    const rawValue = typeof value === "string" ? value.trim() : "";
    const match = /^#?([0-9a-f]{6})$/iu.exec(rawValue);
    return match ? `#${match[1].toLowerCase()}` : defaultValue;
  }

  function readChatWidthPixelNumber(value) {
    // 这一段只接受明确的数字或非空数字字符串，避免 null/空串在 Number() 下被误当成 0。
    // Accept only explicit numbers or non-empty numeric strings so null/empty strings are not coerced to 0.
    const isNumericValue = typeof value === "number" || (typeof value === "string" && value.trim() !== "");
    if (!isNumericValue) return null;
    const width = Number(value);
    return Number.isFinite(width) ? width : null;
  }

  function normalizeChatWidthPixels(value) {
    // 这一段把聊天区宽度限制在桌面可读范围，实际运行时还会按当前窗口二次钳制。
    // Clamp chat width into a readable desktop range; runtime clamps again to the current viewport.
    const width = readChatWidthPixelNumber(value);
    if (width == null) return defaultSettings.chatWidthPixels;
    return Math.min(Math.max(Math.round(width), minChatWidthPixels), maxChatWidthPixels);
  }

  function normalizeLegacyChatWidthPixels(value) {
    // 这一段只迁移旧版本明确保存过的有效宽度，坏值保持官方默认模式。
    // Migrate only explicit valid legacy widths; invalid values keep the native-width mode.
    if (readChatWidthPixelNumber(value) == null) return null;
    return normalizeChatWidthPixels(value);
  }

  function normalizeChatWidthMode(value, source) {
    // 这一段区分官方默认和拖拽后的自定义宽度，并兼容旧版本只保存宽度的配置。
    // Distinguish native width from dragged custom width while migrating older width-only settings.
    const sourceObject = getSourceObject(source);
    const hasExplicitMode = Object.hasOwn(sourceObject, "chatWidthMode");
    const mode = String(hasExplicitMode ? value : "").trim();
    if (chatWidthModes.has(mode)) return mode;
    if (Object.hasOwn(sourceObject, "chatWidthPixels")) {
      const migratedWidth = normalizeLegacyChatWidthPixels(sourceObject.chatWidthPixels);
      if (migratedWidth != null && migratedWidth !== defaultSettings.chatWidthPixels) return "custom";
    }
    return defaultSettings.chatWidthMode;
  }

  function normalizeChatWidthResizerEnabled(value) {
    // 这一段把聊天宽度拖拽开关统一成布尔值，默认启用以改善大屏输入区宽度。
    // Normalize the chat-width resizer switch into a boolean, defaulting to enabled for wider desktop composers.
    return value === false ? false : defaultSettings.enableChatWidthResizer;
  }

  function normalizeHiddenFileTreePatterns(value) {
    // 这一段把右侧文件树过滤规则规整成换行列表，避免空规则和重复规则造成额外扫描。
    // Normalize file-tree filter rules into a newline list so empty and duplicate rules do not add extra scanning.
    const rawValue = typeof value === "string" ? value : "";
    const patterns = rawValue
      .slice(0, maxHiddenFileTreePatternsLength)
      .split(/[,\n]/)
      .map((pattern) => pattern.trim())
      .filter(Boolean);
    return Array.from(new Set(patterns)).join("\n");
  }

  function normalizeDiffHoverPreviewFontSize(value) {
    // 这一段允许留空跟随 Codex 原生代码字号，填写时限制到可读范围内。
    // Allow blank values to follow Codex's native code font size, and clamp custom values into a readable range.
    const rawValue = typeof value === "string" ? value.trim() : value;
    if (rawValue === "" || rawValue == null) return defaultSettings.diffHoverPreviewFontSize;
    const fontSize = Number(rawValue);
    if (!Number.isFinite(fontSize) || fontSize <= 0) return defaultSettings.diffHoverPreviewFontSize;
    return Math.min(
      Math.max(Math.round(fontSize), minDiffHoverPreviewFontSize),
      maxDiffHoverPreviewFontSize,
    );
  }

  function normalizeDiffHoverFileOpenMode(value) {
    // 这一段把悬浮列表文件行左键行为限制在已支持的两个模式里，避免未知值改变打开路径。
    // Constrain hover-list left-click behavior to supported modes so unknown values cannot change the open path.
    const mode = String(value || "").trim();
    return mode === "preview" ? "preview" : defaultSettings.diffHoverFileOpenMode;
  }

  function normalizeExternalDiffToolPath(value) {
    // 这一段只保存外部 Diff 工具可执行文件路径，避免把参数模板混入本机执行配置。
    // Store only the external diff executable path so argument templates do not enter native execution settings.
    const rawValue = typeof value === "string" ? value : "";
    return rawValue
      .trim()
      .replace(/^"(.+)"$/u, "$1")
      .slice(0, maxExternalDiffToolPathLength);
  }

  function normalizeShortcutMainKey(value) {
    // 这一段把主键名称收敛到固定显示值，避免同一个按键出现多种保存格式。
    // Collapse the main key into one display token so one key cannot be stored in multiple formats.
    const token = String(value || "").trim();
    const compactToken = token.replace(/\s+/g, "");
    if (/^[a-z]$/i.test(compactToken)) return compactToken.toUpperCase();
    if (/^[0-9]$/.test(compactToken)) return compactToken;

    // 这一段允许常见功能键、方向键和标点主键，仍保持“一个主键”的安全边界。
    // Allow common function, navigation, and punctuation main keys while keeping the one-main-key boundary.
    const normalizedNamedKey = shortcutKeyAliases[compactToken.toLowerCase()];
    if (normalizedNamedKey) return normalizedNamedKey;
    if (/^f([1-9]|1[0-2])$/i.test(compactToken)) return compactToken.toUpperCase();
    return shortcutPunctuationKeys[compactToken] || "";
  }

  function normalizeMouseGestureShortcut(value) {
    // 这一段把用户输入的组合键整理成 Ctrl+Alt+K 这种稳定格式；空值表示不触发。
    // Normalize a user-entered chord into a stable Ctrl+Alt+K format; empty means no action.
    const rawValue = typeof value === "string" ? value.trim().slice(0, maxMouseGestureShortcutLength) : "";
    if (!rawValue) return "";
    const tokens = rawValue
      .split("+")
      .map((token) => token.trim())
      .filter(Boolean);

    // 这一段只接受多个修饰键加一个主键，拒绝连续按键、宏或多个主键。
    // Accept only multiple modifiers plus one main key, rejecting sequences, macros, or multiple main keys.
    const modifiers = new Set();
    let mainKey = "";
    for (const token of tokens) {
      const modifier = shortcutModifierAliases[token.toLowerCase()];
      if (modifier) {
        modifiers.add(modifier);
        continue;
      }
      const normalizedMainKey = normalizeShortcutMainKey(token);
      if (!normalizedMainKey || mainKey) return "";
      mainKey = normalizedMainKey;
    }
    if (!mainKey || modifiers.size === 0) return "";

    // 这一段按固定顺序输出修饰键，让 Ctrl+Alt 和 Alt+Ctrl 保存为同一个值。
    // Emit modifiers in a fixed order so Ctrl+Alt and Alt+Ctrl are stored as the same value.
    return [...shortcutModifierOrder.filter((modifier) => modifiers.has(modifier)), mainKey].join("+");
  }

  function normalizeMouseGestureShortcuts(value) {
    // 这一段按固定手势集合读取快捷键，忽略未知字段，避免本地存储污染执行层。
    // Read shortcuts only for the fixed gesture set and ignore unknown fields so storage cannot pollute execution.
    const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    return Object.fromEntries(
      mouseGestureShortcutCodes.map((code) => [
        code,
        normalizeMouseGestureShortcut(Object.hasOwn(source, code) ? source[code] : defaultMouseGestureShortcuts[code]),
      ]),
    );
  }

  function areMouseGestureShortcutsEqual(left, right) {
    // 这一段逐项比较手势快捷键，供保存和修改标记复用。
    // Compare gesture shortcuts item by item for save cleanup and modified markers.
    return mouseGestureShortcutCodes.every((code) => left?.[code] === right?.[code]);
  }

  function normalizePetEventSoundPath(value) {
    // 这一段规范化单个宠物状态音效路径，拒绝控制字符并限制长度，避免异常路径进入原生桥。
    // Normalize one pet-state sound path, rejecting control characters and bounding length before it reaches the native bridge.
    const soundPath = String(value || "").trim();
    if (!soundPath || soundPath.length > maxPetEventSoundPathLength || /[\0\r\n]/u.test(soundPath)) return "";
    return soundPath;
  }

  function normalizePetEventSoundPaths(value) {
    // 这一段只保留官方宠物状态 id 对应的路径，未知键不会写回设置。
    // Keep only paths keyed by official pet-state ids so unknown keys are not persisted.
    const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    const paths = {};
    for (const stateId of petEventSoundStateIds) {
      const soundPath = normalizePetEventSoundPath(source[stateId]);
      if (soundPath) paths[stateId] = soundPath;
    }
    return paths;
  }

  function normalizePetEventSoundVolume(value) {
    // 这一段把单个宠物状态音量限制到 0-100，非法值回到满音量默认值。
    // Clamp one pet-state volume to 0-100 and fall back to full volume for invalid values.
    if (typeof value === "string" && !value.trim()) return maxPetEventSoundVolume;
    const number = Number(value);
    if (!Number.isFinite(number)) return maxPetEventSoundVolume;
    return Math.round(Math.min(maxPetEventSoundVolume, Math.max(minPetEventSoundVolume, number)));
  }

  function normalizePetEventSoundVolumes(value) {
    // 这一段只保存偏离默认满音量的官方状态音量，减少本地设置冗余。
    // Store only official state volumes that differ from the full-volume default to keep local settings compact.
    const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    const volumes = {};
    for (const stateId of petEventSoundStateIds) {
      const volume = normalizePetEventSoundVolume(source[stateId]);
      if (volume !== maxPetEventSoundVolume) volumes[stateId] = volume;
    }
    return volumes;
  }

  function arePetEventSoundPathsEqual(left, right) {
    // 这一段按固定状态顺序比较路径对象，避免对象引用差异导致保存按钮误报修改。
    // Compare path objects in a fixed state order so object references do not falsely mark settings as modified.
    const leftPaths = normalizePetEventSoundPaths(left);
    const rightPaths = normalizePetEventSoundPaths(right);
    return petEventSoundStateIds.every((stateId) => leftPaths[stateId] === rightPaths[stateId]);
  }

  function arePetEventSoundVolumesEqual(left, right) {
    // 这一段按固定状态顺序比较音量对象，缺失值按默认满音量处理。
    // Compare volume objects in fixed state order, treating missing entries as full-volume defaults.
    const leftVolumes = normalizePetEventSoundVolumes(left);
    const rightVolumes = normalizePetEventSoundVolumes(right);
    return petEventSoundStateIds.every((stateId) => {
      const leftVolume = leftVolumes[stateId] ?? maxPetEventSoundVolume;
      const rightVolume = rightVolumes[stateId] ?? maxPetEventSoundVolume;
      return leftVolume === rightVolume;
    });
  }

  function normalizePetEventSoundCooldownMs(value) {
    // 这一段把宠物状态音效冷却时间限制在小范围内，防止动画状态抖动时频繁解码或播放。
    // Bound the pet-state sound cooldown so animated-state jitter cannot trigger excessive decoding or playback.
    const number = Number(value);
    if (!Number.isFinite(number)) return defaultSettings.petEventSoundCooldownMs;
    return Math.round(Math.min(maxPetEventSoundCooldownMs, Math.max(minPetEventSoundCooldownMs, number)));
  }

  function readRawSettings() {
    // 这一段只读取本插件自己的本地配置，不接触任何账号或会话数据。
    // Read only this plugin's local settings without touching account or session data.
    try {
      const parsedSettings = JSON.parse(window.localStorage.getItem(storageKey) || "{}");
      return parsedSettings && typeof parsedSettings === "object" && !Array.isArray(parsedSettings)
        ? parsedSettings
        : {};
    } catch {
      return {};
    }
  }

  function writeRawSettings(settings) {
    // 这一段把配置写回浏览器本地存储，失败时让调用方继续使用内存中的结果。
    // Write settings back to browser local storage and let callers keep using in-memory results on failure.
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(settings));
    } catch {
      // 这一段故意吞掉存储失败，避免设置弹窗影响 Codex 主界面可用性。
      // Intentionally ignore storage failures so the settings dialog does not affect Codex itself.
    }
  }

  const settingFields = [
    { key: "backgroundWallpaperImages", normalize: normalizeBackgroundWallpaperImages },
    { key: "backgroundWallpaperIntervalSeconds", normalize: normalizeBackgroundWallpaperIntervalSeconds },
    { key: "backgroundWallpaperOpacity", normalize: normalizeBackgroundWallpaperOpacity },
    { key: "backgroundWallpaperPosition", normalize: normalizeBackgroundWallpaperPosition },
    { key: "backgroundWallpaperRandom", normalize: normalizeBackgroundWallpaperRandom },
    { key: "backgroundWallpaperSize", normalize: normalizeBackgroundWallpaperSize },
    { key: "cloudSyncEndpoint", normalize: normalizeCloudSyncEndpoint, preserveOnPartialSave: true },
    { key: "cloudSyncKey", normalize: normalizeCloudSyncKey, preserveOnPartialSave: true },
    { key: "cloudSyncLastSyncAt", normalize: normalizeCloudSyncLastSyncAt, preserveOnPartialSave: true },
    { key: "cloudSyncRevision", normalize: normalizeCloudSyncRevision, preserveOnPartialSave: true },
    { key: "collapseSidebarOnStartup", normalize: normalizeCollapseSidebarOnStartup },
    {
      key: "conversationArchiveDeviceName",
      normalize: (value) => normalizeConversationArchiveDisplayName(value, defaultSettings.conversationArchiveDeviceName),
      preserveOnPartialSave: true,
    },
    { key: "conversationArchiveEndpoint", normalize: normalizeConversationArchiveEndpoint, preserveOnPartialSave: true },
    { key: "conversationArchiveLastSyncAt", normalize: normalizeCloudSyncLastSyncAt, preserveOnPartialSave: true },
    {
      key: "conversationArchiveProfileName",
      normalize: (value) => normalizeConversationArchiveDisplayName(
        value === legacyDefaultConversationArchiveProfileName ? "" : value,
        defaultSettings.conversationArchiveProfileName,
      ),
      preserveOnPartialSave: true,
    },
    { key: "conversationArchiveRevision", normalize: normalizeCloudSyncRevision, preserveOnPartialSave: true },
    { key: "conversationArchiveSidebarDirectoryPanelMode", normalize: normalizeConversationArchiveSidebarDirectoryPanelMode },
    { key: "conversationArchiveSidebarPanelMode", normalize: normalizeConversationArchiveSidebarPanelMode },
    { key: "contextUsageDecimalPlaces", normalize: normalizeContextUsageDecimalPlaces },
    {
      key: "contextUsageRingCriticalColor",
      normalize: (value) => normalizeContextUsageRingColor(value, defaultSettings.contextUsageRingCriticalColor),
    },
    { key: "contextUsageRingCriticalThreshold", normalize: normalizeContextUsageRingCriticalThreshold },
    {
      key: "contextUsageRingWarningColor",
      normalize: (value) => normalizeContextUsageRingColor(value, defaultSettings.contextUsageRingWarningColor),
    },
    { key: "contextUsageRingWarningThreshold", normalize: normalizeContextUsageRingWarningThreshold },
    { key: "chatWidthMode", normalize: normalizeChatWidthMode },
    { key: "chatWidthPixels", normalize: normalizeChatWidthPixels },
    { key: "diffHoverFileOpenMode", normalize: normalizeDiffHoverFileOpenMode },
    { key: "diffHoverPreviewFontSize", normalize: normalizeDiffHoverPreviewFontSize },
    {
      key: "enableBackgroundWallpaper",
      normalize: (value) => normalizeEnabledSetting(value, defaultSettings.enableBackgroundWallpaper),
    },
    {
      key: "enableChatLineHover",
      normalize: (value) => normalizeEnabledSetting(value, defaultSettings.enableChatLineHover),
    },
    { key: "enableChatWidthResizer", normalize: normalizeChatWidthResizerEnabled },
    { key: "enableCloudSettingsSync", normalize: normalizeCloudSettingsSyncEnabled, preserveOnPartialSave: true },
    { key: "enableConversationArchiveSync", normalize: normalizeConversationArchiveSyncEnabled, preserveOnPartialSave: true },
    {
      key: "enableConversationArchiveSidebar",
      normalize: (value) => normalizeEnabledSetting(value, defaultSettings.enableConversationArchiveSidebar),
    },
    {
      key: "enableContextUsageInline",
      normalize: (value) => normalizeEnabledSetting(value, defaultSettings.enableContextUsageInline),
    },
    {
      key: "enableContextUsageRingColors",
      normalize: (value) => normalizeEnabledSetting(value, defaultSettings.enableContextUsageRingColors),
    },
    {
      key: "enableCodexSqliteLogInsertBlocker",
      normalize: (value) => normalizeEnabledSetting(value, defaultSettings.enableCodexSqliteLogInsertBlocker),
    },
    {
      key: "enableDiffHoverPreview",
      normalize: (value) => normalizeEnabledSetting(value, defaultSettings.enableDiffHoverPreview),
    },
    {
      key: "enableEditedFileCardExternalDiffMiddleClick",
      normalize: (value) => normalizeEnabledSetting(value, defaultSettings.enableEditedFileCardExternalDiffMiddleClick),
    },
    {
      key: "enableExternalDiffMiddleClick",
      normalize: (value) => normalizeEnabledSetting(value, defaultSettings.enableExternalDiffMiddleClick),
    },
    {
      key: "enableFileTreeActiveReveal",
      normalize: (value) => normalizeEnabledSetting(value, defaultSettings.enableFileTreeActiveReveal),
    },
    {
      key: "enableFileTreeFilter",
      normalize: (value) => normalizeEnabledSetting(value, defaultSettings.enableFileTreeFilter),
    },
    {
      key: "enableMouseGestures",
      normalize: (value) => normalizeEnabledSetting(value, defaultSettings.enableMouseGestures),
    },
    {
      key: "enableNativeThreadDragToChat",
      normalize: (value) => normalizeEnabledSetting(value, defaultSettings.enableNativeThreadDragToChat),
    },
    {
      key: "enablePetEventSounds",
      normalize: (value) => normalizeEnabledSetting(value, defaultSettings.enablePetEventSounds),
    },
    {
      key: "enableSplitItemsHotpathPatch",
      normalize: (value) => normalizeEnabledSetting(value, defaultSettings.enableSplitItemsHotpathPatch),
    },
    {
      key: "enableStartupSidebar",
      normalize: (value) => normalizeEnabledSetting(value, defaultSettings.enableStartupSidebar),
    },
    {
      key: "enableTabDragToChat",
      normalize: (value) => normalizeEnabledSetting(value, defaultSettings.enableTabDragToChat),
    },
    {
      key: "enableUsagePanel",
      normalize: (value) => normalizeEnabledSetting(value, defaultSettings.enableUsagePanel),
    },
    { key: "externalDiffToolPath", normalize: normalizeExternalDiffToolPath },
    { key: "hiddenFileTreePatterns", normalize: normalizeHiddenFileTreePatterns },
    { key: "mouseGestureShortcuts", normalize: normalizeMouseGestureShortcuts, equals: areMouseGestureShortcutsEqual },
    { key: "petEventSoundCooldownMs", normalize: normalizePetEventSoundCooldownMs },
    { key: "petEventSoundPaths", normalize: normalizePetEventSoundPaths, equals: arePetEventSoundPathsEqual },
    { key: "petEventSoundVolumes", normalize: normalizePetEventSoundVolumes, equals: arePetEventSoundVolumesEqual },
    { key: "petSyncEndpoint", normalize: normalizePetSyncEndpoint, preserveOnPartialSave: true },
    { key: "petSyncLastSyncAt", normalize: normalizePetSyncLastSyncAt, preserveOnPartialSave: true },
    { key: "petSyncRevision", normalize: normalizePetSyncRevision, preserveOnPartialSave: true },
    { key: "showContextUsageInline", normalize: normalizeShowContextUsageInline },
    { key: "showUsageInLowerLeftPanel", normalize: normalizeShowUsageInLowerLeftPanel },
    { key: "showUsageInEnvironmentPanel", normalize: normalizeShowUsageInEnvironmentPanel },
    { key: "showUsagePanelTokenDetails", normalize: normalizeShowUsagePanelTokenDetails },
    { key: "showUsagePanelTotalInputTokens", normalize: normalizeShowUsagePanelTotalInputTokens },
    { key: "showUsagePanelPing", normalize: normalizeShowUsagePanelPing },
    { key: "usagePanelPingEndpoint", normalize: normalizeUsagePanelPingEndpoint },
    { key: "usagePanelPingRefreshSeconds", normalize: normalizeUsagePanelPingRefreshSeconds },
    { key: "usagePanelTodayTokenSource", normalize: normalizeUsagePanelTodayTokenSource },
    { key: "uiLanguage", normalize: normalizeUiLanguage, preserveOnPartialSave: true },
    { key: "usageRefreshSeconds", normalize: normalizeUsageRefreshSeconds },
    { key: "usagePanelAdaptiveWidth", normalize: normalizeUsagePanelAdaptiveWidth },
  ];
  const publicSettingFields = Object.freeze(settingFields.map((field) => Object.freeze({
    key: field.key,
    preserveOnPartialSave: field.preserveOnPartialSave !== false,
  })));
  // 这一组元数据只对当前同步密钥有效，密钥变化时必须回到未同步状态。
  // These metadata fields are scoped to the current sync key and must reset when the key changes.
  const cloudSyncKeyScopedMetadataKeys = new Set([
    "cloudSyncLastSyncAt",
    "cloudSyncRevision",
    "conversationArchiveLastSyncAt",
    "conversationArchiveRevision",
    "petSyncLastSyncAt",
    "petSyncRevision",
  ]);

  function getSourceObject(source) {
    // 这一段把任意输入收敛成普通对象，防止 null、数组或字符串进入字段循环。
    // Normalize arbitrary input into a plain object so null, arrays, or strings do not enter field loops.
    return source && typeof source === "object" && !Array.isArray(source) ? source : {};
  }

  function getSettingSourceValue(field, source, fallbackSource = defaultSettings) {
    // 这一段按字段名读取来源值，缺失时回到指定 fallback，保持默认读取和保存读取可复用。
    // Read a source value by field name and fall back to the provided fallback for reusable default/save reads.
    const sourceObject = getSourceObject(source);
    if (Object.hasOwn(sourceObject, field.key)) return sourceObject[field.key];
    return getSourceObject(fallbackSource)[field.key];
  }

  function normalizeSettingField(field, source, fallbackSource = defaultSettings) {
    // 这一段通过字段自己的 normalize 函数得到稳定值，外部系统不再读未校验配置。
    // Use each field's normalize function to produce stable values so consumers never read unchecked settings.
    return field.normalize(getSettingSourceValue(field, source, fallbackSource), getSourceObject(source), getSourceObject(fallbackSource));
  }

  function areSettingValuesEqual(field, left, right) {
    // 这一段允许复杂字段自定义比较，普通字段使用 Object.is 避免类型漂移。
    // Allow complex fields to define equality while simple fields use Object.is to avoid type drift.
    return field.equals ? field.equals(left, right) : Object.is(left, right);
  }

  function getNormalizedSettingsFromSource(source, fallbackSource = defaultSettings) {
    // 这一段由字段注册表生成完整设置对象，避免新增字段时重复改多处映射。
    // Build a complete settings object from the field registry so new fields do not require repeated mappings.
    const normalizedSettings = {};
    for (const field of settingFields) {
      normalizedSettings[field.key] = normalizeSettingField(field, source, fallbackSource);
    }
    return normalizedSettings;
  }

  function getMouseGestureShortcutModifiedState(source, requireOwn) {
    // 这一段保留每个手势方向的细粒度修改标记，设置页蓝点仍能标到单独输入行。
    // Keep fine-grained modified markers for each gesture direction so the UI can mark individual shortcut rows.
    const sourceObject = getSourceObject(source);
    const hasShortcuts = Object.hasOwn(sourceObject, "mouseGestureShortcuts");
    const shortcuts = normalizeMouseGestureShortcuts(sourceObject.mouseGestureShortcuts);
    return Object.fromEntries(mouseGestureShortcutCodes.map((code) => [
      "mouseGestureShortcuts:" + code,
      (!requireOwn || hasShortcuts) && shortcuts[code] !== defaultSettings.mouseGestureShortcuts[code],
    ]));
  }

  function getPetEventSoundPathModifiedState(source, requireOwn) {
    // 这一段保留每个宠物状态路径的细粒度修改标记，让事件卡片能独立显示蓝点。
    // Keep fine-grained modified markers for each pet-state path so event cards can show their own dirty marker.
    const sourceObject = getSourceObject(source);
    const hasPaths = Object.hasOwn(sourceObject, "petEventSoundPaths");
    const paths = normalizePetEventSoundPaths(sourceObject.petEventSoundPaths);
    return Object.fromEntries(petEventSoundStateIds.map((stateId) => [
      "petEventSoundPaths:" + stateId,
      (!requireOwn || hasPaths) && paths[stateId] !== defaultSettings.petEventSoundPaths[stateId],
    ]));
  }

  function getPetEventSoundVolumeModifiedState(source, requireOwn) {
    // 这一段保留每个宠物状态音量的细粒度修改标记，让音量输入能独立显示蓝点。
    // Keep fine-grained modified markers for each pet-state volume so volume inputs can show their own dirty marker.
    const sourceObject = getSourceObject(source);
    const hasVolumes = Object.hasOwn(sourceObject, "petEventSoundVolumes");
    const volumes = normalizePetEventSoundVolumes(sourceObject.petEventSoundVolumes);
    return Object.fromEntries(petEventSoundStateIds.map((stateId) => [
      "petEventSoundVolumes:" + stateId,
      (!requireOwn || hasVolumes) && (volumes[stateId] ?? maxPetEventSoundVolume) !== maxPetEventSoundVolume,
    ]));
  }

  function getModifiedStateFromSource(source, { requireOwn }) {
    // 这一段统一生成“已保存”和“草稿”的修改状态，差异只在是否要求 raw 中存在该字段。
    // Generate both saved and draft modified states in one path; they only differ by requiring raw ownership.
    const sourceObject = getSourceObject(source);
    const modifiedState = {};
    for (const field of settingFields) {
      const hasField = Object.hasOwn(sourceObject, field.key);
      const normalizedValue = normalizeSettingField(field, sourceObject);
      modifiedState[field.key] = (!requireOwn || hasField) &&
        !areSettingValuesEqual(field, normalizedValue, defaultSettings[field.key]);
    }
    return {
      ...modifiedState,
      ...getMouseGestureShortcutModifiedState(sourceObject, requireOwn),
      ...getPetEventSoundPathModifiedState(sourceObject, requireOwn),
      ...getPetEventSoundVolumeModifiedState(sourceObject, requireOwn),
    };
  }

  function getSaveValue(field, nextSettingsSource, rawSettings) {
    // 这一段让局部保存只更新传入字段，避免同步元数据写入时清掉其它用户设置。
    // Let partial saves update only provided fields so sync metadata writes do not clear other user settings.
    if (Object.hasOwn(nextSettingsSource, field.key)) return field.normalize(nextSettingsSource[field.key], nextSettingsSource, rawSettings);
    if (field.preserveOnPartialSave !== false && Object.hasOwn(rawSettings, field.key)) return field.normalize(rawSettings[field.key], rawSettings, defaultSettings);
    return field.normalize(defaultSettings[field.key], rawSettings, defaultSettings);
  }

  function applySettingOverride(settings, field, value) {
    // 这一段只保存偏离默认值的字段，默认值会从本机存储中删除以减少迁移负担。
    // Store only values that differ from defaults, deleting default values from local storage to reduce migration load.
    if (areSettingValuesEqual(field, value, defaultSettings[field.key])) {
      delete settings[field.key];
      return;
    }
    settings[field.key] = value;
  }

  function getSettings() {
    // 这一段把默认配置和用户覆盖配置合并，外部系统只读取稳定字段。
    // Merge default settings with user overrides so other systems only consume stable fields.
    return getNormalizedSettingsFromSource(readRawSettings());
  }

  function getModifiedState() {
    // 这一段按“是否存在有效用户覆盖值”判断设置项是否偏离默认配置。
    // Determine whether each setting differs from defaults by checking valid user overrides.
    return getModifiedStateFromSource(readRawSettings(), { requireOwn: true });
  }

  function getDraftModifiedState(nextSettings) {
    // 这一段按表单当前草稿值判断设置项是否偏离默认配置，用于通用蓝色修改标记。
    // Determine whether current draft values differ from defaults for the generic blue modified marker.
    return getModifiedStateFromSource(nextSettings, { requireOwn: false });
  }

  function saveSettings(nextSettings) {
    // 这一段只保留不同于默认值的用户覆盖项，让默认项不会写入本地存储。
    // Keep only user overrides that differ from defaults so default values are not stored locally.
    const rawSettings = readRawSettings();
    const nextSettingsSource = getSourceObject(nextSettings);
    const savedCloudSyncKey = normalizeCloudSyncKey(getSettingSourceValue({ key: "cloudSyncKey" }, rawSettings));
    const nextCloudSyncKey = Object.hasOwn(nextSettingsSource, "cloudSyncKey")
      ? normalizeCloudSyncKey(nextSettingsSource.cloudSyncKey)
      : savedCloudSyncKey;
    const cloudSyncKeyChanged = nextCloudSyncKey !== savedCloudSyncKey;
    const settings = { ...rawSettings };
    const normalizedSettings = {};
    for (const field of settingFields) {
      // 这一段在同步密钥变化时丢弃旧密钥的本机同步基线，避免新密钥首次上传误报云端更新。
      // Drop local sync baselines when the sync key changes so first uploads for a new key do not inherit stale revisions.
      const value = cloudSyncKeyChanged && cloudSyncKeyScopedMetadataKeys.has(field.key)
        ? field.normalize(defaultSettings[field.key])
        : getSaveValue(field, nextSettingsSource, rawSettings);
      normalizedSettings[field.key] = value;
      applySettingOverride(settings, field, value);
    }
    if (normalizedSettings.chatWidthMode === "official" && Object.hasOwn(nextSettingsSource, "chatWidthMode")) {
      // 这一段在用户明确回到官方默认时清掉 px 覆盖，避免旧自定义宽度在下次启动时复活。
      // Clear the pixel override when the user explicitly returns to native width so old custom widths cannot revive.
      normalizedSettings.chatWidthPixels = defaultSettings.chatWidthPixels;
      delete settings.chatWidthPixels;
    }
    writeRawSettings(settings);
    runtime.i18n?.setLocale?.(normalizedSettings.uiLanguage);

    // 这一段同步通知当前页面内的订阅者，让保存后的设置立即生效。
    // Notify same-page subscribers so saved settings take effect immediately.
    for (const listener of listeners) {
      try {
        listener(normalizedSettings);
      } catch (error) {
        console.warn("[Codex-Pro] settings listener failed", error);
      }
    }
    return normalizedSettings;
  }

  function subscribe(listener, signal) {
    // 这一段登记轻量订阅，并在系统销毁时自动解除，避免重复注入泄漏监听。
    // Register a lightweight subscriber and auto-remove it on system teardown to avoid reinjection leaks.
    listeners.add(listener);
    signal?.addEventListener(
      "abort",
      () => {
        listeners.delete(listener);
      },
      { once: true },
    );

    // 这一段返回手动取消函数，方便调用方在自己的生命周期中清理。
    // Return a manual unsubscribe function so callers can clean up within their lifecycle.
    return () => listeners.delete(listener);
  }

  settingsMenu.settings = {
    defaultSettings,
    getDraftModifiedState,
    getModifiedState,
    getSettings,
    maxBackgroundWallpaperImagesLength,
    maxBackgroundWallpaperOpacity,
    maxChatWidthPixels,
    maxCloudSyncEndpointLength,
    maxCloudSyncKeyLength,
    maxConversationArchiveDisplayNameLength,
    maxDiffHoverPreviewFontSize,
    maxExternalDiffToolPathLength,
    maxHiddenFileTreePatternsLength,
    maxPetEventSoundCooldownMs,
    maxPetEventSoundPathLength,
    maxPetEventSoundVolume,
    maxUsagePanelPingEndpointLength,
    maxContextUsageDecimalPlaces,
    maxContextUsageRingThreshold,
    minBackgroundWallpaperIntervalSeconds,
    minBackgroundWallpaperOpacity,
    minChatWidthPixels,
    minContextUsageDecimalPlaces,
    minContextUsageRingThreshold,
    minDiffHoverPreviewFontSize,
    minPetEventSoundCooldownMs,
    minPetEventSoundVolume,
    minUsagePanelPingRefreshSeconds,
    minUsageRefreshSeconds,
    mouseGestureShortcutCodes,
    normalizeMouseGestureShortcut,
    petEventSoundStateIds,
    petEventSoundStateIdSet,
    saveSettings,
    settingFields: publicSettingFields,
    subscribe,
    supportedUiLanguages: Array.from(supportedUiLanguages),
  };
  runtime.i18n?.setLocale?.(getSettings().uiLanguage);
})();
