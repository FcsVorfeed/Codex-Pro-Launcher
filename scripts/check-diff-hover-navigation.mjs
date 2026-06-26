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
const fallbackHostWithScope = { name: "file-tree-host" };
const fallbackHostWithOtherThread = { name: "other-thread-host" };
const fibersByHost = new Map([
  [anchorWithoutScope, { memoizedProps: { label: "Changes" } }],
  [anchorWithOwnScope, { memoizedState: { routeScope: expectedScope } }],
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
  /function isCompactAboveComposerReviewTrigger/u.test(indexSource) &&
    /findAboveComposerPortal\(anchor\)/u.test(indexSource) &&
    /anchor\.contains\(element\)/u.test(indexSource),
  "bottom composer compact review trigger should be accepted structurally without relying on button copy",
);
assert(
  /function hasBottomDiffLineStats/u.test(indexSource) &&
    /typeof props === "object" && \("linesAdded" in props \|\| "linesRemoved" in props\)/u.test(indexSource) &&
    /function isBottomDiffSummaryButton/u.test(indexSource) &&
    /element\.matches\("button,\[role='button'\]"\)/u.test(indexSource),
  "bottom composer diff hover should require the official diff button and line-stat structure",
);
const findBottomSummarySource = indexSource.match(/function findBottomSummaryFromEventTarget\(target\) \{[\s\S]*?\n  \}/u)?.[0] || "";
assert(
  /findBottomDiffSummaryButton\(target, portal\)/u.test(findBottomSummarySource) &&
    !/normalizeBottomTurnDiffAnchor/u.test(indexSource),
  "bottom composer diff hover should not expand the anchor to the full above-composer animation wrapper",
);
assert(
  /function clearSummaryMarks/u.test(indexSource) &&
    /function hideDiffHoverPanelRoots/u.test(indexSource) &&
    /findAboveComposerPortal\(event\.target\)\) \{[\s\S]*?if \(activeAnchor\) scheduleHide\(\);[\s\S]*?else hidePanel\(\);/u.test(indexSource),
  "bottom composer invalid hover should delay while crossing from the diff button and clean only stale surfaces immediately",
);
assert(
  indexSource.includes("const reviewNavigationModulePattern") &&
    indexSource.includes("review-navigation-model-") &&
    indexSource.includes("const reviewSidePanelTabsModulePattern") &&
    indexSource.includes("thread-side-panel-tabs-"),
  "environment review fast path should discover official Review chunks by structural asset patterns",
);
assert(
  /function openEnvironmentWorkspaceFileReview/u.test(indexSource) &&
    /function getReviewSourceSetter/u.test(indexSource) &&
    /reviewNavigationModule\?\.Bt[\s\S]*reviewNavigationModule\?\.Xt/u.test(indexSource) &&
    /setReviewSource\(scope, "branch"\)/u.test(indexSource) &&
    /selectReviewPath\(scope, reviewPath\)/u.test(indexSource) &&
    /openReviewTab\(scope\)/u.test(indexSource),
  "environment review fast path should set official branch+path state before opening Review",
);
const openWorkspaceFileReviewSource = indexSource.match(/async function openWorkspaceFileReview\(summary, file\) \{[\s\S]*?\n    \}/u)?.[0] || "";
assert(
  openWorkspaceFileReviewSource.indexOf("openEnvironmentWorkspaceFileReview(anchor, summary, file)") >= 0 &&
    openWorkspaceFileReviewSource.indexOf("findReviewTriggerFromAnchor(anchor)") >= 0 &&
    openWorkspaceFileReviewSource.indexOf("openEnvironmentWorkspaceFileReview(anchor, summary, file)") <
      openWorkspaceFileReviewSource.indexOf("findReviewTriggerFromAnchor(anchor)"),
  "environment review fast path should run before falling back to clicking the old trigger",
);
assert(
  openWorkspaceFileReviewSource.includes("const environmentReviewAnchor =") &&
    openWorkspaceFileReviewSource.includes("const filterTarget = getReviewFilterTarget(summary, file)") &&
    openWorkspaceFileReviewSource.includes("scheduleEnvironmentReviewSingleFileToggleScope(filterTarget, file)") &&
    openWorkspaceFileReviewSource.includes("else scheduleReviewSingleFileScope(filterTarget, file)"),
  "environment review should use official per-file toggles while non-environment review keeps the existing scope path",
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
    /openWithWorkspaceFileModule\(anchor, summary, file, ranges\[0\] \|\| null\)/u.test(indexSource) &&
    /\{ line: normalizedRange\.line, endLine: normalizedRange\.endLine \}/u.test(indexSource),
  "preview open mode should keep the side-panel hunk navigator and line/endLine jumps",
);
const bindWorkspaceOpenRowSource = indexSource.match(/function bindWorkspaceOpenRow\(row, summary, file,[\s\S]*?\n    \}/u)?.[0] || "";
assert(
  /if \(externalDiffDisabledReason\) \{[\s\S]*?openWorkspaceFile\(summary, file\);[\s\S]*?return;/u.test(bindWorkspaceOpenRowSource),
  "hover row middle-click should fall back to the normal workspace opener when external diff is unavailable",
);
assert(
  /if \(!openExternalDiff\(summary, file, externalDiffToolPath\)\) \{[\s\S]*?openWorkspaceFile\(summary, file\);[\s\S]*?\}/u.test(bindWorkspaceOpenRowSource),
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
    /scheduleEnvironmentReviewSingleFileToggleScope\(filterTarget, file\)/u.test(indexSource) &&
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

console.log("diff hover navigation checks passed");
