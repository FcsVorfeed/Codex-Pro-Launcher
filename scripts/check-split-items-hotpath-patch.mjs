import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const sourcePath = new URL("../crates/codex-pro-core/src/split_items_hotpath_patch.rs", import.meta.url);
const rustSource = readFileSync(sourcePath, "utf8");

assert.ok(
  rustSource.includes("enableSplitItemsHotpathPatch"),
  "Rust split-items hotpath patch must read the performance-fixes setting",
);
assert.ok(
  rustSource.indexOf("split_items_hotpath_patch_enabled(client)") <
    rustSource.indexOf("runtime_patch_marker_active(client)"),
  "Rust split-items hotpath patch must check the setting before the active marker",
);

function extractRawStringConstant(name) {
  const match = rustSource.match(new RegExp(`const ${name}: &str = r#"(.*?)"#;`, "s"));
  assert.ok(match, `missing ${name}`);
  return match[1];
}

function makeMatcher(source) {
  const context = vm.createContext({ globalThis: {} });
  vm.runInContext(`${source}; globalThis.__match = L;`, context);
  return context.globalThis.__match;
}

function cloneApps(tag) {
  return [
    { id: "connector_alpha", name: "Alpha App", pluginDisplayNames: ["Alpha Plugin"], tag: `${tag}-alpha` },
    { id: "beta", name: "Beta Tools", pluginDisplayNames: [], tag: `${tag}-beta` },
    { id: "alpha_long", name: "Alpha Long", pluginDisplayNames: [], tag: `${tag}-alpha-long` },
  ];
}

function assertSameMatch(original, optimized, apps, request, expectedIndex, label) {
  const originalResult = original({ apps, ...request });
  const optimizedResult = optimized({ apps, ...request });
  assert.equal(originalResult, apps[expectedIndex], `${label}: original result`);
  assert.equal(optimizedResult, apps[expectedIndex], `${label}: optimized result`);
}

const original = makeMatcher(extractRawStringConstant("CURRENT_HOTPATH_SOURCE"));
const optimized = makeMatcher(extractRawStringConstant("OPTIMIZED_HOTPATH_SOURCE"));

const apps = cloneApps("first");
assertSameMatch(
  original,
  optimized,
  apps,
  { functionName: "", serverName: "Alpha App", toolName: "" },
  0,
  "serverName exact match",
);
assertSameMatch(
  original,
  optimized,
  apps,
  { functionName: "", serverName: "", toolName: "beta_run" },
  1,
  "toolName prefix match",
);
assertSameMatch(
  original,
  optimized,
  apps,
  { functionName: "tool__alpha_plugin_run", serverName: "", toolName: "" },
  0,
  "functionName prefix match",
);
assertSameMatch(
  original,
  optimized,
  apps,
  { functionName: "tool__alpha_long_run", serverName: "Beta Tools", toolName: "alpha_run" },
  0,
  "earliest app wins across criteria",
);

const secondApps = cloneApps("second");
optimized({ apps, functionName: "", serverName: "Alpha App", toolName: "" });
const secondResult = optimized({ apps: secondApps, functionName: "", serverName: "Alpha App", toolName: "" });
assert.equal(secondResult, secondApps[0], "stable index cache must return the current apps array object");
assert.notEqual(secondResult, apps[0], "stable index cache must not return a previous apps array object");

console.log("split-items hotpath patch semantic checks passed");
