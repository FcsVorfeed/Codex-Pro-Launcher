import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { buildInjectionModulePaths } from "../src/launcher/injection-manifest.mjs";

// 执行真实数据读取模块，验证额度口径和 React 提交树切换。
// Execute the actual reader to verify quota semantics and React commit-tree switching.
const runtime = { systemModules: {} };
const source = await readFile(new URL("../src/inject/systems/sidebar-usage-label/native-meter.js", import.meta.url), "utf8");
vm.runInNewContext(source, { window: { __codexProRuntime: runtime } });
const { formatRemaining, readIndicator } = runtime.systemModules.sidebarUsageLabel;

// 构造不包含账号标识的原生 props 形状。
// Construct native-shaped props without account identifiers.
function props(remaining, kind = "included", reserveRemaining = null) {
  return { source: { kind }, remaining, reserveRemaining, creditBalance: 10 };
}

// 五小时额度为零仍优先显示；仅缺失五小时额度时使用周额度。
// Zero five-hour allowance remains primary; use weekly only when five-hour is absent.
assert.equal(formatRemaining(props({ fiveHour: null, weekly: 92 })), "92%");
assert.equal(formatRemaining(props({ fiveHour: 0, weekly: 92 })), "0%");
assert.equal(formatRemaining(props({ fiveHour: 63.6, weekly: 92 })), "64%");
assert.equal(formatRemaining(props({ weekly: 100 })), "100%");
assert.equal(formatRemaining(props(null, "reserve", 17)), "17%");
for (const value of [undefined, null, "92", NaN, Infinity, -1, 101]) {
  assert.equal(formatRemaining(props({ weekly: value })), "--%");
}
for (const kind of ["credits", "unavailable", "unknown-source"]) {
  assert.equal(formatRemaining(props({ weekly: 92 }, kind)), null);
}

// 模拟提交前后两棵树，防止 DOM 上保留的旧 fiber 让文字停在旧额度。
// Simulate both commit trees so an old DOM fiber cannot leave stale quota text.
const rootState = {};
const oldRoot = { stateNode: rootState };
const newRoot = { stateNode: rootState };
oldRoot.alternate = newRoot;
newRoot.alternate = oldRoot;
const oldFiber = { memoizedProps: props({ weekly: 92 }), return: oldRoot };
const newFiber = { memoizedProps: props({ weekly: 81 }), return: newRoot };
oldFiber.alternate = newFiber;
newFiber.alternate = oldFiber;
oldRoot.child = oldFiber;
newRoot.child = newFiber;
const indicator = { __reactFiber$test: oldFiber };
rootState.current = oldRoot;
assert.equal(readIndicator(indicator).text, "92%");
rootState.current = newRoot;
assert.equal(readIndicator(indicator).text, "81%");
assert.equal(readIndicator({}), null);
assert.equal(readIndicator({ __reactFiber$test: { memoizedProps: { remaining: { weekly: 92 } } } }), null);

// bailout 共享子树的 return 可以指旧根，且首次挂载的节点可以没有 alternate。
// A bailout-shared subtree may return to an old root and newly mounted nodes may lack alternates.
const shared = { memoizedProps: props({ weekly: 72 }) };
const oldParent = { return: oldRoot, child: shared };
const newParent = { return: newRoot, child: shared };
oldParent.alternate = newParent;
newParent.alternate = oldParent;
shared.return = oldParent;
oldRoot.child = oldParent;
newRoot.child = newParent;
assert.equal(readIndicator({ __reactFiber$test: shared }).text, "72%");
const sharedAlternate = { memoizedProps: props({ weekly: 11 }), return: newParent, alternate: shared };
shared.alternate = sharedAlternate;
assert.equal(readIndicator({ __reactFiber$test: sharedAlternate }).text, "72%");

// 两支 return 相同时，真实 child 归属决定选哪棵已提交树。
// When both returns match, actual child ownership selects the committed tree.
sharedAlternate.return = oldParent;
newParent.child = sharedAlternate;
assert.equal(readIndicator({ __reactFiber$test: shared }).text, "11%");

// 硬屏蔽同时移除运行代码与设置贡献，避免部分加载留下功能残片。
// Hard disable removes both runtime modules and settings contribution.
const enabled = buildInjectionModulePaths([]).map((parts) => parts.join("/"));
const disabled = buildInjectionModulePaths(["sidebar-usage-label"]).map((parts) => parts.join("/"));
assert.equal(enabled.filter((path) => path.includes("/sidebar-usage-label/")).length, 3);
assert.equal(disabled.some((path) => path.includes("/sidebar-usage-label/")), false);
console.log("sidebar usage label checks passed");
