(() => {
  const runtime = window.__codexProRuntime;
  if (!runtime) return;

  // 这一段取消重新注入前的请求，并缓存当前官方 HTTP 客户端的发现结果。
  // Cancel requests from the previous injection and cache discovery of the official HTTP client.
  runtime.controllers["http-fetch"]?.abort();
  const controller = new AbortController();
  runtime.controllers["http-fetch"] = controller;
  let clientPromise = null;

  // 从当前页面的官方模块加载器发现已初始化的 HTTP 客户端。
  // Discover the initialized HTTP client through the current page's official module loader.
  async function discoverHttpClient() {
    // 这一段只导入页面已声明的官方 ESM 脚本，不依赖 chunk 名称、hash 或引用层级。
    // Import only declared official ESM scripts without depending on chunk names, hashes, or import depth.
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(12_000)]);
    const entries = [...new Set(Array.from(document.scripts)
      .filter((script) => script.type === "module" && /^app:\/\/-\/assets\/[\w.-]+\.js$/.test(script.src))
      .map((script) => script.src))];
    const loaders = new Set();
    const candidates = new Set();
    for (const url of entries.slice(0, 8)) {
      signal.throwIfAborted();
      const module = await waitWithSignal(import(url), signal);
      const loader = module.__webpack_require__;
      if (typeof loader !== "function" || !loader.m || !loader.c || loaders.has(loader)) continue;
      loaders.add(loader);

      // 这一段只筛选缓存模块的工厂特征，再检查其现有导出；绝不调用工厂或初始化其他模块。
      // Filter cached module factories by signature, then inspect existing exports; never invoke factories or initialize modules.
      for (const [id, cached] of Object.entries(loader.c)) {
        signal.throwIfAborted();
        const factory = loader.m[id];
        if (!cached || cached.error || typeof factory !== "function") continue;
        const source = Function.prototype.toString.call(factory);
        if (!["fetchJson", "cancelStream", "getInstance"].every((name) => source.includes(name))) continue;
        for (const value of Object.values(cached.exports ?? {})) {
          if (typeof value === "function" && value.prototype &&
              Object.hasOwn(value.prototype, "fetch") &&
              Object.hasOwn(value.prototype, "fetchJson") &&
              Object.hasOwn(value.prototype, "cancelStream") &&
              typeof value.getInstance === "function") candidates.add(value);
        }
      }
    }

    // 这一段要求全局唯一的客户端类；同类的重复导出合并，不猜测多个匹配的优先级。
    // Require one unique client class across loaders; deduplicate aliases without guessing among multiple matches.
    signal.throwIfAborted();
    if (candidates.size === 1) return [...candidates][0].getInstance();
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
