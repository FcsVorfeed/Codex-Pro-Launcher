(() => {
  const runtime = window.__codexProRuntime;
  if (!runtime) return;

  // 这一段取消重新注入前的请求，并缓存当前官方 HTTP 客户端的发现结果。
  // Cancel requests from the previous injection and cache discovery of the official HTTP client.
  runtime.controllers["http-fetch"]?.abort();
  const controller = new AbortController();
  runtime.controllers["http-fetch"] = controller;
  let clientPromise = null;

  async function discoverHttpClient() {
    // 这一段只读取当前页面的官方入口，动态解析共享模块路径，不固定构建 hash。
    // Read only the current official entry scripts and discover shared modules without fixed build hashes.
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(12_000)]);
    const entries = Array.from(document.scripts, (script) => script.src)
      .filter((url) => /^app:\/\/-\/assets\/index-[\w-]+\.js$/.test(url));
    const sharedUrls = new Set();
    for (const entry of entries.slice(0, 3)) {
      const response = await fetch(entry, { signal });
      if (!response.ok) throw new Error("Official application entry is unavailable");
      const source = await response.text();
      for (const match of source.matchAll(/app-shared-[\w-]+\.js/g)) {
        sharedUrls.add(new URL(match[0], entry).href);
      }
    }

    // 这一段按官方类的自有方法识别唯一客户端，不调用任意导出或代理服务。
    // Identify the unique official client by its own methods without invoking arbitrary exports or service proxies.
    for (const url of Array.from(sharedUrls).slice(0, 3)) {
      signal.throwIfAborted();
      const module = await import(url);
      const candidates = Object.values(module).filter((value) => (
        typeof value === "function" && value.prototype &&
        Object.hasOwn(value.prototype, "fetch") &&
        Object.hasOwn(value.prototype, "fetchJson") &&
        Object.hasOwn(value.prototype, "cancelStream") &&
        typeof value.getInstance === "function"
      ));
      if (candidates.length === 1) return candidates[0].getInstance();
    }
    throw new Error("Official HTTP fetch client is unavailable");
  }

  function getHttpClient() {
    // 这一段合并并发发现；失败后允许下一次正常刷新重试，不回退到已废弃的消息协议。
    // Share concurrent discovery and allow later refreshes to retry without using the retired message protocol.
    if (!clientPromise) {
      clientPromise = discoverHttpClient().catch((error) => {
        clientPromise = null;
        throw error;
      });
    }
    return clientPromise;
  }

  function waitWithSignal(promise, signal) {
    // 这一段让单个请求在共享发现期间也能及时超时或取消，并清理临时监听。
    // Allow individual requests to time out or cancel during shared discovery and remove temporary listeners.
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        signal.removeEventListener("abort", onAbort);
        reject(signal.reason);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
    });
  }

  async function requestBridge(url, options, readBody) {
    // 这一段统一请求期限、功能取消和重新注入取消，认证与响应流释放由官方客户端处理。
    // Combine timeout, feature cancellation, and reinjection cancellation; the official client handles auth and stream disposal.
    const signals = [controller.signal, AbortSignal.timeout(options.timeoutMs ?? 12_000)];
    if (options.signal) signals.push(options.signal);
    const signal = AbortSignal.any(signals);
    const client = await waitWithSignal(getHttpClient(), signal);
    signal.throwIfAborted();
    const response = await client.fetch(url, {
      method: options.method ?? "GET",
      headers: options.headers ?? {},
      body: options.body,
      signal,
    });
    try {
      if (!response.ok) throw new Error("Request failed: " + response.status);
      return readBody ? await response.json() : { status: response.status };
    } finally {
      // 这一段释放未读取或读取失败的响应流，网络耗时检测不保留响应正文。
      // Release unread or failed response streams; latency checks never retain the response body.
      await response.body?.cancel().catch(() => {});
    }
  }

  function requestJson(url, options = {}) {
    // 这一段为需要数据的调用方读取 JSON，同时沿用统一取消和错误语义。
    // Read JSON for data callers while preserving common cancellation and error handling.
    return requestBridge(url, options, true);
  }

  function requestOk(url, options = {}) {
    // 这一段仅返回 HTTP 状态，供网络耗时检测使用。
    // Return only HTTP status for network latency measurements.
    return requestBridge(url, options, false);
  }

  runtime.fetchBridge = { requestJson, requestOk };
})();
