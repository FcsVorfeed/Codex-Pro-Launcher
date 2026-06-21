import { readFile } from "node:fs/promises";
import path from "node:path";

const rootDir = path.resolve(import.meta.dirname, "..");
const activeRevealPath = path.join(rootDir, "src", "inject", "systems", "file-tree-active-reveal", "index.js");
const fileTreeFilterPath = path.join(rootDir, "src", "inject", "systems", "file-tree-filter", "index.js");

function assert(condition, message) {
  // 这一段用明确错误终止检查，方便定位文件树时序回归。
  // Fail with explicit messages so file-tree timing regressions are easy to locate.
  if (!condition) throw new Error(message);
}

const activeRevealSource = await readFile(activeRevealPath, "utf8");
const fileTreeFilterSource = await readFile(fileTreeFilterPath, "utf8");

assert(
  !/scanIntervalMs|scanDelayMs|revealRetryMs|window\.setInterval|window\.setTimeout/u.test(activeRevealSource),
  "active reveal should not use fixed polling or fixed retry delays",
);
assert(
  /function continueActiveReveal/u.test(activeRevealSource) &&
    /pendingReveal/u.test(activeRevealSource) &&
    /new MutationObserver\(\(mutations\) => \{/u.test(activeRevealSource) &&
    /window\.requestAnimationFrame\(scanFileTrees\)/u.test(activeRevealSource) &&
    /window\.cancelAnimationFrame\(scanFrame\)/u.test(activeRevealSource) &&
    /context\.model\.subscribe\(\(\) => \{/u.test(activeRevealSource) &&
    /modelState\.unsubscribeModelChanges/u.test(activeRevealSource) &&
    /releaseModelState/u.test(activeRevealSource),
  "active reveal should continue from DOM and official model changes with requestAnimationFrame coalescing",
);
assert(
  /seenModelStates/u.test(activeRevealSource) &&
    /releaseModelState\(modelState\)/u.test(activeRevealSource),
  "active reveal should clean up official model subscriptions on abort",
);
assert(
  /pendingReveal\.exhausted = true/u.test(activeRevealSource) &&
    /if \(!hasNewModelData\) return/u.test(activeRevealSource) &&
    /pathCount: getContextPathCount\(context\)/u.test(activeRevealSource),
  "active reveal should not continue expanding after exhausted passes until new model data arrives",
);
assert(
  /context\.model\.resetPaths\(context\.paths, \{ initialExpandedPaths: ancestorPaths \}\)/u.test(activeRevealSource),
  "active reveal should preserve auto-collapse through official resetPaths with target ancestors",
);
assert(
  /data-app-shell-tab-panel-controller='right'/u.test(activeRevealSource) &&
    /data-app-shell-tab-controller='right'/u.test(activeRevealSource),
  "active reveal observer should be constrained to file-tree and right-preview surfaces",
);
assert(
  !/discoveryIntervalMs|window\.setInterval/u.test(fileTreeFilterSource),
  "file-tree filter model discovery should not use fixed polling",
);
assert(
    /const discoveryObserver = new MutationObserver/u.test(fileTreeFilterSource) &&
    /window\.requestAnimationFrame\(discoverFileTreeModels\)/u.test(fileTreeFilterSource) &&
    /window\.cancelAnimationFrame\(discoveryFrame\)/u.test(fileTreeFilterSource) &&
    /state\.model\.subscribe\(\(\) => \{/u.test(fileTreeFilterSource) &&
    /state\.unsubscribeModelChanges\(\)/u.test(fileTreeFilterSource) &&
    /document\.addEventListener\("pointerdown", handleFileTreeInteraction/u.test(fileTreeFilterSource) &&
    /document\.addEventListener\("focusin", handleFileTreeInteraction/u.test(fileTreeFilterSource) &&
    /window\.addEventListener\("message", handleHostMessage/u.test(fileTreeFilterSource) &&
    /messageHasDirectoryEntries/u.test(fileTreeFilterSource),
  "file-tree filter discovery should use MutationObserver, official model subscription, directory responses, file-tree interaction, and requestAnimationFrame",
);
assert(
  /function releaseModelState/u.test(fileTreeFilterSource) &&
    /modelStates\.delete\(state\)/u.test(fileTreeFilterSource) &&
    /modelStateByModel\.delete\(state\.model\)/u.test(fileTreeFilterSource),
  "file-tree filter should release stale model subscriptions and strong references",
);

console.log("file tree system checks passed");
