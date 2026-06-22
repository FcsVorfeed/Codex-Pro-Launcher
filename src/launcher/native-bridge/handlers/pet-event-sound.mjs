import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { normalizeNativeBridgeRequestId } from "../common.mjs";

const petEventSoundMaxPathLength = 1000;
const petEventSoundMaxBytes = 5 * 1024 * 1024;

function normalizePetEventSoundStateId(value) {
  // 这一段规范化页面传入的官方状态 id，底层 bridge 不再接受页面路径。
  // Normalize the page-supplied official state id; the low-level bridge no longer accepts page paths.
  const stateId = String(value || "").trim();
  if (!stateId || stateId.length > 40 || !/^[a-z-]+$/u.test(stateId)) return "";
  return stateId;
}

function normalizePetEventSoundPath(value) {
  // 这一段规范化页面传入的音效路径文本，拒绝空值、控制字符和超长字符串。
  // Normalize page-supplied sound path text, rejecting empty values, control characters, and oversized strings.
  const soundPath = String(value || "").trim();
  if (!soundPath || soundPath.length > petEventSoundMaxPathLength || /[\0\r\n]/u.test(soundPath)) return "";
  return soundPath;
}

function getPetEventSoundMime(filePath) {
  // 这一段按扩展名限制可读取的音频类型，避免页面借音效功能读取任意文件。
  // Restrict readable audio types by extension so the page cannot use sound playback to read arbitrary files.
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".aac") return "audio/aac";
  if (extension === ".flac") return "audio/flac";
  if (extension === ".m4a") return "audio/mp4";
  if (extension === ".mp3") return "audio/mpeg";
  if (extension === ".ogg") return "audio/ogg";
  if (extension === ".wav") return "audio/wav";
  return "";
}

function isLocalAbsolutePath(filePath) {
  // 这一段只允许本机绝对路径，拒绝 UNC/网络路径，避免音效读取触发远端文件访问。
  // Allow only local absolute paths and reject UNC/network paths so sound reads cannot trigger remote file access.
  if (!path.isAbsolute(filePath)) return false;
  if (/^(?:\\\\|\/\/)/u.test(filePath)) return false;
  if (process.platform === "win32") return /^[A-Za-z]:[\\/]/u.test(filePath);
  return filePath.startsWith("/");
}

export function parsePetEventSoundRequest(request) {
  // 这一段解析宠物状态音效读取请求，只允许 request id 和官方状态 id 进入 handler。
  // Parse a pet-state sound read request, allowing only request id and official state id into the handler.
  const requestId = normalizeNativeBridgeRequestId(request?.requestId);
  const stateId = normalizePetEventSoundStateId(request?.stateId);
  if (!requestId || !stateId) return null;
  return {
    requestId,
    stateId,
    type: "pet-event-sound",
  };
}

export async function resolvePetEventSoundPath(client, nativeBridge, stateId) {
  // 这一段在当前主窗口内按状态 id 读取已保存设置路径，把设置映射约束放到 native 边界内。
  // Read the saved settings path by state id in the current main window, enforcing the mapping inside the native boundary.
  const response = await client.send("Runtime.evaluate", {
    allowUnsafeEvalBlockedByCSP: true,
    expression: `
      (() => {
        const bridgeId = ${JSON.stringify(nativeBridge.bridgeId)};
        const stateId = ${JSON.stringify(stateId)};
        if (window.__codexProNativeBridgeConfig?.bridgeId !== bridgeId) return "";
        const settingsApi = window.__codexProRuntime?.systemModules?.settingsMenu?.settings;
        const stateIds = Array.isArray(settingsApi?.petEventSoundStateIds) ? settingsApi.petEventSoundStateIds : [];
        if (!stateIds.includes(stateId)) return "";
        const settings = settingsApi?.getSettings?.() || {};
        if (settings.enablePetEventSounds !== true) return "";
        const paths = settings.petEventSoundPaths && typeof settings.petEventSoundPaths === "object"
          ? settings.petEventSoundPaths
          : {};
        const value = String(paths[stateId] || "").trim();
        if (!value || value.length > ${petEventSoundMaxPathLength} || /[\\0\\r\\n]/u.test(value)) return "";
        return value;
      })()
    `,
    awaitPromise: false,
    returnByValue: true,
  });
  return normalizePetEventSoundPath(response?.result?.result?.value);
}

export async function readPetEventSound(request) {
  // 这一段验证绝对路径、扩展名和大小，避免相对路径探测或超大文件进入 CDP 回包。
  // Validate absolute path, extension, and size so relative-path probing or huge files do not enter the CDP response.
  const soundPath = normalizePetEventSoundPath(request?.path);
  if (!soundPath || !isLocalAbsolutePath(soundPath)) return { bytes: 0, error: "invalidPath", ok: false };
  const mime = getPetEventSoundMime(soundPath);
  if (!mime) return { bytes: 0, error: "unsupportedType", ok: false };
  const info = await stat(soundPath);
  if (!info.isFile()) return { bytes: 0, error: "notFile", ok: false };
  if (info.size > petEventSoundMaxBytes) return { bytes: info.size, error: "fileTooLarge", ok: false };

  // 这一段读取音频文件并回传 base64；响应不包含本机路径，避免泄漏到页面日志。
  // Read the audio file and return base64 without echoing the local path into page logs.
  const bytes = await readFile(soundPath);
  return {
    base64: bytes.toString("base64"),
    bytes: bytes.length,
    error: "",
    mime,
    ok: true,
  };
}
