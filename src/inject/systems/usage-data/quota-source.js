(() => {
  // 这一段给用量面板和输入框提供同一个按需额度源，只保留数值窗口。
  // Share one on-demand quota source between the usage panel and composer, retaining numeric windows only.
  const runtime = window.__codexProRuntime;
  if (!runtime) return;
  const lifetime = new AbortController();
  runtime.lifecycle.replaceController("usage-data", lifetime);
  const listeners = new Set();
  let snapshot = null;
  let requestController = null;
  let timerId = 0;
  let unsubscribeSettings = null;

  // 这一段拒绝 null、空串和非数值字段，避免把未知额度强制转换为 100% 剩余。
  // Reject null, empty strings and nonnumeric fields so unknown quota never becomes 100% remaining.
  function finiteNumber(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }

  // 这一段丢弃账号标识和原始响应，仅向两个消费者提供标准数值窗口。
  // Discard account identifiers and raw responses, exposing only normalized numeric windows.
  function normalizeWindow(value) {
    if (!value || typeof value !== "object") return null;
    return {
      used_percent: finiteNumber(value.used_percent) ?? undefined,
      limit_window_seconds: finiteNumber(value.limit_window_seconds) ?? undefined,
      reset_at: finiteNumber(value.reset_at) ?? undefined,
    };
  }

  // 这一段按官方返回时长识别一周，不假定 primary 或 secondary 的位置。
  // Identify the week by its official duration without assuming primary or secondary position.
  function weeklyRemaining(usage) {
    if (!usage) return { visible: true, text: "--%" };
    const windows = [usage.rate_limit?.primary_window, usage.rate_limit?.secondary_window];
    const week = windows.find((item) => item?.limit_window_seconds === 7 * 24 * 60 * 60);
    if (!week) return { visible: false, text: "" };
    const used = finiteNumber(week.used_percent);
    return { visible: true, text: used === null ? "--%" : `${Math.round(Math.max(0, Math.min(100, 100 - used)))}%` };
  }

  // 这一段在每次请求结束后安排下一次刷新，网络较慢时不叠加请求。
  // Schedule after each completed request so slow networks never stack requests.
  function schedule() {
    window.clearTimeout(timerId);
    if (!listeners.size || lifetime.signal.aborted || requestController) return;
    const configured = Number(runtime.systemModules.settingsMenu?.settings?.getSettings?.().usageRefreshSeconds);
    const seconds = Number.isFinite(configured) ? Math.max(10, configured) : 30;
    timerId = window.setTimeout(refresh, seconds * 1000);
  }

  // 这一段串行刷新共享快照，停止订阅后的迟到响应不会覆盖新一轮数据。
  // Refresh the shared snapshot serially; late responses after unsubscribe cannot overwrite a new session.
  async function refresh() {
    if (!listeners.size || lifetime.signal.aborted || requestController) return;
    const current = new AbortController();
    requestController = current;
    try {
      const payload = await runtime.fetchBridge.requestJson("/wham/usage", { signal: current.signal });
      if (current.signal.aborted) return;
      snapshot = { rate_limit: {
        primary_window: normalizeWindow(payload?.rate_limit?.primary_window),
        secondary_window: normalizeWindow(payload?.rate_limit?.secondary_window),
      } };
    } catch {
      if (current.signal.aborted) return;
      snapshot = null;
    } finally {
      if (requestController === current) requestController = null;
      if (!current.signal.aborted) {
        for (const listener of listeners) listener(snapshot);
        schedule();
      }
    }
  }

  // 这一段在最后一个消费者退出后取消请求、刷新时钟和设置订阅并丢弃旧快照。
  // Cancel requests, timers and settings subscription and discard stale data when the last consumer leaves.
  function stop() {
    window.clearTimeout(timerId);
    requestController?.abort();
    requestController = null;
    unsubscribeSettings?.();
    unsubscribeSettings = null;
    snapshot = null;
  }

  // 这一段按订阅数启动一次轮询，每个消费者的 AbortSignal 单独负责退出。
  // Start one poller by subscriber count; each consumer's AbortSignal handles its own exit.
  function subscribe(listener, signal) {
    if (signal?.aborted || lifetime.signal.aborted) return () => {};
    listeners.add(listener);
    listener(snapshot);
    // 这一段将主动取消与 AbortSignal 取消汇合，避免留下信号监听器。
    // Merge explicit and signal cancellation so no abort listener remains attached.
    const unsubscribe = () => {
      listeners.delete(listener);
      signal?.removeEventListener("abort", unsubscribe);
      if (!listeners.size) stop();
    };
    signal?.addEventListener("abort", unsubscribe, { once: true });
    if (listeners.size === 1) {
      unsubscribeSettings = runtime.systemModules.settingsMenu?.settings?.subscribe?.(schedule);
      void refresh();
    }
    return unsubscribe;
  }

  // 这一段热注入时先停止旧数据源；消费者退出和共享源销毁都保持幂等。
  // Stop the old source on hot injection; both consumer exit and source disposal remain idempotent.
  lifetime.signal.addEventListener("abort", () => { listeners.clear(); stop(); }, { once: true });
  runtime.systemModules.usageData = { subscribe, weeklyRemaining };
})();
