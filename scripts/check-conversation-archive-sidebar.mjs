import { readFile } from "node:fs/promises";
import path from "node:path";

// 这一段定位同步会话侧栏源码，后续检查只读取本地文件。
// Resolve the conversation archive sidebar source; checks only read local files.
const rootDir = path.resolve(import.meta.dirname, "..");
const sidebarPath = path.join(rootDir, "src", "inject", "systems", "conversation-archive-sidebar", "index.js");
const archivePath = path.join(rootDir, "src", "inject", "systems", "conversation-archive", "index.js");
const tabDragToChatPath = path.join(rootDir, "src", "inject", "systems", "tab-drag-to-chat", "index.js");

function assert(condition, message) {
  // 这一段用明确错误终止检查，方便定位同步会话打开链路回归。
  // Fail with explicit messages so conversation archive open-flow regressions are easy to locate.
  if (!condition) throw new Error(message);
}

const source = await readFile(sidebarPath, "utf8");
const archiveSource = await readFile(archivePath, "utf8");
const tabDragToChatSource = await readFile(tabDragToChatPath, "utf8");
const previewPathSegment = "/.Codex-Pro-Launcher/conversation-archive-preview/";

function normalizePathForPreviewLinkCheck(value) {
  // 这一段复刻归档链接路径归一化规则，用来测试安全边界而不是依赖源码文本猜测。
  // Mirror archive-link path normalization so safety boundaries are tested instead of inferred from source text.
  let text = String(value || "").trim();
  try {
    text = decodeURIComponent(text);
  } catch {
    // 这一段保留无法解码的原始值，和运行时代码一样继续走严格路径匹配。
    // Keep undecodable raw values, matching runtime behavior before strict path checks.
  }
  return text
    .replace(/\\/gu, "/")
    .replace(/\/+$/u, "")
    .trim()
    .replace(/^file:local:/iu, "")
    .replace(/^file:\/\/\/?/iu, "")
    .replace(/^\/([A-Za-z]:\/)/u, "$1");
}

function matchesThinkingPreviewPathForCheck(value) {
  // 这一段用代表性用例验证 thinking 附件路径契约，覆盖外链、HTML、普通 Markdown 和 dot-segment 负例。
  // Validate the thinking attachment path contract with representative positive and negative cases.
  const normalizedPath = normalizePathForPreviewLinkCheck(value);
  const previewIndex = normalizedPath.toLowerCase().indexOf(previewPathSegment.toLowerCase());
  if (previewIndex < 0) return false;
  const previewRelativePath = normalizedPath.slice(previewIndex + previewPathSegment.length);
  const parts = previewRelativePath.split("/");
  if (parts.length !== 2) return false;
  const [directoryName, fileName] = parts;
  if (!directoryName || directoryName === "." || directoryName === "..") return false;
  return /^thinking-\d{3,6}-[a-f0-9]{12}\.md$/iu.test(fileName);
}

function extractFunctionSource(sourceText, signature) {
  // 这一段用括号计数提取函数正文，避免内部早返回或嵌套块让懒正则截短。
  // Extract function source with brace counting so early returns or nested blocks do not truncate it.
  const start = sourceText.indexOf(signature);
  if (start < 0) return "";
  const openBrace = sourceText.indexOf("{", start);
  if (openBrace < 0) return "";
  let depth = 0;
  for (let index = openBrace; index < sourceText.length; index += 1) {
    const char = sourceText[index];
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return sourceText.slice(start, index + 1);
    }
  }
  return "";
}

// 这一段提取打开函数正文，避免断言误扫到其它系统的相似逻辑。
// Extract the opener function body so assertions do not match similar logic from other systems.
const openFunctionSource = extractFunctionSource(source, "async function openLocalMarkdownInSidePanel(localPath)");

// 这一段固定回归点：同步会话不能依赖已挂载的当前对话窗口。
// Pin the regression point: synced sessions must not depend on a mounted current-thread window.
assert(openFunctionSource, "openLocalMarkdownInSidePanel should exist");
assert(
  !openFunctionSource.includes("if (scope && cwd)"),
  "conversation archive preview should not require a mounted thread scope and cwd before calling Codex opener",
);
assert(
  /function findConversationArchiveRouteScopeFromHost\(host\)/u.test(source) &&
    /findConversationArchiveRouteScopeFromHost\(host\)/u.test(source.match(/function findWorkspaceRouteScope\(\) \{[\s\S]*?\n  \}/u)?.[0] || ""),
  "conversation archive should have its own route-scope activation fallback",
);
assert(
  /if \(!scope\) \{[\s\S]*return false;[\s\S]*const module = await getWorkspaceFileModule\(\);/u.test(openFunctionSource),
  "conversation archive should use a route scope when calling the official side-panel opener",
);
assert(
  /module\.t\(\{[\s\S]*scope,[\s\S]*hostId: "local",[\s\S]*isPreview: true,[\s\S]*openInSidePanel: true,[\s\S]*path: workspacePath,[\s\S]*\}\);/u.test(openFunctionSource),
  "conversation archive should call the official side-panel opener with scope and openInSidePanel",
);
assert(
  /isPreview: true/u.test(openFunctionSource) &&
    /openInSidePanel: true/u.test(openFunctionSource),
  "conversation archive should open synced Markdown through the right-side Preview path",
);
assert(
  /openFile:\s*\(params\) => \{[\s\S]*usedOpenFileFallback = true;[\s\S]*blocked open-file fallback for conversation archive preview/u.test(openFunctionSource),
  "conversation archive should block the official open-file fallback so synced previews never launch external editors",
);
assert(
  !/tryOfficialSidePanelOpen|tabFallbackParams|previewFallbackParams|openFileFallbackParams/u.test(openFunctionSource),
  "conversation archive should not fall back from Preview to normal right-side tabs",
);
assert(
  !/findWorkspaceOpenFileHandler\(\)|Finally try Codex's native open-file path|native open-file fallback/u.test(openFunctionSource),
  "conversation archive should not use file-tree or native open-file fallbacks after Preview attempts",
);
assert(
  /data-codex-pro-conversation-archive-file-tree-hidden/u.test(source) &&
    /function isConversationArchivePreviewTabPanel\(panel\)/u.test(source) &&
    /function hideConversationArchivePreviewFileTree\(\)/u.test(source) &&
    /function scheduleConversationArchivePreviewFileTreeHide\(\)/u.test(source),
  "conversation archive should hide the file-tree column only for archive preview tabs",
);
assert(
  /panel\.querySelectorAll\("file-tree-container"\)/u.test(source) &&
    /\[role="tabpanel"\]\[data-app-shell-tab-panel-controller="right"\]\[data-tab-id\*="\/\.Codex-Pro-Launcher\/conversation-archive-preview\/"\] \[\$\{previewFileTreeHiddenAttribute\}\]/u.test(source) &&
    /column\.style\.removeProperty\("display"\)/u.test(source) &&
    /scheduleConversationArchivePreviewFileTreeHide\(\)/u.test(openFunctionSource),
  "conversation archive should suppress the right file tree with archive-tab-scoped CSS after successful Preview opens",
);
assert(
  /"home", "local-thread", "new-thread-panel", "other", "remote-thread"/u.test(source),
  "conversation archive route-scope detection should include new-thread and home route states",
);
assert(
  /function getConversationArchivePreviewDirectory\(panel\)/u.test(source) &&
    /data-tab-id/u.test(source) &&
    /conversationArchivePreviewPathSegment/u.test(source),
  "conversation archive thinking-link interception should derive the preview directory from the preview tab",
);
assert(
  /function normalizeConversationArchiveLocalPath\(value\)/u.test(source) &&
    /decodeConversationArchivePromptLink\(value\)/u.test(source) &&
    /\^file:local:/u.test(source) &&
    /\^file:\\\/\\\/\\\/\?/u.test(source),
  "conversation archive local path normalization should accept encoded file:local and file URI link shapes",
);
assert(
  /function isConversationArchiveThinkingPreviewPath\(value\)/u.test(source) &&
    /thinking-\\d\{3,6\}-\[a-f0-9\]\{12\}\\\.md/u.test(source) &&
    /directoryName === "\." \|\| directoryName === "\.\."/u.test(source) &&
    !/data-prompt-link-label/u.test(source),
  "conversation archive thinking-link interception should match thinking attachment paths structurally without prompt labels",
);
assert(
  /function resolveConversationArchiveThinkingLinkPath\(linkTarget, panel\)/u.test(source) &&
    /getConversationArchivePreviewDirectory\(panel\)/u.test(source) &&
    /\^thinking-\\d\{3,6\}-\[a-f0-9\]\{12\}\\\.md\$/u.test(source) &&
    /normalizedPreviewDirectory/u.test(source) &&
    /normalizedTarget\.toLowerCase\(\)\.startsWith\(normalizedPreviewDirectory\.toLowerCase\(\)\)/u.test(source),
  "conversation archive thinking-link interception should accept only current preview-directory paths",
);
assert(
    matchesThinkingPreviewPathForCheck("C:/Users/example/.codex/.Codex-Pro-Launcher/conversation-archive-preview/thread-title/thinking-001-abcdef123456.md") &&
    matchesThinkingPreviewPathForCheck("file:local:/C:/Users/example/.codex/.Codex-Pro-Launcher/conversation-archive-preview/thread%20title/thinking-001-abcdef123456.md") &&
    matchesThinkingPreviewPathForCheck("file:///C:/Users/example/.codex/.Codex-Pro-Launcher/conversation-archive-preview/thread%20title/thinking-001-abcdef123456.md") &&
    matchesThinkingPreviewPathForCheck("X:/Example/Codex-Pro/.codex/.Codex-Pro-Launcher/conversation-archive-preview/thread-title/thinking-001-abcdef123456.md") &&
    !matchesThinkingPreviewPathForCheck("https://example.com/thinking-001-abcdef123456.md") &&
    !matchesThinkingPreviewPathForCheck("/C:/Users/example/Documents/index.html") &&
    !matchesThinkingPreviewPathForCheck("C:/Users/example/.codex/.Codex-Pro-Launcher/conversation-archive-preview/thread-title/notes.md") &&
    !matchesThinkingPreviewPathForCheck("C:/Users/example/.codex/.Codex-Pro-Launcher/conversation-archive-preview/../thinking-001-abcdef123456.md"),
  "conversation archive thinking-link path contract should reject external, html, normal markdown, and dot-segment paths",
);
assert(
  /function getConversationArchiveThinkingLinkFromEvent\(event\)/u.test(source) &&
    /\[data-file-reference="true"\]\[data-prompt-link-href\]/u.test(source) &&
    /isConversationArchivePreviewTabPanel\(panel\)/u.test(source),
  "conversation archive thinking-link interception should only target Codex file-reference buttons inside archive preview tabs",
);
assert(
  /function handleConversationArchivePreviewLinkClick\(event\)/u.test(source) &&
    /event\.button !== 0/u.test(source) &&
    /function handleConversationArchivePreviewLinkKeydown\(event\)/u.test(source) &&
    /event\.key !== "Enter" && event\.key !== " "/u.test(source) &&
    /document\.addEventListener\("click", handleConversationArchivePreviewLinkClick, \{ capture: true, signal: controller\.signal \}\)/u.test(source) &&
    /document\.addEventListener\("keydown", handleConversationArchivePreviewLinkKeydown, \{ capture: true, signal: controller\.signal \}\)/u.test(source),
  "conversation archive thinking-link interception should capture mouse and keyboard activation through lifecycle-scoped listeners",
);

// 这一段固定弹出框交互：首次贴住左侧栏右边缘和左下角入口底部，但之后不能再跟随侧栏自动隐藏。
// Pin the popup interaction: first open attaches to the sidebar edge and lower-left entry bottom, but later behavior must not auto-follow or auto-hide with the sidebar.
assert(
  /function getDefaultPanelPosition\(root, panel\)/u.test(source) &&
    /sidebarRect\?\.right \|\| 320/u.test(source) &&
    /rootRect\?\.bottom \|\| sidebarRect\?\.bottom \|\| window\.innerHeight - panelViewportMargin/u.test(source) &&
    /const top = anchorBottom - panelHeight/u.test(source),
  "conversation archive popup should keep sidebar-adjacent and bottom-aligned first-open placement",
);
assert(
  /function beginPanelDrag\(event, panel\)/u.test(source) &&
    /data-codex-pro-sync-dragging/u.test(source) &&
    /window\.addEventListener\("pointermove", movePanel/u.test(source),
  "conversation archive popup should support dragging from the header",
);
assert(
  /function closePanelFromOutside\(event\)/u.test(source) &&
    /document\.addEventListener\("click", closePanelFromOutside, \{ capture: true, signal: controller\.signal \}\)/u.test(source) &&
    /eventPath\.includes\(panel\)/u.test(source) &&
    /eventPath\.includes\(threadPanel\)/u.test(source),
  "conversation archive popup should close from outside clicks without closing from its own controls",
);
assert(
  /conversationArchiveSidebarDirectoryPanelMode/u.test(source) &&
    /function getConversationArchiveSidebarDirectoryPanelMode\(\)/u.test(source) &&
    /function isHoverDirectoryPanelMode\(\)/u.test(source) &&
    /devicePanelCloseTimer: 0/u.test(source) &&
    /function isPointerInsideDirectoryHoverRegion\(\)/u.test(source) &&
    /function isPointerInsideThreadHoverRegion\(\)/u.test(source) &&
    /function scheduleDevicePanelHoverClose\(\)/u.test(source) &&
    /function openDirectoryPanelDevice\(device, \{ pinned = true, refresh = false \} = \{\}\)/u.test(source) &&
    /function previewDirectoryPanelDevice\(device\)/u.test(source) &&
    /button\.addEventListener\("pointerenter", \(event\) => \{[\s\S]*previewDirectoryPanelDevice\(device\);/u.test(source) &&
    !/button\.addEventListener\("pointerenter", \(event\) => \{[\s\S]*clearThreadPanelHoverCloseTimer\(\);[\s\S]*previewDirectoryPanelDevice\(device\);/u.test(source) &&
    /button\.addEventListener\("pointerleave", \(event\) => \{[\s\S]*scheduleDevicePanelHoverClose\(\);/u.test(source) &&
    /state\.isDevicePinned = pinned \? !shouldUnpinDevice : false/u.test(source) &&
    /state\.isDevicePinned = !isHoverDirectoryPanelMode\(\)/u.test(source) &&
    /isPointerInsideDirectoryHoverRegion\(\) \|\|[\s\S]*state\.activeThreadPanelWorkCount > 0/u.test(source) &&
    /isPointerInsideThreadHoverRegion\(\) \|\|[\s\S]*state\.activeThreadPanelWorkCount > 0/u.test(source) &&
    /const isInsideDirectoryHoverRegion = isPointerInsideDirectoryHoverRegion\(\);[\s\S]*const isInsideThreadHoverRegion = isPointerInsideThreadHoverRegion\(\);[\s\S]*if \(hadActiveThreadDrag && !isInsideDirectoryHoverRegion\) \{[\s\S]*scheduleDevicePanelHoverClose\(\);[\s\S]*if \(hadActiveThreadDrag && !isInsideThreadHoverRegion\) \{[\s\S]*scheduleThreadPanelHoverClose\(\);/u.test(source),
  "conversation archive popup should support a separate hover/click mode for the left directory panel",
);
assert(
  !/detachedPanelCheckTimers|scheduleDetachedPanelChecks|closeDetachedPanel|function updatePanelPlacement|codex-pro-sync-panel-left|codex-pro-sync-panel-top/u.test(source),
  "conversation archive popup should not keep sidebar auto-hide or follow-position logic",
);
assert(
  /const threadPanelId = "codex-pro-conversation-archive-thread-panel"/u.test(source) &&
    /function ensureThreadPanel\(\)/u.test(source) &&
    /function renderThreadPanel\(panel\)/u.test(source) &&
    /function renderPanel\(panel\)/u.test(source) &&
    /panelProfileId: ""/u.test(source) &&
    /panelGroupKey: ""/u.test(source) &&
    /getProfileGroups\(profile\)/u.test(source) &&
    /archiveGroupDisplayName/u.test(source) &&
    /title\.textContent = group\.archiveGroupDisplayName \|\| group\.archiveGroupName \|\| i18n\.t\("syncSidebar\.group\.conversations"\)/u.test(source) &&
    /function renderProfilePicker\(panel, device, profile, profiles\)/u.test(source) &&
    /const profileMenuId = "codex-pro-conversation-archive-profile-menu"/u.test(source) &&
    /isProfileMenuOpen: false/u.test(source) &&
    /function ensureProfileMenu\(\)/u.test(source) &&
    /document\.body\.append\(menu\)/u.test(source) &&
    /function positionProfileMenu\(menu, trigger\)/u.test(source) &&
    /const upTop = triggerRect\.top - menuRect\.height - gap/u.test(source) &&
    /const top = Math\.max\(panelViewportMargin, upTop\)/u.test(source) &&
    !/const downTop = triggerRect\.bottom \+ gap/u.test(source) &&
    /function syncProfileMenuSurface\(menu, panel\)/u.test(source) &&
    /menu\.style\.setProperty\("--codex-pro-sync-surface", panelBackground\)/u.test(source) &&
    /syncProfileMenuSurface\(menu, panel\)/u.test(source) &&
    /function renderProfileMenu\(\)/u.test(source) &&
    /renderProfileMenu\(\);/u.test(source) &&
    /codex-pro-sync-profile-trigger/u.test(source) &&
    /codex-pro-sync-profile-menu/u.test(source) &&
    /codex-pro-sync-profile-option/u.test(source) &&
    /selectPanelProfile\(item\.profileId \|\| "", device\)/u.test(source) &&
    /codex-pro-sync-group-button/u.test(source) &&
    /runtime\.dom\.ensureNativePanelTokens\?\.\(\);/u.test(source) &&
    /runtime\.dom\.upsertStyle\(styleId,/u.test(source) &&
    /--codex-pro-sync-surface: var\(--codex-pro-native-panel-surface\);/u.test(source) &&
    /--codex-pro-sync-border: var\(--codex-pro-native-panel-border\);/u.test(source) &&
    /--codex-pro-sync-row-hover: var\(--codex-pro-native-panel-hover\);/u.test(source) &&
    /#\$\{panelId\} \{[\s\S]*background: var\(--codex-pro-sync-surface\);[\s\S]*border: 1px solid var\(--codex-pro-sync-border\);[\s\S]*backdrop-filter: blur\(var\(--codex-pro-native-panel-blur\)\);/u.test(source) &&
    /#\$\{profileMenuId\}\.codex-pro-sync-profile-menu \{[\s\S]*background: var\(--codex-pro-sync-surface\);[\s\S]*border: 1px solid var\(--codex-pro-sync-border\);[\s\S]*position: fixed[\s\S]*backdrop-filter: blur\(var\(--codex-pro-native-panel-blur\)\);/u.test(source) &&
    /#\$\{profileMenuId\} \.codex-pro-sync-profile-option:hover,[\s\S]*background: var\(--codex-pro-sync-row-hover\);/u.test(source) &&
    !/picker\.append\(menu\)/u.test(source) &&
    !/chevron\.textContent/u.test(source) &&
    !/document\.createElement\("select"\)/u.test(source),
  "conversation archive popup should render a Codex-style profile menu, directory groups, and a following thread panel",
);
assert(
  /function appendTrashIcon\(button\)/u.test(source) &&
    /await runtime\.dialogs\.confirm\(\{/u.test(source) &&
    /confirmKind: "danger"/u.test(source) &&
    /signal: controller\.signal/u.test(source) &&
    !/window\.confirm/u.test(source) &&
    /function deleteDeviceArchive\(device\)/u.test(source) &&
    /conversationArchive\.deleteRemoteDeviceArchive/u.test(source) &&
    /function removeDeviceFromLocalSnapshot\(deviceId, visibleAfterRevision = Number\.POSITIVE_INFINITY\)/u.test(source) &&
    /deviceDeletePending: false/u.test(source) &&
    /localDeviceDeletePending: false/u.test(source) &&
    /localDeviceUploadBlockedAfterDelete: false/u.test(source) &&
    /function isDeviceDeleteLocked\(\)/u.test(source) &&
    /function syncLocalDeviceDeleteState\(data\)/u.test(source) &&
    /locallyHiddenDeviceIds: new Map\(\)/u.test(source) &&
    /function filterLocallyHiddenArchiveSnapshot\(snapshot\)/u.test(source) &&
    /function rememberLocallyHiddenDevice\(deviceId, visibleAfterRevision = Number\.POSITIVE_INFINITY\)/u.test(source) &&
    /return snapshotRevision > hiddenUntilRevision/u.test(source) &&
    /const nextSnapshot = filterLocallyHiddenArchiveSnapshot\(snapshot\)/u.test(source) &&
    /state\.locallyHiddenDeviceIds\.clear\(\)/u.test(source) &&
    /removeDeviceFromLocalSnapshot\(deviceId, data\?\.revision\);[\s\S]*setStatus\(i18n\.t\("syncSidebar\.deleteDevice\.status\.deleted"\)/u.test(source) &&
    /data\?\.deletePending[\s\S]*syncSidebar\.deleteDevice\.status\.pending/u.test(source) &&
    /const hiddenLocally = removeDeviceFromLocalSnapshot\(deviceId\)/u.test(source) &&
    /refreshButton\.disabled = isArchiveSidebarBusy\(\) \|\| isDeviceDeleteLocked\(\) \|\| !hasSyncConfig\(\)/u.test(source) &&
    /deviceDeletePending[\s\S]*uploadFirst = false/u.test(source) &&
    /deviceDeletePending \|\| state\.localDeviceUploadBlockedAfterDelete/u.test(source) &&
    /const isHiddenLocally = removeDeviceFromLocalSnapshot\(deviceId\) \|\| hiddenLocally/u.test(source) &&
    /syncSidebar\.deleteDevice\.status\.localOnly/u.test(source) &&
    /deleteButton\.className = "codex-pro-sync-panel-action"/u.test(source),
  "conversation archive popup should delete a remote device, block refresh while deleting, and hide it locally when remote deletion fails",
);
assert(
  /#\$\{threadPanelId\} \.codex-pro-sync-status \{[\s\S]*flex: 0 0 44px;[\s\S]*height: 44px;[\s\S]*line-height: 44px;[\s\S]*min-height: 44px;[\s\S]*white-space: nowrap;/u.test(source) &&
    /#\$\{threadPanelId\} \.codex-pro-sync-status\[data-tone="idle"\]/u.test(source) &&
    /const statusText = state\.statusMessage \|\| i18n\.t\("syncSidebar\.status\.idle"\)/u.test(source) &&
    /status\.dataset\.tone = state\.statusMessage \? state\.statusTone : "idle"/u.test(source) &&
    /panel\.append\(header\);\s*panel\.append\(status\);\s*panel\.append\(list\);/u.test(source) &&
    !/if \(statusText\) panel\.append\(status\)/u.test(source),
  "conversation archive thread panel should reserve a fixed status row so the thread list does not jump",
);
assert(
  /threadListScrollByGroupKey: new Map\(\)/u.test(source) &&
    /function getSelectedGroupScrollKey\(groupKey = state\.panelGroupKey\)/u.test(source) &&
    /function readThreadListScrollSnapshot\(panel = document\.getElementById\(threadPanelId\)\)/u.test(source) &&
    /panel instanceof HTMLElement\) \|\| panel\.hidden/u.test(source) &&
    /anchorPath = button instanceof HTMLElement \? button\.dataset\.codexProSyncThreadPath \|\| "" : ""/u.test(source) &&
    /function rememberThreadListScroll\(panel = document\.getElementById\(threadPanelId\)\)/u.test(source) &&
    /state\.threadListScrollByGroupKey\.set\(snapshot\.scrollKey, snapshot\.value\)/u.test(source) &&
    /function restoreThreadListScroll\(list, snapshot\)/u.test(source) &&
    /button\.dataset\.codexProSyncThreadPath === anchorPath/u.test(source) &&
    /list\.scrollTop = Math\.max\(0, Number\(snapshot\.scrollTop\) \|\| 0\)/u.test(source) &&
    /rememberThreadListScroll\(\);[\s\S]*state\.isPanelOpen = false/u.test(source) &&
    /rememberThreadListScroll\(\);[\s\S]*state\.panelDeviceId = deviceId/u.test(source) &&
    /button\.dataset\.codexProSyncThreadPath = thread\.path \|\| ""/u.test(source) &&
    /currentThreadListScroll = previousGroupKey === currentGroupKey[\s\S]*readThreadListScrollSnapshot\(panel\)\?\.value/u.test(source) &&
    /const rememberedThreadListScroll = currentThreadListScroll \|\| state\.threadListScrollByGroupKey\.get\(currentGroupKey\) \|\| null/u.test(source) &&
    /restoreThreadListScroll\(list, rememberedThreadListScroll\)/u.test(source),
  "conversation archive popup should remember per-directory thread-list anchors across close and reopen",
);
assert(
  /function clearThreadListScrollMemory\(\)/u.test(source) &&
    /state\.threadListScrollByGroupKey\.clear\(\)/u.test(source) &&
    /delete panel\.dataset\.codexProSyncDeviceId/u.test(source) &&
    /panel\.replaceChildren\(\)/u.test(source) &&
    /delete threadPanel\.dataset\.codexProSyncGroupKey/u.test(source) &&
    /state\.activeThreadPath = "";[\s\S]*clearThreadListScrollMemory\(\);[\s\S]*scheduleStartupAutoSync\(\)/u.test(source),
  "conversation archive popup should clear scroll memory and stale panel DOM when sync config changes",
);
assert(
  /function getArchiveRevision\(value\)/u.test(source) &&
    /function isArchiveSnapshotCurrent\(\)/u.test(source) &&
    /function saveConversationArchiveMetadata\(data\)/u.test(source) &&
    /const currentSettings = settingsApi\.getSettings\(\);/u.test(source) &&
    !/const currentSettings = state\.latestSettings \|\| settingsApi\.getSettings\(\);/u.test(source) &&
    /isSavingArchiveMetadata: false/u.test(source) &&
    /function formatSidebarHeading\(\)/u.test(source) &&
    /heading\.textContent = formatSidebarHeading\(\)/u.test(source) &&
    /state\.snapshot && isArchiveSnapshotCurrent\(\)/u.test(source) &&
    /const revisionChanged = getArchiveRevision\(previous\.conversationArchiveRevision\) !== getArchiveRevision\(nextSettings\.conversationArchiveRevision\)/u.test(source) &&
    /else if \(revisionChanged && !state\.isSavingArchiveMetadata\) \{[\s\S]*scheduleRefresh\(true\)/u.test(source) &&
    /void refreshArchive\(\{ force: false \}\)/u.test(source),
  "conversation archive popup should refresh stale snapshots after archive revision changes or panel open",
);
assert(
  /const conversationArchiveStatusEventName = "codex-pro:conversation-archive-status"/u.test(source) &&
    /function handleConversationArchiveStatusEvent\(event\)/u.test(source) &&
    /window\.addEventListener\(conversationArchiveStatusEventName, handleConversationArchiveStatusEvent/u.test(source) &&
    /if \(state\.statusSource && state\.statusSource !== "auto"\) return;/u.test(source) &&
    /const conversationArchiveStatusEventName = "codex-pro:conversation-archive-status"/u.test(archiveSource) &&
    /function emitConversationArchiveStatus\(message, tone, kind, snapshot = null, progress = null\)/u.test(archiveSource) &&
    /function didAutoPushConfigChange\(previousSettings, nextSettings\)/u.test(archiveSource) &&
    /conversationArchiveRevision/u.test(archiveSource) === false &&
    /if \(didAutoPushConfigChange\(previousSettings, nextSettings\)\) scheduleAutoPush\(\);/u.test(archiveSource) &&
    /emitConversationArchiveStatus\(i18n\.t\("syncSidebar\.status\.uploading"\), "", "uploading"\)/u.test(archiveSource) &&
    /const data = await pushLocalArchive\(/u.test(archiveSource) &&
    /onProgress: \(progress\) => \{[\s\S]*emitConversationArchiveStatus\(i18n\.t\("syncSidebar\.status\.uploading"\), "", "uploading", null, progress\);[\s\S]*\}/u.test(archiveSource) &&
    /emitConversationArchiveStatus\(i18n\.t\("syncSidebar\.status\.autoUploaded"\), "success", "success", data\)/u.test(archiveSource),
  "conversation archive sidebar should receive manual and automatic sync status updates",
);
assert(
  /refreshButton\.addEventListener\("click", \(\) => \{[\s\S]*refreshArchive\(\{ force: true, uploadFirst: true \}\)/u.test(source) &&
    /async function refreshArchive\(\{ force = false, uploadFirst = false \} = \{\}\)/u.test(source) &&
    /conversationArchive\.pushLocalArchive\(\{[\s\S]*force: true/u.test(source) &&
    /const data = await conversationArchive\.listArchive\(config\)/u.test(source) &&
    /const uploadSnapshot = filterLocallyHiddenArchiveSnapshot\(uploadData\);[\s\S]*saveConversationArchiveMetadata\(uploadSnapshot\);[\s\S]*state\.snapshot = uploadSnapshot;/u.test(source) &&
    /const listSnapshot = filterLocallyHiddenArchiveSnapshot\(data\);[\s\S]*saveConversationArchiveMetadata\(listSnapshot\);[\s\S]*state\.snapshot = listSnapshot;/u.test(source),
  "conversation archive sidebar refresh button should upload local sessions before refreshing the remote list",
);
assert(
  /isStartupAutoSyncing: false/u.test(source) &&
    /startupAutoSyncTimer: 0/u.test(source) &&
    /function isArchiveSidebarBusy\(\)/u.test(source) &&
    /function runStartupAutoSync\(\)/u.test(source) &&
    /conversationArchive\.pushLocalArchive\(\{[\s\S]*force: false/u.test(extractFunctionSource(source, "async function runStartupAutoSync()")) &&
    /applyAutoArchiveSnapshot\(uploadData\)/u.test(source) &&
    /uploadData\?\.deviceDeletePending[\s\S]*syncSidebar\.deleteDevice\.status\.pending/u.test(source) &&
    /skippedLocalUpload[\s\S]*syncSidebar\.status\.refreshed/u.test(source) &&
    /if \(!applied\) scheduleRefresh\(true\)/u.test(source) &&
    /function scheduleStartupAutoSync\(delayMs = refreshDelayMs\)/u.test(source) &&
    /refreshButton\.disabled = isArchiveSidebarBusy\(\) \|\| isDeviceDeleteLocked\(\) \|\| !hasSyncConfig\(\)/u.test(source) &&
    /isArchiveSidebarBusy\(\) && !state\.snapshot/u.test(source) &&
    /render\(\);\s*scheduleStartupAutoSync\(\);/u.test(source) &&
    /window\.clearTimeout\(state\.startupAutoSyncTimer\)/u.test(source),
  "conversation archive sidebar should try a non-forced local upload on startup before showing an empty remote list",
);
assert(
  !/function formatArchiveLifecycleLabel/u.test(source) &&
    !/lifecycleText/u.test(source) &&
    /meta\.textContent = `\$\{timeText \|\| i18n\.t\("common\.unknownTime"\)\} · \$\{formatArchiveBytes\(thread\.markdownBytes\)\}`/u.test(source) &&
    !/common\.messageCount/u.test(extractFunctionSource(source, "function renderThreadPanel(panel)")),
  "conversation archive popup thread metadata should show only time and size",
);
assert(
  /const tabDragToChat = runtime\.systemModules\.tabDragToChat \?\?= \{\};/u.test(tabDragToChatSource) &&
    /function createLocalFileAttachment\(path, label = ""\)/u.test(tabDragToChatSource) &&
    /function findComposerControllerFromElement\(element\)/u.test(tabDragToChatSource) &&
    /props\.composerInput\?\.props\?\.children\?\.props\?\.composerController/u.test(tabDragToChatSource) &&
    /function createPastedFileLike\(attachment\)/u.test(tabDragToChatSource) &&
    /new File\(\[new Uint8Array\(\[0\]\)\], name/u.test(tabDragToChatSource) &&
    /Object\.defineProperties\(file, \{[\s\S]*fsPath:[\s\S]*path:/u.test(tabDragToChatSource) &&
    /controller\.eventEmitter\.emit\("pasted-files", \[pastedFile\]\)/u.test(tabDragToChatSource) &&
    /const attachmentApi = \{[\s\S]*addLocalFileAttachment: addAttachmentToComposer,[\s\S]*createLocalFileAttachment,[\s\S]*isComposerDropEvent: \(event\) => isPointInElement\(event, findComposerDropRegion\(\)\),[\s\S]*\};/u.test(tabDragToChatSource) &&
    /Object\.assign\(tabDragToChat, attachmentApi\)/u.test(tabDragToChatSource) &&
    /for \(const \[key, value\] of Object\.entries\(attachmentApi\)\) \{[\s\S]*if \(tabDragToChat\[key\] === value\) delete tabDragToChat\[key\];/u.test(tabDragToChatSource) &&
    !/setFileAttachments/u.test(tabDragToChatSource) &&
    !/onAddLocalFileAttachments/u.test(tabDragToChatSource),
  "tab drag system should expose a shared local-file helper through Codex's pasted-files composer controller",
);
assert(
  /const conversationArchiveThreadDragDataType = "application\/x-codex-pro-conversation-archive-thread"/u.test(source) &&
    /const conversationArchiveAttachmentPointerThresholdPx = 8/u.test(source) &&
    /activeArchivePointerDrag: null/u.test(source) &&
    /activeArchiveThreadDrag: null/u.test(source) &&
    /function getArchiveThreadAttachmentApi\(\)/u.test(source) &&
    /runtime\.systemModules\.tabDragToChat/u.test(source) &&
    /typeof attachmentApi\?\.addLocalFileAttachment !== "function"/u.test(source) &&
    /typeof attachmentApi\?\.isComposerDropEvent !== "function"/u.test(source) &&
    /function isArchiveThreadComposerDropEvent\(event\)/u.test(source) &&
    /getArchiveThreadAttachmentApi\(\)\?\.isComposerDropEvent\(event\)/u.test(source) &&
    /function handleArchiveThreadDragStart\(event, thread\)/u.test(source) &&
    /event\.dataTransfer\?\.setData\?\.\(conversationArchiveThreadDragDataType, thread\.path\)/u.test(source) &&
    !/setData\?\.\("text\/plain"/u.test(source) &&
    /function handleArchiveThreadDrop\(event\)/u.test(source) &&
    /clearArchiveThreadDrag\(\);[\s\S]*void attachArchiveThreadToComposer\(thread\);/u.test(source) &&
    /function finishArchiveThreadPointerDrag\(event\)/u.test(source) &&
    /void attachArchiveThreadToComposer\(drag\.thread\);/u.test(source) &&
    /button\.draggable = true/u.test(source) &&
    /button\.addEventListener\("dragstart", \(event\) => \{[\s\S]*handleArchiveThreadDragStart\(event, thread\);/u.test(source) &&
    /button\.addEventListener\("pointerdown", \(event\) => \{[\s\S]*startArchiveThreadPointerDrag\(event, thread\);/u.test(source) &&
    /document\.addEventListener\("dragover", handleArchiveThreadDragOver, \{ capture: true, signal: controller\.signal \}\)/u.test(source) &&
    /document\.addEventListener\("drop", handleArchiveThreadDrop, \{ capture: true, signal: controller\.signal \}\)/u.test(source) &&
    /document\.addEventListener\("pointerup", finishArchiveThreadPointerDrag, \{ capture: true, signal: controller\.signal \}\)/u.test(source),
  "conversation archive thread rows should be draggable into the composer through the shared attachment helper",
);
assert(
  /async function attachArchiveThreadToComposer\(thread\)/u.test(source) &&
    /const initialAttachmentApi = getArchiveThreadAttachmentApi\(\);/u.test(source) &&
    /conversationArchive\.prepareArchiveFile\(\{[\s\S]*path: thread\.path,[\s\S]*\}\)/u.test(source) &&
    /const attachmentApi = getArchiveThreadAttachmentApi\(\);/u.test(source) &&
    /attachmentApi\.createLocalFileAttachment\(localPath, getArchiveThreadTitle\(thread\)\)/u.test(source) &&
    /if \(!attachmentApi\.addLocalFileAttachment\(attachment\)\) \{/u.test(source) &&
    /setStatus\(i18n\.t\("syncSidebar\.status\.attached"\), "success", "success"\)/u.test(source),
  "conversation archive drop should append the unpacked Markdown as a normal local-file attachment without custom dedupe",
);

// 这一段输出简短成功标记，方便 npm check 聚合展示。
// Print a short success marker for npm check aggregation.
console.log("conversation archive sidebar checks passed");
