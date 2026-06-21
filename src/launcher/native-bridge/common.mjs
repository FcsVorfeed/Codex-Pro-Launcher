import { randomUUID } from "node:crypto";
import { rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export const cloudSyncMaxEndpointLength = 500;
export const codexProDataDirName = ".Codex-Pro-Launcher";

export function normalizeNativeBridgeRequestId(value) {
  // 这一段把页面请求 id 收敛成短文本，避免事件回包携带任意大字符串。
  // Collapse page request ids into short text so response events cannot carry arbitrary large strings.
  const requestId = String(value || "").trim();
  if (!requestId || requestId.length > 80 || !/^[A-Za-z0-9._:-]+$/u.test(requestId)) return "";
  return requestId;
}

export function normalizeCloudSyncEndpoint(value) {
  // 这一段只允许 HTTPS 或本机 HTTP 同步地址，避免页面借 native bridge 请求任意协议。
  // Allow only HTTPS or local HTTP sync endpoints so the page cannot use native bridge for arbitrary protocols.
  const rawValue = typeof value === "string" ? value.trim().slice(0, cloudSyncMaxEndpointLength) : "";
  if (!rawValue || rawValue.includes("\0")) return "";
  try {
    const url = new URL(rawValue);
    const isLocalHttp =
      url.protocol === "http:" &&
      ["127.0.0.1", "::1", "[::1]", "localhost"].includes(url.hostname);
    if (url.protocol !== "https:" && !isLocalHttp) return "";
    return url.href.replace(/\/+$/, "");
  } catch {
    return "";
  }
}

export function getCodexHomeDir() {
  // 这一段解析 Codex 用户目录，只使用 CODEX_HOME 或当前用户 home 下的 .codex。
  // Resolve the Codex user directory from CODEX_HOME or the current user's home .codex folder.
  const override = String(process.env.CODEX_HOME || "").trim();
  return path.resolve(override || path.join(homedir(), ".codex"));
}

export function getCodexProDataRootDir() {
  // 这一段把 Codex-Pro 自有运行期文件统一收口到 Codex 用户目录下的单一根目录。
  // Keep Codex-Pro owned runtime files under one root inside the Codex user directory.
  return path.join(getCodexHomeDir(), codexProDataDirName);
}

export const nativeBridgeStateDir = getCodexProDataRootDir();

export async function writeFileAtomically(filePath, content, encoding) {
  // 这一段先写临时文件再 rename，避免中断时留下半个 JSON、Markdown 或资源文件。
  // Write a temp file before rename so interruptions do not leave partial JSON, Markdown, or resource files.
  const tempPath = `${filePath}.codex-pro-tmp-${process.pid}-${Date.now()}-${randomUUID()}`;
  try {
    await writeFile(tempPath, content, encoding);
    await rename(tempPath, filePath);
  } catch (error) {
    try {
      await unlink(tempPath);
    } catch {
      // 这一段忽略清理失败，保留原始写入错误给调用方处理。
      // Ignore cleanup failures so the original write error remains visible to callers.
    }
    throw error;
  }
}
