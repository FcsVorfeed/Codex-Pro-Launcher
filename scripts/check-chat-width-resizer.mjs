import { readFile } from "node:fs/promises";
import path from "node:path";

const rootDir = path.resolve(import.meta.dirname, "..");
const runtimePath = path.join(rootDir, "src", "inject", "systems", "chat-width-resizer", "index.js");
const settingsPath = path.join(rootDir, "src", "inject", "systems", "chat-width-resizer", "settings.js");
const manifestPath = path.join(rootDir, "src", "launcher", "injection-manifest.mjs");
const rustManifestPath = path.join(rootDir, "crates", "codex-pro-core", "src", "injection_manifest.rs");
const rustAssetsPath = path.join(rootDir, "crates", "codex-pro-core", "src", "assets.rs");

function assertIncludes(source, needle, message) {
  // 这一段用明确错误提示锁定缺失契约，便于更新官方 DOM 后快速定位。
  // Use explicit messages for missing contracts so official DOM updates are quick to diagnose.
  if (!source.includes(needle)) throw new Error(message);
}

function assertNotIncludes(source, needle, message) {
  // 这一段用反向断言锁住“透明热区”契约，避免重新露出视觉竖线。
  // Use a negative assertion to keep the hotspot transparent and prevent the visual rail from returning.
  if (source.includes(needle)) throw new Error(message);
}

const runtimeSource = await readFile(runtimePath, "utf8");
const settingsSource = await readFile(settingsPath, "utf8");
const manifestSource = await readFile(manifestPath, "utf8");
const rustManifestSource = await readFile(rustManifestPath, "utf8");
const rustAssetsSource = await readFile(rustAssetsPath, "utf8");

assertIncludes(runtimeSource, '"chat-width-resizer"', "runtime must register the chat-width-resizer system");
assertIncludes(runtimeSource, "--thread-content-max-width", "runtime must use Codex's thread-content width CSS variable");
assertIncludes(runtimeSource, "[data-codex-composer='true']", "runtime must anchor to Codex's composer marker");
assertIncludes(runtimeSource, "max-w-(--thread-content-max-width)", "runtime must find the official width wrapper");
assertIncludes(runtimeSource, "setPointerCapture", "runtime must capture pointer drags on the resize handle");
assertIncludes(runtimeSource, "requestAnimationFrame", "runtime must coalesce DOM/layout refreshes");
assertIncludes(runtimeSource, "MutationObserver", "runtime must follow composer rerenders");
assertIncludes(runtimeSource, "ResizeObserver", "runtime must follow composer size changes");
assertIncludes(runtimeSource, "saveSettings", "runtime must persist dragged width through settings");
assertIncludes(runtimeSource, "chatWidthMode: \"custom\"", "runtime must mark dragged width as custom");
assertIncludes(runtimeSource, "chatWidthMode: \"official\"", "runtime must support returning to native width");
assertIncludes(runtimeSource, "auxclick", "runtime must suppress middle-click browser autoscroll");
assertIncludes(runtimeSource, 'window.addEventListener("pointerdown", captureMiddleReset', "runtime must capture hotspot middle-clicks before mouse gestures");
assertIncludes(runtimeSource, "restoreNativeThreadContentWidth(originalBodyWidth)", "runtime must restore any pre-existing inline width in native mode");
assertIncludes(runtimeSource, "removeProperty(threadContentWidthProperty)", "runtime must restore the native width variable on cleanup");
assertNotIncludes(runtimeSource, `#\${handleId}::after`, "runtime must keep the resize hotspot visually transparent");

assertIncludes(settingsSource, 'id: "chat-width-resizer"', "settings section must register chat-width-resizer");
assertIncludes(settingsSource, "enableChatWidthResizer", "settings section must expose the enable switch");
assertIncludes(settingsSource, "chatWidthMode", "settings section must register the persisted width mode");
assertIncludes(settingsSource, "chatWidthPixels", "settings section must expose the width field");
assertIncludes(settingsSource, 'modifiedSettingKeys: ["enableChatWidthResizer"]', "settings section must keep hidden width state out of left-nav modified markers");
assertNotIncludes(settingsSource, "renderNumberField", "settings section must not expose manual pixel entry");

assertIncludes(manifestSource, 'ownerSystem: "chat-width-resizer"', "JS manifest must preload the settings section");
assertIncludes(manifestSource, 'name: "chat-width-resizer"', "JS manifest must inject the runtime system");
assertIncludes(rustManifestSource, 'owner_system: "chat-width-resizer"', "Rust manifest must preload the settings section");
assertIncludes(rustManifestSource, 'name: "chat-width-resizer"', "Rust manifest must inject the runtime system");
assertIncludes(rustAssetsSource, "src/inject/systems/chat-width-resizer/settings.js", "Rust assets must embed chat width settings");
assertIncludes(rustAssetsSource, "src/inject/systems/chat-width-resizer/index.js", "Rust assets must embed chat width runtime");

console.log("chat width resizer checks passed");
