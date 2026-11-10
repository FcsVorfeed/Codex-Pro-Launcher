import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

// 这一段直接执行 Rust 内嵌的保护模板，覆盖同文档重放、显式重注入和新文档生命周期。
// Execute the template embedded by Rust to cover replay, explicit reinjection and new documents.
const template = await readFile(new URL("../crates/codex-pro-core/src/injection/once.js", import.meta.url), "utf8");
const context = vm.createContext({ window: {}, document: { readyState: "complete" } });
const source = "window.starts = (window.starts || 0) + 1;";

// 这一段只替换生产模板的两个插槽，测试脚本使用公开占位标识，不读取真实设置。
// Replace only the production template slots with public test markers, without reading user settings.
function script(id, body = source) {
  return template.replace("/* CODEX_PRO_ATTEMPT_ID */", JSON.stringify(id))
    .replace("/* CODEX_PRO_INJECTION_SOURCE */", () => body);
}

await vm.runInContext(script("first"), context);
await vm.runInContext(script("first"), context);
assert.equal(context.window.starts, 1);
await vm.runInContext(script("second"), context);
assert.equal(context.window.starts, 2);
const newDocument = vm.createContext({ window: {}, document: { readyState: "complete" } });
await vm.runInContext(script("second"), newDocument);
assert.equal(newDocument.window.starts, 1);

// 这一段验证部分执行失败不被重放或伪装成功；下一次显式注入仍能恢复。
// Verify partial failures cannot replay or appear successful, while explicit reinjection can recover.
await assert.rejects(vm.runInContext(script("failed", `${source} throw new Error('test failure');`), context), /test failure/);
await assert.rejects(vm.runInContext(script("failed"), context), /test failure/);
assert.equal(context.window.starts, 3);
assert.equal(context.window.__codexProInjectionAttempt.complete, false);
await vm.runInContext(script("recovery"), context);
assert.equal(context.window.starts, 4);
assert.equal(context.window.__codexProInjectionAttempt.complete, true);

// 这一段复现无 body 的新文档自动执行；正式调用必须共享等待且只安装一个就绪监听器。
// Reproduce automatic execution before body exists; manual calls must share the wait and one readiness listener.
let ready;
let listeners = 0;
const loadingDocument = vm.createContext({ window: {}, document: {
  readyState: "loading", body: null,
  // 这一段只模拟一次性的 DOM 就绪事件，不复制生产注入逻辑。
  // Simulate only the one-shot DOM ready event, without duplicating production injection logic.
  addEventListener(type, callback, options) {
    assert.equal(type, "DOMContentLoaded");
    assert.equal(options.once, true);
    listeners += 1;
    ready = callback;
  },
} });
const needsBody = script("loading", `if (!document.body) throw new Error('missing body'); ${source}`);
const automatic = vm.runInContext(needsBody, loadingDocument);
const manual = vm.runInContext(needsBody, loadingDocument);
assert.equal(automatic, manual);
assert.equal(listeners, 1);
assert.equal(loadingDocument.window.starts, undefined);
assert.equal(loadingDocument.window.__codexProInjectionAttempt.complete, false);
loadingDocument.document.body = {};
loadingDocument.document.readyState = "interactive";
ready();
await manual;
await vm.runInContext(needsBody, loadingDocument);
assert.equal(loadingDocument.window.starts, 1);
assert.equal(loadingDocument.window.__codexProInjectionAttempt.complete, true);
console.log("Injection once guard checks passed.");
