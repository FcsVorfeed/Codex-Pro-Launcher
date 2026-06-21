(() => {
  const runtime = window.__codexProRuntime;
  if (!runtime) return;

  function requestBridge(url, options = {}) {
    // 这一段通过 Codex 自己的 Electron fetch bridge 请求接口，不直接处理认证信息。
    // Request endpoints through Codex's Electron fetch bridge without handling auth data directly.
    const bridge = window.electronBridge;
    if (!bridge?.sendMessageFromView) {
      return Promise.reject(new Error("Codex fetch bridge is unavailable"));
    }

    // 这一段为单次请求建立临时监听器，完成、超时或取消后都会清理。
    // Create a temporary listener for one request and clean it up on completion, timeout, or cancel.
    const requestId = crypto.randomUUID();
    const method = options.method ?? "GET";
    const timeoutMs = options.timeoutMs ?? 12_000;
    const signal = options.signal;
    if (signal?.aborted) {
      return Promise.reject(new DOMException("Aborted", "AbortError"));
    }

    return new Promise((resolve, reject) => {
      let timeoutId = 0;
      const cleanup = () => {
        window.clearTimeout(timeoutId);
        window.removeEventListener("message", onMessage);
        signal?.removeEventListener("abort", onAbort);
      };

      const finishWithError = (error) => {
        cleanup();
        reject(error);
      };

      function onAbort() {
        finishWithError(new DOMException("Aborted", "AbortError"));
      }

      function onMessage(event) {
        const message = event.data;
        if (!message || message.type !== "fetch-response" || message.requestId !== requestId) return;
        cleanup();

        if (message.responseType !== "success" || message.status < 200 || message.status >= 300) {
          reject(new Error(`Request failed: ${message.status || "unknown"}`));
          return;
        }

        resolve(message);
      }

      timeoutId = window.setTimeout(() => {
        finishWithError(new Error("Request timed out"));
      }, timeoutMs);

      window.addEventListener("message", onMessage);
      signal?.addEventListener("abort", onAbort, { once: true });

      bridge
        .sendMessageFromView({
          type: "fetch",
          requestId,
          method,
          url,
          headers: options.headers ?? {},
          body: options.body,
        })
        .catch(finishWithError);
    });
  }

  function requestJson(url, options = {}) {
    // 这一段在请求成功后解析 JSON，供 Codex 内部接口和状态接口复用。
    // Parse JSON only after a successful request for Codex internal APIs and JSON endpoints.
    return requestBridge(url, options).then((message) => JSON.parse(message.bodyJsonString));
  }

  function requestOk(url, options = {}) {
    // 这一段只确认 HTTP 请求成功，适合网络耗时检测这类不需要读取响应体的请求。
    // Confirm only HTTP success for latency checks that do not need the response body.
    return requestBridge(url, options).then((message) => ({
      status: message.status,
    }));
  }

  runtime.fetchBridge = {
    requestJson,
    requestOk,
  };
})();
