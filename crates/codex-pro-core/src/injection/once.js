(() => {
  // 这一段在当前文档保留本次注入状态，防止新文档自动执行与手动执行重复启动系统。
  // Keep this attempt's document-local state so automatic and manual execution cannot start systems twice.
  const attemptId = /* CODEX_PRO_ATTEMPT_ID */;
  const previous = window.__codexProInjectionAttempt;
  if (previous?.id === attemptId) return previous.promise;
  const attempt = { id: attemptId, complete: false, promise: null };
  window.__codexProInjectionAttempt = attempt;

  // 这一段让自动注册与手动调用等待同一个 DOM 就绪任务，避免 body 尚未创建时启动功能。
  // Share DOM readiness between automatic and manual calls so features never start before body exists.
  attempt.promise = (async () => {
    if (document.readyState === "loading") {
      await new Promise((resolve) => document.addEventListener("DOMContentLoaded", resolve, { once: true }));
    }
    // 这一段仅在全部同步模块执行成功后标记完成；失败保留同一个拒绝结果，禁止同次重放。
    // Mark completion only after all synchronous modules succeed; preserve the rejected result instead of replaying.
    /* CODEX_PRO_INJECTION_SOURCE */
    attempt.complete = true;
  })();
  // 这一段避免新文档自动执行时产生未处理拒绝；手动调用仍等待原 Promise 并获得原始异常。
  // Prevent unhandled rejections during automatic execution; manual calls await the original rejected promise.
  attempt.promise.catch(() => {});
  return attempt.promise;
})();
