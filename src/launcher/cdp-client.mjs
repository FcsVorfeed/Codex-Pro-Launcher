export async function fetchJson(url) {
  // 这一段请求 CDP HTTP 接口，并把非 2xx 响应转成明确错误。
  // Request a CDP HTTP endpoint and turn non-2xx responses into explicit errors.
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return response.json();
}

export function cdpTargetListUrls(debugPort) {
  // 这一段按优先顺序列出 Codex DevTools 可能监听的本机地址。
  // List local Codex DevTools endpoints in probe order.
  return [
    `http://127.0.0.1:${debugPort}/json`,
    `http://[::1]:${debugPort}/json`,
  ];
}

function isPageTarget(target) {
  // 这一段只识别可通过 WebSocket 调试的页面目标。
  // Identify only page targets that can be debugged through WebSocket.
  return target?.type === "page" && Boolean(target.webSocketDebuggerUrl);
}

function parseTargetUrl(target) {
  // 这一段安全解析 CDP 目标 URL，避免加载中页面的空 URL 打断目标选择。
  // Safely parse the CDP target URL so loading or empty URLs do not break target selection.
  try {
    return new URL(target?.url || "");
  } catch {
    return null;
  }
}

function getInitialRoute(target) {
  // 这一段读取 Codex 多窗口路由，用来区分主窗口和宠物悬浮窗。
  // Read Codex's multi-window route so the main window and avatar overlay can be separated.
  return parseTargetUrl(target)?.searchParams.get("initialRoute") || "";
}

export function isAuxiliaryCodexPageTarget(target) {
  // 这一段排除宠物悬浮窗，避免把 Codex-Pro 面板注入到辅助窗口。
  // Exclude the avatar overlay so Codex-Pro panels are not injected into auxiliary windows.
  return isPageTarget(target) && getInitialRoute(target) === "/avatar-overlay";
}

export function isMainCodexPageTarget(target) {
  // 这一段优先锁定真实 Codex 主窗口，主窗口通常是无 initialRoute 的 app://-/index.html。
  // Prefer the real Codex main window, usually app://-/index.html without an initialRoute.
  if (!isPageTarget(target) || isAuxiliaryCodexPageTarget(target)) return false;
  const url = parseTargetUrl(target);
  return url?.protocol === "app:" && url.host === "-" && url.pathname === "/index.html" && !getInitialRoute(target);
}

function looksLikeCodexPageTarget(target) {
  // 这一段作为兼容兜底，只接受非辅助窗口的 Codex 页面，不再退回任意 page。
  // Keep a compatibility fallback for non-auxiliary Codex pages without falling back to any page.
  if (!isPageTarget(target) || isAuxiliaryCodexPageTarget(target)) return false;
  return `${target.title} ${target.url}`.toLowerCase().includes("codex");
}

export function pickPageTarget(targets) {
  // 这一段只保留可通过 WebSocket 调试的页面目标。
  // Keep only page targets that expose a WebSocket debugger URL.
  const pages = targets.filter(isPageTarget);

  // 这一段优先选择主 Codex 窗口；没有主窗口时继续等待，而不是误选宠物页。
  // Prefer the main Codex window; when it is absent, wait instead of selecting the avatar page.
  return (
    pages.find(isMainCodexPageTarget) ||
    pages.find(looksLikeCodexPageTarget) ||
    null
  );
}

export async function listTargetConnections(debugPort) {
  // 这一段同时尝试 IPv4 和 IPv6 loopback，避免把单地址失败误判为 Codex 不可验证。
  // Try both IPv4 and IPv6 loopback so one endpoint failure does not block runtime verification.
  const errors = [];
  const connections = [];
  for (const url of cdpTargetListUrls(debugPort)) {
    try {
      const targets = await fetchJson(url);
      if (!Array.isArray(targets)) {
        errors.push(`${url}: CDP target list is not an array`);
        continue;
      }
      connections.push({ targets, url });
    } catch (error) {
      errors.push(`${url}: ${error?.message || error}`);
    }
  }
  if (connections.length > 0) return connections;
  throw new Error(`failed to query CDP targets: ${errors.join("; ")}`);
}

export async function listTargets(debugPort) {
  // 这一段优先返回包含主 Codex target 的端点，避免 IPv4 被其它进程占用时跳过 IPv6。
  // Prefer the endpoint with the main Codex target so an occupied IPv4 port cannot hide IPv6.
  const connections = await listTargetConnections(debugPort);
  return (
    connections.find(({ targets }) => pickPageTarget(targets)) ||
    connections.find(({ targets }) => targets.some(isAuxiliaryCodexPageTarget)) ||
    connections[0]
  );
}

export async function waitForTargetConnection(debugPort, timeoutMs) {
  // 这一段在限定时间内轮询 CDP 目标，等待 Codex 窗口真正可连接。
  // Poll CDP targets within the timeout until the Codex window is connectable.
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      // 这一段读取当前页面目标列表，并挑出可注入的页面。
      // Read current page targets and pick one suitable for injection.
      const connections = await listTargetConnections(debugPort);
      for (const { targets, url } of connections) {
        const target = pickPageTarget(targets);
        if (target) return { target, url };
      }
      lastError = new Error(`No page target found in ${connections.map(({ url }) => url).join(", ")}`);
    } catch (error) {
      // 这一段保留最后一次失败原因，超时时给用户更有用的错误信息。
      // Preserve the last failure so timeout errors stay useful.
      lastError = error;
    }

    // 这一段短暂等待后重试，避免 Codex 冷启动时立即失败。
    // Wait briefly before retrying so cold Codex startup does not fail immediately.
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for CDP target: ${lastError?.message || "unknown error"}`);
}

export async function waitForTarget(debugPort, timeoutMs) {
  // 这一段保留旧调用方返回 target 的接口，同时复用双 loopback 探测。
  // Keep the old target-only contract while reusing the dual-loopback probe.
  return (await waitForTargetConnection(debugPort, timeoutMs)).target;
}

export function delay(ms) {
  // 这一段提供轻量等待工具，供后台桥断线重连时节流使用。
  // Provide a lightweight wait helper so background bridge reconnects are throttled.
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class CdpClient {
  constructor(webSocketUrl) {
    // 这一段保存 CDP WebSocket 地址，并初始化请求编号、等待队列和事件监听表。
    // Store the CDP WebSocket URL and initialize request ids, pending calls, and event handlers.
    this.webSocketUrl = webSocketUrl;
    this.nextId = 1;
    this.pending = new Map();
    this.eventHandlers = new Map();
  }

  async connect() {
    // 这一段建立 WebSocket 连接，用来发送 CDP 命令。
    // Open the WebSocket connection used to send CDP commands.
    this.socket = new WebSocket(this.webSocketUrl);

    // 这一段把 CDP 响应和事件分别分发，既支持请求响应，也支持 Runtime.bindingCalled 这类主动事件。
    // Route CDP responses and events separately so both request replies and Runtime.bindingCalled events work.
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) {
          pending.reject(new Error(JSON.stringify(message.error)));
        } else {
          pending.resolve(message);
        }
        return;
      }
      this.emit(message.method, message.params);
    });

    // 这一段在调试连接关闭时拒绝未完成请求，避免桥接进程挂住等待。
    // Reject pending calls when the debugging connection closes so the bridge cannot hang on stale work.
    this.closed = new Promise((resolve) => {
      this.socket.addEventListener("close", () => {
        const error = new Error("CDP connection closed");
        for (const pending of this.pending.values()) pending.reject(error);
        this.pending.clear();
        resolve();
      }, { once: true });
    });

    // 这一段等待连接成功或失败，避免在 socket 未打开时发送命令。
    // Wait for connection success or failure before sending any commands.
    await new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });
  }

  send(method, params = {}) {
    // 这一段给每个 CDP 请求分配唯一 id，并序列化请求体。
    // Assign a unique id to each CDP request and serialize the payload.
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });

    // 这一段记录待完成请求，再把命令发给 Codex 的调试端口。
    // Track the pending request before sending the command to Codex's debugger.
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(payload);
    });
  }

  on(method, handler) {
    // 这一段登记 CDP 主动事件监听器，返回函数供调用方按生命周期清理。
    // Register a CDP event handler and return a cleanup function for lifecycle control.
    const handlers = this.eventHandlers.get(method) ?? new Set();
    handlers.add(handler);
    this.eventHandlers.set(method, handlers);
    return () => handlers.delete(handler);
  }

  emit(method, params) {
    // 这一段分发 CDP 主动事件，单个监听器失败只记录警告，不影响其它监听器。
    // Dispatch CDP events; one handler failure only logs and does not affect other handlers.
    const handlers = this.eventHandlers.get(method);
    if (!handlers) return;
    for (const handler of handlers) {
      try {
        handler(params);
      } catch (error) {
        console.warn("[Codex-Pro] CDP event handler failed", error);
      }
    }
  }

  waitForClose() {
    // 这一段暴露连接关闭信号，让原生快捷键桥可以随 Codex 页面生命周期退出。
    // Expose the close signal so the native shortcut bridge exits with the Codex page lifecycle.
    return this.closed;
  }

  close() {
    // 这一段关闭 WebSocket，避免注入完成后保留多余连接。
    // Close the WebSocket so injection does not leave an extra connection behind.
    this.socket?.close();
  }
}
