import { readFile } from "node:fs/promises";
import path from "node:path";

import { buildInjectionModulePaths } from "../src/launcher/injection-manifest.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const runtimePath = path.join(rootDir, "src", "inject", "systems", "chat-line-hover", "index.js");
const settingsPath = path.join(rootDir, "src", "inject", "systems", "chat-line-hover", "settings.js");
const manifestPath = path.join(rootDir, "src", "launcher", "injection-manifest.mjs");
const rustManifestPath = path.join(rootDir, "crates", "codex-pro-core", "src", "injection_manifest.rs");
const rustAssetsPath = path.join(rootDir, "crates", "codex-pro-core", "src", "assets.rs");
const jsCleanupPath = path.join(rootDir, "src", "launcher", "injection.mjs");
const rustCleanupPath = path.join(rootDir, "crates", "codex-pro-core", "src", "injection.rs");

function assertIncludes(source, needle, message) {
  // 这一段用明确错误定位契约缺口，避免小功能漏进发布版清单。
  // Use explicit failures to locate contract gaps before a small feature misses release manifests.
  if (!source.includes(needle)) throw new Error(message);
}

function assertNotIncludes(source, needle, message) {
  // 这一段锁住非全量扫描契约，防止后续把聊天记录整页遍历回来。
  // Lock the no-full-scan contract so later changes do not reintroduce whole-chat traversal.
  if (source.includes(needle)) throw new Error(message);
}

function assert(condition, message) {
  // 这一段统一布尔断言，让顺序检查和源码检查输出一致。
  // Keep boolean assertions consistent across source and ordering checks.
  if (!condition) throw new Error(message);
}

const runtimeSource = await readFile(runtimePath, "utf8");
const settingsSource = await readFile(settingsPath, "utf8");
const manifestSource = await readFile(manifestPath, "utf8");
const rustManifestSource = await readFile(rustManifestPath, "utf8");
const rustAssetsSource = await readFile(rustAssetsPath, "utf8");
const jsCleanupSource = await readFile(jsCleanupPath, "utf8");
const rustCleanupSource = await readFile(rustCleanupPath, "utf8");

assertIncludes(runtimeSource, 'const systemName = "chat-line-hover"', "runtime must name the chat-line-hover system");
assertIncludes(runtimeSource, 'const lineId = "codex-pro-chat-line-hover"', "runtime must use one stable overlay id");
assertIncludes(runtimeSource, "runtime.registerSystem(systemName", "runtime must register the system");
assertIncludes(runtimeSource, 'enableSetting: "enableChatLineHover"', "runtime must be controlled by the settings switch");
assertIncludes(runtimeSource, 'const chatLineHoverDisplayModes = new Set(["line", "full-line", "block"])', "runtime must expose the supported display modes");
assertIncludes(runtimeSource, "normalizeDisplayMode", "runtime must normalize the display mode");
assertIncludes(runtimeSource, "settings.chatLineHoverDisplayMode", "runtime must read the display mode setting");
assertIncludes(runtimeSource, "settings.expandChatLineHoverToLine === true", "runtime must preserve the legacy full-row guide setting");
assertIncludes(runtimeSource, "getBlockHoverRect", "runtime must support rounded text-block frames");
assertIncludes(runtimeSource, 'mode: "block"', "runtime must mark block overlay geometry with block mode");
assertIncludes(runtimeSource, "window.requestAnimationFrame", "runtime must coalesce pointer movement with requestAnimationFrame");
assertIncludes(runtimeSource, "document.caretRangeFromPoint", "runtime must use point-based text hit testing");
assertIncludes(runtimeSource, "document.caretPositionFromPoint", "runtime must keep the standards fallback for point hit testing");
assertIncludes(runtimeSource, "document.elementFromPoint", "runtime must use only the current pointer target for fallback");
assertIncludes(runtimeSource, "document.createTreeWalker", "runtime fallback must stay scoped to the current hit element");
assertIncludes(runtimeSource, "visited < 80", "runtime fallback scan must be capped");
assertIncludes(runtimeSource, "getLineBlockContentRect", "runtime must expand full-row mode through a local text block content box");
assertIncludes(runtimeSource, "window.getComputedStyle(block)", "runtime must account for local block padding in full-row mode");
assertIncludes(runtimeSource, "findChatTextRoot", "runtime must use positive chat-message text-root gating");
assertIncludes(runtimeSource, "chatTextRootSelector", "runtime must keep chat text root selectors centralized");
assertIncludes(runtimeSource, "[data-selected-text-overlay-target]", "runtime must accept official assistant message text roots");
assertIncludes(runtimeSource, "[data-user-message-bubble='true'] [class*='whitespace-pre-wrap']", "runtime must accept official user message bubble text roots");
assertIncludes(runtimeSource, "[data-content-search-unit-key]", "runtime must require an official message unit ancestor");
assertIncludes(runtimeSource, "/:(assistant|user)$/u", "runtime must require user or assistant message units");
assertIncludes(runtimeSource, "messageUnit.closest(\"main\")", "runtime must require the message unit to belong to the main content area");
assertIncludes(runtimeSource, "excludedAncestorSelector", "runtime must keep a small safety exclusion for composer, settings, sidebars, and plugin overlays");
assertNotIncludes(runtimeSource, "summary-panel-row", "runtime must not chase right-side summary panel exclusions instead of positive chat roots");
assertNotIncludes(runtimeSource, "codex-pro-environment-usage-row", "runtime must not chase environment-panel exclusions instead of positive chat roots");
assertNotIncludes(runtimeSource, "composer-surface-chrome", "runtime must not chase composer chrome exclusions instead of positive chat roots");
assertIncludes(runtimeSource, "pointer-events: none", "overlay must not capture chat clicks");
assertIncludes(runtimeSource, "opacity 140ms ease", "overlay must fade in and out instead of toggling display immediately");
assertIncludes(runtimeSource, "left 70ms cubic-bezier", "overlay must smooth short horizontal moves between nearby lines without feeling laggy");
assertIncludes(runtimeSource, "data-codex-pro-chat-line-hover-visible", "runtime must use a visibility state attribute for fade transitions");
assertIncludes(runtimeSource, "data-codex-pro-chat-line-hover-mode", "runtime must expose display mode as a state attribute");
assertNotIncludes(runtimeSource, "#${lineId}[hidden]", "runtime must not hide the line with display:none because that skips fade-out");
assertIncludes(runtimeSource, "runtime.lifecycle.replaceController", "runtime must cleanly replace old controllers on reinjection");
assertIncludes(runtimeSource, "document.getElementById(styleId)?.remove()", "runtime must remove its stylesheet on abort");
assertIncludes(runtimeSource, "window.cancelAnimationFrame", "runtime must cancel pending frames on cleanup");
assertNotIncludes(runtimeSource, "querySelectorAll(\"main", "runtime must not scan main content nodes");
assertNotIncludes(runtimeSource, "innerText", "runtime must not read rendered chat text");
assertNotIncludes(runtimeSource, "block.textContent", "runtime full-row mode must not read whole local block text");
assertNotIncludes(runtimeSource, "range.selectNodeContents(block)", "runtime full-row mode must not measure whole local blocks");

assertIncludes(settingsSource, 'id: "chat-line-hover"', "settings section must register chat-line-hover");
assertIncludes(settingsSource, "enableChatLineHover", "settings section must expose the enable switch");
assertIncludes(settingsSource, "chatLineHoverDisplayMode", "settings section must expose the display mode selector");
assertIncludes(settingsSource, '<option value="line">', "settings section must expose current-line mode");
assertIncludes(settingsSource, '<option value="full-line">', "settings section must expose full-row line mode");
assertIncludes(settingsSource, '<option value="block">', "settings section must expose rounded block mode");
assertIncludes(settingsSource, 'chatLineHoverDisplayMode: "enableChatLineHover"', "display mode selector must depend on the main hover switch");
assertIncludes(settingsSource, 'sourceSystem: "chat-line-hover"', "settings section must expose owner system metadata");

assertIncludes(manifestSource, 'ownerSystem: "chat-line-hover"', "JS manifest must preload chat-line-hover settings");
assertIncludes(manifestSource, 'name: "chat-line-hover"', "JS manifest must inject chat-line-hover runtime");
assertIncludes(rustManifestSource, 'owner_system: "chat-line-hover"', "Rust manifest must preload chat-line-hover settings");
assertIncludes(rustManifestSource, 'name: "chat-line-hover"', "Rust manifest must inject chat-line-hover runtime");
assertIncludes(rustAssetsSource, "src/inject/systems/chat-line-hover/settings.js", "Rust assets must embed chat-line-hover settings");
assertIncludes(rustAssetsSource, "src/inject/systems/chat-line-hover/index.js", "Rust assets must embed chat-line-hover runtime");
assertIncludes(jsCleanupSource, "codex-pro-chat-line-hover", "JS auxiliary cleanup must remove the chat-line-hover node");
assertIncludes(jsCleanupSource, "codex-pro-chat-line-hover-style", "JS auxiliary cleanup must remove the chat-line-hover style");
assertIncludes(rustCleanupSource, "codex-pro-chat-line-hover", "Rust auxiliary cleanup must remove the chat-line-hover node");
assertIncludes(rustCleanupSource, "codex-pro-chat-line-hover-style", "Rust auxiliary cleanup must remove the chat-line-hover style");

const modulePaths = buildInjectionModulePaths([]).map((modulePath) => modulePath.join("/"));
const settingsModule = "src/inject/systems/chat-line-hover/settings.js";
const runtimeModule = "src/inject/systems/chat-line-hover/index.js";
const settingsViewModule = "src/inject/systems/settings-menu/view.js";
assert(modulePaths.includes(settingsModule), "buildInjectionModulePaths must include chat-line-hover settings");
assert(modulePaths.includes(runtimeModule), "buildInjectionModulePaths must include chat-line-hover runtime");
assert(
  modulePaths.indexOf(settingsModule) < modulePaths.indexOf(settingsViewModule),
  "chat-line-hover settings must load before settings-menu view",
);
assert(
  modulePaths.indexOf(settingsViewModule) < modulePaths.indexOf(runtimeModule),
  "chat-line-hover runtime must load after settings-menu view",
);

console.log("chat line hover checks passed");
