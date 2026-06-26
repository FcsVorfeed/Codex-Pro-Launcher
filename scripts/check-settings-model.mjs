import { readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";

const rootDir = path.resolve(import.meta.dirname, "..");
const settingsPath = path.join(rootDir, "src", "inject", "systems", "settings-menu", "settings.js");
const storage = new Map();

function createLocalStorage() {
  // 这一段提供最小 localStorage 仿真，让设置模块能在 Node VM 里按浏览器路径运行。
  // Provide a minimal localStorage shim so the settings module runs through its browser path in a Node VM.
  return {
    getItem(key) {
      return storage.has(key) ? storage.get(key) : null;
    },
    setItem(key, value) {
      storage.set(key, String(value));
    },
  };
}

function assert(condition, message) {
  // 这一段用明确错误终止测试，方便定位设置注册表缺项。
  // Fail with explicit messages so missing setting registry entries are easy to locate.
  if (!condition) throw new Error(message);
}

function readStoredSettings() {
  // 这一段读取插件设置原始存储，验证 saveSettings 是否仍只保存覆盖项。
  // Read raw plugin settings to verify saveSettings still stores only overrides.
  return JSON.parse(storage.get("codex-pro:settings") || "{}");
}

const windowObject = {
  __codexProRuntime: {
    systemModules: {},
  },
  localStorage: createLocalStorage(),
};
const context = vm.createContext({
  URL,
  console,
  window: windowObject,
});

const source = await readFile(settingsPath, "utf8");
vm.runInContext(source, context, { filename: settingsPath });

const settings = windowObject.__codexProRuntime.systemModules.settingsMenu.settings;
assert(settings, "settings API was not registered");
assert(Array.isArray(settings.settingFields), "settings.settingFields must be exposed");
assert(
  JSON.stringify(settings.supportedUiLanguages) === JSON.stringify(["zh-CN", "en-US", "ja-JP"]),
  "settings.supportedUiLanguages must expose zh-CN, en-US, and ja-JP",
);
assert(settings.defaultSettings.uiLanguage === "en-US", "UI language should default to English");

const fieldKeys = settings.settingFields.map((field) => field.key);
const defaultKeys = Object.keys(settings.defaultSettings);
assert(new Set(fieldKeys).size === fieldKeys.length, "settings.settingFields contains duplicate keys");
for (const key of defaultKeys) {
  assert(fieldKeys.includes(key), `settings.settingFields is missing default key: ${key}`);
}
assert(
  settings.defaultSettings.conversationArchiveSidebarDirectoryPanelMode === "click",
  "left directory panel mode should default to click so existing behavior is preserved",
);
assert(
  settings.defaultSettings.conversationArchiveProfileName === "Default profile",
  "conversation archive profile name should default to English display text",
);
assert(
  settings.defaultSettings.enableConversationArchiveSync === false,
  "conversation archive auto upload should default to disabled",
);
assert(
  settings.defaultSettings.enableBackgroundWallpaper === false,
  "background wallpaper should default to disabled",
);
assert(
  settings.defaultSettings.showUsagePanelTokenDetails === false,
  "conversation token details should default to hidden",
);
assert(
  settings.defaultSettings.enableContextUsageRingColors === false,
  "context usage ring colors should default to disabled",
);
assert(
  settings.defaultSettings.contextUsageRingWarningThreshold === 60 &&
    settings.defaultSettings.contextUsageRingCriticalThreshold === 80,
  "context usage ring thresholds should default to 60/80",
);
assert(
  settings.defaultSettings.contextUsageRingWarningColor === "#f59e0b" &&
    settings.defaultSettings.contextUsageRingCriticalColor === "#ef4444",
  "context usage ring colors should default to yellow/red",
);
assert(
  settings.defaultSettings.usagePanelTodayTokenSource === "hidden",
  "Today token source should default to hidden",
);
assert(
  settings.defaultSettings.usagePanelPingEndpoint === "https://status.openai.com/api/v2/status.json",
  "Ping endpoint should default to OpenAI status",
);
assert(
  settings.defaultSettings.usagePanelPingRefreshSeconds === 10,
  "Ping refresh interval should default to 10 seconds",
);
assert(
  settings.defaultSettings.enableChatWidthResizer === true,
  "chat width resizer should default to enabled",
);
assert(
  settings.defaultSettings.enableSplitItemsHotpathPatch === true,
  "split-items hotpath patch should default to enabled",
);
assert(
  settings.defaultSettings.enableCodexSqliteLogInsertBlocker === false,
  "Codex SQLite log insert blocker should default to disabled",
);
assert(
  settings.defaultSettings.chatWidthMode === "official",
  "chat width should default to Codex's native mode",
);
assert(
  settings.defaultSettings.chatWidthPixels === 1100,
  "chat width should keep a conservative custom seed width",
);
assert(
  settings.defaultSettings.enablePetEventSounds === false,
  "pet event sounds should default to disabled",
);
assert(
  settings.defaultSettings.petEventSoundCooldownMs === 350,
  "pet event sound cooldown should default to 350 ms",
);
assert(
  JSON.stringify(settings.defaultSettings.petEventSoundVolumes) === "{}",
  "pet event sound volumes should default to compact full-volume mapping",
);
assert(settings.minPetEventSoundVolume === 0, "pet event sound volume minimum should be 0");
assert(settings.maxPetEventSoundVolume === 100, "pet event sound volume maximum should be 100");
assert(
  JSON.stringify(settings.petEventSoundStateIds) === JSON.stringify([
    "idle",
    "waving",
    "running",
    "waiting",
    "failed",
    "review",
    "jumping",
    "running-left",
    "running-right",
  ]),
  "pet event sound states should expose the official avatar animation states",
);

storage.set("codex-pro:settings", JSON.stringify({ chatWidthPixels: 1320 }));
assert(settings.getSettings().chatWidthMode === "custom", "legacy custom chat width should migrate to custom mode");
assert(settings.getSettings().chatWidthPixels === 1320, "legacy custom chat width should keep its stored pixel value");
storage.set("codex-pro:settings", JSON.stringify({ chatWidthPixels: null }));
assert(settings.getSettings().chatWidthMode === "official", "invalid legacy chat width should keep native mode");
assert(settings.getSettings().chatWidthPixels === 1100, "invalid legacy chat width should fall back to the default width");
storage.delete("codex-pro:settings");

const migratedLegacyProfileSettings = settings.saveSettings({
  ...settings.getSettings(),
  conversationArchiveProfileName: "默认账号",
});
let rawSettings = readStoredSettings();
assert(
  migratedLegacyProfileSettings.conversationArchiveProfileName === "Default profile",
  "legacy Chinese default profile name should migrate to the English default",
);
assert(
  !Object.hasOwn(rawSettings, "conversationArchiveProfileName"),
  "legacy Chinese default profile name should not remain as a raw override",
);

const savedSettings = settings.saveSettings({
  cloudSyncEndpoint: "https://example.com/custom-sync",
  cloudSyncKey: "local-only-key",
  conversationArchiveDeviceName: "Desk",
  conversationArchiveEndpoint: "https://example.com/archive-sync",
  conversationArchiveProfileName: "Work",
  conversationArchiveSidebarDirectoryPanelMode: "hover",
  collapseSidebarOnStartup: true,
  enableCloudSettingsSync: true,
  enableConversationArchiveSidebar: false,
  enableConversationArchiveSync: true,
  enableBackgroundWallpaper: true,
  enableChatWidthResizer: false,
  enableCodexSqliteLogInsertBlocker: true,
  enableSplitItemsHotpathPatch: false,
  enableStartupSidebar: true,
  enableUsagePanel: false,
  enableContextUsageRingColors: true,
  contextUsageRingWarningThreshold: 90,
  contextUsageRingCriticalThreshold: 75,
  contextUsageRingWarningColor: "FACC15",
  contextUsageRingCriticalColor: "#DC2626",
  hiddenFileTreePatterns: "dist/**",
  enablePetEventSounds: true,
  petEventSoundCooldownMs: 600,
  petEventSoundPaths: {
    running: "C:/Sounds/running.mp3",
    waiting: "C:/Sounds/waiting.wav",
    unknown: "C:/Sounds/unknown.mp3",
  },
  petEventSoundVolumes: {
    failed: -10,
    jumping: 101,
    review: 100,
    running: 65,
    waiting: 0,
    unknown: 25,
  },
  petSyncEndpoint: "https://example.com/pet-sync",
  petSyncLastSyncAt: "2026-06-10T00:00:00.000Z",
  petSyncRevision: 2,
  showUsageInLowerLeftPanel: true,
  showUsagePanelPing: false,
  usagePanelPingEndpoint: "https://example.com/ping",
  usagePanelPingRefreshSeconds: 20,
  showUsagePanelTokenDetails: true,
  usagePanelTodayTokenSource: "official",
  uiLanguage: "zh-CN",
  chatWidthMode: "custom",
  chatWidthPixels: 1320,
  usageRefreshSeconds: 15,
});
assert(savedSettings.enableUsagePanel === false, "saveSettings should normalize changed boolean fields");
assert(savedSettings.enableCloudSettingsSync === true, "saveSettings should normalize changed cloud sync switch");
assert(savedSettings.enableConversationArchiveSidebar === false, "saveSettings should normalize changed archive sidebar switch");
assert(savedSettings.enableConversationArchiveSync === true, "saveSettings should normalize changed archive sync switch");
assert(savedSettings.enableBackgroundWallpaper === true, "saveSettings should allow changed background wallpaper switch to turn on");
assert(savedSettings.enableChatWidthResizer === false, "saveSettings should allow changed chat width resizer switch to turn off");
assert(savedSettings.enableCodexSqliteLogInsertBlocker === true, "saveSettings should allow Codex SQLite log blocker to turn on");
assert(savedSettings.enableSplitItemsHotpathPatch === false, "saveSettings should allow split-items hotpath patch to turn off");
assert(savedSettings.collapseSidebarOnStartup === true, "saveSettings should allow changed startup collapse switch to turn on");
assert(savedSettings.enableStartupSidebar === true, "saveSettings should allow changed startup sidebar switch to turn on");
assert(savedSettings.enableContextUsageRingColors === true, "saveSettings should allow context ring colors to turn on");
assert(savedSettings.contextUsageRingWarningThreshold === 75, "saveSettings should clamp warning threshold to critical threshold");
assert(savedSettings.contextUsageRingCriticalThreshold === 75, "saveSettings should normalize critical threshold");
assert(savedSettings.contextUsageRingWarningColor === "#facc15", "saveSettings should normalize warning ring color");
assert(savedSettings.contextUsageRingCriticalColor === "#dc2626", "saveSettings should normalize critical ring color");
assert(savedSettings.conversationArchiveSidebarDirectoryPanelMode === "hover", "saveSettings should normalize changed left directory panel mode");
assert(savedSettings.showUsageInLowerLeftPanel === true, "saveSettings should allow changed lower-left usage switch to turn on");
assert(savedSettings.showUsagePanelPing === false, "saveSettings should allow changed Ping switch to turn off");
assert(savedSettings.usagePanelPingEndpoint === "https://example.com/ping", "saveSettings should normalize changed Ping endpoint");
assert(savedSettings.usagePanelPingRefreshSeconds === 20, "saveSettings should normalize changed Ping interval");
assert(savedSettings.showUsagePanelTokenDetails === true, "saveSettings should allow changed token details switch to turn on");
assert(savedSettings.usagePanelTodayTokenSource === "official", "saveSettings should normalize changed Today token source");
assert(savedSettings.uiLanguage === "zh-CN", "saveSettings should normalize changed UI language");
assert(savedSettings.chatWidthMode === "custom", "saveSettings should normalize changed chat width mode");
assert(savedSettings.chatWidthPixels === 1320, "saveSettings should normalize changed chat width");
assert(savedSettings.usageRefreshSeconds === 15, "saveSettings should normalize changed numeric fields");
assert(savedSettings.enablePetEventSounds === true, "saveSettings should allow pet event sounds to turn on");
assert(savedSettings.petEventSoundCooldownMs === 600, "saveSettings should normalize pet event sound cooldown");
assert(savedSettings.petEventSoundPaths.running === "C:/Sounds/running.mp3", "saveSettings should keep configured pet event sound paths");
assert(savedSettings.petEventSoundPaths.waiting === "C:/Sounds/waiting.wav", "saveSettings should keep multiple pet event sound paths");
assert(!Object.hasOwn(savedSettings.petEventSoundPaths, "unknown"), "saveSettings should drop unknown pet event sound states");
assert(savedSettings.petEventSoundVolumes.failed === 0, "saveSettings should clamp short pet event sound volume");
assert(!Object.hasOwn(savedSettings.petEventSoundVolumes, "jumping"), "saveSettings should remove max-volume pet event sound overrides");
assert(!Object.hasOwn(savedSettings.petEventSoundVolumes, "review"), "saveSettings should remove default pet event sound volume overrides");
assert(savedSettings.petEventSoundVolumes.running === 65, "saveSettings should keep configured pet event sound volume");
assert(savedSettings.petEventSoundVolumes.waiting === 0, "saveSettings should allow muted pet event sound volume");
assert(!Object.hasOwn(savedSettings.petEventSoundVolumes, "unknown"), "saveSettings should drop unknown pet event sound volume states");

rawSettings = readStoredSettings();
assert(rawSettings.enableUsagePanel === false, "changed boolean field should be stored as override");
assert(rawSettings.conversationArchiveSidebarDirectoryPanelMode === "hover", "changed left directory panel mode should be stored as override");
assert(rawSettings.enableCloudSettingsSync === true, "changed cloud sync switch should be stored as override");
assert(rawSettings.enableConversationArchiveSidebar === false, "changed archive sidebar switch should be stored as override");
assert(rawSettings.enableConversationArchiveSync === true, "changed archive sync switch should be stored as override");
assert(rawSettings.enableBackgroundWallpaper === true, "changed background wallpaper switch should be stored as override");
assert(rawSettings.enableChatWidthResizer === false, "changed chat width resizer switch should be stored as override");
assert(rawSettings.enableCodexSqliteLogInsertBlocker === true, "changed Codex SQLite log blocker switch should be stored as override");
assert(rawSettings.enableSplitItemsHotpathPatch === false, "changed split-items hotpath patch switch should be stored as override");
assert(rawSettings.collapseSidebarOnStartup === true, "changed startup collapse switch should be stored as override");
assert(rawSettings.enableStartupSidebar === true, "changed startup sidebar switch should be stored as override");
assert(rawSettings.enableContextUsageRingColors === true, "changed context ring colors switch should be stored as override");
assert(rawSettings.contextUsageRingWarningThreshold === 75, "changed warning threshold should be stored normalized");
assert(rawSettings.contextUsageRingCriticalThreshold === 75, "changed critical threshold should be stored normalized");
assert(rawSettings.contextUsageRingWarningColor === "#facc15", "changed warning ring color should be stored normalized");
assert(rawSettings.contextUsageRingCriticalColor === "#dc2626", "changed critical ring color should be stored normalized");
assert(rawSettings.showUsageInLowerLeftPanel === true, "changed lower-left usage switch should be stored as override");
assert(rawSettings.showUsagePanelPing === false, "changed Ping switch should be stored as override");
assert(rawSettings.usagePanelPingEndpoint === "https://example.com/ping", "changed Ping endpoint should be stored as override");
assert(rawSettings.usagePanelPingRefreshSeconds === 20, "changed Ping interval should be stored as override");
assert(rawSettings.showUsagePanelTokenDetails === true, "changed token details switch should be stored as override");
assert(rawSettings.usagePanelTodayTokenSource === "official", "changed Today token source should be stored as override");
assert(rawSettings.uiLanguage === "zh-CN", "changed UI language should be stored as override");
assert(rawSettings.chatWidthMode === "custom", "changed chat width mode should be stored as override");
assert(rawSettings.chatWidthPixels === 1320, "changed chat width should be stored as override");
assert(rawSettings.usageRefreshSeconds === 15, "changed numeric field should be stored as override");
assert(rawSettings.hiddenFileTreePatterns === "dist/**", "changed textarea field should be stored as override");
assert(rawSettings.enablePetEventSounds === true, "changed pet event sounds switch should be stored as override");
assert(rawSettings.petEventSoundCooldownMs === 600, "changed pet event sound cooldown should be stored as override");
assert(rawSettings.petEventSoundPaths.running === "C:/Sounds/running.mp3", "changed pet event sound path should be stored as override");
assert(!Object.hasOwn(rawSettings.petEventSoundPaths, "unknown"), "unknown pet event sound path keys should not be stored");
assert(rawSettings.petEventSoundVolumes.running === 65, "changed pet event sound volume should be stored as override");
assert(rawSettings.petEventSoundVolumes.waiting === 0, "muted pet event sound volume should be stored as override");
assert(!Object.hasOwn(rawSettings.petEventSoundVolumes, "review"), "default pet event sound volume should not be stored");
assert(!Object.hasOwn(rawSettings.petEventSoundVolumes, "jumping"), "clamped default pet event sound volume should not be stored");
assert(!Object.hasOwn(rawSettings.petEventSoundVolumes, "unknown"), "unknown pet event sound volume keys should not be stored");

settings.saveSettings({
  cloudSyncLastSyncAt: "2026-06-10T00:00:30.000Z",
  cloudSyncRevision: 6,
  conversationArchiveLastSyncAt: "2026-06-10T00:01:00.000Z",
  conversationArchiveRevision: 3,
  petSyncLastSyncAt: "2026-06-10T00:00:00.000Z",
  petSyncRevision: 2,
});
settings.saveSettings({
  cloudSyncRevision: 7,
  conversationArchiveRevision: 9,
  petSyncRevision: 8,
});
rawSettings = readStoredSettings();
assert(rawSettings.cloudSyncEndpoint === "https://example.com/custom-sync", "partial sync metadata save should preserve existing endpoint");
assert(rawSettings.cloudSyncKey === "local-only-key", "partial sync metadata save should preserve existing sync key");
assert(rawSettings.enableCloudSettingsSync === true, "partial sync metadata save should preserve sync switch");
assert(rawSettings.cloudSyncRevision === 7, "partial sync metadata save should store the new revision");
assert(rawSettings.petSyncEndpoint === "https://example.com/pet-sync", "partial pet sync metadata save should preserve endpoint");
assert(rawSettings.petSyncLastSyncAt === "2026-06-10T00:00:00.000Z", "partial pet sync metadata save should preserve last sync time");
assert(rawSettings.petSyncRevision === 8, "partial pet sync metadata save should store the new revision");
assert(rawSettings.conversationArchiveDeviceName === "Desk", "partial archive metadata save should preserve device name");
assert(rawSettings.conversationArchiveEndpoint === "https://example.com/archive-sync", "partial archive metadata save should preserve endpoint");
assert(rawSettings.enableConversationArchiveSync === true, "partial archive metadata save should preserve sync switch");
assert(rawSettings.uiLanguage === "zh-CN", "partial sync metadata save should preserve UI language");
assert(rawSettings.conversationArchiveLastSyncAt === "2026-06-10T00:01:00.000Z", "partial archive metadata save should preserve last sync time");
assert(rawSettings.conversationArchiveProfileName === "Work", "partial archive metadata save should preserve profile name");
assert(rawSettings.conversationArchiveRevision === 9, "partial archive metadata save should store the new revision");
assert(rawSettings.collapseSidebarOnStartup === true, "partial metadata save should preserve startup collapse switch");
assert(rawSettings.enableConversationArchiveSidebar === false, "partial metadata save should preserve archive sidebar switch");
assert(rawSettings.enableBackgroundWallpaper === true, "partial metadata save should preserve background wallpaper switch");
assert(rawSettings.enableChatWidthResizer === false, "partial metadata save should preserve chat width resizer switch");
assert(rawSettings.enableCodexSqliteLogInsertBlocker === true, "partial metadata save should preserve Codex SQLite log blocker switch");
assert(rawSettings.enableSplitItemsHotpathPatch === false, "partial metadata save should preserve split-items hotpath patch switch");
assert(rawSettings.enableStartupSidebar === true, "partial metadata save should preserve startup sidebar switch");
assert(rawSettings.enableContextUsageRingColors === true, "partial metadata save should preserve context ring colors switch");
assert(rawSettings.contextUsageRingWarningThreshold === 75, "partial metadata save should preserve warning threshold");
assert(rawSettings.contextUsageRingCriticalThreshold === 75, "partial metadata save should preserve critical threshold");
assert(rawSettings.contextUsageRingWarningColor === "#facc15", "partial metadata save should preserve warning ring color");
assert(rawSettings.contextUsageRingCriticalColor === "#dc2626", "partial metadata save should preserve critical ring color");
assert(rawSettings.enableUsagePanel === false, "partial metadata save should preserve ordinary boolean overrides");
assert(rawSettings.hiddenFileTreePatterns === "dist/**", "partial metadata save should preserve ordinary textarea overrides");
assert(rawSettings.enablePetEventSounds === true, "partial metadata save should preserve pet event sounds switch");
assert(rawSettings.petEventSoundCooldownMs === 600, "partial metadata save should preserve pet event sound cooldown");
assert(rawSettings.petEventSoundPaths.running === "C:/Sounds/running.mp3", "partial metadata save should preserve pet event sound paths");
assert(rawSettings.petEventSoundVolumes.running === 65, "partial metadata save should preserve pet event sound volumes");
assert(rawSettings.petEventSoundVolumes.waiting === 0, "partial metadata save should preserve muted pet event sound volumes");
assert(rawSettings.conversationArchiveSidebarDirectoryPanelMode === "hover", "partial metadata save should preserve left directory panel mode");
assert(rawSettings.showUsageInLowerLeftPanel === true, "partial metadata save should preserve lower-left usage switch");
assert(rawSettings.showUsagePanelPing === false, "partial metadata save should preserve Ping switch");
assert(rawSettings.usagePanelPingEndpoint === "https://example.com/ping", "partial metadata save should preserve Ping endpoint");
assert(rawSettings.usagePanelPingRefreshSeconds === 20, "partial metadata save should preserve Ping interval");
assert(rawSettings.showUsagePanelTokenDetails === true, "partial metadata save should preserve token details switch");
assert(rawSettings.usagePanelTodayTokenSource === "official", "partial metadata save should preserve Today token source");
assert(rawSettings.chatWidthMode === "custom", "partial metadata save should preserve chat width mode");
assert(rawSettings.chatWidthPixels === 1320, "partial metadata save should preserve chat width");
assert(rawSettings.usageRefreshSeconds === 15, "partial metadata save should preserve ordinary numeric overrides");

// 这一段模拟用户切换同步密钥后立即上传，确认旧密钥的本机同步基线不会被沿用。
// Simulate switching the sync key before an upload and ensure old-key sync baselines are not reused.
const switchedKeySettings = settings.saveSettings({
  ...settings.getSettings(),
  cloudSyncKey: "new-local-only-key",
  cloudSyncLastSyncAt: "2026-06-10T00:02:00.000Z",
  cloudSyncRevision: 7,
  conversationArchiveLastSyncAt: "2026-06-10T00:04:00.000Z",
  conversationArchiveRevision: 10,
  petSyncLastSyncAt: "2026-06-10T00:03:00.000Z",
  petSyncRevision: 8,
});
rawSettings = readStoredSettings();
assert(switchedKeySettings.cloudSyncKey === "new-local-only-key", "sync key switch should save the new key");
assert(switchedKeySettings.cloudSyncLastSyncAt === "", "sync key switch should reset settings last-sync time");
assert(switchedKeySettings.cloudSyncRevision === 0, "sync key switch should reset settings revision");
assert(switchedKeySettings.conversationArchiveLastSyncAt === "", "sync key switch should reset archive last-sync time");
assert(switchedKeySettings.conversationArchiveRevision === 0, "sync key switch should reset archive revision");
assert(switchedKeySettings.petSyncLastSyncAt === "", "sync key switch should reset pet last-sync time");
assert(switchedKeySettings.petSyncRevision === 0, "sync key switch should reset pet revision");
assert(!Object.hasOwn(rawSettings, "cloudSyncLastSyncAt"), "sync key switch should remove raw settings last-sync metadata");
assert(!Object.hasOwn(rawSettings, "cloudSyncRevision"), "sync key switch should remove raw settings revision metadata");
assert(!Object.hasOwn(rawSettings, "conversationArchiveLastSyncAt"), "sync key switch should remove raw archive last-sync metadata");
assert(!Object.hasOwn(rawSettings, "conversationArchiveRevision"), "sync key switch should remove raw archive revision metadata");
assert(!Object.hasOwn(rawSettings, "petSyncLastSyncAt"), "sync key switch should remove raw pet last-sync metadata");
assert(!Object.hasOwn(rawSettings, "petSyncRevision"), "sync key switch should remove raw pet revision metadata");

settings.saveSettings({
  ...settings.getSettings(),
  uiLanguage: "fr-FR",
});
rawSettings = readStoredSettings();
assert(!Object.hasOwn(rawSettings, "uiLanguage"), "invalid UI language should fall back to default and be removed from raw storage");
assert(settings.getSettings().uiLanguage === settings.defaultSettings.uiLanguage, "invalid UI language should read back as default");

settings.saveSettings({
  ...settings.getSettings(),
  conversationArchiveSidebarDirectoryPanelMode: "float",
});
rawSettings = readStoredSettings();
assert(
  !Object.hasOwn(rawSettings, "conversationArchiveSidebarDirectoryPanelMode"),
  "invalid left directory panel mode should fall back to default and be removed from raw storage",
);
assert(
  settings.getSettings().conversationArchiveSidebarDirectoryPanelMode === settings.defaultSettings.conversationArchiveSidebarDirectoryPanelMode,
  "invalid left directory panel mode should read back as default",
);

settings.saveSettings({
  ...settings.getSettings(),
  usagePanelTodayTokenSource: "remote",
});
rawSettings = readStoredSettings();
assert(!Object.hasOwn(rawSettings, "usagePanelTodayTokenSource"), "invalid Today token source should fall back to default and be removed from raw storage");
assert(settings.getSettings().usagePanelTodayTokenSource === settings.defaultSettings.usagePanelTodayTokenSource, "invalid Today token source should read back as default");

settings.saveSettings({
  ...settings.getSettings(),
  usagePanelPingEndpoint: "http://example.com/ping",
});
rawSettings = readStoredSettings();
assert(!Object.hasOwn(rawSettings, "usagePanelPingEndpoint"), "remote HTTP Ping endpoint should fall back to default and be removed from raw storage");
assert(settings.getSettings().usagePanelPingEndpoint === settings.defaultSettings.usagePanelPingEndpoint, "remote HTTP Ping endpoint should read back as default");

settings.saveSettings({
  ...settings.getSettings(),
  usagePanelPingEndpoint: "http://127.0.0.1:12345/ping",
  usagePanelPingRefreshSeconds: 1,
});
rawSettings = readStoredSettings();
assert(rawSettings.usagePanelPingEndpoint === "http://127.0.0.1:12345/ping", "local HTTP Ping endpoint should be stored as override");
assert(rawSettings.usagePanelPingRefreshSeconds === settings.minUsagePanelPingRefreshSeconds, "short Ping interval should clamp to the minimum");

settings.saveSettings({
  ...settings.getSettings(),
  chatWidthMode: "custom",
  chatWidthPixels: 10,
});
rawSettings = readStoredSettings();
assert(rawSettings.chatWidthMode === "custom", "short custom chat width should keep custom mode");
assert(rawSettings.chatWidthPixels === settings.minChatWidthPixels, "short chat width should clamp to the minimum");

settings.saveSettings({
  ...settings.getSettings(),
  chatWidthMode: "custom",
  chatWidthPixels: 99999,
});
rawSettings = readStoredSettings();
assert(rawSettings.chatWidthMode === "custom", "large custom chat width should keep custom mode");
assert(rawSettings.chatWidthPixels === settings.maxChatWidthPixels, "large chat width should clamp to the maximum");

settings.saveSettings({
  ...settings.getSettings(),
  chatWidthMode: "official",
  chatWidthPixels: 1320,
});
rawSettings = readStoredSettings();
assert(settings.getSettings().chatWidthMode === "official", "official chat width mode should read back as native mode");
assert(!Object.hasOwn(rawSettings, "chatWidthMode"), "official chat width mode should be removed from raw storage");
assert(!Object.hasOwn(rawSettings, "chatWidthPixels"), "official chat width reset should remove raw custom width");

settings.saveSettings({
  ...settings.getSettings(),
  uiLanguage: "ja-JP",
});
rawSettings = readStoredSettings();
assert(rawSettings.uiLanguage === "ja-JP", "Japanese UI language should be stored as override");

settings.saveSettings({
  ...settings.getSettings(),
  enableUsagePanel: false,
});
rawSettings = readStoredSettings();
assert(rawSettings.enableUsagePanel === false, "changed boolean field should be stored again as override");

settings.saveSettings({
  ...settings.getSettings(),
  enableUsagePanel: settings.defaultSettings.enableUsagePanel,
});
rawSettings = readStoredSettings();
assert(!Object.hasOwn(rawSettings, "enableUsagePanel"), "default boolean field should be removed from raw storage");

console.log("settings model checks passed");
