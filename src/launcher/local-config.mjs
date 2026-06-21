import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { rootDir } from "./paths.mjs";

const localConfigEnvName = "CODEX_PRO_LOCAL_CONFIG";
const localConfigRelativePath = ["private", "config", "codex-pro.local.json"];
const localConfigFileName = "codex-pro.local.json";

export async function readLocalConfig() {
  // 这一段按优先级读取本机私有配置，让开发注入和 Rust 启动器使用同一份配置。
  // Read private local config by priority so dev injection and the Rust launcher share one config.
  for (const configPath of getLocalConfigCandidatePaths()) {
    try {
      const contents = await readFile(configPath, "utf8");
      const parsed = JSON.parse(contents);
      return sanitizeFrontendLocalConfig(parsed);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      console.warn("[Codex-Pro] local config skipped", error?.message || error);
    }
  }
  return {};
}

function sanitizeFrontendLocalConfig(config) {
  // 这一段只把前端需要的配置注入页面，授权服务地址保留在 native bridge 侧读取。
  // Inject only frontend-needed config into the page; keep license-service URLs on the native bridge side.
  if (!config || typeof config !== "object" || Array.isArray(config)) return {};
  return {
    appearance: readObject(config.appearance),
    conversationArchive: readObject(config.conversationArchive),
    sync: readObject(config.sync),
  };
}

function readObject(value) {
  // 这一段只接受普通对象配置，避免数组或字符串被注入成运行时配置。
  // Accept only object config values so arrays or strings are not injected as runtime config.
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function getLocalConfigCandidatePaths() {
  // 这一段生成候选路径并去重，显式环境变量优先。
  // Build de-duplicated candidate paths with the explicit environment variable first.
  const paths = [];
  const seen = new Set();
  pushEnvConfigPath(paths, seen);
  pushRepositoryConfigPath(rootDir, paths, seen);
  pushCurrentDirConfigPaths(paths, seen);
  pushRuntimeDataConfigPath(paths, seen);
  return paths;
}

function pushEnvConfigPath(paths, seen) {
  // 这一段支持把私有配置放在仓库外，降低公开仓库误带真实值的概率。
  // Support private config outside the repo to reduce accidental publication risk.
  const value = String(process.env[localConfigEnvName] || "").trim();
  if (value) pushUniquePath(paths, seen, path.resolve(value));
}

function pushRepositoryConfigPath(baseDir, paths, seen) {
  // 这一段加入仓库约定的 private/config/codex-pro.local.json。
  // Add the repository-convention private/config/codex-pro.local.json path.
  pushUniquePath(paths, seen, path.resolve(baseDir, ...localConfigRelativePath));
}

function pushCurrentDirConfigPaths(paths, seen) {
  // 这一段兼容从仓库子目录执行 Node 注入脚本的情况。
  // Cover Node injection launched from a repository subdirectory.
  let current = process.cwd();
  while (current && current !== path.dirname(current)) {
    pushRepositoryConfigPath(current, paths, seen);
    current = path.dirname(current);
  }
  if (current) pushRepositoryConfigPath(current, paths, seen);
}

function pushRuntimeDataConfigPath(paths, seen) {
  // 这一段兼容把私有配置放到用户 Codex-Pro 数据目录。
  // Support private config stored in the user Codex-Pro data directory.
  const home = homedir();
  if (!home) return;
  pushUniquePath(paths, seen, path.join(home, ".codex", ".Codex-Pro-Launcher", localConfigFileName));
}

function pushUniquePath(paths, seen, configPath) {
  // 这一段用字符串路径去重，避免同一路径重复读取。
  // De-duplicate by string path so the same file is not read repeatedly.
  if (seen.has(configPath)) return;
  seen.add(configPath);
  paths.push(configPath);
}
