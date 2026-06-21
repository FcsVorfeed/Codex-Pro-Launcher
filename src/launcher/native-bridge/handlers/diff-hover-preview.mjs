import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  nativeBridgeStateDir,
  normalizeNativeBridgeRequestId,
} from "../common.mjs";
import { rootDir } from "../../paths.mjs";

const externalDiffTempRootDir = path.join(nativeBridgeStateDir, "external-diff");
const externalDiffMaxFileBytes = 25 * 1024 * 1024;
const externalDiffMaxPathLength = 1000;
const externalDiffMaxRelativePathLength = 500;
const externalDiffFocusCommand = "--focus-external-diff";
const externalDiffFocusHelperEnvName = "CODEX_PRO_FOCUS_HELPER_EXE";
const externalDiffFocusFallbackHelperPath = path.join(rootDir, "private", "bin", "Codex-Pro-Launcher.exe");
const externalDiffGitCommandTimeoutMs = 8000;
const externalDiffTempMaxAgeMs = 24 * 60 * 60 * 1000;
const gitDiffSummaryCommandTimeoutMs = 8000;
const gitDiffSummaryMaxFiles = 500;
const gitDiffSummaryMaxNavigationRanges = 200;
const gitDiffSummaryMaxOutputBytes = 2 * 1024 * 1024;
const gitHunkHeaderPattern = /^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,(\d+))?\s+@@/u;

function normalizeExternalDiffExecutablePath(value) {
  // 这一段只接受绝对可执行文件路径，避免页面把参数或相对命令传给 launcher。
  // Accept only an absolute executable path so the page cannot pass arguments or relative commands to the launcher.
  const rawPath = typeof value === "string" ? value.trim().slice(0, externalDiffMaxPathLength) : "";
  const filePath = rawPath.replace(/^"(.+)"$/u, "$1");
  if (!filePath || filePath.includes("\0") || !path.isAbsolute(filePath)) return "";
  return path.normalize(filePath);
}

function normalizeExternalDiffCwd(value) {
  // 这一段只接受绝对工作区路径，后续文件解析必须限制在这个目录内。
  // Accept only an absolute workspace path; file resolution is later constrained to this directory.
  const cwd = typeof value === "string" ? value.trim().slice(0, externalDiffMaxPathLength) : "";
  if (!cwd || cwd.includes("\0") || !path.isAbsolute(cwd)) return "";
  return path.resolve(cwd);
}

function normalizeExternalDiffRelativePath(value) {
  // 这一段把页面传入的文件路径限制为普通工作区相对路径，拒绝绝对路径和向上跳转。
  // Restrict page-provided file paths to plain workspace-relative paths, rejecting absolutes and parent traversal.
  const rawPath = typeof value === "string" ? value.trim().slice(0, externalDiffMaxRelativePathLength) : "";
  const unifiedPath = rawPath.replace(/\\/g, "/").replace(/^\.\//u, "");
  if (!unifiedPath || unifiedPath.includes("\0")) return "";
  if (unifiedPath.startsWith("/") || /^[a-z]:/iu.test(unifiedPath)) return "";

  // 这一段逐段校验路径，保留正常子目录结构但不允许 . 或 .. 语义。
  // Validate path segment by segment, preserving subdirectories without allowing . or .. semantics.
  const segments = unifiedPath.split("/").filter(Boolean);
  if (segments.length === 0 || segments.some((segment) => segment === "." || segment === "..")) return "";
  return segments.join("/");
}

function normalizeExternalDiffChangeKind(value) {
  // 这一段只保留短变更类型文本，用于决定新增/删除文件的空文件侧。
  // Keep only a short change-kind label to decide which side should be empty for added/deleted files.
  return String(value || "").trim().slice(0, 40);
}

export function parseExternalDiffRequest(request) {
  // 这一段把外部 Diff 请求收敛到固定字段，不接受任意命令行参数。
  // Collapse an external diff request to fixed fields and reject arbitrary command-line arguments.
  const toolPath = normalizeExternalDiffExecutablePath(request?.toolPath);
  const cwd = normalizeExternalDiffCwd(request?.cwd);
  const filePath = normalizeExternalDiffRelativePath(request?.path);
  const previousPath = normalizeExternalDiffRelativePath(request?.previousPath);
  if (!toolPath || !cwd || !filePath) return null;
  return {
    changeKind: normalizeExternalDiffChangeKind(request?.changeKind),
    cwd,
    path: filePath,
    previousPath,
    toolPath,
    type: "external-diff",
  };
}

export function parseGitDiffSummaryRequest(request) {
  // 这一段解析 Git 变更摘要请求，只接受 requestId 和绝对工作区路径。
  // Parse a Git diff summary request, accepting only requestId and an absolute workspace path.
  const requestId = normalizeNativeBridgeRequestId(request?.requestId);
  const cwd = normalizeExternalDiffCwd(request?.cwd);
  if (!requestId || !cwd) return null;
  return {
    cwd,
    requestId,
    type: "git-diff-summary",
  };
}

function comparePathInside(basePath, targetPath) {
  // 这一段按平台大小写规则判断目标路径是否仍在工作区内。
  // Check whether a target path remains inside the workspace using platform case rules.
  const normalizedBase = process.platform === "win32" ? basePath.toLowerCase() : basePath;
  const normalizedTarget = process.platform === "win32" ? targetPath.toLowerCase() : targetPath;
  const relativePath = path.relative(normalizedBase, normalizedTarget);
  return Boolean(relativePath && !relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function resolveWorkspaceFilePath(cwd, relativePath) {
  // 这一段把相对路径解析为工作区内绝对路径，拒绝任何越界结果。
  // Resolve a relative path to an absolute path inside the workspace and reject escaped targets.
  const basePath = path.resolve(cwd);
  const targetPath = path.resolve(basePath, ...relativePath.split("/"));
  if (targetPath === basePath || !comparePathInside(basePath, targetPath)) return "";
  return targetPath;
}

function getExternalDiffKindFlags(changeKind) {
  // 这一段兼容英文类型和中文标签，决定哪一侧需要空文件。
  // Support English kinds and Chinese labels to decide which side needs an empty file.
  const kind = String(changeKind || "").toLowerCase();
  return {
    isAdded: kind.includes("add") || kind.includes("create") || kind.includes("新增"),
    isDeleted: kind.includes("delete") || kind.includes("remove") || kind.includes("删除"),
  };
}

function getExternalDiffTempFileName(prefix, relativePath) {
  // 这一段保留文件名方便外部工具标题可读，同时移除 Windows 不允许的字符。
  // Keep the filename readable in external tool titles while removing Windows-invalid characters.
  const rawName = path.basename(relativePath) || "file";
  const safeName = rawName.replace(/[<>:"/\\|?*\x00-\x1F]/gu, "_").slice(0, 120) || "file";
  return `${prefix}-${safeName}`;
}

async function isExistingFile(filePath) {
  // 这一段用 stat 校验文件存在且是普通文件，失败时统一返回 false。
  // Use stat to confirm the path exists as a regular file, returning false on failures.
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

async function assertExternalDiffInputs(request) {
  // 这一段校验工具路径、工作区目录和当前文件解析结果，避免启动无效或越界路径。
  // Validate the tool path, workspace directory, and resolved current path before launching anything.
  const [toolStats, cwdStats] = await Promise.all([
    stat(request.toolPath),
    stat(request.cwd),
  ]);
  if (!toolStats.isFile()) throw new Error("External diff tool is not a file");
  if (!cwdStats.isDirectory()) throw new Error("External diff cwd is not a directory");

  // 这一段返回受限后的当前文件路径，删除文件后续会改用空文件。
  // Return the constrained current file path; deleted files later use an empty file instead.
  const currentPath = resolveWorkspaceFilePath(request.cwd, request.path);
  if (!currentPath) throw new Error("External diff file escaped workspace");
  return currentPath;
}

async function runGitShow(cwd, relativePath) {
  // 这一段通过 git show 读取 HEAD 中的文件内容，spawn 参数数组避免 shell 解释路径。
  // Read the file content from HEAD through git show, using spawn arguments so the shell never interprets paths.
  return await new Promise((resolve) => {
    const child = spawn("git", ["-C", cwd, "show", `HEAD:${relativePath}`], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const chunks = [];
    let byteLength = 0;
    let overflowed = false;
    let settled = false;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      resolve(value);
    };
    const timeoutId = setTimeout(() => {
      child.kill();
      finish(null);
    }, externalDiffGitCommandTimeoutMs);

    // 这一段限制旧版本文件大小，避免一次外部 Diff 请求占用过多内存。
    // Limit old-version file size so one external diff request cannot consume too much memory.
    child.stdout.on("data", (chunk) => {
      byteLength += chunk.length;
      if (byteLength > externalDiffMaxFileBytes) {
        overflowed = true;
        child.kill();
        return;
      }
      chunks.push(chunk);
    });
    child.stderr?.resume?.();
    child.on("error", () => finish(null));
    child.on("close", (status) => {
      if (status !== 0 || overflowed) {
        finish(null);
        return;
      }
      finish(Buffer.concat(chunks));
    });
  });
}

async function pruneExternalDiffTempRoot() {
  // 这一段清理一天前的外部 Diff 临时目录，避免长期使用后残留持续增长。
  // Remove external diff temp directories older than a day so repeated use does not grow forever.
  try {
    const entries = await readdir(externalDiffTempRootDir, { withFileTypes: true });
    await Promise.all(entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("run-"))
      .map(async (entry) => {
        const entryPath = path.join(externalDiffTempRootDir, entry.name);
        const entryStats = await stat(entryPath);
        if (Date.now() - entryStats.mtimeMs <= externalDiffTempMaxAgeMs) return;
        await rm(entryPath, { force: true, recursive: true });
      }));
  } catch {
    // 这一段忽略临时目录清理失败，避免影响本次外部 Diff 打开。
    // Ignore temp cleanup failures so the current external diff launch is not affected.
  }
}

export async function clearExternalDiffTempRootOnWorkerExit() {
  // 这一段在后台 worker 正常退出时删除外部 Diff 临时目录，避免 Codex 关闭后缓存长期残留。
  // Delete the external diff temp directory when the background worker exits so caches do not remain after Codex closes.
  try {
    await rm(externalDiffTempRootDir, { force: true, recursive: true });
  } catch {
    // 这一段忽略被外部 Diff 工具占用的文件，避免清理失败影响 worker 正常退出。
    // Ignore files still held by an external diff tool so cleanup failure does not block worker shutdown.
  }
}

async function createExternalDiffTempDir() {
  // 这一段在项目忽略目录下创建单次运行目录，让外部工具能稳定读取临时文件。
  // Create one run directory under the ignored project state folder so external tools can read stable temp files.
  await mkdir(externalDiffTempRootDir, { recursive: true });
  await pruneExternalDiffTempRoot();
  return await mkdtemp(path.join(externalDiffTempRootDir, "run-"));
}

async function writeExternalDiffTempFile(tempDir, prefix, relativePath, content = null) {
  // 这一段写入旧版本或空占位文件，并保留原始扩展名方便外部工具识别语法。
  // Write an old-version or empty placeholder file while preserving the extension for external tool syntax detection.
  const filePath = path.join(tempDir, getExternalDiffTempFileName(prefix, relativePath));
  await writeFile(filePath, content || Buffer.alloc(0));
  return filePath;
}

async function buildExternalDiffFilePair(request, currentPath) {
  // 这一段为外部 Diff 准备左右两侧文件：左侧 HEAD 版本，右侧工作区版本。
  // Prepare the two external diff sides: HEAD content on the left and workspace content on the right.
  const tempDir = await createExternalDiffTempDir();
  const { isAdded, isDeleted } = getExternalDiffKindFlags(request.changeKind);
  const oldRelativePath = request.previousPath || request.path;
  const oldContent = isAdded ? null : await runGitShow(request.cwd, oldRelativePath);
  const leftPath = await writeExternalDiffTempFile(tempDir, "HEAD", oldRelativePath, oldContent);

  // 这一段处理新增/删除/当前文件不存在的边界，外部工具始终收到两个真实路径。
  // Handle added/deleted/missing-current edges so the external tool always receives two real paths.
  if (isDeleted || !(await isExistingFile(currentPath))) {
    const rightPath = await writeExternalDiffTempFile(tempDir, "WORKTREE", request.path);
    return { leftPath, rightPath };
  }
  return { leftPath, rightPath: currentPath };
}

async function focusExternalDiffWindow(processId, toolPath) {
  // 这一段只在 Windows 上调用启动壳的隐藏辅助模式，避免影响其它平台的原有打开行为。
  // Use the launcher shell's hidden helper mode only on Windows so other platforms keep the existing launch behavior.
  if (process.platform !== "win32" || !Number.isInteger(processId) || processId <= 0) return;
  try {
    const helperPath = resolveExternalDiffFocusHelperPath();
    const helperStats = await stat(helperPath);
    if (!helperStats.isFile()) return;
    const child = spawn(helperPath, [externalDiffFocusCommand, String(processId), toolPath], {
      cwd: rootDir,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.on("error", (error) => {
      // 这一段吞掉聚焦辅助进程启动失败，避免外部 Diff 已打开时反向打断 native bridge。
      // Swallow focus-helper spawn failures so an already-opened external diff cannot take down the native bridge.
      console.warn("[Codex-Pro] external diff focus helper failed to start", error);
    });
    child.unref();
  } catch (error) {
    console.warn("[Codex-Pro] external diff focus helper unavailable", error);
  }
}

function resolveExternalDiffFocusHelperPath() {
  // 这一段允许便携单文件启动器通过环境变量指向自身；开发模式仍默认使用项目根薄壳。
  // Let the portable single-file launcher point the helper to itself; development mode still uses the root thin shell.
  const overridePath = String(process.env[externalDiffFocusHelperEnvName] || "").trim();
  if (overridePath && path.isAbsolute(overridePath)) return path.normalize(overridePath);
  return externalDiffFocusFallbackHelperPath;
}

export async function openExternalDiff(request) {
  // 这一段准备文件对并启动外部工具；启动参数固定为 [旧版本, 当前版本]。
  // Prepare the file pair and launch the external tool with fixed [old, current] arguments.
  const currentPath = await assertExternalDiffInputs(request);
  const { leftPath, rightPath } = await buildExternalDiffFilePair(request, currentPath);
  const child = spawn(request.toolPath, [leftPath, rightPath], {
    cwd: request.cwd,
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  });
  child.unref();
  void focusExternalDiffWindow(child.pid, request.toolPath);
}

function normalizeGitDiffNumber(value) {
  // 这一段把 git numstat 数字规整成非负整数，二进制文件的 "-" 统计为 0。
  // Normalize git numstat values into non-negative integers, treating binary "-" values as zero.
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.round(number));
}

function getGitDiffChangeKind(status) {
  // 这一段把 git name-status 状态转成悬浮列表使用的英文变更类型。
  // Convert git name-status codes into the English change kinds used by the hover list.
  const code = String(status || "").charAt(0).toUpperCase();
  if (code === "A") return "added";
  if (code === "D") return "deleted";
  if (code === "R") return "renamed";
  if (code === "C") return "copied";
  return "modified";
}

async function runGitText(cwd, args) {
  // 这一段运行固定 git 子命令并收集受限大小的 stdout，不经过 shell。
  // Run fixed git subcommands and collect bounded stdout without going through a shell.
  return await new Promise((resolve) => {
    const child = spawn("git", ["-C", cwd, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const chunks = [];
    let byteLength = 0;
    let overflowed = false;
    let settled = false;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      resolve(value);
    };
    const timeoutId = setTimeout(() => {
      child.kill();
      finish("");
    }, gitDiffSummaryCommandTimeoutMs);

    child.stdout.on("data", (chunk) => {
      byteLength += chunk.length;
      if (byteLength > gitDiffSummaryMaxOutputBytes) {
        overflowed = true;
        child.kill();
        return;
      }
      chunks.push(chunk);
    });
    child.stderr?.resume?.();
    child.on("error", () => finish(""));
    child.on("close", (status) => {
      if (status !== 0 || overflowed) {
        finish("");
        return;
      }
      finish(Buffer.concat(chunks).toString("utf8"));
    });
  });
}

function parseGitDiffNumstat(output) {
  // 这一段解析 git diff --numstat 输出，只保留安全的相对路径和增删行数。
  // Parse git diff --numstat output, keeping only safe relative paths and line counts.
  const statsByPath = new Map();
  for (const line of String(output || "").split(/\r?\n/u)) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const relativePath = normalizeExternalDiffRelativePath(parts.slice(2).join("\t"));
    if (!relativePath) continue;
    statsByPath.set(relativePath, {
      additions: normalizeGitDiffNumber(parts[0]),
      deletions: normalizeGitDiffNumber(parts[1]),
    });
  }
  return statsByPath;
}

function normalizeGitNavigationRanges(value) {
  // 这一段只保留正整数 hunk 范围，避免异常 diff 让页面侧状态无界增长。
  // Keep only positive integer hunk ranges so unusual diffs cannot grow page-side state unbounded.
  if (!Array.isArray(value)) return [];
  const ranges = [];
  for (const item of value) {
    const line = Math.round(Number(item?.line));
    const endLine = Math.round(Number(item?.endLine ?? item?.line));
    if (!Number.isFinite(line) || line <= 0) continue;
    ranges.push({
      line,
      endLine: Number.isFinite(endLine) && endLine > 0 ? Math.max(line, endLine) : line,
    });
    if (ranges.length >= gitDiffSummaryMaxNavigationRanges) break;
  }
  return ranges;
}

function parseGitUnifiedDiffPath(value) {
  // 这一段从 Git patch 文件头提取相对路径，并复用外部 Diff 的路径安全校验。
  // Extract a relative path from Git patch headers and reuse the external-diff path safety check.
  const token = String(value || "").trim().split(/\t/u)[0];
  if (!token || token === "/dev/null") return "";
  return normalizeExternalDiffRelativePath(token.replace(/^"?[ab]\//u, "").replace(/^"|"$/gu, ""));
}

function createGitHunkTracker(line, count) {
  // 这一段记录新文件侧 hunk 起点；删除-only hunk 用起点作为可跳转锚点。
  // Track the new-file hunk start; deletion-only hunks use it as the jump anchor.
  return {
    anchorLine: Math.max(1, line),
    endLine: 0,
    hasChange: false,
    line: 0,
    newLine: line,
    newLineCount: Math.max(0, count),
  };
}

function pushGitHunkRange(file, hunk) {
  // 这一段把一个 Git hunk 收束成一个导航块，只返回行号范围，不返回源码。
  // Collapse one Git hunk into one navigation block, returning only line ranges and no source content.
  if (!file || !hunk || !hunk.hasChange) return;
  const line = hunk.line || hunk.anchorLine;
  const endLine = hunk.endLine || line;
  file.navigationRanges.push({ line, endLine: Math.max(line, endLine) });
}

function finalizeGitHunkFile(rangesByPath, file) {
  // 这一段把当前文件的 hunk 范围写入 Map，只保留安全路径和有效范围。
  // Store current-file hunk ranges in the map, keeping only safe paths and valid ranges.
  if (!file) return;
  const filePath = file.path || file.previousPath;
  const navigationRanges = normalizeGitNavigationRanges(file.navigationRanges);
  if (!filePath || navigationRanges.length === 0) return;
  rangesByPath.set(filePath, navigationRanges);
}

export function parseGitDiffHunks(output) {
  // 这一段解析 git diff --unified=0 输出，只保留每个文件的 hunk 行号范围。
  // Parse git diff --unified=0 output, keeping only each file's hunk line ranges.
  const rangesByPath = new Map();
  let currentFile = null;
  let currentHunk = null;
  for (const line of String(output || "").split(/\r?\n/u)) {
    if (line.startsWith("diff --git ")) {
      pushGitHunkRange(currentFile, currentHunk);
      finalizeGitHunkFile(rangesByPath, currentFile);
      currentFile = { navigationRanges: [], path: "", previousPath: "" };
      currentHunk = null;
      continue;
    }
    if (!currentFile) continue;
    if (line.startsWith("rename from ")) {
      currentFile.previousPath = normalizeExternalDiffRelativePath(line.slice("rename from ".length));
      continue;
    }
    if (line.startsWith("rename to ")) {
      currentFile.path = normalizeExternalDiffRelativePath(line.slice("rename to ".length));
      continue;
    }
    if (line.startsWith("--- ")) {
      currentFile.previousPath = parseGitUnifiedDiffPath(line.slice(4));
      continue;
    }
    if (line.startsWith("+++ ")) {
      currentFile.path = parseGitUnifiedDiffPath(line.slice(4));
      continue;
    }
    const hunkMatch = gitHunkHeaderPattern.exec(line);
    if (hunkMatch) {
      pushGitHunkRange(currentFile, currentHunk);
      currentHunk = createGitHunkTracker(Number(hunkMatch[1]), Number(hunkMatch[2] ?? "1"));
      continue;
    }
    if (!currentHunk) continue;
    if (line.startsWith("+") && !line.startsWith("+++")) {
      currentHunk.hasChange = true;
      if (!currentHunk.line) currentHunk.line = currentHunk.newLine;
      currentHunk.endLine = currentHunk.newLine;
      currentHunk.newLine += 1;
      continue;
    }
    if (line.startsWith("-") && !line.startsWith("---")) {
      currentHunk.hasChange = true;
      if (!currentHunk.line && currentHunk.newLineCount === 0) currentHunk.line = currentHunk.anchorLine;
      continue;
    }
    if (line.startsWith(" ")) {
      currentHunk.newLine += 1;
    }
  }
  pushGitHunkRange(currentFile, currentHunk);
  finalizeGitHunkFile(rangesByPath, currentFile);
  return rangesByPath;
}

function parseGitDiffNameStatus(output, statsByPath, revision, navigationRangesByPath = new Map()) {
  // 这一段解析 git diff --name-status 输出，以状态列表作为文件顺序和变更类型来源。
  // Parse git diff --name-status output, using it as the source of file order and change kinds.
  const files = [];
  const seenPaths = new Set();
  for (const line of String(output || "").split(/\r?\n/u)) {
    if (!line.trim() || files.length >= gitDiffSummaryMaxFiles) continue;
    const parts = line.split("\t");
    const status = parts[0] || "";
    const isRenameOrCopy = /^[RC]/iu.test(status);
    const previousPath = isRenameOrCopy ? normalizeExternalDiffRelativePath(parts[1]) : "";
    const currentPath = normalizeExternalDiffRelativePath(isRenameOrCopy ? parts[2] : parts[1]);
    if (!currentPath || seenPaths.has(currentPath)) continue;
    seenPaths.add(currentPath);
    const stats = statsByPath.get(currentPath) || { additions: 0, deletions: 0 };
    files.push({
      additions: stats.additions,
      changeKind: getGitDiffChangeKind(status),
      deletions: stats.deletions,
      navigationRanges: navigationRangesByPath.get(currentPath) || [],
      path: currentPath,
      previousPath,
      revision,
    });
  }
  return files;
}

function parseGitUntrackedFiles(output, existingFiles, revision) {
  // 这一段把未跟踪文件补进摘要列表，避免全局本地变更只显示已跟踪文件。
  // Add untracked files to the summary so local changes are not limited to tracked files.
  const files = [];
  const seenPaths = new Set(existingFiles.map((file) => file.path));
  for (const line of String(output || "").split(/\r?\n/u)) {
    const relativePath = normalizeExternalDiffRelativePath(line);
    if (!relativePath || seenPaths.has(relativePath) || existingFiles.length + files.length >= gitDiffSummaryMaxFiles) continue;
    seenPaths.add(relativePath);
    files.push({
      additions: 0,
      changeKind: "added",
      deletions: 0,
      path: relativePath,
      previousPath: "",
      revision,
    });
  }
  return files;
}

async function resolveGitDiffSummaryBase(cwd) {
  // 这一段优先使用当前分支 upstream 作为基准，使摘要和 Codex 环境面板的本地变更统计一致。
  // Prefer the current branch upstream as the base so the summary matches Codex's environment-panel local changes.
  const upstreamRevision = (await runGitText(cwd, ["rev-parse", "--verify", "--quiet", "@{upstream}"])).trim();
  return upstreamRevision ? "@{upstream}" : "HEAD";
}

export async function readGitDiffSummary(cwd) {
  // 这一段读取 upstream/HEAD 到工作区的整体变更摘要，只返回路径、状态、增删行数和 hunk 行号。
  // Read the upstream-or-HEAD-to-worktree summary, returning only paths, statuses, line counts, and hunk line numbers.
  const cwdStats = await stat(cwd);
  if (!cwdStats.isDirectory()) throw new Error("Git diff summary cwd is not a directory");
  const baseRevision = await resolveGitDiffSummaryBase(cwd);
  const [numstatOutput, nameStatusOutput, patchOutput, untrackedOutput] = await Promise.all([
    runGitText(cwd, ["diff", "--no-ext-diff", "--find-renames", "--numstat", baseRevision, "--"]),
    runGitText(cwd, ["diff", "--no-ext-diff", "--find-renames", "--name-status", baseRevision, "--"]),
    runGitText(cwd, ["diff", "--no-ext-diff", "--find-renames", "--unified=0", baseRevision, "--"]),
    runGitText(cwd, ["ls-files", "--others", "--exclude-standard"]),
  ]);
  const statsByPath = parseGitDiffNumstat(numstatOutput);
  const navigationRangesByPath = parseGitDiffHunks(patchOutput);
  const trackedFiles = parseGitDiffNameStatus(nameStatusOutput, statsByPath, baseRevision, navigationRangesByPath);
  const files = [...trackedFiles, ...parseGitUntrackedFiles(untrackedOutput, trackedFiles, baseRevision)];
  return {
    baseRevision,
    cwd,
    files,
    type: "success",
  };
}
