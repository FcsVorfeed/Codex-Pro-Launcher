import { readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";

const rootDir = path.resolve(import.meta.dirname, "..");
const navigationUtilsPath = path.join(rootDir, "src", "inject", "systems", "diff-hover-preview", "navigation-utils.js");
const diffHoverIndexPath = path.join(rootDir, "src", "inject", "systems", "diff-hover-preview", "index.js");
const injectionManifestPath = path.join(rootDir, "src", "launcher", "injection-manifest.mjs");

function assert(condition, message) {
  // 这一段用明确错误终止检查，方便定位行导航解析回归。
  // Fail with explicit messages so line-navigation parsing regressions are easy to locate.
  if (!condition) throw new Error(message);
}

function assertRanges(actual, expected, label) {
  // 这一段只比较公开的 line/endLine 字段，避免跨 VM 的对象原型影响断言。
  // Compare only public line/endLine fields so cross-VM object prototypes do not affect assertions.
  const normalizedActual = Array.from(actual || []).map((range) => ({
    line: range.line,
    endLine: range.endLine,
  }));
  assert(
    JSON.stringify(normalizedActual) === JSON.stringify(expected),
    `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(normalizedActual)}`,
  );
}

const windowObject = {
  __codexProRuntime: {
    systemModules: {},
  },
};
const context = vm.createContext({
  console,
  window: windowObject,
});

const source = await readFile(navigationUtilsPath, "utf8");
const indexSource = await readFile(diffHoverIndexPath, "utf8");
const manifestSource = await readFile(injectionManifestPath, "utf8");
vm.runInContext(source, context, { filename: navigationUtilsPath });

const navigation = windowObject.__codexProRuntime.systemModules.diffHoverPreviewNavigation;
assert(navigation, "diff hover navigation utility should be registered");
assert(typeof navigation.parseUnifiedDiffNavigationRanges === "function", "parseUnifiedDiffNavigationRanges should be exposed");
assert(typeof navigation.normalizeNavigationRanges === "function", "normalizeNavigationRanges should be exposed");
assert(typeof navigation.firstNavigationRange === "function", "firstNavigationRange should be exposed");
assert(typeof navigation.findWorkspaceRouteScope === "function", "findWorkspaceRouteScope should be exposed");
assert(typeof navigation.getPreviewNavigationPlacement === "function", "getPreviewNavigationPlacement should be exposed");

const parsedRanges = navigation.parseUnifiedDiffNavigationRanges(`
diff --git a/src/app.js b/src/app.js
--- a/src/app.js
+++ b/src/app.js
@@ -8,0 +10,2 @@
+const first = true;
+const second = true;
@@ -28,2 +30,1 @@
-const oldValue = false;
+const newValue = true;
diff --git a/src/delete-only.js b/src/delete-only.js
--- a/src/delete-only.js
+++ b/src/delete-only.js
@@ -4,1 +4,0 @@
-const removed = true;
diff --git a/src/renamed-old.js b/src/renamed-new.js
rename from src/renamed-old.js
rename to src/renamed-new.js
--- a/src/renamed-old.js
+++ b/src/renamed-new.js
@@ -2,0 +3,1 @@
+export const renamed = true;
`);

assertRanges(parsedRanges.get("src/app.js"), [
  { line: 10, endLine: 11 },
  { line: 30, endLine: 30 },
], "modified file ranges");
assertRanges(parsedRanges.get("src/delete-only.js"), [
  { line: 4, endLine: 4 },
], "delete-only hunk ranges");
assertRanges(parsedRanges.get("src/renamed-new.js"), [
  { line: 3, endLine: 3 },
], "renamed file ranges");

const normalizedRanges = navigation.normalizeNavigationRanges([
  { line: 0, endLine: 2 },
  { line: 5, endLine: 4 },
  { line: 8, endLine: 9 },
  { line: Number.NaN, endLine: 12 },
]);
assertRanges(normalizedRanges, [
  { line: 5, endLine: 5 },
  { line: 8, endLine: 9 },
], "normalized ranges");

const manyRanges = navigation.normalizeNavigationRanges(
  Array.from({ length: 240 }, (_, index) => ({ line: index + 1, endLine: index + 1 })),
);
assert(manyRanges.length === 200, "navigation ranges should be capped at 200 entries");
assert(navigation.firstNavigationRange({ navigationRanges: manyRanges }).line === 1, "firstNavigationRange should return the first range");
assert(navigation.firstNavigationRange({ navigationRanges: [] }) === null, "firstNavigationRange should return null without ranges");

const expectedScope = {
  chain: [],
  get() {},
  node: {},
  queryClient: {},
  set() {},
  value: {
    conversationId: "conversation-with-scope",
    routeKind: "local-thread",
  },
};
const unrelatedScope = {
  chain: [],
  get() {},
  node: {},
  queryClient: {},
  set() {},
  value: {
    conversationId: "other-conversation",
    routeKind: "local-thread",
  },
};
const anchorWithoutScope = { name: "environment-anchor" };
const anchorWithOwnScope = { name: "thread-anchor" };
const anchorWithBlockedFrame = { name: "cross-origin-frame-anchor" };
const fallbackHostWithScope = { name: "file-tree-host" };
const fallbackHostWithOtherThread = { name: "other-thread-host" };
const blockedFrameWindow = new Proxy({}, {
  // 这一段模拟跨域 Window：命名属性和 ownKeys 都会被浏览器安全边界拒绝。
  // Simulate a cross-origin Window whose named properties and ownKeys are blocked by the browser security boundary.
  get() {
    throw new Error("Blocked a frame from accessing a cross-origin frame.");
  },
  ownKeys() {
    throw new Error("Blocked a frame from enumerating a cross-origin frame.");
  },
});
const blockedRouteScope = {
  chain: [],
  get() {},
  node: {},
  queryClient: {},
  set() {},
  value: new Proxy({}, {
    // 这一段模拟 route 对象自身属性被安全边界拒绝。
    // Simulate the security boundary blocking properties on the route object itself.
    get() {
      throw new Error("Route property access blocked.");
    },
  }),
};
const blockedPrototypeObject = new Proxy({}, {
  // 这一段模拟 instanceof 触发 Proxy getPrototypeOf 陷阱。
  // Simulate instanceof triggering a Proxy getPrototypeOf trap.
  getPrototypeOf() {
    throw new Error("Prototype access blocked.");
  },
});
const fibersByHost = new Map([
  [anchorWithoutScope, { memoizedProps: { label: "Changes" } }],
  [anchorWithOwnScope, { memoizedState: { routeScope: expectedScope } }],
  [anchorWithBlockedFrame, {
    dependencies: blockedPrototypeObject,
    memoizedState: blockedFrameWindow,
    updateQueue: blockedRouteScope,
  }],
  [fallbackHostWithScope, { memoizedState: { routeScope: expectedScope } }],
  [fallbackHostWithOtherThread, { memoizedState: { routeScope: unrelatedScope } }],
]);
const foundFallbackScope = navigation.findWorkspaceRouteScope(anchorWithoutScope, {
  conversationId: "conversation-with-scope",
}, {
  getFallbackHosts: () => [fallbackHostWithOtherThread, fallbackHostWithScope],
  getReactFiber: (host) => fibersByHost.get(host) || null,
});
assert(foundFallbackScope === expectedScope, "findWorkspaceRouteScope should use fallback hosts when the anchor has no scope");
const missingConversationFallbackScope = navigation.findWorkspaceRouteScope(anchorWithoutScope, {}, {
  getFallbackHosts: () => [fallbackHostWithScope],
  getReactFiber: (host) => fibersByHost.get(host) || null,
});
assert(
  missingConversationFallbackScope === null,
  "findWorkspaceRouteScope should not use fallback hosts without a matching conversation id",
);
const ownScopeWithoutConversation = navigation.findWorkspaceRouteScope(anchorWithOwnScope, {}, {
  getFallbackHosts: () => [],
  getReactFiber: (host) => fibersByHost.get(host) || null,
});
assert(
  ownScopeWithoutConversation === expectedScope,
  "findWorkspaceRouteScope should still accept a scope found on the anchor without fallback conversation metadata",
);
const scopeAfterBlockedFrame = navigation.findWorkspaceRouteScope(anchorWithBlockedFrame, {
  conversationId: "conversation-with-scope",
}, {
  getFallbackHosts: () => [fallbackHostWithScope],
  getReactFiber: (host) => fibersByHost.get(host) || null,
});
assert(
  scopeAfterBlockedFrame === expectedScope,
  "findWorkspaceRouteScope should skip blocked cross-origin objects and continue to a valid fallback scope",
);

const previewPlacement = navigation.getPreviewNavigationPlacement(
  { left: 720, top: 240, right: 1280, bottom: 1040, width: 560, height: 800 },
  { width: 40, height: 116 },
  { width: 1296, height: 1142 },
);
assert(previewPlacement.left === 1224, `preview navigator should sit inside the preview right edge, got left=${previewPlacement.left}`);
assert(previewPlacement.top === 252, `preview navigator should sit near the preview top edge, got top=${previewPlacement.top}`);
assert(
  navigation.getPreviewNavigationPlacement(null, { width: 40, height: 116 }, { width: 1296, height: 1142 }) === null,
  "preview navigator should hide when the preview host is unavailable",
);

for (const name of ["maxScopeObjectDepth", "maxScopeObjectKeys"]) {
  assert(
    new RegExp(`const\\s+${name}\\s*=`).test(indexSource),
    `${name} should be declared for environment diff metadata scanning`,
  );
}
assert(
  /const\s+maxFiles\s*=\s*100;/u.test(indexSource),
  "diff hover file list should render up to 100 files before showing the hidden-count hint",
);
assert(
  /diffs-container/u.test(indexSource) && /role="tabpanel"/u.test(indexSource),
  "preview navigation should target real preview content instead of the tab controller",
);
const getRightPreviewPanelSource = indexSource.match(/function getRightPreviewPanel\(\) \{[\s\S]*?\n    \}/u)?.[0] || "";
assert(
  !getRightPreviewPanelSource.includes("data-app-shell-tab-controller"),
  "getRightPreviewPanel should not treat the right tab controller as the preview panel",
);
const getWorkspaceRouteScopeFallbackHostsSource = indexSource.match(/function getWorkspaceRouteScopeFallbackHosts\(\) \{[\s\S]*?\n    \}/u)?.[0] || "";
assert(
  !getWorkspaceRouteScopeFallbackHostsSource.includes("data-app-shell-tab-controller"),
  "workspace route fallback hosts should not use the right tab controller",
);
assert(
  /const routeScopeHostSelectors = \["file-tree-container", "aside", "main", "nav", "#root"\]/u.test(indexSource) &&
    /for \(const selector of routeScopeHostSelectors\)/u.test(getWorkspaceRouteScopeFallbackHostsSource),
  "workspace route fallback hosts should include structural page hosts instead of depending only on the file tree",
);
assert(
  !/function findWorkspaceOpenFileHandler|function openWithFileTreeHandler|onOpenFile/u.test(indexSource),
  "diff hover right-side opening should not fall back to the file-tree onOpenFile handler",
);
assert(
  /function isWorkspaceFileOpener\(candidate\)/u.test(indexSource) &&
    /function getWorkspaceFileOpener\(module\)/u.test(indexSource) &&
    /\[module\?\.t, module\?\.n\]/u.test(indexSource) &&
    /source\.includes\("openInSidePanel"\)/u.test(indexSource) &&
    /Object\.keys\(module \|\| \{\}\)/u.test(indexSource),
  "diff hover right-side opening should tolerate Codex open-workspace-file export-name drift",
);
assert(
  /function isCompactBottomDiffReviewTrigger/u.test(indexSource) &&
    /isBottomDiffSummaryButton\(anchor\)/u.test(indexSource) &&
    /anchor\.contains\(element\)/u.test(indexSource),
  "bottom composer compact review trigger should be accepted structurally without relying on button copy",
);
assert(
  /function readBottomDiffSummaryMetadata/u.test(indexSource) &&
    /diffSummary\.hasChanges === true/u.test(indexSource) &&
    /item\?\.type === "turn-diff"/u.test(indexSource) &&
    /typeof item\.unifiedDiff === "string"/u.test(indexSource) &&
    /normalizeNumber\(diffSummary\.linesAdded\)/u.test(indexSource) &&
    /normalizeNumber\(diffSummary\.linesDeleted\)/u.test(indexSource) &&
    /function isBottomDiffSummaryButton/u.test(indexSource) &&
    /element instanceof HTMLButtonElement/u.test(indexSource),
  "bottom composer diff hover should require the current native turn-diff button and diffSummary structure",
);
const findBottomSummarySource = indexSource.match(/function findBottomSummaryFromEventTarget\(target\) \{[\s\S]*?\n  \}/u)?.[0] || "";
assert(
  /findBottomDiffSummaryButton\(target\)/u.test(findBottomSummarySource) &&
    /isBottomSummaryAnchor\(anchor\)/u.test(findBottomSummarySource),
  "bottom composer diff hover should locate the native turn-diff button and retain the composer geometry guard",
);
assert(
  !/above-composer-portal|findAboveComposerPortal|hasBottomDiffLineStats/u.test(indexSource),
  "latest-only bottom diff hover should not retain the removed portal or legacy line-stat compatibility path",
);
const environmentAnchorSource = indexSource.match(/function isEnvironmentDiffAnchorWithData\(element, data\) \{[\s\S]*?\n  \}/u)?.[0] || "";
assert(
  /element instanceof HTMLButtonElement/u.test(environmentAnchorSource) &&
    /data\?\.diffStats && data\.isEnvironmentSection/u.test(environmentAnchorSource) &&
    !/getAttribute\("role"\)/u.test(environmentAnchorSource),
  "environment diff hover should accept the current native button while keeping diffStats and sectionKey validation",
);
assert(
  indexSource.includes("const reviewRuntimeModulePattern") &&
    indexSource.includes("discoverReviewNavigationModule"),
  "environment review fast path should discover the latest official Review chunk by its structural asset pattern",
);
assert(
  /performance\.getEntriesByType\("resource"\)/u.test(indexSource) &&
    /normalizeCodexAssetModulePath\(assetUrl, modulePattern, assetUrl\)/u.test(indexSource) &&
    /const appEntryModulePattern/u.test(indexSource) &&
    /normalizeCodexAssetModulePath\(source, appEntryModulePattern, sourceUrl\)/u.test(indexSource) &&
    /sourceUrls\.push\(entryModulePath\)/u.test(indexSource),
  "latest chunk discovery should prefer loaded resource URLs and bounded-walk index into the current app entry graph",
);
assert(
  /function openEnvironmentWorkspaceFileReview/u.test(indexSource) &&
    /function getThreadBranchReviewOpener/u.test(indexSource) &&
    /reviewNavigationModule\?\.openThreadBranchReviewSidePanelTab/u.test(indexSource) &&
    /openBranchReview\(scope, \{ path: reviewPath \}\)/u.test(indexSource),
  "environment review fast path should call the latest official branch Review entrypoint with the selected path",
);
assert(
  !/review-navigation-model|thread-side-panel-tabs-|getReviewSourceSetter|reviewSidePanelTabsModuleFallbackPaths/u.test(indexSource),
  "latest-only environment review should not retain removed Review state modules, short exports, or pinned chunk fallbacks",
);
const openWorkspaceFileReviewSource =
  indexSource.match(/async function openWorkspaceFileReview\(summary, file, openContext = null\) \{[\s\S]*?\n    \}/u)?.[0] || "";
assert(
  openWorkspaceFileReviewSource.indexOf("openEnvironmentWorkspaceFileReview(anchor, summary, file, openContext?.routeScope || null)") >= 0 &&
    openWorkspaceFileReviewSource.indexOf("official environment single-file review opener unavailable") >= 0 &&
    openWorkspaceFileReviewSource.indexOf("return;") <
      openWorkspaceFileReviewSource.indexOf("findReviewTriggerFromAnchor(anchor)"),
  "environment review should stop when the latest single-file API is unavailable instead of clicking the all-files trigger",
);
assert(
  openWorkspaceFileReviewSource.includes("const environmentReviewAnchor =") &&
    openWorkspaceFileReviewSource.includes("const filterTarget = getReviewFilterTarget(summary, file)") &&
    openWorkspaceFileReviewSource.includes("scheduleEnvironmentReviewSingleFileToggleScope(filterTarget, file, review.selectPath)") &&
    openWorkspaceFileReviewSource.includes("scheduleReviewSingleFileScope(filterTarget, file)"),
  "environment review should use official per-file toggles while non-environment review keeps the existing scope path",
);
assert(
  /openContext\?\.anchor instanceof HTMLElement/u.test(openWorkspaceFileReviewSource) &&
    /openContext\?\.environmentReview === true/u.test(openWorkspaceFileReviewSource) &&
    /function renderPanel\(\s*anchor,\s*summary,/u.test(indexSource) &&
    /routeScope: environmentReview \? findWorkspaceRouteScope\(anchor, summary\) : null/u.test(indexSource) &&
    /bindWorkspaceOpenRow\(\s*row,\s*openContext,\s*summary,/u.test(indexSource),
  "rendered hover rows should retain their entry type and route scope across Git refreshes and Popover unmounts",
);
const reviewDiffPathMatchesSource =
  indexSource.match(/function reviewDiffPathMatches\(candidatePath, targetPath\) \{[\s\S]*?\n    \}/u)?.[0] || "";
assert(
  /function normalizeReviewFilterTarget\(targetPath\)/u.test(indexSource) &&
    /function getReviewFilterTarget\(summary, file\)/u.test(indexSource) &&
    reviewDiffPathMatchesSource.includes("const { absolutePath, relativePath } = normalizeReviewFilterTarget(targetPath)") &&
    reviewDiffPathMatchesSource.includes("normalizedCandidate === relativePath") &&
    reviewDiffPathMatchesSource.includes("normalizedCandidate === absolutePath") &&
    reviewDiffPathMatchesSource.includes('if (!relativePath.includes("/")) return false') &&
    reviewDiffPathMatchesSource.includes("normalizedCandidate.endsWith(`/${relativePath}`)"),
  "single-file Review scoping should use exact absolute targets and avoid suffix matching for bare filenames",
);
const reviewPathMatchingStart = indexSource.indexOf("function normalizeReviewDiffPath(value)");
const reviewPathMatchingEnd = indexSource.indexOf("function shouldClearReviewFilterForClick(event)");
assert(
  reviewPathMatchingStart >= 0 && reviewPathMatchingEnd > reviewPathMatchingStart,
  "single-file Review path matching helpers should remain extractable for behavior checks",
);
const reviewDiffPathMatches = new Function(
  `${indexSource.slice(reviewPathMatchingStart, reviewPathMatchingEnd)}; return reviewDiffPathMatches;`,
)();
const rootReadmeTarget = {
  absolutePath: "C:/workspace/project/README.md",
  relativePath: "README.md",
};
assert(
  reviewDiffPathMatches("C:/workspace/project/README.md", rootReadmeTarget),
  "root README should still match its exact workspace-absolute Review card",
);
assert(
  !reviewDiffPathMatches("C:/workspace/project/docs/nested/README.md", rootReadmeTarget),
  "bare README target should not match a different nested README card",
);
assert(
  reviewDiffPathMatches("C:/workspace/project/docs/nested/README.md", {
    absolutePath: "C:/workspace/project/docs/nested/README.md",
    relativePath: "docs/nested/README.md",
  }),
  "nested README target should match its own workspace-relative Review card",
);
assert(
  !/diffUnifiedModulePattern|parseReviewLoadFullFilesExportName|load-full-files|enableOfficialReviewFullFiles/u.test(indexSource),
  "review opening should not use the official load-full-files signal",
);
assert(
  /const reviewFileToggleAttribute = "data-app-action-review-file-toggle"/u.test(indexSource) &&
    /const reviewFileExpandedAttribute = "data-app-action-review-file-expanded"/u.test(indexSource) &&
    /function scheduleEnvironmentReviewSingleFileToggleScope/u.test(indexSource) &&
    /new MutationObserver\(queueApply\)/u.test(indexSource) &&
    /window\.requestAnimationFrame\(\(\) => \{/u.test(indexSource),
  "environment review should follow official per-file expanded state with a DOM observer",
);
assert(
  !/function getReviewExpandButtons|function expandReviewDiffContext|data-expand-all-button|data-expand-button/u.test(indexSource),
  "review opening should not use legacy broad expand-button simulation helpers",
);
assert(
  !/function scrollReviewNavigationRange|reviewFilterPath|mode: "review"/u.test(indexSource),
  "review mode should not add a hunk navigator or custom scroll patch",
);
assert(
  /function openWorkspaceFilePreview/u.test(indexSource) &&
    /function showNavigationForFile/u.test(indexSource) &&
    /openWithWorkspaceFileModule\([\s\S]*?ranges\[0\] \|\| null,[\s\S]*?openContext\?\.routeScope \|\| null/u.test(indexSource) &&
    /\{ line: normalizedRange\.line, endLine: normalizedRange\.endLine \}/u.test(indexSource),
  "preview open mode should keep the side-panel hunk navigator and line/endLine jumps",
);
const bindWorkspaceOpenRowSource =
  indexSource.match(/function bindWorkspaceOpenRow\(\s*row,\s*openContext,\s*summary,[\s\S]*?\n    \}/u)?.[0] || "";
assert(
  /if \(externalDiffDisabledReason\) \{[\s\S]*?openWorkspaceFile\(summary, file, openContext\);[\s\S]*?return;/u.test(bindWorkspaceOpenRowSource),
  "hover row middle-click should fall back to the normal workspace opener when external diff is unavailable",
);
assert(
  /if \(!openExternalDiff\(summary, file, externalDiffToolPath\)\) \{[\s\S]*?openWorkspaceFile\(summary, file, openContext\);[\s\S]*?\}/u.test(bindWorkspaceOpenRowSource),
  "hover row middle-click should fall back when the external diff bridge rejects the request",
);
assert(
  /function readEditedFileCardExternalDiffTarget/u.test(indexSource) &&
    /function handleEditedFileCardExternalDiffAuxClick/u.test(indexSource) &&
    /function openEditedFileCardSingleFileReview/u.test(indexSource) &&
    /function openOfficialSingleFileBranchReview/u.test(indexSource) &&
    /enableEditedFileCardExternalDiffMiddleClick/u.test(indexSource) &&
    /readEditedFileCardExternalDiffTarget\(element\)/u.test(indexSource) &&
    /openExternalDiff\(diffTarget\.summary, diffTarget\.file, externalDiffToolPath\)/u.test(indexSource) &&
    /openEditedFileCardSingleFileReview\(diffTarget\)/u.test(indexSource) &&
    /scheduleEnvironmentReviewSingleFileToggleScope\(filterTarget, file, review\.selectPath\)/u.test(indexSource) &&
    /openOfficialSingleFileBranchReview\(anchor, summary, file, "edited file card"\)/u.test(indexSource),
  "official edited-file card rows should middle-click external Diff and fall back to single-file Review",
);
assert(
  !/function openEditedFileCardFallback|diffTarget\.button\.click\(\)|native open fallback/u.test(indexSource),
  "official edited-file card fallback should not click the native row because it expands all files",
);
const diffHoverManifestSource = manifestSource.match(/name:\s*"diff-hover-preview"[\s\S]*?modules:\s*\[[\s\S]*?\n    \]/u)?.[0] || "";
const navigationUtilsManifestIndex = diffHoverManifestSource.indexOf('"navigation-utils.js"');
const diffHoverIndexManifestIndex = diffHoverManifestSource.indexOf('"index.js"');
assert(
  navigationUtilsManifestIndex >= 0 && diffHoverIndexManifestIndex >= 0 && navigationUtilsManifestIndex < diffHoverIndexManifestIndex,
  "injection manifest should load diff hover navigation-utils before index.js",
);

// 这一段直接执行生产发现逻辑，验证入口迁移、相似文件名排除和失败后重新发现。
// Execute production discovery to verify moved entrypoints, lookalike filename rejection, and retry after failure.
const reviewDiscoverySource = indexSource.slice(
  indexSource.indexOf("async function discoverReviewNavigationModule()"),
  indexSource.indexOf("function getWorkspaceRouteScopeFallbackHosts()"),
).replace("await import(url)", "await importReviewModule(url)");
const assetPathSource = indexSource.slice(
  indexSource.indexOf("function normalizeCodexAssetModulePath("),
  indexSource.indexOf("function normalizeWorkspaceFileModulePath("),
);
const reviewPatternDeclaration = indexSource.match(/const reviewRuntimeModulePattern = .*;/u)?.[0];
const entryPatternDeclaration = indexSource.match(/const appEntryModulePattern = .*;/u)?.[0];
assert(reviewPatternDeclaration && entryPatternDeclaration, "Review discovery declarations must be present");
let reviewFixtureAvailable = false;
const fetchedReviewAssets = [];
const importedReviewAssets = [];
const officialReviewModule = { openThreadBranchReviewSidePanelTab() { return true; } };
const discoveryController = new AbortController();
const discoverFixture = new Function("document", "performance", "fetch", "importReviewModule", "signal", "location", `
  let reviewNavigationModulePromise = null;
  ${reviewPatternDeclaration}
  ${entryPatternDeclaration}
  ${assetPathSource}
  ${reviewDiscoverySource}
  return getReviewNavigationModule;
`)(
  { scripts: [{ src: "app://-/assets/index-fixture.js" }] },
  { getEntriesByType: () => [{ name: "app://-/assets/jsx-runtime-trap.js" }] },
  async (url, options) => {
    fetchedReviewAssets.push(url);
    assert(options.signal === discoveryController.signal, "Review discovery must use the system cancellation signal");
    const assets = {
      "app://-/assets/index-fixture.js": reviewFixtureAvailable ? 'import "./app-initial-fixture.js";' : 'import "./thread-side-panel-tabs-old.js";',
      "app://-/assets/app-initial-fixture.js": 'import "./jsx-runtime-trap.js"; import "./runtime-unrelated.js"; import "./runtime-renamed.js";',
      "app://-/assets/runtime-unrelated.js": "export const unrelated = true;",
      "app://-/assets/runtime-renamed.js": "export { action as openThreadBranchReviewSidePanelTab };",
    };
    return { ok: url in assets, text: async () => assets[url] };
  },
  async (url) => {
    importedReviewAssets.push(url);
    return officialReviewModule;
  },
  discoveryController.signal,
  { href: "app://-/index.html" },
);
let discoveryFailed = false;
try { await discoverFixture(); } catch { discoveryFailed = true; }
assert(discoveryFailed, "missing official Review export must fail instead of selecting another action");
reviewFixtureAvailable = true;
const discoveredReviewModules = await Promise.all([discoverFixture(), discoverFixture()]);
assert(discoveredReviewModules.every((module) => module === officialReviewModule), "concurrent discovery must resolve the official module");
assert(importedReviewAssets.length === 1 && importedReviewAssets[0].endsWith("/runtime-renamed.js"), "only the verified Review runtime should be imported once");
assert(!fetchedReviewAssets.some((url) => url.includes("jsx-runtime")), "jsx-runtime must not be mistaken for a Review runtime");

// 这一段使用真实卡片选择函数验证原始 Windows 路径、展开状态、单次定位及观察器清理。
// Exercise production card selection for raw Windows paths, expansion state, one-time selection, and observer cleanup.
const reviewFrames = new Map();
const reviewTimers = new Map();
const reviewObservers = [];
let reviewCallbackId = 0;
class ReviewElement {
  // 这一段建立最小官方卡片/按钮替身，不模拟布局或复制生产选择算法。
  // Build minimal official card/toggle stand-ins without copying production selection or layout logic.
  constructor(attributes = {}) { this.attributes = attributes; }
  getAttribute(name) { return this.attributes[name] ?? null; }
  querySelector() { return this.toggle ?? null; }
  click() {
    this.attributes["data-app-action-review-file-expanded"] = this.attributes["data-app-action-review-file-expanded"] === "true" ? "false" : "true";
    for (const observer of reviewObservers) if (observer.active) observer.callback();
  }
}
class ReviewObserver {
  // 这一段记录观察器生命周期，便于检测替换和结束后仍存在的回调。
  // Track observer lifecycle to detect callbacks surviving replacement or cleanup.
  constructor(callback) { this.callback = callback; reviewObservers.push(this); }
  observe() { this.active = true; }
  disconnect() { this.active = false; }
}
const reviewCards = ["/C:/workspace/project/src/app.js", "/C:/workspace/project/src/other.js"].map((filePath, index) => {
  const card = new ReviewElement({ "data-review-path": filePath });
  card.toggle = new ReviewElement({ "data-app-action-review-file-expanded": index === 0 ? "false" : "true" });
  return card;
});
const selectionSource = indexSource.slice(
  indexSource.indexOf("function getOfficialReviewFileToggle("),
  indexSource.indexOf("function syncReviewSingleFileScope("),
);
const selectionController = new AbortController();
const fixtureSelection = new Function("document", "HTMLElement", "MutationObserver", "window", "signal", "reviewDiffPathMatches", `
  const reviewFileToggleAttribute = "data-app-action-review-file-toggle";
  const reviewFileExpandedAttribute = "data-app-action-review-file-expanded";
  const environmentReviewSingleFileScopeTimeoutMs = 6000;
  let environmentReviewSingleFileScopeCleanup = null;
  function cancelEnvironmentReviewSingleFileScope() {
    environmentReviewSingleFileScopeCleanup?.();
    environmentReviewSingleFileScopeCleanup = null;
  }
  ${selectionSource}
  return { schedule: scheduleEnvironmentReviewSingleFileToggleScope, cancel: cancelEnvironmentReviewSingleFileScope };
`)(
  { querySelectorAll: () => reviewCards, body: {} }, ReviewElement, ReviewObserver,
  {
    requestAnimationFrame(callback) { const id = ++reviewCallbackId; reviewFrames.set(id, callback); return id; },
    cancelAnimationFrame(id) { reviewFrames.delete(id); },
    setTimeout(callback) { const id = ++reviewCallbackId; reviewTimers.set(id, callback); return id; },
    clearTimeout(id) { reviewTimers.delete(id); },
  }, selectionController.signal, reviewDiffPathMatches,
);
const selectedOfficialPaths = [];
fixtureSelection.schedule(
  { absolutePath: "C:/workspace/project/src/app.js", relativePath: "src/app.js" },
  { path: "src/app.js" },
  (filePath) => { selectedOfficialPaths.push(filePath); return true; },
);
for (let attempt = 0; reviewFrames.size && attempt < 10; attempt += 1) {
  const callbacks = Array.from(reviewFrames.values());
  reviewFrames.clear();
  for (const callback of callbacks) callback();
}
assert(selectedOfficialPaths.length === 1 && selectedOfficialPaths[0] === "/C:/workspace/project/src/app.js", "selection must use the untouched official path exactly once");
assert(reviewCards[0].toggle.getAttribute("data-app-action-review-file-expanded") === "true", "target file must be expanded");
assert(reviewCards[1].toggle.getAttribute("data-app-action-review-file-expanded") === "false", "other file must be collapsed");
fixtureSelection.cancel();
assert(reviewFrames.size === 0 && reviewTimers.size === 0 && reviewObservers.every((observer) => !observer.active), "cancelling Review selection must release observers and callbacks");

// 这一段验证迟到的打开请求不会覆盖新点击，正常打开后只接受官方卡片提供的精确路径。
// Verify delayed opens cannot override newer clicks and successful opens accept exact paths from official cards.
const openReviewSource = indexSource.slice(
  indexSource.indexOf("async function openOfficialSingleFileBranchReview("),
  indexSource.indexOf("async function openEnvironmentWorkspaceFileReview("),
);
let resolveDelayedReview;
const delayedReview = new Promise((resolve) => { resolveDelayedReview = resolve; });
const openCalls = [];
const openFixture = new Function("HTMLElement", "signal", "getReviewNavigationModule", `
  let reviewOpenGeneration = 0;
  const normalizePath = (value) => String(value || "");
  const findWorkspaceRouteScope = () => ({});
  const getThreadBranchReviewOpener = (module) => module.openThreadBranchReviewSidePanelTab;
  ${openReviewSource}
  return { open: openOfficialSingleFileBranchReview, invalidate() { reviewOpenGeneration += 1; } };
`)(ReviewElement, new AbortController().signal, () => delayedReview);
const staleOpen = openFixture.open(new ReviewElement(), {}, { path: "src/app.js" }, "fixture");
openFixture.invalidate();
resolveDelayedReview({ openThreadBranchReviewSidePanelTab(scope, options) { openCalls.push(options); return true; } });
assert(await staleOpen === false && openCalls.length === 0, "a superseded open must not change official Review state");
const currentOpen = await openFixture.open(new ReviewElement(), {}, { path: "src/app.js" }, "fixture");
assert(currentOpen && openCalls.length === 1 && openCalls[0] === undefined, "initial open must not send a guessed path");
assert(currentOpen.selectPath("/C:/workspace/project/src/app.js") === true && openCalls[1].path === "/C:/workspace/project/src/app.js", "official card path must reach the native action unchanged");
openFixture.invalidate();
assert(currentOpen.selectPath("/C:/workspace/project/src/app.js") === false && openCalls.length === 2, "stale selection callbacks must not move the current Review");

console.log("diff hover navigation checks passed");
