import { readFile } from "node:fs/promises";
import path from "node:path";

const rootDir = path.resolve(import.meta.dirname, "..");
const sourcePath = path.join(rootDir, "src", "inject", "systems", "native-thread-drag-to-chat", "index.js");
const settingsPath = path.join(rootDir, "src", "inject", "systems", "native-thread-drag-to-chat", "settings.js");
const archivePath = path.join(rootDir, "src", "inject", "systems", "conversation-archive", "index.js");
const bridgePath = path.join(rootDir, "src", "inject", "core", "native-bridge.js");
const nodeHandlerPath = path.join(rootDir, "src", "launcher", "native-bridge", "handlers", "conversation-archive.mjs");
const rustRequestPath = path.join(rootDir, "crates", "codex-pro-bridge", "src", "handlers", "conversation_archive", "request.rs");
const rustHandlerPath = path.join(rootDir, "crates", "codex-pro-bridge", "src", "handlers", "conversation_archive", "mod.rs");
const rustCoreAssetsPath = path.join(rootDir, "crates", "codex-pro-core", "src", "assets.rs");
const rustCoreManifestPath = path.join(rootDir, "crates", "codex-pro-core", "src", "injection_manifest.rs");
const rustCoreInjectionPath = path.join(rootDir, "crates", "codex-pro-core", "src", "injection.rs");

const [
  source,
  settingsSource,
  archiveSource,
  bridgeSource,
  nodeHandlerSource,
  rustRequestSource,
  rustHandlerSource,
  rustCoreAssetsSource,
  rustCoreManifestSource,
  rustCoreInjectionSource,
] = await Promise.all([
  readFile(sourcePath, "utf8"),
  readFile(settingsPath, "utf8"),
  readFile(archivePath, "utf8"),
  readFile(bridgePath, "utf8"),
  readFile(nodeHandlerPath, "utf8"),
  readFile(rustRequestPath, "utf8"),
  readFile(rustHandlerPath, "utf8"),
  readFile(rustCoreAssetsPath, "utf8"),
  readFile(rustCoreManifestPath, "utf8"),
  readFile(rustCoreInjectionPath, "utf8"),
]);

function assert(condition, message) {
  // 这一段用明确错误终止检查，方便定位拖拽链路漂移。
  // Fail with explicit messages so drag-chain drift is easy to locate.
  if (!condition) throw new Error(message);
}

function assertIncludes(haystack, needle, message) {
  // 这一段检查关键结构存在，避免功能被重构成脆弱文案匹配。
  // Check key structures so the feature is not refactored into brittle text matching.
  const normalizedHaystack = haystack.replaceAll("\r\n", "\n");
  const normalizedNeedle = needle.replaceAll("\r\n", "\n");
  assert(normalizedHaystack.includes(normalizedNeedle), message);
}

assertIncludes(source, 'const threadSelector = "[data-app-action-sidebar-thread-id]"', "native thread drag should use structured sidebar thread ids");
assertIncludes(source, 'const sidebarScrollSelector = "[data-app-action-sidebar-scroll]"', "native thread drag should be scoped to the native sidebar scroller");
assertIncludes(source, 'const fiberPrefix = "__reactFiber$"', "native thread drag should use the current React row data for canonical conversation ids");
assertIncludes(source, "function findCanonicalThreadId(row)", "native thread drag should resolve the canonical conversation id from the native row");
assertIncludes(source, "props.conversationId ||\n        props.entry?.conversationId ||", "native thread drag should read structured conversation ids before using the DOM key");
assertIncludes(source, 'findCanonicalThreadId(row) ||\n      normalizeThreadId(row.getAttribute("data-app-action-sidebar-thread-id"))', "native thread drag should preserve the older DOM thread-id fallback");
assertIncludes(source, "runtime.systemModules.tabDragToChat", "native thread drag should reuse tab-drag attachment API");
assertIncludes(source, "prepareLocalThreadArchiveFile", "native thread drag should use local archive prepare API");
assertIncludes(source, "attachNativeThreadToComposer", "native thread drag should attach after composer drop");
assertIncludes(source, "setDragCursorState(isComposerDrop ? \"copy\" : \"blocked\")", "native thread drag should suppress text cursors during pointer fallback");
assertIncludes(source, "function finishPointerDrag(event)", "native thread drag should finish through the pointer release path");
assertIncludes(source, "void attachNativeThreadToComposer(drag.thread, event)", "native thread pointer release should attach the selected thread");
assertIncludes(source, 'document.addEventListener("pointermove", updatePointerDrag, { capture: true, signal })', "native thread drag should track pointer movement at document scope");
assertIncludes(source, 'document.addEventListener("pointerup", finishPointerDrag, { capture: true, signal })', "native thread drag should finish at document scope");
assertIncludes(source, 'document.addEventListener("pointercancel", clearActiveDrag, { capture: true, signal })', "native thread drag should always clear a cancelled pointer session");
assertIncludes(source, 'document.addEventListener("lostpointercapture", clearActiveDrag, { capture: true, signal })', "native thread drag should clear when pointer capture is lost");
assertIncludes(source, 'document.addEventListener("visibilitychange", handleVisibilityChange, { signal })', "native thread drag should clear when the page becomes hidden");
assertIncludes(source, 'document.addEventListener("keydown", handleEscapeKey, { capture: true, signal })', "native thread drag should support Escape cancellation");
assertIncludes(source, 'window.addEventListener("blur", clearActiveDrag, { signal })', "native thread drag should clear when the Codex window loses focus");
assertIncludes(source, 'enableSettings: ["enableNativeThreadDragToChat", "enableTabDragToChat"]', "native thread drag runtime should stop when file-drag attachment support is disabled");
assert(!source.includes('document.addEventListener("pointerover"'), "native thread drag should not change native row cursor on hover");
assert(!source.includes("nativeThreadDrag.status.attached"), "native thread drag should not show a success toast after attaching");
assert(!source.includes('row.setAttribute("draggable", "true")'), "native thread drag should not enable HTML5 dragging on React-owned rows");
assert(!source.includes("setDragImage"), "native thread drag should not depend on a detachable HTML5 drag source");
assert(!source.includes("activeNativeThreadDrag"), "native thread drag should keep one pointer-owned drag state");
assert(!source.includes('document.addEventListener("dragstart"'), "native thread drag should not start an HTML5 drag session");
assert(!source.includes('document.addEventListener("dragend"'), "native thread drag should not depend on document-level HTML5 drag cleanup");
assert(!/textContent.*querySelectorAll/u.test(source), "native thread drag should not locate rows by visible text");

assertIncludes(settingsSource, 'id: "native-thread-drag-to-chat"', "native thread drag settings section should be registered");
assertIncludes(settingsSource, 'enableNativeThreadDragToChat: "enableTabDragToChat"', "native thread drag setting should depend on file-drag attachment support");

assertIncludes(archiveSource, 'action === "prepare-local-file"', "conversation archive page helper should support local prepare action");
assertIncludes(archiveSource, "prepareLocalThreadArchiveFile", "conversation archive helper should expose local thread prepare API");
assertIncludes(bridgeSource, '"prepare-local-file"', "native bridge page core should forward local prepare action");
assertIncludes(bridgeSource, "request.threadId = threadId", "native bridge page core should forward only threadId for local prepare");

assertIncludes(nodeHandlerSource, '"prepare-local-file"', "Node conversation archive handler should parse local prepare action");
assertIncludes(nodeHandlerSource, "runConversationArchivePrepareLocalFileRequest", "Node conversation archive handler should implement local prepare action");
assertIncludes(nodeHandlerSource, "exportConversationArchiveMarkdown(row, identity, displayNames)", "Node local prepare should reuse archive Markdown export");
assertIncludes(nodeHandlerSource, "exportConversationArchiveFallbackMarkdown(row, identity, displayNames)", "Node local prepare should preserve a metadata-only fallback on parse errors");
assertIncludes(nodeHandlerSource, "slice(0, 180)", "Node local prepare thread id normalization should match the page/Rust length contract");
assertIncludes(nodeHandlerSource, "^[A-Za-z0-9_.:-]{8,180}$", "Node local prepare thread id normalization should allow colon thread ids like the page helper");

assertIncludes(rustRequestSource, '"prepare-local-file"', "Rust request parser should accept local prepare action");
assertIncludes(rustRequestSource, 'thread_id: String', "Rust request should carry local thread id");
assertIncludes(rustHandlerSource, "prepare_local_archive_file", "Rust handler should implement local prepare action");
assertIncludes(rustHandlerSource, "rollout_reader::export_thread_archive", "Rust local prepare should reuse archive Markdown export");
assertIncludes(rustHandlerSource, "preview::write_preview_file", "Rust local prepare should write controlled preview files");

assertIncludes(rustCoreAssetsSource, "src/inject/systems/native-thread-drag-to-chat/settings.js", "Rust core assets should embed native thread drag settings");
assertIncludes(rustCoreAssetsSource, "src/inject/systems/native-thread-drag-to-chat/index.js", "Rust core assets should embed native thread drag system");
assertIncludes(rustCoreManifestSource, 'owner_system: "native-thread-drag-to-chat"', "Rust core manifest should register native thread drag settings section");
assertIncludes(rustCoreManifestSource, 'name: "native-thread-drag-to-chat"', "Rust core manifest should inject native thread drag system");
assertIncludes(rustCoreInjectionSource, "codex-pro-native-thread-drag-to-chat-ghost", "Rust auxiliary cleanup should remove native thread drag ghost");
assertIncludes(rustCoreInjectionSource, "codex-pro-native-thread-drag-to-chat-style", "Rust auxiliary cleanup should remove native thread drag style");

console.log("native thread drag-to-chat checks passed");
