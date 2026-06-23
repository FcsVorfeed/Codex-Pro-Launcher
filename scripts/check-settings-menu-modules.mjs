import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";

import {
  buildPetEventSoundOverlayModulePaths,
  buildInjectionModulePaths,
  coreInjectionModulePaths,
  settingsMenuBuiltinSectionModules,
  settingsMenuSectionModules,
} from "../src/launcher/injection-manifest.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const viewPath = path.join(rootDir, "src", "inject", "systems", "settings-menu", "view.js");
const i18nPath = path.join(rootDir, "src", "inject", "core", "i18n.js");
const dialogsPath = path.join(rootDir, "src", "inject", "core", "dialogs.js");
const registryPath = path.join(rootDir, "src", "inject", "systems", "settings-menu", "section-registry.js");
const formBindingPath = path.join(rootDir, "src", "inject", "systems", "settings-menu", "form-binding.js");
const cloudSyncPath = path.join(rootDir, "src", "inject", "systems", "settings-menu", "cloud-sync.js");
const petSyncPath = path.join(rootDir, "src", "inject", "systems", "pet-sync", "index.js");
const conversationArchivePath = path.join(rootDir, "src", "inject", "systems", "conversation-archive", "index.js");
const rustCloudSyncPath = path.join(rootDir, "crates", "codex-pro-bridge", "src", "handlers", "cloud_sync.rs");
const rustSyncLicensePath = path.join(rootDir, "crates", "codex-pro-bridge", "src", "handlers", "sync_license.rs");

const expectedBuiltinSections = [
  {
    id: "language",
    modulePath: ["src", "inject", "systems", "settings-menu", "sections", "language.js"],
    settingKeys: ["uiLanguage"],
  },
  {
    id: "cloud-sync",
    modulePath: ["src", "inject", "systems", "settings-menu", "sections", "cloud-sync.js"],
    requiresBind: true,
    fieldDependencies: {
      conversationArchiveSidebarDirectoryPanelMode: "enableConversationArchiveSidebar",
      conversationArchiveSidebarPanelMode: "enableConversationArchiveSidebar",
    },
    settingKeys: [
      "cloudSyncKey",
      "enableCloudSettingsSync",
      "enableConversationArchiveSync",
      "conversationArchiveDeviceName",
      "conversationArchiveProfileName",
      "enableConversationArchiveSidebar",
      "conversationArchiveSidebarDirectoryPanelMode",
      "conversationArchiveSidebarPanelMode",
    ],
  },
  {
    id: "background-wallpaper",
    modulePath: ["src", "inject", "systems", "settings-menu", "sections", "background-wallpaper.js"],
    settingKeys: [
      "enableBackgroundWallpaper",
      "backgroundWallpaperImages",
      "backgroundWallpaperIntervalSeconds",
      "backgroundWallpaperOpacity",
      "backgroundWallpaperPosition",
      "backgroundWallpaperRandom",
      "backgroundWallpaperSize",
    ],
    fieldDependencies: {
      backgroundWallpaperImages: "enableBackgroundWallpaper",
      backgroundWallpaperIntervalSeconds: "enableBackgroundWallpaper",
      backgroundWallpaperOpacity: "enableBackgroundWallpaper",
      backgroundWallpaperPosition: "enableBackgroundWallpaper",
      backgroundWallpaperRandom: "enableBackgroundWallpaper",
      backgroundWallpaperSize: "enableBackgroundWallpaper",
    },
  },
  {
    id: "diff-hover",
    modulePath: ["src", "inject", "systems", "settings-menu", "sections", "diff-hover.js"],
    settingKeys: [
      "enableDiffHoverPreview",
      "diffHoverFileOpenMode",
      "diffHoverPreviewFontSize",
      "enableExternalDiffMiddleClick",
      "enableEditedFileCardExternalDiffMiddleClick",
      "externalDiffToolPath",
    ],
    fieldDependencies: {
      diffHoverFileOpenMode: "enableDiffHoverPreview",
      diffHoverPreviewFontSize: "enableDiffHoverPreview",
      enableExternalDiffMiddleClick: "enableDiffHoverPreview",
      enableEditedFileCardExternalDiffMiddleClick: "enableDiffHoverPreview",
      externalDiffToolPath: "enableDiffHoverPreview",
    },
  },
  {
    id: "mouse-gestures",
    modulePath: ["src", "inject", "systems", "settings-menu", "sections", "mouse-gestures.js"],
    requiresBind: true,
    settingKeys: ["enableMouseGestures", "mouseGestureShortcuts"],
  },
];

const expectedCloudSyncBlocks = [
  {
    id: "pet-sync",
    modulePath: ["src", "inject", "systems", "settings-menu", "sections", "pet-sync.js"],
    requiresBind: true,
    settingKeys: [],
  },
  {
    id: "conversation-archive",
    modulePath: ["src", "inject", "systems", "settings-menu", "sections", "conversation-archive.js"],
    settingKeys: [
      "enableConversationArchiveSync",
      "conversationArchiveDeviceName",
      "conversationArchiveProfileName",
    ],
  },
  {
    id: "conversation-archive-sidebar",
    modulePath: ["src", "inject", "systems", "conversation-archive-sidebar", "settings.js"],
    ownerSystem: "conversation-archive-sidebar",
    fieldDependencies: {
      conversationArchiveSidebarDirectoryPanelMode: "enableConversationArchiveSidebar",
      conversationArchiveSidebarPanelMode: "enableConversationArchiveSidebar",
    },
    settingKeys: [
      "enableConversationArchiveSidebar",
      "conversationArchiveSidebarDirectoryPanelMode",
      "conversationArchiveSidebarPanelMode",
    ],
  },
];

const expectedSections = [
  {
    id: "startup-sidebar",
    modulePath: ["src", "inject", "systems", "startup-sidebar", "settings.js"],
    ownerSystem: "startup-sidebar",
    settingKeys: ["enableStartupSidebar", "collapseSidebarOnStartup"],
    fieldDependencies: {
      collapseSidebarOnStartup: "enableStartupSidebar",
    },
  },
  {
    id: "usage-panel",
    modulePath: ["src", "inject", "systems", "usage-panel", "settings.js"],
    ownerSystem: "usage-panel",
    settingKeys: [
      "enableUsagePanel",
      "showUsageInLowerLeftPanel",
      "showUsageInEnvironmentPanel",
      "showUsagePanelTokenDetails",
      "showUsagePanelTotalInputTokens",
      "showUsagePanelPing",
      "usagePanelPingEndpoint",
      "usagePanelPingRefreshSeconds",
      "usagePanelTodayTokenSource",
      "usagePanelAdaptiveWidth",
      "usageRefreshSeconds",
    ],
    fieldDependencies: {
      showUsageInLowerLeftPanel: "enableUsagePanel",
      showUsageInEnvironmentPanel: "enableUsagePanel",
      showUsagePanelTokenDetails: "enableUsagePanel",
      showUsagePanelTotalInputTokens: ["enableUsagePanel", "showUsagePanelTokenDetails"],
      showUsagePanelPing: "enableUsagePanel",
      usagePanelPingEndpoint: ["enableUsagePanel", "showUsagePanelPing"],
      usagePanelPingRefreshSeconds: ["enableUsagePanel", "showUsagePanelPing"],
      usagePanelTodayTokenSource: "enableUsagePanel",
      usagePanelAdaptiveWidth: ["enableUsagePanel", "showUsageInLowerLeftPanel"],
      usageRefreshSeconds: "enableUsagePanel",
    },
  },
  {
    id: "context-usage",
    modulePath: ["src", "inject", "systems", "context-usage-inline", "settings.js"],
    ownerSystem: "context-usage-inline",
    settingKeys: ["enableContextUsageInline", "showContextUsageInline", "contextUsageDecimalPlaces"],
    fieldDependencies: {
      contextUsageDecimalPlaces: ["enableContextUsageInline", "showContextUsageInline"],
      showContextUsageInline: "enableContextUsageInline",
    },
  },
  {
    id: "chat-width-resizer",
    modulePath: ["src", "inject", "systems", "chat-width-resizer", "settings.js"],
    ownerSystem: "chat-width-resizer",
    settingKeys: ["enableChatWidthResizer", "chatWidthMode", "chatWidthPixels"],
    hiddenSettingKeys: ["chatWidthMode", "chatWidthPixels"],
    modifiedSettingKeys: ["enableChatWidthResizer"],
  },
  {
    id: "file-tree",
    modulePath: ["src", "inject", "systems", "file-tree-filter", "settings.js"],
    ownerSystem: "file-tree-filter",
    settingKeys: ["enableFileTreeFilter", "hiddenFileTreePatterns"],
    fieldDependencies: {
      hiddenFileTreePatterns: "enableFileTreeFilter",
    },
  },
  {
    id: "file-tree-active-reveal",
    modulePath: ["src", "inject", "systems", "file-tree-active-reveal", "settings.js"],
    ownerSystem: "file-tree-active-reveal",
    settingKeys: ["enableFileTreeActiveReveal"],
  },
  {
    id: "tab-drag-to-chat",
    modulePath: ["src", "inject", "systems", "tab-drag-to-chat", "settings.js"],
    ownerSystem: "tab-drag-to-chat",
    settingKeys: ["enableTabDragToChat"],
  },
  {
    id: "native-thread-drag-to-chat",
    modulePath: ["src", "inject", "systems", "native-thread-drag-to-chat", "settings.js"],
    ownerSystem: "native-thread-drag-to-chat",
    settingKeys: ["enableNativeThreadDragToChat"],
    fieldDependencies: {
      enableNativeThreadDragToChat: "enableTabDragToChat",
    },
  },
  {
    id: "performance-fixes",
    modulePath: ["src", "inject", "systems", "performance-fixes", "settings.js"],
    ownerSystem: "split-items-hotpath-patch",
    settingKeys: ["enableSplitItemsHotpathPatch"],
    modifiedSettingKeys: ["enableSplitItemsHotpathPatch"],
  },
  {
    id: "update-check",
    modulePath: ["src", "inject", "systems", "update-check", "settings.js"],
    ownerSystem: "update-check",
    requiresBind: true,
    settingKeys: [],
  },
  {
    id: "pet-status",
    modulePath: ["src", "inject", "systems", "settings-menu", "sections", "pet-status.js"],
    ownerSystem: "pet-event-sounds",
    requiresBind: true,
    settingKeys: ["enablePetEventSounds", "petEventSoundCooldownMs", "petEventSoundPaths", "petEventSoundVolumes"],
  },
];

function pathFromParts(parts) {
  // 这一段把注入清单路径转换为当前系统可读取的文件路径。
  // Convert manifest path entries into readable file paths for this system.
  return path.join(rootDir, ...parts);
}

function pathId(parts) {
  // 这一段生成和 launcher 诊断一致的注入路径文本，方便检查实际构建顺序。
  // Build the same injection path text used by launcher diagnostics so actual build order can be checked.
  return parts.join("/");
}

async function assertFileExists(filePath) {
  // 这一段确认目标文件已经落盘，避免注入清单指向不存在的模块。
  // Confirm the target file exists so the injection manifest cannot point at a missing module.
  const stats = await stat(filePath);
  if (!stats.isFile()) {
    throw new Error(`${path.relative(rootDir, filePath)} is not a file`);
  }
}

function assert(condition, message) {
  // 这一段用明确错误终止测试，方便定位设置分区拆分问题。
  // Fail with explicit messages so settings section split issues are easy to locate.
  if (!condition) throw new Error(message);
}

function assertBeforeInList(paths, firstNeedle, secondNeedle) {
  // 这一段确认 buildInjectionModulePaths 的实际输出顺序，不只依赖源码字符串顺序。
  // Confirm the actual buildInjectionModulePaths output order instead of relying only on source string order.
  const firstIndex = paths.indexOf(firstNeedle);
  const secondIndex = paths.indexOf(secondNeedle);
  if (firstIndex < 0) throw new Error(`Missing injection module: ${firstNeedle}`);
  if (secondIndex < 0) throw new Error(`Missing injection module: ${secondNeedle}`);
  if (firstIndex > secondIndex) {
    throw new Error(`${firstNeedle} must load before ${secondNeedle}`);
  }
}

function assertBeforeInSource(source, firstNeedle, secondNeedle, label) {
  // 这一段确认源码内 UI 选项顺序，避免设置下拉显示顺序回退。
  // Confirm UI option order in source so setting dropdown order does not regress.
  const firstIndex = source.indexOf(firstNeedle);
  const secondIndex = source.indexOf(secondNeedle);
  if (firstIndex < 0) throw new Error(`Missing ${label}: ${firstNeedle}`);
  if (secondIndex < 0) throw new Error(`Missing ${label}: ${secondNeedle}`);
  if (firstIndex > secondIndex) {
    throw new Error(`${label} must appear before ${secondNeedle}`);
  }
}

function createSettingsApi() {
  // 这一段提供渲染设置分区需要的最小设置 API，避免测试依赖浏览器页面。
  // Provide the minimal settings API needed to render settings sections without a browser page.
  return {
    defaultSettings: {
      cloudSyncEndpoint: "https://example.com/settings",
      conversationArchiveEndpoint: "https://example.com/archive",
      petSyncEndpoint: "https://example.com/pets",
      uiLanguage: "en-US",
    },
    maxBackgroundWallpaperImagesLength: 5000,
    maxBackgroundWallpaperOpacity: 1,
    maxCloudSyncEndpointLength: 500,
    maxCloudSyncKeyLength: 256,
    maxConversationArchiveDisplayNameLength: 80,
    maxDiffHoverPreviewFontSize: 32,
    maxExternalDiffToolPathLength: 1000,
    maxChatWidthPixels: 2200,
    maxPetEventSoundCooldownMs: 5000,
    maxPetEventSoundPathLength: 1000,
    maxPetEventSoundVolume: 100,
    minBackgroundWallpaperIntervalSeconds: 5,
    minBackgroundWallpaperOpacity: 0,
    minChatWidthPixels: 560,
    minDiffHoverPreviewFontSize: 8,
    minPetEventSoundCooldownMs: 0,
    minPetEventSoundVolume: 0,
    minUsageRefreshSeconds: 5,
    minContextUsageDecimalPlaces: 0,
    maxContextUsageDecimalPlaces: 2,
    maxHiddenFileTreePatternsLength: 5000,
    petEventSoundStateIds: [
      "idle",
      "waving",
      "running",
      "waiting",
      "failed",
      "review",
      "jumping",
      "running-left",
      "running-right",
    ],
  };
}

function extractStringList(source, name) {
  // 这一段从设置同步白名单源码里提取字符串列表，让页面、native 和云函数白名单可以自动比对。
  // Extract string lists from sync allow-list source so page, native, and cloud function lists can be compared automatically.
  const declarationPattern = new RegExp(`const\\s+${name}\\s*=\\s*(?:new\\s+Set\\()?\\s*\\[([\\s\\S]*?)\\]`, "u");
  const match = source.match(declarationPattern);
  assert(match, `Missing string list declaration: ${name}`);
  return Array.from(match[1].matchAll(/"([^"]+)"/gu), (entry) => entry[1]);
}

function extractRustStringList(source, name) {
  // 这一段从 Rust 新架构源码里提取字符串列表，避免检查仍只覆盖旧 Node bridge。
  // Extract string lists from the Rust new-architecture source so checks no longer cover only the old Node bridge.
  const declarationPattern = new RegExp(`fn\\s+${name}\\s*\\([\\s\\S]*?\\{[\\s\\S]*?\\[([\\s\\S]*?)\\]\\s*\\.into_iter\\(\\)`, "u");
  const match = source.match(declarationPattern);
  assert(match, `Missing Rust string list declaration: ${name}`);
  return Array.from(match[1].matchAll(/"([^"]+)"/gu), (entry) => entry[1]);
}

function assertSameStringList(actual, expected, label) {
  // 这一段要求同步白名单顺序和值完全一致，避免新增设置时不同通道静默漂移。
  // Require sync allow-lists to match in order and value so new settings cannot drift silently across channels.
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${label} must match settings-menu cloud sync allow-list`,
  );
}

function assertSameObject(actual, expected, label) {
  // 这一段用稳定 JSON 比较声明式对象，字段依赖顺序由代码约定保持可读。
  // Compare declarative objects with stable JSON; dependency order is kept readable by convention.
  assert(JSON.stringify(actual || {}) === JSON.stringify(expected || {}), `${label} mismatch`);
}

async function runModuleInContext(filePath, context) {
  // 这一段在 VM 中按注入顺序执行模块，验证注册逻辑本身而不是只做字符串探针。
  // Execute modules in injection order inside a VM so registration logic is verified, not only source strings.
  const source = await readFile(filePath, "utf8");
  vm.runInContext(source, context, { filename: filePath });
}

async function fileExists(filePath) {
  // 这一段让私有服务端源码检查在公开仓库缺少 private 内容时自动跳过。
  // Let private server-source checks skip automatically when the public checkout has no private content.
  try {
    const stats = await stat(filePath);
    return stats.isFile();
  } catch {
    return false;
  }
}

function createFakeControl(properties = {}) {
  // 这一段创建最小表单控件替身，用于在 Node VM 外验证共享表单绑定行为。
  // Create a minimal form-control stand-in for validating shared form binding outside a browser VM.
  const listeners = new Map();
  const { field = null, ...controlProperties } = properties;
  return {
    addEventListener(type, handler) {
      const handlers = listeners.get(type) || [];
      handlers.push(handler);
      listeners.set(type, handlers);
    },
    async dispatch(type, event = {}) {
      for (const handler of listeners.get(type) || []) await handler({ target: this, ...event });
    },
    dataset: {},
    disabled: false,
    closest(selector) {
      return selector === "[data-codex-pro-setting-key]" ? field : null;
    },
    tagName: "INPUT",
    type: "text",
    value: "",
    ...controlProperties,
  };
}

function createFakeSettingField() {
  // 这一段创建最小设置行替身，用来验证 disabled 视觉标记不会和控件状态脱节。
  // Create a minimal settings-row stand-in so disabled visual markers stay coupled to control state.
  return {
    attributes: {},
    dataset: {},
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    },
  };
}

function assertFormBindingBehavior(formBinding) {
  // 这一段执行共享表单绑定的核心行为测试，确保缺失 DOM 字段保留当前设置值。
  // Execute the core shared-form behavior test so missing DOM fields keep current settings values.
  const fakeSettings = {
    getSettings() {
      return {
        cloudSyncRevision: 7,
        showUsageInLowerLeftPanel: true,
        showUsagePanelTokenDetails: true,
        showUsagePanelTotalInputTokens: false,
        showUsagePanelPing: true,
        usagePanelPingEndpoint: "https://status.openai.com/api/v2/status.json",
        usagePanelPingRefreshSeconds: 10,
        usagePanelTodayTokenSource: "observer",
        enableUsagePanel: true,
        chatWidthMode: "custom",
        chatWidthPixels: 1320,
        mouseGestureShortcuts: { L: "Ctrl+L" },
        usagePanelAdaptiveWidth: false,
        usageRefreshSeconds: 30,
      };
    },
    settingFields: [
      { key: "enableUsagePanel" },
      { key: "showUsageInLowerLeftPanel" },
      { key: "showUsagePanelTokenDetails" },
      { key: "showUsagePanelTotalInputTokens" },
      { key: "showUsagePanelPing" },
      { key: "usagePanelPingEndpoint" },
      { key: "usagePanelPingRefreshSeconds" },
      { key: "usagePanelTodayTokenSource" },
      { key: "usagePanelAdaptiveWidth" },
      { key: "usageRefreshSeconds" },
      { key: "chatWidthMode" },
      { key: "chatWidthPixels" },
      { key: "cloudSyncRevision" },
      { key: "mouseGestureShortcuts" },
    ],
  };
  const fakeForm = {
    elements: {
      enableUsagePanel: createFakeControl({ checked: true, type: "checkbox" }),
      showUsageInLowerLeftPanel: createFakeControl({
        checked: true,
        field: createFakeSettingField(),
        type: "checkbox",
      }),
      showUsagePanelTokenDetails: createFakeControl({
        checked: true,
        field: createFakeSettingField(),
        type: "checkbox",
      }),
      showUsagePanelTotalInputTokens: createFakeControl({
        checked: false,
        field: createFakeSettingField(),
        type: "checkbox",
      }),
      showUsagePanelPing: createFakeControl({
        checked: true,
        field: createFakeSettingField(),
        type: "checkbox",
      }),
      usagePanelPingEndpoint: createFakeControl({
        field: createFakeSettingField(),
        type: "url",
        value: "https://example.com/ping",
      }),
      usagePanelPingRefreshSeconds: createFakeControl({
        field: createFakeSettingField(),
        type: "number",
        value: "20",
      }),
      usagePanelTodayTokenSource: createFakeControl({
        field: createFakeSettingField(),
        tagName: "SELECT",
        type: "select-one",
        value: "observer",
      }),
      usagePanelAdaptiveWidth: createFakeControl({
        checked: false,
        field: createFakeSettingField(),
        type: "checkbox",
      }),
      usageRefreshSeconds: createFakeControl({
        field: createFakeSettingField(),
        type: "number",
        value: "45",
      }),
    },
  };
  fakeForm.elements.usageRefreshSeconds.disabled = true;
  const draftSettings = formBinding.readDraftSettings({ form: fakeForm, settings: fakeSettings });
  assert(draftSettings.enableUsagePanel === true, "form-binding must read checkbox fields");
  assert(draftSettings.showUsageInLowerLeftPanel === true, "form-binding must read dependent checkbox fields");
  assert(draftSettings.showUsagePanelTokenDetails === true, "form-binding must read token-detail checkbox fields");
  assert(draftSettings.showUsagePanelTotalInputTokens === false, "form-binding must read input-token total checkbox fields");
  assert(draftSettings.showUsagePanelPing === true, "form-binding must read Ping checkbox fields");
  assert(draftSettings.usagePanelPingEndpoint === "https://example.com/ping", "form-binding must read Ping endpoint fields");
  assert(draftSettings.usagePanelPingRefreshSeconds === "20", "form-binding must read Ping interval fields");
  assert(draftSettings.usagePanelTodayTokenSource === "observer", "form-binding must read Today token source select fields");
  assert(draftSettings.usagePanelAdaptiveWidth === false, "form-binding must read multi-dependent checkbox fields");
  assert(draftSettings.usageRefreshSeconds === "45", "form-binding must read normal value fields");
  assert(draftSettings.usageRefreshSeconds === "45", "form-binding must read disabled controls so saves do not drop values");
  assert(draftSettings.cloudSyncRevision === 7, "form-binding must preserve missing DOM fields from current settings");
  assert(
    draftSettings.mouseGestureShortcuts?.L === "Ctrl+L",
    "form-binding must leave mouseGestureShortcuts to the mouse gesture section",
  );
  assert(draftSettings.chatWidthMode === "custom", "form-binding must preserve hidden chat width mode fields");
  assert(draftSettings.chatWidthPixels === 1320, "form-binding must preserve hidden chat width pixel fields");

  formBinding.writeSettingsToForm({
    currentSettings: {
      cloudSyncRevision: 9,
      enableUsagePanel: true,
      chatWidthMode: "official",
      chatWidthPixels: 1100,
      mouseGestureShortcuts: { L: "" },
      showUsageInLowerLeftPanel: true,
      showUsagePanelTokenDetails: true,
      showUsagePanelTotalInputTokens: false,
      showUsagePanelPing: true,
      usagePanelPingEndpoint: "https://status.openai.com/api/v2/status.json",
      usagePanelPingRefreshSeconds: 10,
      usagePanelTodayTokenSource: "official",
      usagePanelAdaptiveWidth: false,
      usageRefreshSeconds: 15,
    },
    form: fakeForm,
    settings: fakeSettings,
  });
  assert(fakeForm.elements.enableUsagePanel.checked === true, "form-binding must write checkbox fields");
  assert(fakeForm.elements.showUsagePanelTotalInputTokens.checked === false, "form-binding must write input-token total checkbox fields");
  assert(fakeForm.elements.showUsagePanelPing.checked === true, "form-binding must write Ping checkbox fields");
  assert(fakeForm.elements.usagePanelPingEndpoint.value === "https://status.openai.com/api/v2/status.json", "form-binding must write Ping endpoint fields");
  assert(fakeForm.elements.usagePanelPingRefreshSeconds.value === "10", "form-binding must write Ping interval fields");
  assert(fakeForm.elements.usagePanelTodayTokenSource.value === "official", "form-binding must write Today token source select fields");
  assert(fakeForm.elements.usageRefreshSeconds.value === "15", "form-binding must write normal value fields");
  formBinding.applyFieldDependencyState({ form: fakeForm });
  assert(fakeForm.elements.showUsagePanelTotalInputTokens.disabled === false, "form-binding must enable token subfields when dependencies pass");
  assert(fakeForm.elements.showUsagePanelPing.disabled === false, "form-binding must enable Ping fields when dependencies pass");
  assert(fakeForm.elements.usagePanelPingEndpoint.disabled === false, "form-binding must enable Ping endpoint fields when dependencies pass");
  assert(fakeForm.elements.usagePanelPingRefreshSeconds.disabled === false, "form-binding must enable Ping interval fields when dependencies pass");
  assert(fakeForm.elements.usagePanelTodayTokenSource.disabled === false, "form-binding must enable Today token source when dependencies pass");
  assert(fakeForm.elements.usageRefreshSeconds.disabled === false, "form-binding must enable fields when dependencies pass");
  assert(
    fakeForm.elements.usageRefreshSeconds.closest("[data-codex-pro-setting-key]").dataset.codexProDisabled === "false",
    "form-binding must clear the row-level disabled marker when dependencies pass",
  );
  assert(fakeForm.elements.usagePanelAdaptiveWidth.disabled === false, "form-binding must enable multi-dependent fields when all dependencies pass");
  fakeForm.elements.showUsagePanelTokenDetails.checked = false;
  formBinding.applyFieldDependencyState({ form: fakeForm });
  assert(fakeForm.elements.showUsagePanelTotalInputTokens.disabled === true, "form-binding must disable token subfields when token details are hidden");
  fakeForm.elements.showUsagePanelTokenDetails.checked = true;
  fakeForm.elements.showUsagePanelPing.checked = false;
  formBinding.applyFieldDependencyState({ form: fakeForm });
  assert(fakeForm.elements.usagePanelPingEndpoint.disabled === true, "form-binding must disable Ping endpoint fields when Ping is hidden");
  assert(fakeForm.elements.usagePanelPingRefreshSeconds.disabled === true, "form-binding must disable Ping interval fields when Ping is hidden");
  fakeForm.elements.showUsagePanelPing.checked = true;
  fakeForm.elements.showUsageInLowerLeftPanel.checked = false;
  formBinding.applyFieldDependencyState({ form: fakeForm });
  assert(fakeForm.elements.usagePanelAdaptiveWidth.disabled === true, "form-binding must disable multi-dependent fields when a secondary dependency fails");
  fakeForm.elements.showUsageInLowerLeftPanel.checked = true;
  fakeForm.elements.enableUsagePanel.checked = false;
  formBinding.applyFieldDependencyState({ form: fakeForm });
  assert(fakeForm.elements.usageRefreshSeconds.disabled === true, "form-binding must disable fields when dependencies fail");
  assert(fakeForm.elements.showUsagePanelPing.disabled === true, "form-binding must disable Ping fields when dependencies fail");
  assert(fakeForm.elements.usagePanelPingEndpoint.disabled === true, "form-binding must disable Ping endpoint fields when dependencies fail");
  assert(fakeForm.elements.usagePanelPingRefreshSeconds.disabled === true, "form-binding must disable Ping interval fields when dependencies fail");
  assert(fakeForm.elements.usagePanelTodayTokenSource.disabled === true, "form-binding must disable Today token source when dependencies fail");
  assert(
    fakeForm.elements.showUsagePanelPing.closest("[data-codex-pro-setting-key]").dataset.codexProDisabled === "true",
    "form-binding must set the row-level disabled marker when dependencies fail",
  );
  assert(
    fakeForm.elements.showUsagePanelPing.closest("[data-codex-pro-setting-key]").attributes["aria-disabled"] === "true",
    "form-binding must expose row disabled state to accessibility APIs",
  );
  assert(fakeForm.elements.usagePanelAdaptiveWidth.disabled === true, "form-binding must disable multi-dependent fields when the primary dependency fails");
}

function createSectionBindContext(settingsMenu, sectionId, overrides = {}) {
  // 这一段为复杂内置 section 构造最小 bind(context)，只验证元数据读写 hook 是否注册和工作。
  // Build a minimal bind(context) for complex builtin sections, validating only metadata hook registration and behavior.
  const controls = new Map();
  const getControl = (selector, properties = {}) => {
    if (!controls.has(selector)) controls.set(selector, createFakeControl(properties));
    return controls.get(selector);
  };
  const root = {
    querySelector(selector) {
      return controls.get(selector) || null;
    },
    querySelectorAll() {
      return [];
    },
  };
  const context = {
    addDialogOpenHandler(handler) {
      context.dialogOpenHandlers.push(handler);
    },
    addDraftSettingsReader(reader) {
      context.draftReaders.push(reader);
    },
    addModifiedStateRenderer() {},
    addSettingsWriter(writer) {
      context.settingsWriters.push(writer);
    },
    dialogOpenHandlers: [],
    draftReaders: [],
    form: { elements: {} },
    readDraftSettings() {
      return {};
    },
    registerAfterSaveHandler(handler) {
      context.afterSaveHandlers.push(handler);
    },
    afterSaveHandlers: [],
    controls,
    renderModifiedState() {},
    root,
    runtime: windowObject.__codexProRuntime,
    saveAndRefreshSettings: overrides.saveAndRefreshSettings || (() => ({})),
    settings: overrides.settings || {
      defaultSettings: {
        chatWidthPixels: 1100,
        cloudSyncLastSyncAt: "",
        cloudSyncRevision: 0,
        conversationArchiveLastSyncAt: "",
        conversationArchiveRevision: 0,
        petSyncLastSyncAt: "",
        petSyncRevision: 0,
      },
    },
    settingsWriters: [],
    signal: undefined,
    writeSettingsToForm: overrides.writeSettingsToForm || (() => {}),
  };

  if (sectionId === "cloud-sync") {
    settingsMenu.cloudSync = {
      getSyncLicenseGate() {
        return {
          canSync: true,
          message: "",
          status: "unknown",
          tone: "",
        };
      },
      openKeyAcquisitionPage() {},
      pullSettings() {},
      pushSettings() {},
      requestSyncLicenseValidation() {},
      resetSyncLicenseState() {},
      syncLicenseStatusEventName: "codex-pro:sync-license-status",
      validateSyncLicense() {},
      ...overrides.cloudSync,
    };
    settingsMenu.settings = context.settings;
    context.form.elements.cloudSyncKey = createFakeControl({ type: "password" });
    getControl("[data-codex-pro-cloud-sync-get-key]");
    getControl("[data-codex-pro-cloud-sync-validate-key]");
    getControl("[data-codex-pro-cloud-sync-upload]");
    getControl("[data-codex-pro-cloud-sync-download]");
    getControl("[data-codex-pro-cloud-sync-status]");
    windowObject.__codexProRuntime.systemModules.petSync = {};
    getControl("[data-codex-pro-pet-sync-upload]");
    getControl("[data-codex-pro-pet-sync-download]");
    getControl("[data-codex-pro-pet-sync-status]");
  }
  return context;
}

async function flushMicrotasks() {
  // 这一段给 click handler 内部的 async 下载流程让出微任务队列。
  // Yield to the microtask queue used by async download handlers.
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

function assertMetadataSectionBind(settingsMenu, sectionId, expectedPatch) {
  // 这一段验证复杂同步分区会向 view shell 注册元数据 reader/writer，避免保存时丢失同步版本。
  // Verify complex sync sections register metadata reader/writer hooks so saves do not drop sync versions.
  const section = settingsMenu.sections.find((candidate) => candidate.id === sectionId);
  const context = createSectionBindContext(settingsMenu, sectionId);
  section.bind(context);
  assert(context.draftReaders.length > 0, `${sectionId} must register a draft settings reader`);
  assert(context.settingsWriters.length > 0, `${sectionId} must register a settings writer`);
  for (const writer of context.settingsWriters) writer(expectedPatch);
  const draftPatch = Object.assign({}, ...context.draftReaders.map((reader) => reader({})));
  for (const [key, value] of Object.entries(expectedPatch)) {
    assert(draftPatch[key] === value, `${sectionId} must preserve ${key} through draft readers`);
  }
  if (sectionId === "cloud-sync") {
    assert(context.afterSaveHandlers.length > 0, "cloud-sync must register an after-save handler for automatic upload");
  }
}

await assertFileExists(registryPath);
await assertFileExists(formBindingPath);
await assertFileExists(i18nPath);
await assertFileExists(cloudSyncPath);
for (const section of expectedBuiltinSections) {
  await assertFileExists(pathFromParts(section.modulePath));
}

async function assertCloudSyncLegacyChatWidthDownload(settingsMenu) {
  // 这一段模拟云端旧格式下载，确保有效旧宽度迁移、坏旧宽度不误迁移。
  // Simulate legacy cloud downloads so valid widths migrate and invalid widths do not become custom.
  const section = settingsMenu.sections.find((candidate) => candidate.id === "cloud-sync");
  const savedPayloads = [];
  const currentSettings = {
    chatWidthMode: "official",
    chatWidthPixels: 1100,
    cloudSyncEndpoint: "https://example.com/settings",
    cloudSyncKey: "valid-sync-key-for-test",
    cloudSyncLastSyncAt: "",
    cloudSyncRevision: 0,
    enableCloudSettingsSync: false,
  };
  const settingsApi = {
    defaultSettings: {
      chatWidthPixels: 1100,
      cloudSyncLastSyncAt: "",
      cloudSyncRevision: 0,
    },
    getSettings() {
      return { ...currentSettings };
    },
    maxChatWidthPixels: 2200,
    minChatWidthPixels: 560,
    saveSettings(nextSettings) {
      savedPayloads.push(nextSettings);
      return { ...currentSettings, ...nextSettings };
    },
  };
  const context = createSectionBindContext(settingsMenu, "cloud-sync", {
    cloudSync: {
      async pullSettings() {
        return {
          exists: true,
          revision: 5,
          settings: { chatWidthPixels: 1320 },
          updatedAt: "2026-06-22T00:00:00.000Z",
        };
      },
    },
    saveAndRefreshSettings() {
      return { ...currentSettings };
    },
    settings: settingsApi,
  });
  section.bind(context);
  await context.controls.get("[data-codex-pro-cloud-sync-download]").dispatch("click");
  await flushMicrotasks();
  const validPayload = savedPayloads.at(-1);
  assert(validPayload.chatWidthMode === "custom", "legacy cloud width must migrate to custom mode");
  assert(validPayload.chatWidthPixels === 1320, "legacy cloud width must preserve the pulled width");

  savedPayloads.length = 0;
  const invalidContext = createSectionBindContext(settingsMenu, "cloud-sync", {
    cloudSync: {
      async pullSettings() {
        return {
          exists: true,
          revision: 6,
          settings: { chatWidthPixels: null },
          updatedAt: "2026-06-22T00:01:00.000Z",
        };
      },
    },
    saveAndRefreshSettings() {
      return { ...currentSettings };
    },
    settings: settingsApi,
  });
  section.bind(invalidContext);
  await invalidContext.controls.get("[data-codex-pro-cloud-sync-download]").dispatch("click");
  await flushMicrotasks();
  const invalidPayload = savedPayloads.at(-1);
  assert(invalidPayload.chatWidthMode === "official", "invalid legacy cloud width must keep native mode");
  assert(invalidPayload.chatWidthPixels === 1100, "invalid legacy cloud width must not force a custom width");
}
for (const block of expectedCloudSyncBlocks) {
  await assertFileExists(pathFromParts(block.modulePath));
}
for (const section of expectedSections) {
  await assertFileExists(pathFromParts(section.modulePath));
}

const viewSource = await readFile(viewPath, "utf8");
const i18nSource = await readFile(i18nPath, "utf8");
const dialogsSource = await readFile(dialogsPath, "utf8");
const formBindingSource = await readFile(formBindingPath, "utf8");
const cloudSyncSource = await readFile(cloudSyncPath, "utf8");
const petSyncSource = await readFile(petSyncPath, "utf8");
const conversationArchiveSource = await readFile(conversationArchivePath, "utf8");
const cloudSyncSectionSource = await readFile(pathFromParts(["src", "inject", "systems", "settings-menu", "sections", "cloud-sync.js"]), "utf8");
const petSyncSectionSource = await readFile(pathFromParts(["src", "inject", "systems", "settings-menu", "sections", "pet-sync.js"]), "utf8");
const conversationArchiveSectionSource = await readFile(pathFromParts(["src", "inject", "systems", "settings-menu", "sections", "conversation-archive.js"]), "utf8");
const usagePanelSettingsSource = await readFile(pathFromParts(["src", "inject", "systems", "usage-panel", "settings.js"]), "utf8");
const rustCloudSyncSource = await readFile(rustCloudSyncPath, "utf8");
const rustSyncLicenseSource = await readFile(rustSyncLicensePath, "utf8");
const requiredBindingGuard = viewSource.match(/if\s*\(\s*([\s\S]*?)\s*\)\s*\{\s*return;\s*\}\s*\n\s*\/\/ 这一段默认打开/u)?.[1] || "";
const injectionModulePaths = buildInjectionModulePaths([]).map(pathId);
const petOverlayModulePaths = buildPetEventSoundOverlayModulePaths([]).map(pathId);
const disabledSettingsMenuPaths = buildInjectionModulePaths(["settings-menu"]).map(pathId);
const coreInjectionModulePathIds = coreInjectionModulePaths.map(pathId);
const builtinSectionModulePaths = settingsMenuBuiltinSectionModules.map((module) => pathId(module.path));
const sectionModulePaths = settingsMenuSectionModules.map((module) => pathId(module.path));

assert(
  coreInjectionModulePathIds.includes(pathId(["src", "inject", "core", "i18n.js"])),
  "coreInjectionModulePaths must include the i18n core",
);
assert(
  coreInjectionModulePathIds.includes(pathId(["src", "inject", "core", "dialogs.js"])),
  "coreInjectionModulePaths must include the shared in-page dialog core",
);
const viewEntry = pathId(["src", "inject", "systems", "settings-menu", "view.js"]);
const registryEntry = pathId(["src", "inject", "systems", "settings-menu", "section-registry.js"]);
const formBindingEntry = pathId(["src", "inject", "systems", "settings-menu", "form-binding.js"]);
const cloudSyncSectionEntry = pathId(["src", "inject", "systems", "settings-menu", "sections", "cloud-sync.js"]);
assertBeforeInList(injectionModulePaths, pathId(["src", "inject", "core", "i18n.js"]), registryEntry);
assertBeforeInList(injectionModulePaths, pathId(["src", "inject", "core", "dialogs.js"]), registryEntry);
assertBeforeInList(injectionModulePaths, registryEntry, viewEntry);
assertBeforeInList(injectionModulePaths, registryEntry, formBindingEntry);
assertBeforeInList(injectionModulePaths, formBindingEntry, viewEntry);
assert(
  !injectionModulePaths.includes(pathId(["src", "inject", "systems", "settings-menu", "sections", "simple-sections.js"])),
  "settings-menu must not preload all simple sections from a central simple-sections.js file",
);
assert(
  petOverlayModulePaths.includes(pathId(["src", "inject", "systems", "pet-event-sounds", "index.js"])) &&
    petOverlayModulePaths.includes(pathId(["src", "inject", "systems", "settings-menu", "settings.js"])) &&
    !petOverlayModulePaths.includes(pathId(["src", "inject", "systems", "settings-menu", "view.js"])),
  "pet event sound overlay bundle must stay minimal and avoid full settings UI",
);
assert(
  buildPetEventSoundOverlayModulePaths(["pet-event-sounds"]).length === 0,
  "pet event sound overlay bundle must be skipped when the system is disabled",
);

for (const section of expectedBuiltinSections) {
  const moduleId = pathId(section.modulePath);
  assert(builtinSectionModulePaths.includes(moduleId), `${section.id} must be declared in settingsMenuBuiltinSectionModules`);
  assertBeforeInList(injectionModulePaths, formBindingEntry, moduleId);
  assertBeforeInList(injectionModulePaths, moduleId, viewEntry);
  assert(
    !disabledSettingsMenuPaths.includes(moduleId),
    `${section.id} builtin section must be skipped when settings-menu is disabled`,
  );
}

for (const block of expectedCloudSyncBlocks) {
  const moduleId = pathId(block.modulePath);
  if (block.ownerSystem) {
    assert(sectionModulePaths.includes(moduleId), `${block.id} must be declared in settingsMenuSectionModules`);
    assert(
      !buildInjectionModulePaths([block.ownerSystem]).map(pathId).includes(moduleId),
      `${block.id} cloud-sync block must be skipped when ${block.ownerSystem} is disabled`,
    );
  } else {
    assert(builtinSectionModulePaths.includes(moduleId), `${block.id} must be declared in settingsMenuBuiltinSectionModules`);
  }
  assertBeforeInList(injectionModulePaths, cloudSyncSectionEntry, moduleId);
  assertBeforeInList(injectionModulePaths, formBindingEntry, moduleId);
  assertBeforeInList(injectionModulePaths, moduleId, viewEntry);
  assert(
    !disabledSettingsMenuPaths.includes(moduleId),
    `${block.id} cloud-sync block must be skipped when settings-menu is disabled`,
  );
}

for (const section of expectedSections) {
  const moduleId = pathId(section.modulePath);
  assert(sectionModulePaths.includes(moduleId), `${section.id} must be declared in settingsMenuSectionModules`);
  assertBeforeInList(injectionModulePaths, registryEntry, moduleId);
  assertBeforeInList(injectionModulePaths, moduleId, viewEntry);
  assert(
    !buildInjectionModulePaths([section.ownerSystem]).map(pathId).includes(moduleId),
    `${section.id} settings module must be skipped when ${section.ownerSystem} is disabled`,
  );
  for (const key of section.settingKeys) {
    assert(
      !requiredBindingGuard.includes(`!${key}Input`),
      `${section.id} field ${key} must not be a global required binding when ${section.ownerSystem} is disabled`,
    );
  }
  assert(
    !disabledSettingsMenuPaths.includes(moduleId),
    `${section.id} settings module must be skipped when settings-menu is disabled`,
  );
}

assert(
  formBindingSource.includes("settingsMenu.formBinding"),
  "form-binding.js must expose settingsMenu.formBinding",
);
assert(
  dialogsSource.includes("runtime.dialogs") &&
    dialogsSource.includes("codex-pro-sync-confirm-backdrop") &&
    dialogsSource.includes("dialog suppression"),
  "dialogs.js must expose the shared in-page dialog and reuse the sync confirmation style",
);
assert(
  formBindingSource.includes("settingFields") &&
    formBindingSource.includes("mouseGestureShortcuts") &&
    formBindingSource.includes("fieldDependencies") &&
    formBindingSource.includes("applyFieldDependencyState"),
  "form-binding.js must be driven by settings.settingFields and section fieldDependencies",
);
assert(
  formBindingSource.includes("setFieldDisabledState") &&
    formBindingSource.includes("dataset.codexProDisabled") &&
    formBindingSource.includes('setAttribute("aria-disabled"'),
  "form-binding.js must mirror disabled controls to row-level disabled markers",
);
assert(
  viewSource.includes("settingsMenu.formBinding"),
  "settings-menu view must use settingsMenu.formBinding",
);
assert(
  viewSource.includes("formBinding.applyFieldDependencyState({ form })"),
  "settings-menu view must delegate field dependencies to form-binding",
);
assert(
  !viewSource.includes("renderBuiltInDependencyState"),
  "settings-menu view must not keep shell-level field dependency logic",
);
assert(viewSource.includes("settingsMenu.sections"), "settings-menu view must read registered sections");
assert(viewSource.includes("function getAvailableSection(section)"), "settings-menu view must normalize unavailable active sections");
assert(
  viewSource.includes("activeSection = getAvailableSection(section);"),
  "settings-menu setActiveSection must fall back when the requested section is disabled",
);
assert(
  viewSource.includes('button.getAttribute("data-codex-pro-settings-section-button") === activeSection'),
  "settings-menu section buttons must compare against normalized activeSection",
);
assert(
  viewSource.includes('panel.getAttribute("data-codex-pro-settings-section") === activeSection'),
  "settings-menu panels must compare against normalized activeSection",
);
assert(
  viewSource.includes("setActiveSection(activeSection);"),
  "settings-menu openDialog must route stale activeSection through fallback logic",
);
assert(
  viewSource.includes("modifiedSettingKeys") && viewSource.includes("section.settingKeys"),
  "settings-menu view must allow sections to keep hidden state out of left-nav modified markers",
);
assert(
  viewSource.includes("codex-pro-settings-update-tooltip") &&
    viewSource.includes("settings.updateCheck.hoverAvailable") &&
    viewSource.includes("bindUpdateTooltip(trigger, signal)"),
  "settings-menu view must show a custom update tooltip on trigger hover",
);
assert(
  viewSource.includes('data-codex-pro-disabled="true"') &&
    viewSource.includes(".codex-pro-settings-switch input:disabled + .codex-pro-settings-switch-track"),
  "settings-menu view must visibly dim row copy and disabled switch tracks",
);
assert(
  cloudSyncSectionSource.includes("registerCloudSyncBlock") &&
    cloudSyncSectionSource.includes("data-codex-pro-cloud-sync-gated-block") &&
    cloudSyncSectionSource.includes("applyCloudSyncFeatureGate") &&
    cloudSyncSectionSource.includes("data-codex-pro-cloud-sync-validate-key") &&
    cloudSyncSectionSource.includes("runSyncLicenseValidation") &&
    cloudSyncSectionSource.includes("addDialogOpenHandler"),
  "cloud sync settings section must own merged feature blocks, the shared license gate UI, and manual/open validation",
);
for (const [label, source] of [
  ["cloud sync settings section", cloudSyncSectionSource],
  ["pet sync settings block", petSyncSectionSource],
]) {
  assert(!/window\.(alert|confirm|prompt)\s*\(/u.test(source), `${label} must use runtime.dialogs instead of native browser dialogs`);
}
assert(
  !conversationArchiveSectionSource.includes('data-codex-pro-setting-key="conversationArchiveEndpoint"') &&
    !conversationArchiveSectionSource.includes('name="conversationArchiveEndpoint"'),
  "conversation archive settings section must not render the sync endpoint field",
);
assert(
  !conversationArchiveSectionSource.includes("data-codex-pro-conversation-archive-upload") &&
    !conversationArchiveSectionSource.includes("data-codex-pro-conversation-archive-refresh") &&
    !conversationArchiveSectionSource.includes("codex-pro-archive-browser"),
  "conversation archive settings section must hide manual archive actions and remote preview",
);

const forbiddenViewBusinessNeedles = [
  "renderMouseGestureShortcutFields",
  "getShortcutFromEvent",
  "mouseGestureShortcutInputs",
  "runtime.systemModules.conversationArchive",
  "runtime.systemModules.petSync",
  "data-codex-pro-conversation-archive-upload",
  "data-codex-pro-pet-sync-upload",
  "backgroundWallpaperImagesInput",
  "diffHoverPreviewFontSizeInput",
  "pushSavedSettingsToCloud",
];
for (const needle of forbiddenViewBusinessNeedles) {
  assert(!viewSource.includes(needle), `settings-menu view must not keep migrated section business logic: ${needle}`);
}

const pageSyncableSettingKeys = extractStringList(cloudSyncSource, "syncableSettingKeys");
const rustSyncableSettingKeys = extractRustStringList(rustCloudSyncSource, "cloud_sync_allowed_setting_keys");
assertSameStringList(rustSyncableSettingKeys, pageSyncableSettingKeys, "Rust native cloud-sync allow-list");
assert(pageSyncableSettingKeys.includes("usagePanelPingEndpoint"), "cloud sync should include Ping endpoint");
assert(pageSyncableSettingKeys.includes("usagePanelPingRefreshSeconds"), "cloud sync should include Ping interval");
assert(
  cloudSyncSource.includes('new Set(["zh-CN", "en-US", "ja-JP"])') && cloudSyncSource.includes('Object.hasOwn(payload, "uiLanguage")'),
  "settings-menu cloud sync must sanitize uiLanguage values",
);
assert(
  cloudSyncSectionSource.includes("normalizePulledSettings") &&
    cloudSyncSectionSource.includes("normalizeLegacyPulledChatWidthPixels") &&
    cloudSyncSectionSource.includes('Object.hasOwn(pulledSettings, "chatWidthPixels")') &&
    cloudSyncSectionSource.includes("delete pulledSettings.chatWidthPixels") &&
    cloudSyncSectionSource.includes('migratedWidth !== getDefaultChatWidthPixels() ? "custom" : "official"'),
  "settings-menu cloud download must migrate only valid legacy chat width snapshots before saving",
);
assert(
  rustCloudSyncSource.includes('language == "zh-CN" || language == "en-US" || language == "ja-JP"') && rustCloudSyncSource.includes('"uiLanguage"'),
  "Rust native cloud sync must sanitize uiLanguage values",
);
assert(
  cloudSyncSource.includes('new Set(["hidden", "observer", "official"])') && cloudSyncSource.includes('Object.hasOwn(payload, "usagePanelTodayTokenSource")'),
  "settings-menu cloud sync must sanitize Today token source values",
);
assert(
  cloudSyncSource.includes("getSyncLicenseGate") &&
    cloudSyncSource.includes("markSyncLicenseInvalid") &&
    cloudSyncSource.includes("readSyncLicenseMetadata") &&
    cloudSyncSource.includes("expiresAt") &&
    cloudSyncSource.includes("syncLicenseStatusEventName") &&
    cloudSyncSource.includes("requestSyncLicenseValidation") &&
    cloudSyncSource.includes("syncLicenseHeartbeatIntervalMs") &&
    cloudSyncSource.includes("installSyncLicenseAutoValidation") &&
    cloudSyncSource.includes("validateSyncLicense"),
  "settings-menu cloud sync must expose shared sync-license gate state, validation probe, and heartbeat validation",
);
assert(
  rustCloudSyncSource.includes('"license"') &&
    rustCloudSyncSource.includes('"expiresAt"') &&
    rustSyncLicenseSource.includes("SyncLicenseAuthorization") &&
    rustSyncLicenseSource.includes("license_response_expiry"),
  "Rust native cloud sync must expose safe sync-license expiry metadata",
);
assert(
  /status:\s*"unknown"[\s\S]*?canSync:\s*false/u.test(cloudSyncSource) ||
    /canSync:\s*false[\s\S]*?status:\s*"unknown"/u.test(cloudSyncSource),
  "settings-menu cloud sync must keep pending/unknown keys locked until authorized",
);
assert(
  petSyncSource.includes("markSyncLicenseInvalid") &&
    conversationArchiveSource.includes("markSyncLicenseInvalid"),
  "pet sync and conversation archive must report license failures to the shared gate",
);
for (const [label, source] of [
  ["settings cloud sync", cloudSyncSource],
  ["pet sync", petSyncSource],
  ["conversation archive sync", conversationArchiveSource],
]) {
  assert(!/Keygen|keygen/u.test(source), `${label} must not expose provider names in injected code`);
}
// 这一段防止同步授权的用户可见文案重新出现官方/官网口吻。
// Prevent sync-license user-facing copy from regressing to official-site wording.
const forbiddenSyncCopyFragments = [
  "Codex-Pro 官网",
  "官网获取",
  "官网发放",
  "官方授权码",
  "官方同步密钥",
  "official site",
  "official sync key",
  "official license code",
  "Codex-Pro official site",
  "公式サイトで取得",
  "Codex-Pro 公式サイト",
  "公式同期キー",
];
for (const fragment of forbiddenSyncCopyFragments) {
  assert(!i18nSource.includes(fragment), `sync user-facing copy must avoid official wording: ${fragment}`);
}
assert(
  rustCloudSyncSource.includes('source == "hidden" || source == "observer" || source == "official"') && rustCloudSyncSource.includes('"usagePanelTodayTokenSource"'),
  "Rust native cloud sync must sanitize Today token source values",
);
assertBeforeInSource(usagePanelSettingsSource, '<option value="hidden">', '<option value="observer">', "Today token hidden option");
assertBeforeInSource(usagePanelSettingsSource, '<option value="observer">', '<option value="official">', "Today token observer option");
for (const [label, source] of [
  ["settings cloud sync", cloudSyncSource],
  ["pet sync", petSyncSource],
  ["conversation archive sync", conversationArchiveSource],
]) {
  assert(source.includes("getDisplayResponseError("), `${label} must localize display errors`);
  assert(!source.includes("responseData?.error || data?.message || i18n.t("), `${label} must not display raw remote errors before i18n fallback`);
}

const windowObject = {
  __codexProRuntime: {
    systemModules: {},
  },
};
const context = vm.createContext({
  Intl,
  console,
  window: windowObject,
});

await runModuleInContext(i18nPath, context);
await runModuleInContext(registryPath, context);
await runModuleInContext(formBindingPath, context);
for (const section of [...expectedBuiltinSections, ...expectedSections]) {
  await runModuleInContext(pathFromParts(section.modulePath), context);
}
for (const block of expectedCloudSyncBlocks) {
  await runModuleInContext(pathFromParts(block.modulePath), context);
}

const settingsMenu = windowObject.__codexProRuntime.systemModules.settingsMenu;
assertFormBindingBehavior(settingsMenu.formBinding);
const registeredSections = settingsMenu.sections || [];
const registeredIds = registeredSections.map((section) => section.id);
const registeredCloudSyncBlocks = settingsMenu.cloudSyncBlocks || [];
const registeredCloudSyncBlockIds = registeredCloudSyncBlocks.map((block) => block.id);
assert(
  registeredSections.length === expectedBuiltinSections.length + expectedSections.length,
  "registered settings section count changed",
);
assert(
  registeredCloudSyncBlocks.length === expectedCloudSyncBlocks.length,
  "registered cloud-sync block count changed",
);
for (const removedSectionId of ["pet-sync", "conversation-archive", "conversation-archive-sidebar"]) {
  assert(!registeredIds.includes(removedSectionId), `${removedSectionId} must be merged into cloud-sync instead of left nav`);
}

assertMetadataSectionBind(settingsMenu, "cloud-sync", {
  cloudSyncLastSyncAt: "2026-06-10T00:00:00.000Z",
  cloudSyncRevision: 12,
  petSyncLastSyncAt: "2026-06-10T00:01:00.000Z",
  petSyncRevision: 13,
});
await assertCloudSyncLegacyChatWidthDownload(settingsMenu);

for (const expectedSection of [...expectedBuiltinSections, ...expectedSections]) {
  const section = registeredSections.find((candidate) => candidate.id === expectedSection.id);
  assert(section, `missing registered section: ${expectedSection.id}`);
  if (!expectedBuiltinSections.some((candidate) => candidate.id === expectedSection.id)) {
    assert(section.sourceSystem, `${expectedSection.id} must declare sourceSystem`);
    assert(section.sourcePath, `${expectedSection.id} must declare sourcePath`);
  }
  assert(
    JSON.stringify(section.settingKeys) === JSON.stringify(expectedSection.settingKeys),
    `${expectedSection.id} settingKeys mismatch`,
  );
  if (expectedSection.modifiedSettingKeys) {
    assert(
      JSON.stringify(section.modifiedSettingKeys) === JSON.stringify(expectedSection.modifiedSettingKeys),
      `${expectedSection.id} modifiedSettingKeys mismatch`,
    );
  }
  assertSameObject(section.fieldDependencies || {}, expectedSection.fieldDependencies || {}, `${expectedSection.id} fieldDependencies`);
  if (expectedSection.requiresBind) {
    assert(typeof section.bind === "function", `${expectedSection.id} section must expose bind(context)`);
  } else if (expectedBuiltinSections.some((candidate) => candidate.id === expectedSection.id)) {
    assert(section.bind == null, `${expectedSection.id} pure form section must not keep bind(context) logic`);
  }

  const html = section.render(createSettingsApi());
  if (expectedSection.id === "cloud-sync") {
    assert(
      !html.includes('data-codex-pro-setting-key="cloudSyncEndpoint"') &&
        !html.includes('name="cloudSyncEndpoint"'),
      "cloud sync settings section must not render the sync endpoint field",
    );
  }
  if (expectedSection.id === "pet-sync") {
    assert(
      !html.includes('data-codex-pro-setting-key="petSyncEndpoint"') &&
        !html.includes('name="petSyncEndpoint"'),
      "pet sync settings section must not render the sync endpoint field",
    );
  }
  for (const key of expectedSection.settingKeys) {
    if (expectedSection.hiddenSettingKeys?.includes(key)) continue;
    if (key === "mouseGestureShortcuts") {
      assert(
        html.includes('data-codex-pro-setting-key="mouseGestureShortcuts:'),
        `${expectedSection.id} missing mouse gesture shortcut data keys`,
      );
      continue;
    }
    if (key === "petEventSoundPaths") {
      assert(
        html.includes('data-codex-pro-setting-key="petEventSoundPaths:running"') &&
          html.includes('data-codex-pro-pet-event-sound-path="running"'),
        `${expectedSection.id} missing pet event sound path data keys`,
      );
      continue;
    }
    if (key === "petEventSoundVolumes") {
      assert(
        html.includes('data-codex-pro-setting-key="petEventSoundVolumes:running"') &&
          html.includes('data-codex-pro-pet-event-sound-volume="running"') &&
          html.includes('data-codex-pro-pet-event-sound-preview="running"'),
        `${expectedSection.id} missing pet event sound volume and preview data keys`,
      );
      continue;
    }
    assert(html.includes(`data-codex-pro-setting-key="${key}"`), `${expectedSection.id} missing data key ${key}`);
    if (key !== "mouseGestureShortcuts") {
      assert(html.includes(`name="${key}"`), `${expectedSection.id} missing form name ${key}`);
    }
  }
}

for (const expectedBlock of expectedCloudSyncBlocks) {
  const block = registeredCloudSyncBlocks.find((candidate) => candidate.id === expectedBlock.id);
  assert(block, `missing cloud-sync block: ${expectedBlock.id}`);
  assert(
    JSON.stringify(block.settingKeys) === JSON.stringify(expectedBlock.settingKeys),
    `${expectedBlock.id} cloud-sync block settingKeys mismatch`,
  );
  assertSameObject(block.fieldDependencies || {}, expectedBlock.fieldDependencies || {}, `${expectedBlock.id} cloud-sync block fieldDependencies`);
  if (expectedBlock.requiresBind) {
    assert(typeof block.bind === "function", `${expectedBlock.id} cloud-sync block must expose bind(context)`);
  }
  const html = block.render(createSettingsApi());
  if (expectedBlock.id === "pet-sync") {
    assert(
      !html.includes('data-codex-pro-setting-key="petSyncEndpoint"') &&
        !html.includes('name="petSyncEndpoint"'),
      "pet sync cloud-sync block must not render the sync endpoint field",
    );
  }
  for (const key of expectedBlock.settingKeys) {
    assert(html.includes(`data-codex-pro-setting-key="${key}"`), `${expectedBlock.id} missing data key ${key}`);
    assert(html.includes(`name="${key}"`), `${expectedBlock.id} missing form name ${key}`);
  }
}

console.log(`settings-menu per-system section checks passed: ${registeredIds.join(", ")}; cloud-sync blocks: ${registeredCloudSyncBlockIds.join(", ")}`);
