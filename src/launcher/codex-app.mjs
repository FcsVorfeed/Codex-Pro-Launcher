import { spawn, spawnSync } from "node:child_process";
import path from "node:path";

import { rootDir } from "./paths.mjs";

function versionPartsFromPackageName(value) {
  // 这一段从 MSIX 包目录名中提取版本号，后续用于选择最新安装包。
  // Extract the version from an MSIX package directory name for latest-package sorting.
  const match = /OpenAI\.Codex_(\d+(?:\.\d+)*)_/i.exec(value);
  if (!match) return [];
  return match[1].split(".").map((part) => Number(part) || 0);
}

function compareVersions(left, right) {
  // 这一段逐位比较版本号，支持不同长度的版本数组。
  // Compare version arrays part by part, including arrays with different lengths.
  const max = Math.max(left.length, right.length);
  for (let index = 0; index < max; index += 1) {
    const diff = (left[index] || 0) - (right[index] || 0);
    if (diff) return diff;
  }
  return 0;
}

function normalizeCodexPath(value) {
  // 这一段把用户传入的 exe、app 目录或包目录统一成 Codex.exe 路径。
  // Normalize an exe path, app directory, or package directory into a Codex.exe path.
  if (!value) return "";
  const resolved = path.resolve(value);
  if (/codex\.exe$/i.test(resolved)) return resolved;
  if (/\\app$/i.test(resolved)) return path.join(resolved, "Codex.exe");
  return path.join(resolved, "app", "Codex.exe");
}

function packageNameFromExecutable(executable) {
  // 这一段从 Codex.exe 完整路径中找出 OpenAI.Codex_* 包目录名。
  // Find the OpenAI.Codex_* package directory name from a full Codex.exe path.
  return executable
    .split(/[\\/]/)
    .find((part) => /^OpenAI\.Codex_/i.test(part)) || "";
}

export function appUserModelIdFromExecutable(executable) {
  // 这一段根据 MSIX 包名推导 AppUserModelId，用于系统应用激活。
  // Derive the AppUserModelId from the MSIX package name for packaged app activation.
  const packageName = packageNameFromExecutable(executable);
  if (!packageName.includes("__")) return "";
  const identityName = packageName.split("_")[0];
  const publisherId = packageName.split("__").at(-1);
  if (!identityName || !publisherId) return "";
  return `${identityName}_${publisherId}!App`;
}

function candidateFromNodeOnPath() {
  // 这一段只在 Windows 上探测 PATH，因为 Codex 桌面端是 Windows MSIX 应用。
  // Probe PATH only on Windows because the Codex desktop app target here is an MSIX app.
  if (process.platform !== "win32") return "";

  // 这一段用 where.exe 找 node.exe，Codex 自带 node.exe 时可反推出 Codex.exe。
  // Use where.exe to find node.exe so Codex's bundled node can reveal Codex.exe.
  const result = spawnSync("where.exe", ["node"], { encoding: "utf8" });
  if (result.status !== 0) return "";

  // 这一段筛选 Codex 包内的 node.exe，避免误用系统 Node.js。
  // Filter for Codex's packaged node.exe and avoid using the system Node.js path.
  const codexNode = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /\\OpenAI\.Codex_[^\\]+\\app\\resources\\node\.exe$/i.test(line));

  // 这一段把 resources\node.exe 替换为同级 app\Codex.exe。
  // Convert resources\node.exe into the sibling app\Codex.exe path.
  if (!codexNode) return "";
  return codexNode.replace(/\\resources\\node\.exe$/i, "\\Codex.exe");
}

export function resolveCodexExecutable(appPath) {
  // 这一段优先使用用户显式传入的路径，避免自动探测误判。
  // Prefer an explicitly supplied path to avoid incorrect auto-detection.
  const explicit = normalizeCodexPath(appPath);
  if (explicit) return explicit;

  // 这一段尝试从 PATH 中的 Codex 内置 Node.js 反推 Codex.exe。
  // Try to infer Codex.exe from Codex's bundled Node.js on PATH.
  const fromNodePath = candidateFromNodeOnPath();
  if (fromNodePath) return fromNodePath;

  // 这一段准备常见 WindowsApps 根目录，兼容不同 Program Files 环境变量。
  // Prepare common WindowsApps roots to handle different Program Files variables.
  const roots = [
    process.env.ProgramFiles,
    process.env.ProgramW6432,
    "C:\\Program Files",
  ]
    .filter(Boolean)
    .map((root) => path.join(root, "WindowsApps"));

  // 这一段扫描 OpenAI.Codex_* 包目录，并记录每个候选版本。
  // Scan OpenAI.Codex_* package directories and keep each candidate version.
  const candidates = [];
  for (const root of roots) {
    const result = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `Get-ChildItem -LiteralPath ${JSON.stringify(root)} -Directory -Filter 'OpenAI.Codex_*' -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName }`,
      ],
      { encoding: "utf8" },
    );
    if (result.status !== 0) continue;
    for (const line of result.stdout.split(/\r?\n/)) {
      const packageDir = line.trim();
      if (!packageDir) continue;
      candidates.push({
        executable: path.join(packageDir, "app", "Codex.exe"),
        version: versionPartsFromPackageName(packageDir),
      });
    }
  }

  // 这一段选择版本号最高的 Codex.exe，避免旧版本残留被优先使用。
  // Choose the highest-version Codex.exe so stale package directories are not preferred.
  candidates.sort((left, right) => compareVersions(right.version, left.version));
  return candidates[0]?.executable || "";
}

export function codexLaunchArgs(debugPort) {
  // 这一段生成 Chromium CDP 参数，注入器后续会连接这个本地端口。
  // Build Chromium CDP arguments; the injector connects to this local port later.
  return [
    `--remote-debugging-port=${debugPort}`,
    `--remote-allow-origins=http://127.0.0.1:${debugPort}`,
  ];
}

export function launchCodex(target, debugPort) {
  // 这一段生成 Codex 启动参数，确保 CDP 端口打开给注入器使用。
  // Build Codex launch arguments so the CDP port is available for injection.
  const args = codexLaunchArgs(debugPort);

  // 这一段在 exe 路径不可见时走 MSIX 激活，适配普通 PowerShell 权限。
  // Use MSIX activation when the exe path is not visible from a normal PowerShell session.
  if (!target.executable) {
    return activatePackagedCodex(target.appUserModelId, args);
  }

  try {
    // 这一段优先直接启动 exe，适配可访问 WindowsApps 路径的环境。
    // Prefer launching the exe directly when the WindowsApps path is accessible.
    const child = spawn(target.executable, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    return { executable: target.executable, args, pid: child.pid, method: "spawn" };
  } catch (error) {
    // 这一段在 MSIX 权限拦截直接启动时，退回系统应用激活接口。
    // Fall back to packaged app activation when MSIX blocks direct process spawn.
    if (process.platform !== "win32" || error?.code !== "EPERM") throw error;
    return activatePackagedCodex(target.appUserModelId, args, target.executable);
  }
}

function activatePackagedCodex(appUserModelId, args, executable = "") {
  // 这一段确认有可用的 AppUserModelId，否则无法通过 MSIX 启动应用。
  // Ensure an AppUserModelId is available because MSIX activation requires it.
  if (!appUserModelId) {
    throw new Error(`Cannot derive AppUserModelId${executable ? ` from ${executable}` : ""}`);
  }

  // 这一段调用 PowerShell 激活脚本，并显式绕过脚本执行策略。
  // Invoke the PowerShell activation helper with an explicit execution-policy bypass.
  const scriptPath = path.join(rootDir, "scripts", "activate-packaged-app.ps1");
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      scriptPath,
      "-AppUserModelId",
      appUserModelId,
      "-Arguments",
      args.join(" "),
    ],
    { encoding: "utf8" },
  );

  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || "Packaged activation failed").trim());
  }

  // 这一段返回统一的启动信息，方便日志和 dry-run 对齐。
  // Return normalized launch metadata so logs and dry-run output stay aligned.
  return {
    executable,
    args,
    appUserModelId,
    method: "packaged-activation",
    pid: Number(result.stdout.trim()) || null,
  };
}
