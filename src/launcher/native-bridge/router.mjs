import {
  openExternalDiff,
  parseExternalDiffRequest,
  parseGitDiffSummaryRequest,
  readGitDiffSummary,
} from "./handlers/diff-hover-preview.mjs";
import {
  dispatchNativeShortcut,
  parseShortcutRequest,
} from "./handlers/mouse-gestures.mjs";
import {
  parseConversationArchiveRequest,
  runConversationArchiveRequest,
} from "./handlers/conversation-archive.mjs";
import {
  parseTodayTokenUsageRequest,
  readTodayTokenUsage,
} from "./handlers/today-token-usage.mjs";
import {
  parsePetEventSoundRequest,
  readPetEventSound,
  resolvePetEventSoundPath,
} from "./handlers/pet-event-sound.mjs";

const defaultNativeBridgeMaxPayloadLength = 24_000;

function createParserMap() {
  // 这一段集中声明 request type 到 parser 的映射，避免主 bridge 继续堆分支。
  // Centralize request type to parser mapping so the main bridge no longer accumulates branches.
  return new Map([
    ["shortcut", parseShortcutRequest],
    ["external-diff", parseExternalDiffRequest],
    ["git-diff-summary", parseGitDiffSummaryRequest],
    ["conversation-archive", parseConversationArchiveRequest],
    ["today-token-usage", parseTodayTokenUsageRequest],
    ["pet-event-sound", parsePetEventSoundRequest],
  ]);
}

function createDispatchMap() {
  // 这一段集中声明 request type 到 handler 的映射，让主 bridge 不再承载业务分支。
  // Centralize request type to handler mapping so the main bridge no longer owns business branches.
  return new Map([
    ["shortcut", dispatchShortcutRequest],
    ["external-diff", dispatchExternalDiffRequest],
    ["git-diff-summary", dispatchGitDiffSummaryRequest],
    ["conversation-archive", dispatchConversationArchiveRequest],
    ["today-token-usage", dispatchTodayTokenUsageRequest],
    ["pet-event-sound", dispatchPetEventSoundRequest],
  ]);
}

export function parseNativeBridgeRequest(params, nativeBridge, options = {}) {
  // 这一段解析并校验页面请求，只接受当前 bridgeId 和很小的 JSON 负载。
  // Parse and validate page requests, accepting only the current bridgeId and a small JSON payload.
  if (!nativeBridge || params?.name !== nativeBridge.bindingName) return null;
  const rawPayload = typeof params?.payload === "string" ? params.payload : "";
  const maxPayloadLength = Number.isInteger(options.maxPayloadLength)
    ? options.maxPayloadLength
    : defaultNativeBridgeMaxPayloadLength;
  if (!rawPayload || rawPayload.length > maxPayloadLength) return null;
  try {
    const request = JSON.parse(rawPayload);
    if (request?.bridgeId !== nativeBridge.bridgeId) return null;
    const parser = createParserMap().get(request?.type);
    return typeof parser === "function" ? parser(request) : null;
  } catch {
    return null;
  }
}

function dispatchShortcutRequest(client, nativeBridge, request, options) {
  // 这一段把快捷键发送交给鼠标手势 handler；测试可通过 options 注入 fake dispatcher。
  // Send shortcut dispatch to the mouse gesture handler; tests may inject a fake dispatcher through options.
  const dispatchShortcut = typeof options.dispatchShortcut === "function"
    ? options.dispatchShortcut
    : dispatchNativeShortcut;
  dispatchShortcut(client, request.shortcut).catch((error) => {
    console.warn(`[Codex-Pro] native shortcut failed: ${request.shortcut.description}`, error);
  });
  return true;
}

function dispatchExternalDiffRequest(client, nativeBridge, request) {
  // 这一段启动外部 Diff，不需要页面回包。
  // Launch external diff without sending a response event back to the page.
  openExternalDiff(request).catch((error) => {
    console.warn(`[Codex-Pro] external diff failed for ${request.path}`, error);
  });
  return true;
}

function sendResponse(client, nativeBridge, request, response, options, responseType = request.type) {
  // 这一段复用主文件统一响应发送函数，保证所有异步回包格式一致。
  // Reuse the main file's unified response sender so all async responses keep the same shape.
  if (typeof options.sendNativeBridgeResponse !== "function") return Promise.resolve(false);
  return options.sendNativeBridgeResponse(client, nativeBridge, request.requestId, responseType, response);
}

function dispatchResponseRequest(client, nativeBridge, request, options, runner, logMessage, fallbackResponse) {
  // 这一段统一异步 handler 的成功回包和失败回包，避免每个分支重复事件发送逻辑。
  // Share success and failure response handling across async handlers to avoid duplicated event dispatch code.
  runner()
    .then((response) => sendResponse(client, nativeBridge, request, response, options))
    .catch((error) => {
      console.warn(logMessage, error?.message || error);
      return sendResponse(client, nativeBridge, request, fallbackResponse(error), options);
    });
  return true;
}

function dispatchGitDiffSummaryRequest(client, nativeBridge, request, options) {
  // 这一段读取 Git 摘要并回传给页面；失败时保留原有 null 响应。
  // Read the Git summary and return it to the page; failures preserve the existing null response.
  return dispatchResponseRequest(
    client,
    nativeBridge,
    request,
    options,
    () => readGitDiffSummary(request.cwd),
    `[Codex-Pro] git diff summary failed for ${request.cwd}`,
    () => null,
  );
}

function dispatchConversationArchiveRequest(client, nativeBridge, request, options) {
  // 这一段把会话归档请求交给独立 handler，并复用统一响应事件。
  // Send conversation archive requests to the dedicated handler and reuse the unified response event.
  const sendProgress = (progress) => sendResponse(
    client,
    nativeBridge,
    request,
    {
      data: progress,
      error: "",
      ok: true,
      status: 102,
    },
    options,
    "conversation-archive-progress",
  );
  return dispatchResponseRequest(
    client,
    nativeBridge,
    request,
    options,
    () => runConversationArchiveRequest(request, { onProgress: sendProgress }),
    "[Codex-Pro] conversation archive request failed",
    (error) => ({
      data: null,
      error: error?.message || "Conversation archive request failed",
      ok: false,
      status: 0,
    }),
  );
}

function dispatchTodayTokenUsageRequest(client, nativeBridge, request, options) {
  // 这一段读取本机 Today token 聚合并回传页面；失败时保持结构化错误。
  // Read local Today token aggregates and return them to the page, preserving structured errors on failure.
  return dispatchResponseRequest(
    client,
    nativeBridge,
    request,
    options,
    () => readTodayTokenUsage(request),
    "[Codex-Pro] today token usage request failed",
    (error) => ({
      data: null,
      error: error?.message || "Today token usage request failed",
      ok: false,
      status: 0,
    }),
  );
}

function dispatchPetEventSoundRequest(client, nativeBridge, request, options) {
  // 这一段先从当前设置解析状态音效路径，再读取文件；失败时使用中性错误，不输出本机路径。
  // Resolve the state sound path from current settings before reading; failures use a neutral error without logging the local path.
  resolvePetEventSoundPath(client, nativeBridge, request.stateId)
    .then((soundPath) => (soundPath
      ? readPetEventSound({ path: soundPath, requestId: request.requestId, type: request.type })
      : { bytes: 0, error: "unavailable", ok: false }))
    .then((response) => sendResponse(client, nativeBridge, request, response, options))
    .catch(() => sendResponse(client, nativeBridge, request, {
      bytes: 0,
      error: "readFailed",
      ok: false,
    }, options));
  return true;
}

export function dispatchNativeBridgeRequest(client, nativeBridge, request, options = {}) {
  // 这一段根据已解析 request 找 handler；未知类型直接忽略，保持原有安全边界。
  // Find the handler for a parsed request; unknown types are ignored to preserve the existing safety boundary.
  const handler = createDispatchMap().get(request?.type);
  return typeof handler === "function" ? handler(client, nativeBridge, request, options) : false;
}
