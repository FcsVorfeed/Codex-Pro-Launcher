(() => {
  const runtime = window.__codexProRuntime;
  if (!runtime) return;

  const bridgeConfig = window.__codexProNativeBridgeConfig || null;
  const maxHeartbeatAgeMs = 8000;
  const responseEventName = "codex-pro:native-bridge-response";
  const requestTimeoutMs = 5000;
  const cloudSyncRequestTimeoutMs = 20000;
  const conversationArchiveRequestTimeoutMs = 180000;
  const petSyncRequestTimeoutMs = 60000;
  const todayTokenUsageRequestTimeoutMs = 10000;

  function getBinding() {
    // 这一段只读取 launcher 注入的受控绑定函数，缺失时让调用方走降级逻辑。
    // Read only the controlled binding injected by the launcher; callers can fall back when it is absent.
    const bindingName = bridgeConfig?.bindingName;
    if (!bindingName || typeof window[bindingName] !== "function") return null;
    return window[bindingName];
  }

  function isHeartbeatFresh() {
    // 这一段用后台 worker 写入的心跳判断桥是否真的有人接收，而不是只剩页面函数残留。
    // Use the background worker heartbeat to verify that the bridge is actually being serviced, not just a stale page function.
    const status = window.__codexProNativeBridgeStatus;
    return Boolean(
      status &&
      status.bridgeId === bridgeConfig?.bridgeId &&
      Number.isFinite(status.updatedAt) &&
      Date.now() - status.updatedAt <= maxHeartbeatAgeMs,
    );
  }

  function buildRequest(type, payload) {
    // 这一段给桥接请求补上本次注入的 bridgeId，避免旧 launcher 进程重复处理新请求。
    // Attach this injection's bridgeId so stale launcher processes do not process new requests.
    if (!bridgeConfig?.bridgeId) return null;
    return {
      ...payload,
      bridgeId: bridgeConfig.bridgeId,
      type,
    };
  }

  function send(type, payload = {}) {
    // 这一段把页面请求发送给 CDP 侧 launcher；发送失败只返回 false，不在页面内抛出。
    // Send page requests to the CDP-side launcher; failures return false instead of throwing in-page.
    const binding = getBinding();
    const request = buildRequest(type, payload);
    if (!binding || !request || !isHeartbeatFresh()) return false;
    try {
      binding(JSON.stringify(request));
      return true;
    } catch (error) {
      console.warn("[Codex-Pro] native bridge request failed", error);
      return false;
    }
  }

  function sendShortcut(shortcut) {
    // 这一段只发送短格式快捷键字符串，后台桥会再次校验并拒绝宏或未知主键。
    // Send only a short shortcut string; the background bridge validates again and rejects macros or unknown main keys.
    if (typeof shortcut !== "string" || shortcut.length > 80 || !/^[A-Za-z0-9+`\-=[\]\\;',./ ]+$/.test(shortcut)) return false;
    return send("shortcut", { shortcut });
  }

  function supportsExternalDiff() {
    // 这一段要求新版桥协议和新鲜心跳同时存在，避免旧快捷键 worker 吞掉外部 Diff 请求。
    // Require the newer bridge protocol and a fresh heartbeat so old shortcut-only workers do not swallow external diff requests.
    return Boolean(bridgeConfig?.protocolVersion >= 8 && getBinding() && bridgeConfig?.bridgeId && isHeartbeatFresh());
  }

  function supportsGitDiffSummary() {
    // 这一段要求支持响应事件的新版桥协议，避免旧 worker 收到未知请求后没有回包。
    // Require the newer response-capable bridge protocol so older workers do not receive requests they cannot answer.
    return Boolean(bridgeConfig?.protocolVersion >= 4 && getBinding() && bridgeConfig?.bridgeId && isHeartbeatFresh());
  }

  function supportsCloudSync() {
    // 这一段要求支持云同步请求的新版桥协议，避免旧 worker 收到敏感请求后无法回包。
    // Require the newer cloud-sync bridge protocol so older workers cannot receive sensitive requests without replying.
    return Boolean(bridgeConfig?.protocolVersion >= 6 && getBinding() && bridgeConfig?.bridgeId && isHeartbeatFresh());
  }

  function supportsPetSync() {
    // 这一段要求支持宠物资源同步的新版桥协议，避免旧 worker 收到资源请求后无响应。
    // Require the newer pet-resource sync bridge protocol so older workers do not receive unsupported resource requests.
    return Boolean(bridgeConfig?.protocolVersion >= 7 && getBinding() && bridgeConfig?.bridgeId && isHeartbeatFresh());
  }

  function supportsConversationArchive() {
    // 这一段要求支持会话归档同步的新版桥协议，避免旧 worker 收到归档请求后无响应。
    // Require the newer conversation-archive bridge protocol so older workers do not receive unsupported archive requests.
    return Boolean(bridgeConfig?.protocolVersion >= 9 && getBinding() && bridgeConfig?.bridgeId && isHeartbeatFresh());
  }

  function supportsTodayTokenUsage() {
    // 这一段要求支持 Today token 聚合的新版桥协议，避免旧 worker 收到未知请求后等待超时。
    // Require the newer Today-token bridge protocol so older workers do not receive unsupported requests and time out.
    return Boolean(bridgeConfig?.protocolVersion >= 66 && getBinding() && bridgeConfig?.bridgeId && isHeartbeatFresh());
  }

  function isShortBridgeText(value, maxLength) {
    // 这一段限制页面传给桥接层的短文本字段，避免异常大 payload 或控制字符进入本机侧。
    // Bound short text fields sent to the bridge so huge payloads or control characters cannot reach the native side.
    return typeof value === "string" &&
      value.length <= maxLength &&
      !/[\0\r\n]/u.test(value);
  }

  function sendExternalDiff(params) {
    // 这一段只发送外部 Diff 的结构化参数，后台桥会重新校验路径和工作区边界。
    // Send only structured external diff parameters; the background bridge revalidates paths and workspace bounds.
    if (!supportsExternalDiff()) return false;
    const toolPath = String(params?.toolPath || "").trim();
    const cwd = String(params?.cwd || "").trim();
    const filePath = String(params?.path || "").trim();
    const previousPath = String(params?.previousPath || "").trim();
    const changeKind = String(params?.changeKind || "").trim();
    if (!isShortBridgeText(toolPath, 1000) || !isShortBridgeText(cwd, 1000) || !isShortBridgeText(filePath, 500)) return false;
    if (!isShortBridgeText(previousPath, 500) || !isShortBridgeText(changeKind, 40)) return false;
    return send("external-diff", {
      changeKind,
      cwd,
      path: filePath,
      previousPath,
      toolPath,
    });
  }

  function requestGitDiffSummary(params) {
    // 这一段异步请求工作区 Git 变更摘要，只传 cwd，不传任意命令或文件内容。
    // Request a workspace Git diff summary asynchronously, sending only cwd and no arbitrary commands or file contents.
    if (!supportsGitDiffSummary()) return Promise.resolve(null);
    const cwd = String(params?.cwd || "").trim();
    if (!isShortBridgeText(cwd, 1000)) return Promise.resolve(null);
    const requestId = crypto.randomUUID();
    return new Promise((resolve) => {
      let timeoutId = 0;
      const cleanup = () => {
        window.clearTimeout(timeoutId);
        window.removeEventListener(responseEventName, handleResponse);
      };
      function finish(value) {
        cleanup();
        resolve(value);
      }
      function handleResponse(event) {
        const detail = event?.detail;
        if (!detail || detail.requestId !== requestId || detail.type !== "git-diff-summary") return;
        finish(detail.response || null);
      }
      window.addEventListener(responseEventName, handleResponse);
      timeoutId = window.setTimeout(() => finish(null), requestTimeoutMs);
      if (!send("git-diff-summary", { cwd, requestId })) finish(null);
    });
  }

  function requestCloudSync(params) {
    // 这一段通过 launcher 发起云同步请求，绕过 Codex 页面外网 fetch 限制但不开放任意原生命令。
    // Ask the launcher to perform cloud-sync requests, bypassing page fetch limits without exposing arbitrary commands.
    if (!supportsCloudSync()) return Promise.resolve(null);
    const endpoint = String(params?.endpoint || "").trim();
    const body = params?.body && typeof params.body === "object" && !Array.isArray(params.body)
      ? params.body
      : null;
    if (!isShortBridgeText(endpoint, 500) || !body) return Promise.resolve(null);
    const requestId = crypto.randomUUID();
    return new Promise((resolve) => {
      let timeoutId = 0;
      const cleanup = () => {
        window.clearTimeout(timeoutId);
        window.removeEventListener(responseEventName, handleResponse);
      };
      function finish(value) {
        cleanup();
        resolve(value);
      }
      function handleResponse(event) {
        const detail = event?.detail;
        if (!detail || detail.requestId !== requestId || detail.type !== "cloud-sync") return;
        finish(detail.response || null);
      }
      window.addEventListener(responseEventName, handleResponse);
      timeoutId = window.setTimeout(() => finish(null), cloudSyncRequestTimeoutMs);
      if (!send("cloud-sync", { body, endpoint, requestId })) finish(null);
    });
  }

  function requestPetSync(params) {
    // 这一段通过 launcher 发起宠物资源同步，只传小型控制字段，不让页面传递文件内容。
    // Ask the launcher to perform pet-resource sync, sending only small control fields and no file content.
    if (!supportsPetSync()) return Promise.resolve(null);
    const action = String(params?.action || "").trim().toLowerCase();
    const endpoint = String(params?.endpoint || "").trim();
    const syncKey = String(params?.syncKey || "").trim();
    if ((action !== "pull" && action !== "push") || !isShortBridgeText(endpoint, 500) || !isShortBridgeText(syncKey, 160)) {
      return Promise.resolve(null);
    }
    const request = { action, endpoint, syncKey };
    if (Number.isInteger(params?.baseRevision) && params.baseRevision >= 0) {
      request.baseRevision = params.baseRevision;
    }
    const requestId = crypto.randomUUID();
    return new Promise((resolve) => {
      let timeoutId = 0;
      const cleanup = () => {
        window.clearTimeout(timeoutId);
        window.removeEventListener(responseEventName, handleResponse);
      };
      function finish(value) {
        cleanup();
        resolve(value);
      }
      function handleResponse(event) {
        const detail = event?.detail;
        if (!detail || detail.requestId !== requestId || detail.type !== "pet-sync") return;
        finish(detail.response || null);
      }
      window.addEventListener(responseEventName, handleResponse);
      timeoutId = window.setTimeout(() => finish(null), petSyncRequestTimeoutMs);
      if (!send("pet-sync", { ...request, requestId })) finish(null);
    });
  }

  function requestConversationArchive(params) {
    // 这一段通过 launcher 发起会话归档同步，只传控制字段，不让页面读取 rollout 或 Markdown 正文。
    // Ask the launcher to perform conversation archive sync, sending only control fields and no rollout or Markdown bodies.
    if (!supportsConversationArchive()) return Promise.resolve(null);
    const action = String(params?.action || "").trim().toLowerCase();
    const endpoint = String(params?.endpoint || "").trim();
    const syncKey = String(params?.syncKey || "").trim();
    const deviceName = String(params?.deviceName || "").trim();
    const deviceId = String(params?.deviceId || "").trim();
    const profileName = String(params?.profileName || "").trim();
    const path = String(params?.path || "").trim();
    const threadId = String(params?.threadId || "").trim();
    const onProgress = typeof params?.onProgress === "function" ? params.onProgress : null;
    if (!["push", "list", "get-file", "prepare-file", "prepare-local-file", "reset", "delete-device"].includes(action)) {
      return Promise.resolve(null);
    }
    if (action === "prepare-local-file" && !isShortBridgeText(threadId, 180)) {
      return Promise.resolve(null);
    }
    if (action !== "prepare-local-file" && (!isShortBridgeText(endpoint, 500) || !isShortBridgeText(syncKey, 160))) {
      return Promise.resolve(null);
    }
    if (!isShortBridgeText(deviceName, 120) || !isShortBridgeText(deviceId, 120) || !isShortBridgeText(profileName, 120) || !isShortBridgeText(path, 500)) {
      return Promise.resolve(null);
    }
    const requestId = crypto.randomUUID();
    const request = { action, deviceName, endpoint, profileName, requestId, syncKey };
    if (deviceId) request.deviceId = deviceId;
    if (path) request.path = path;
    if (action === "prepare-local-file") request.threadId = threadId;
    if (params?.force === true) request.force = true;
    return new Promise((resolve) => {
      let timeoutId = 0;
      let settled = false;
      const cleanup = () => {
        window.clearTimeout(timeoutId);
        window.removeEventListener(responseEventName, handleResponse);
      };
      function finish(value) {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      }
      function resetTimeout() {
        // 这一段把归档请求超时改成“无进度超时”，避免大批量附件仍在上传时被页面误判失败。
        // Treat archive timeout as an idle timeout so large attachment batches are not marked failed while progressing.
        window.clearTimeout(timeoutId);
        timeoutId = window.setTimeout(() => finish(null), conversationArchiveRequestTimeoutMs);
      }
      function handleResponse(event) {
        const detail = event?.detail;
        if (!detail || detail.requestId !== requestId) return;
        if (detail.type === "conversation-archive-progress") {
          resetTimeout();
          try {
            onProgress?.(detail.response?.data || detail.response || {});
          } catch (error) {
            console.warn("[Codex-Pro] conversation archive progress handler failed", error);
          }
          return;
        }
        if (detail.type !== "conversation-archive") return;
        finish(detail.response || null);
      }
      window.addEventListener(responseEventName, handleResponse);
      resetTimeout();
      if (!send("conversation-archive", request)) finish(null);
    });
  }

  function requestTodayTokenUsage(params) {
    // 这一段通过 launcher 读取本机 Codex token_count 聚合，只传日期和时间窗，不传路径或正文。
    // Ask the launcher to read local Codex token_count aggregates, sending only date and time window, not paths or content.
    if (!supportsTodayTokenUsage()) return Promise.resolve(null);
    const date = String(params?.date || "").trim();
    const startIso = String(params?.startIso || "").trim();
    const endIso = String(params?.endIso || "").trim();
    const startMs = Number(params?.startMs);
    const endMs = Number(params?.endMs);
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) return Promise.resolve(null);
    if (!isShortBridgeText(startIso, 40) || !isShortBridgeText(endIso, 40)) return Promise.resolve(null);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs >= endMs) return Promise.resolve(null);
    const requestId = crypto.randomUUID();
    return new Promise((resolve) => {
      let timeoutId = 0;
      const cleanup = () => {
        window.clearTimeout(timeoutId);
        window.removeEventListener(responseEventName, handleResponse);
      };
      function finish(value) {
        cleanup();
        resolve(value);
      }
      function handleResponse(event) {
        const detail = event?.detail;
        if (!detail || detail.requestId !== requestId || detail.type !== "today-token-usage") return;
        finish(detail.response || null);
      }
      window.addEventListener(responseEventName, handleResponse);
      timeoutId = window.setTimeout(() => finish(null), todayTokenUsageRequestTimeoutMs);
      if (!send("today-token-usage", { date, endIso, endMs, requestId, startIso, startMs })) finish(null);
    });
  }

  runtime.nativeBridge = {
    isAvailable: () => Boolean(getBinding() && bridgeConfig?.bridgeId && isHeartbeatFresh()),
    requestCloudSync,
    requestConversationArchive,
    requestGitDiffSummary,
    requestPetSync,
    requestTodayTokenUsage,
    sendExternalDiff,
    sendShortcut,
    supportsCloudSync,
    supportsConversationArchive,
    supportsExternalDiff,
    supportsGitDiffSummary,
    supportsPetSync,
    supportsTodayTokenUsage,
  };
})();
