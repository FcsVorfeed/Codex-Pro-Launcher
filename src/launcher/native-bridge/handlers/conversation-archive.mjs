import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { copyFile, mkdir, readdir, readFile, stat, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { gunzipSync, gzipSync } from "node:zlib";

import {
  getCodexHomeDir,
  nativeBridgeStateDir,
  normalizeCloudSyncEndpoint,
  normalizeNativeBridgeRequestId,
  writeFileAtomically,
} from "../common.mjs";
import { rootDir } from "../../paths.mjs";

const conversationArchiveIndexVersion = 2;
const conversationArchiveMarkdownFormatVersion = 14;
const conversationArchivePackageFormatVersion = 1;
const conversationArchivePackageKind = "thread-bundle";
const conversationArchiveMaxBodyBytes = 8 * 1024 * 1024;
const conversationArchiveBatchTargetBodyBytes = 5 * 1024 * 1024;
const conversationArchiveBatchMaxBodyBytes = 7 * 1024 * 1024;
const conversationArchiveMaxBatchItems = 80;
const conversationArchiveMaxDisplayNameLength = 120;
const conversationArchiveMaxMarkdownBytes = 5 * 1024 * 1024;
const conversationArchiveMaxPackageBytes = 5 * 1024 * 1024;
const conversationArchiveMaxPackageUncompressedBytes = 10 * 1024 * 1024;
const conversationArchiveMaxNativeTitleLength = 120;
const conversationArchiveMaxPathLength = 500;
const conversationArchiveMaxRemoteEntries = 5000;
const conversationArchiveMaxThinkingFilesPerThread = 500;
const conversationArchiveMaxSessionIndexBytes = 16 * 1024 * 1024;
const conversationArchiveMaxUnstableDelayMs = 5 * 60 * 1000;
const conversationArchiveMaxUploadsPerRun = 1000;
const conversationArchiveMaxUploadRateLimitRetries = 4;
const conversationArchiveMaxUploadRateLimitDelayMs = 65 * 1000;
const conversationArchiveProgressIntervalMs = 500;
const conversationArchiveStableDelayMs = 90 * 1000;
const conversationArchiveRequestTimeoutMs = 120000;
const conversationArchiveDeleteRequestTimeoutMs = 15000;
const conversationArchiveStateDir = path.join(nativeBridgeStateDir, "conversation-archive");
const conversationArchiveIdentityPath = path.join(conversationArchiveStateDir, "identity.json");
const conversationArchivePendingDeviceDeletesPath = path.join(conversationArchiveStateDir, "pending-device-deletes.json");
const conversationArchivePreviewDir = path.join(nativeBridgeStateDir, "conversation-archive-preview");
const legacyConversationArchiveStateDir = path.join(rootDir, ".codex-pro", "conversation-archive");
const legacyConversationArchiveIdentityPath = path.join(legacyConversationArchiveStateDir, "identity.json");
const conversationArchiveOfficialGlobalStateFile = ".codex-global-state.json";
const conversationArchiveLifecycleActive = "active";
const conversationArchiveLifecycleArchived = "archived";
const conversationArchiveLifecycleDeleted = "deleted";
const conversationArchiveGroupTypeConversation = "conversation";
const conversationArchiveGroupTypeProject = "project";
const conversationArchiveDefaultConversationGroupId = "conversation_default";
const conversationArchiveDefaultConversationGroupName = "对话";

function getConversationArchiveThreadColumns(db) {
  // 这一段读取 SQLite 表结构，只让后续 SQL 引用真实存在的列。
  // Read the SQLite table shape so later SQL only references columns that actually exist.
  return new Set(db.prepare("PRAGMA table_info(threads)").all()
    .map((column) => String(column?.name || "")));
}

function buildConversationArchiveThreadWhere(threadColumns, { internal = false } = {}) {
  // 这一段按 schema 动态构造线程筛选条件，兼容旧库缺少 thread_source/source 的情况。
  // Build thread filters from the detected schema, including older databases without thread_source/source.
  const clauses = ["rollout_path IS NOT NULL AND rollout_path != ''"];
  const hasThreadSource = threadColumns.has("thread_source");
  const hasSource = threadColumns.has("source");
  if (!internal) {
    if (hasThreadSource) clauses.push("(thread_source IS NULL OR thread_source = '' OR thread_source = 'user')");
    if (hasSource) clauses.push("(source IS NULL OR source NOT LIKE '{\"subagent\":%')");
    return clauses.join("\n      AND ");
  }

  const internalClauses = [];
  if (hasThreadSource) internalClauses.push("(thread_source IS NOT NULL AND thread_source != '' AND thread_source != 'user')");
  if (hasSource) internalClauses.push("source LIKE '{\"subagent\":%'");
  clauses.push(internalClauses.length ? `(${internalClauses.join(" OR ")})` : "1 = 0");
  return clauses.join("\n      AND ");
}

function normalizeConversationArchivePath(value) {
  // 这一段只接受 GitHub 友好的归档 Markdown 路径，避免页面请求任意云端文件。
  // Accept only GitHub-friendly archive Markdown paths so the page cannot request arbitrary cloud files.
  const archivePath = String(value || "").trim().slice(0, conversationArchiveMaxPathLength).replace(/\\/g, "/");
  return parseConversationArchivePath(archivePath) ? archivePath : "";
}

function parseConversationArchivePath(value) {
  // 这一段只解析正式分组路径；旧未分组归档不再进入 v2 列表。
  // Parse only the formal grouped path; legacy ungrouped archives no longer enter the v2 list.
  const archivePath = String(value || "").trim().slice(0, conversationArchiveMaxPathLength).replace(/\\/g, "/");
  const groupedMatch = archivePath.match(/^devices\/(device_[A-Za-z0-9._-]{1,96})\/profiles\/(profile_[A-Za-z0-9._-]{1,96})\/(projects|conversations)\/([A-Za-z0-9][A-Za-z0-9._-]{0,95})\/threads\/(\d{4})\/(\d{2})\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})\/(index|thinking-\d{3,6})\.md$/u);
  if (groupedMatch) {
    return {
      archiveGroupId: groupedMatch[4],
      archiveGroupType: groupedMatch[3] === "projects" ? conversationArchiveGroupTypeProject : conversationArchiveGroupTypeConversation,
      deviceId: groupedMatch[1],
      fileName: `${groupedMatch[8]}.md`,
      month: groupedMatch[6],
      profileId: groupedMatch[2],
      threadId: groupedMatch[7],
      year: groupedMatch[5],
    };
  }
  return null;
}

function normalizeConversationArchiveDisplayName(value) {
  // 这一段清理设备和账号显示名，只保留短文本，不让控制字符进入同步层。
  // Clean device and profile display names as short text without control characters entering the sync layer.
  return typeof value === "string"
    ? value.replace(/[\0-\x1f]/gu, " ").trim().slice(0, conversationArchiveMaxDisplayNameLength)
    : "";
}

export function parseConversationArchiveRequest(request) {
  // 这一段解析会话归档同步请求，只允许动作、endpoint、同步密钥、显示名和预览路径。
  // Parse conversation-archive requests, allowing only action, endpoint, sync key, display names, and preview path.
  const requestId = normalizeNativeBridgeRequestId(request?.requestId);
  const action = String(request?.action || "").trim().toLowerCase();
  const localFileAction = action === "prepare-local-file";
  if (!requestId || !["push", "list", "get-file", "prepare-file", "prepare-local-file", "reset", "delete-device"].includes(action)) {
    return null;
  }
  const endpoint = localFileAction ? "" : normalizeCloudSyncEndpoint(request?.endpoint);
  const syncKey = localFileAction ? "" : String(request?.syncKey || "").trim().slice(0, 160);
  if (!localFileAction && (!endpoint || syncKey.length < 16 || syncKey.includes("\0"))) return null;

  const archiveRequest = {
    action,
    deviceName: normalizeConversationArchiveDisplayName(request?.deviceName),
    endpoint,
    force: action === "push" && request?.force === true,
    profileName: normalizeConversationArchiveDisplayName(request?.profileName),
    requestId,
    syncKey,
    type: "conversation-archive",
  };
  if (localFileAction) {
    const threadId = normalizeConversationArchiveThreadId(request?.threadId);
    if (!threadId) return null;
    archiveRequest.threadId = threadId;
  }
  if (action === "get-file" || action === "prepare-file") {
    const archivePath = normalizeConversationArchivePath(request?.path);
    if (!archivePath) return null;
    archiveRequest.path = archivePath;
  }
  if (action === "delete-device") {
    const deviceId = getConversationArchiveLocalId(request?.deviceId, "device_");
    if (!deviceId) return null;
    archiveRequest.deviceId = deviceId;
  }
  return archiveRequest;
}

function getConversationArchiveLocalId(value, prefix) {
  // 这一段只接受本机生成的单段安全 ID，避免写出可穿越路径的设备或账号目录。
  // Accept only locally generated single-segment IDs so device/profile directories cannot traverse paths.
  const rawValue = String(value || "").trim().slice(0, 96);
  if (!rawValue.startsWith(prefix)) return "";
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/u.test(rawValue) ? rawValue : "";
}

function createConversationArchiveLocalId(prefix) {
  // 这一段生成稳定本机设备或账号 ID，使用随机 UUID 不读取真实账号信息。
  // Generate a stable local device or profile ID with a random UUID and without reading real account data.
  return `${prefix}${randomUUID()}`;
}

async function readJsonFile(filePath, fallbackValue) {
  // 这一段安全读取本机 JSON 状态；损坏时回落默认值，不影响 Codex 主界面。
  // Safely read local JSON state, falling back on corrupt data without affecting the Codex UI.
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : fallbackValue;
  } catch {
    return fallbackValue;
  }
}

async function isConversationArchiveStateFile(filePath) {
  // 这一段只确认普通文件是否存在，用于旧状态一次性迁移判断。
  // Check only whether a regular file exists for one-time legacy state migration.
  try {
    const stats = await stat(filePath);
    return stats.isFile();
  } catch {
    return false;
  }
}

async function seedConversationArchiveStateFileFromLegacy(legacyPath, targetPath) {
  // 这一段只从旧项目根状态读取并复制到新根，不再向旧目录写入任何运行期文件。
  // Read and copy legacy project-root state into the new root without writing runtime files back to the old directory.
  if (path.resolve(legacyPath).toLowerCase() === path.resolve(targetPath).toLowerCase()) return;
  if (await isConversationArchiveStateFile(targetPath)) return;
  if (!await isConversationArchiveStateFile(legacyPath)) return;
  try {
    await mkdir(path.dirname(targetPath), { recursive: true });
    await copyFile(legacyPath, targetPath, constants.COPYFILE_EXCL);
  } catch {
    // 这一段忽略旧状态迁移失败，后续会按新根的正常创建逻辑继续。
    // Ignore legacy migration failures so normal new-root creation can continue.
  }
}

async function getConversationArchiveIdentity() {
  // 这一段读取或创建本机归档身份，只保存随机设备/profile ID，不保存账号 token。
  // Read or create the local archive identity, storing only random device/profile IDs and no account tokens.
  await mkdir(conversationArchiveStateDir, { recursive: true });
  await seedConversationArchiveStateFileFromLegacy(legacyConversationArchiveIdentityPath, conversationArchiveIdentityPath);
  const identity = await readJsonFile(conversationArchiveIdentityPath, {});
  const deviceId = getConversationArchiveLocalId(identity.deviceId, "device_") || createConversationArchiveLocalId("device_");
  const profileId = getConversationArchiveLocalId(identity.profileId, "profile_") || createConversationArchiveLocalId("profile_");
  const projectSalt = getConversationArchiveLocalId(identity.projectSalt, "salt_") || createConversationArchiveLocalId("salt_");
  const nextIdentity = {
    deviceId,
    profileId,
    projectSalt,
    schemaVersion: conversationArchiveIndexVersion,
  };
  if (identity.deviceId !== deviceId ||
    identity.profileId !== profileId ||
    identity.projectSalt !== projectSalt ||
    identity.schemaVersion !== conversationArchiveIndexVersion) {
    await writeFileAtomically(conversationArchiveIdentityPath, JSON.stringify(nextIdentity, null, 2), "utf8");
  }
  return nextIdentity;
}

function getConversationArchiveSyncKeyHash(syncKey) {
  // 这一段只用同步密钥哈希命名本地索引，避免在文件名或日志里出现原始密钥。
  // Use only the sync-key hash for local index names so raw keys never appear in filenames or logs.
  return createHash("sha256").update(syncKey, "utf8").digest("hex");
}

function getConversationArchiveEndpointHash(endpoint) {
  // 这一段用 endpoint 哈希隔离不同云端环境的删除待办，不把 URL 拼进状态 key。
  // Use an endpoint hash to isolate pending deletes across cloud endpoints without placing the URL in the state key.
  return createHash("sha256").update(String(endpoint || ""), "utf8").digest("hex");
}

function getConversationArchivePendingDeviceDeleteKey(endpoint, syncKeyHash, deviceId) {
  // 这一段用 endpoint、同步密钥哈希和设备 ID 组合成稳定待办 key。
  // Combine endpoint, sync-key hash, and device ID into a stable pending-delete key.
  return `${getConversationArchiveEndpointHash(endpoint).slice(0, 16)}:${syncKeyHash.slice(0, 16)}:${deviceId}`;
}

function getConversationArchiveIndexPath(syncKeyHash, identity, stateDir = conversationArchiveStateDir) {
  // 这一段按同步密钥和本机身份隔离增量索引，避免不同设备或密钥互相污染。
  // Isolate incremental indexes by sync key and local identity so devices or keys do not mix state.
  return path.join(
    stateDir,
    `sync-index-${syncKeyHash.slice(0, 16)}-${identity.deviceId}-${identity.profileId}.json`,
  );
}

async function readConversationArchiveIndex(syncKeyHash, identity) {
  // 这一段读取本机增量索引，索引缺失时从空状态开始。
  // Read the local incremental index, starting from an empty state when it is missing.
  const indexPath = getConversationArchiveIndexPath(syncKeyHash, identity);
  await seedConversationArchiveStateFileFromLegacy(
    getConversationArchiveIndexPath(syncKeyHash, identity, legacyConversationArchiveStateDir),
    indexPath,
  );
  const index = await readJsonFile(indexPath, {});
  return {
    localDeviceUploadBlockedAfterDeleteAt: typeof index?.localDeviceUploadBlockedAfterDeleteAt === "string"
      ? index.localDeviceUploadBlockedAfterDeleteAt
      : "",
    schemaVersion: conversationArchiveIndexVersion,
    threads: index?.threads && typeof index.threads === "object" && !Array.isArray(index.threads)
      ? index.threads
      : {},
  };
}

async function writeConversationArchiveIndex(syncKeyHash, identity, index) {
  // 这一段原子写入本机增量索引，避免中断时留下半个 JSON 文件。
  // Atomically write the local incremental index so interruptions do not leave partial JSON files.
  await mkdir(conversationArchiveStateDir, { recursive: true });
  await writeFileAtomically(
    getConversationArchiveIndexPath(syncKeyHash, identity),
    JSON.stringify({
      ...(index.localDeviceUploadBlockedAfterDeleteAt
        ? { localDeviceUploadBlockedAfterDeleteAt: index.localDeviceUploadBlockedAfterDeleteAt }
        : {}),
      schemaVersion: conversationArchiveIndexVersion,
      threads: index.threads || {},
      updatedAt: new Date().toISOString(),
    }, null, 2),
    "utf8",
  );
}

async function readConversationArchivePendingDeviceDeletes() {
  // 这一段读取持久化的单设备删除待办；内容只含哈希和安全设备 ID，不含同步密钥正文。
  // Read persisted per-device delete intents; entries contain only hashes and safe device IDs, never the raw sync key.
  const state = await readJsonFile(conversationArchivePendingDeviceDeletesPath, {});
  const rawEntries = state?.entries && typeof state.entries === "object" && !Array.isArray(state.entries)
    ? state.entries
    : {};
  const entries = {};
  for (const [key, value] of Object.entries(rawEntries)) {
    const deviceId = getConversationArchiveLocalId(value?.deviceId, "device_");
    const endpointHash = /^[a-f0-9]{64}$/u.test(String(value?.endpointHash || "")) ? String(value.endpointHash) : "";
    const syncKeyHash = /^[a-f0-9]{64}$/u.test(String(value?.syncKeyHash || "")) ? String(value.syncKeyHash) : "";
    if (!deviceId || !endpointHash || !syncKeyHash) continue;
    entries[key] = {
      createdAt: String(value?.createdAt || ""),
      deviceId,
      endpointHash,
      syncKeyHash,
      updatedAt: String(value?.updatedAt || ""),
    };
  }
  return entries;
}

async function writeConversationArchivePendingDeviceDeletes(entries) {
  // 这一段原子写入删除待办，避免客户端关闭时留下半个 JSON。
  // Atomically write pending deletes so client shutdowns do not leave partial JSON.
  await mkdir(conversationArchiveStateDir, { recursive: true });
  await writeFileAtomically(
    conversationArchivePendingDeviceDeletesPath,
    JSON.stringify({
      entries: entries && typeof entries === "object" && !Array.isArray(entries) ? entries : {},
      schemaVersion: conversationArchiveIndexVersion,
      updatedAt: new Date().toISOString(),
    }, null, 2),
    "utf8",
  );
}

async function rememberConversationArchivePendingDeviceDelete(request, syncKeyHash) {
  // 这一段在发起远端删除前先落本机待办，确保关客户端后也不会马上重传同设备。
  // Persist the delete intent before the remote request so restarting the client cannot immediately re-upload the same device.
  const entries = await readConversationArchivePendingDeviceDeletes();
  const key = getConversationArchivePendingDeviceDeleteKey(request.endpoint, syncKeyHash, request.deviceId);
  const now = new Date().toISOString();
  entries[key] = {
    createdAt: entries[key]?.createdAt || now,
    deviceId: request.deviceId,
    endpointHash: getConversationArchiveEndpointHash(request.endpoint),
    syncKeyHash,
    updatedAt: now,
  };
  await writeConversationArchivePendingDeviceDeletes(entries);
}

async function forgetConversationArchivePendingDeviceDelete(request, syncKeyHash, deviceId = request.deviceId) {
  // 这一段在幂等删除确认成功后清掉本机待办，使后续显式同步可以重新生成本机数据。
  // Clear the local intent after idempotent delete confirmation so a later explicit sync can recreate local data.
  const safeDeviceId = getConversationArchiveLocalId(deviceId, "device_");
  if (!safeDeviceId) return;
  const entries = await readConversationArchivePendingDeviceDeletes();
  const key = getConversationArchivePendingDeviceDeleteKey(request.endpoint, syncKeyHash, safeDeviceId);
  if (!entries[key]) return;
  delete entries[key];
  await writeConversationArchivePendingDeviceDeletes(entries);
}

async function listConversationArchivePendingDeviceDeleteIds(request, syncKeyHash) {
  // 这一段返回当前 endpoint + 同步密钥下仍待确认删除的设备 ID 集合。
  // Return device IDs still pending delete confirmation for the current endpoint and sync key.
  const entries = await readConversationArchivePendingDeviceDeletes();
  const endpointHash = getConversationArchiveEndpointHash(request.endpoint);
  return new Set(Object.values(entries)
    .filter((entry) => entry.endpointHash === endpointHash && entry.syncKeyHash === syncKeyHash)
    .map((entry) => entry.deviceId));
}

async function retryConversationArchivePendingDeviceDeletes(request, syncKeyHash) {
  // 这一段在列表或上传前幂等重试未确认删除，解决“服务器成功但客户端没收到响应”的断线情况。
  // Idempotently retry unconfirmed deletes before listing or uploading, covering cases where the server succeeded but the client missed the response.
  const deviceIds = await listConversationArchivePendingDeviceDeleteIds(request, syncKeyHash);
  for (const deviceId of deviceIds) {
    try {
      const response = await deleteConversationArchiveDeviceManifest(request.endpoint, request.syncKey, deviceId);
      if (response.ok) await forgetConversationArchivePendingDeviceDelete(request, syncKeyHash, deviceId);
    } catch {
      // 这一段保留待办，下一次列表或同步会继续重试。
      // Keep the intent so the next list or sync can retry.
    }
  }
}

function normalizeConversationArchiveThreadId(value) {
  // 这一段把 Codex thread id 收敛成文件名安全值，local:/remote: 前缀只作为显示层兼容被去掉。
  // Normalize a Codex thread id into a filename-safe value, removing local:/remote: display prefixes.
  const threadId = String(value || "").trim().replace(/^(?:local|remote):/iu, "").slice(0, 180);
  if (!threadId || ["__proto__", "prototype", "constructor"].includes(threadId)) return "";
  return /^[A-Za-z0-9_.:-]{8,180}$/u.test(threadId) ? threadId : "";
}

function normalizeConversationArchiveTitle(value) {
  // 这一段清理 Markdown 标题，避免标题里的换行破坏归档列表和文档头部。
  // Clean Markdown titles so title newlines do not break archive lists or document headings.
  const title = String(value || "")
    .replace(/[\0-\x08\x0b\x0c\x0e-\x1f]/gu, " ")
    .split(/\s+/u)
    .filter(Boolean)
    .join(" ")
    .slice(0, 180)
    .trim();
  return title || "Untitled session";
}

function isConversationArchiveGeneratedTitle(value) {
  // 这一段识别 SQLite 里被 transcript 或代理历史污染的标题，避免它们进入同步侧栏。
  // Detect titles polluted by transcripts or agent-history prompts so they do not enter the sync sidebar.
  const title = normalizeConversationArchiveTitle(value);
  if (!title || title === "Untitled session") return false;
  return [
    /^The following is the Codex agent history\b/iu,
    /^The following is a transcript\b/iu,
    />>> TRANSCRIPT/iu,
    /\bAPPROVAL REQUEST\b/iu,
  ].some((pattern) => pattern.test(title));
}

function normalizeConversationArchiveGroupType(value) {
  // 这一段只接受项目和普通对话两种分组类型，未知值统一归入普通对话。
  // Accept only project and conversation group types, folding unknown values into conversations.
  return String(value || "").trim() === conversationArchiveGroupTypeProject
    ? conversationArchiveGroupTypeProject
    : conversationArchiveGroupTypeConversation;
}

function normalizeConversationArchiveGroupId(value, groupType = conversationArchiveGroupTypeConversation) {
  // 这一段清理分组 ID，确保它只能作为远端路径里的单个安全目录名。
  // Clean group ids so they can only be used as one safe remote path segment.
  const id = String(value || "").trim().slice(0, 96);
  if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/u.test(id)) return id;
  return normalizeConversationArchiveGroupType(groupType) === conversationArchiveGroupTypeProject
    ? "project_unknown"
    : conversationArchiveDefaultConversationGroupId;
}

function normalizeConversationArchiveGroupName(value, groupType = conversationArchiveGroupTypeConversation) {
  // 这一段只上传项目目录名或“对话”显示名，不上传完整本机路径。
  // Upload only the project directory name or the Conversations label, never the full local path.
  const fallback = normalizeConversationArchiveGroupType(groupType) === conversationArchiveGroupTypeProject
    ? "项目"
    : conversationArchiveDefaultConversationGroupName;
  const text = normalizeConversationArchiveDisplayText(value, "").replace(/\\/gu, "/");
  const segment = text.split("/").filter(Boolean).pop() || text;
  const name = normalizeConversationArchiveDisplayText(segment.replace(/^[A-Za-z]:\s*/u, ""), fallback);
  return name || fallback;
}

function getConversationArchivePathSegmentForGroup(groupType) {
  // 这一段把内部短枚举映射成远端路径目录名，便于云端按目录区分。
  // Map the internal short enum into the remote path segment used for directory grouping.
  return normalizeConversationArchiveGroupType(groupType) === conversationArchiveGroupTypeProject
    ? "projects"
    : "conversations";
}

function getConversationArchiveProjectName(cwd) {
  // 这一段从真实工作区路径只取最后一级项目名，避免把完整本机路径写进同步 metadata。
  // Derive only the final project directory name from the real cwd so full local paths are not synced.
  const value = String(cwd || "").trim();
  if (!value) return "";
  const normalizedPath = path.normalize(value);
  const parsed = path.parse(normalizedPath);
  const basename = path.basename(normalizedPath);
  const candidate = basename && basename !== path.sep ? basename : parsed.name;
  if (!candidate) return "";
  return normalizeConversationArchiveTitle(candidate).slice(0, conversationArchiveMaxDisplayNameLength);
}

function getConversationArchiveProjectKey(projectIdentity, identity) {
  // 这一段用本机私有盐给官方项目身份做不可逆分组 ID，避免同名项目互相覆盖或泄露真实路径。
  // Hash the official project identity with a local private salt so same-name projects do not collide or leak real paths.
  const value = String(projectIdentity || "").trim();
  if (!value) return "";
  const salt = String(identity?.projectSalt || identity?.deviceId || "").trim();
  const hashInput = salt ? `${salt}\n${value}` : value;
  return `project_${createHash("sha256").update(hashInput, "utf8").digest("hex").slice(0, 16)}`;
}

function normalizeConversationArchiveOfficialPathKey(value) {
  // 这一段归一化官方状态里的工作区路径，只作为本机匹配 key，不上传真实路径。
  // Normalize workspace paths from official state only as local match keys, never uploading real paths.
  const rawValue = String(value || "").trim();
  if (!rawValue) return "";
  const withoutLongPathPrefix = rawValue
    .replace(/^\\\\\?\\UNC\\/iu, "\\\\")
    .replace(/^\\\\\?\\/u, "");
  let normalizedPath = withoutLongPathPrefix;
  try {
    normalizedPath = path.resolve(withoutLongPathPrefix);
  } catch {
    normalizedPath = path.normalize(withoutLongPathPrefix);
  }
  const withoutTrailingSlash = normalizedPath.replace(/[\\/]+$/u, "");
  return process.platform === "win32" ? withoutTrailingSlash.toLowerCase() : withoutTrailingSlash;
}

function getConversationArchiveStateStringArray(value) {
  // 这一段只从官方状态里提取字符串数组，忽略异常项以保持同步扫描稳定。
  // Extract only string arrays from official state, ignoring invalid entries so sync scanning stays stable.
  return Array.isArray(value) ? value.filter((item) => typeof item === "string" && item.trim()) : [];
}

function getConversationArchiveStateObject(value) {
  // 这一段只接受普通对象状态，避免数组或空值被当成 project map 使用。
  // Accept only plain object state so arrays or null values are not treated as project maps.
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function getConversationArchiveWorkspaceRootOptions(value) {
  // 这一段兼容官方保存工作区的数组形态和 roots/labels 对象形态。
  // Support both official saved-workspace array state and roots/labels object state.
  if (Array.isArray(value)) {
    return {
      labels: {},
      roots: getConversationArchiveStateStringArray(value),
    };
  }
  return {
    labels: getConversationArchiveStateObject(value?.labels),
    roots: getConversationArchiveStateStringArray(value?.roots),
  };
}

function addConversationArchiveOfficialProject(projects, candidate) {
  // 这一段登记一个官方项目候选，同时建立 projectId 和本机路径两种匹配索引。
  // Register one official project candidate and index it by projectId plus local path when available.
  const projectKind = String(candidate?.projectKind || "local").trim() || "local";
  const projectId = String(candidate?.projectId || "").trim();
  const hostId = String(candidate?.hostId || "").trim();
  const pathValue = String(candidate?.path || "").trim();
  const pathKey = normalizeConversationArchiveOfficialPathKey(pathValue);
  const identityValue = projectId || pathKey || pathValue;
  if (!identityValue) return null;

  const project = {
    hostId,
    identity: `official:${projectKind}:${hostId}:${identityValue}`,
    projectId: projectId || pathKey,
    projectKind,
    projectName: normalizeConversationArchiveGroupName(candidate?.projectName || candidate?.label || getConversationArchiveProjectName(pathValue) || projectId, conversationArchiveGroupTypeProject),
    path: pathValue,
    pathKey,
  };
  if (project.projectId) projects.byProjectId.set(`${projectKind}:${hostId}:${project.projectId}`, project);
  if (pathKey) projects.byPathKey.set(pathKey, project);
  projects.list.push(project);
  return project;
}

function buildConversationArchiveOfficialProjects(globalState) {
  // 这一段从官方全局状态建立项目索引，只使用官方保存的项目根和显式项目定义。
  // Build project indexes from official global state using only saved project roots and explicit project definitions.
  const state = getConversationArchiveStateObject(globalState);
  const workspaceRootOptions = getConversationArchiveWorkspaceRootOptions(state["electron-saved-workspace-roots"]);
  const projects = {
    byPathKey: new Map(),
    byProjectId: new Map(),
    list: [],
  };

  for (const root of workspaceRootOptions.roots) {
    const pathKey = normalizeConversationArchiveOfficialPathKey(root);
    const label = String(workspaceRootOptions.labels[root] || workspaceRootOptions.labels[pathKey] || "").trim();
    addConversationArchiveOfficialProject(projects, {
      label,
      path: root,
      projectId: root,
      projectKind: "local",
      projectName: label || getConversationArchiveProjectName(root),
    });
  }

  for (const projectPath of getConversationArchiveStateStringArray(state["project-order"])) {
    const pathKey = normalizeConversationArchiveOfficialPathKey(projectPath);
    if (!pathKey || projects.byPathKey.has(pathKey)) continue;
    addConversationArchiveOfficialProject(projects, {
      path: projectPath,
      projectId: projectPath,
      projectKind: "local",
      projectName: getConversationArchiveProjectName(projectPath),
    });
  }

  for (const [projectId, project] of Object.entries(getConversationArchiveStateObject(state["local-projects"]))) {
    const projectRecord = getConversationArchiveStateObject(project);
    addConversationArchiveOfficialProject(projects, {
      label: projectRecord.name,
      path: projectRecord.path || projectRecord.root || projectRecord.cwd,
      projectId: projectRecord.id || projectId,
      projectKind: "local",
      projectName: projectRecord.name || projectRecord.label || projectId,
    });
  }

  for (const [projectId, roots] of Object.entries(getConversationArchiveStateObject(state["project-writable-roots"]))) {
    const rootList = Array.isArray(roots) ? roots : [roots];
    for (const root of rootList) {
      if (typeof root !== "string" || !root.trim()) continue;
      addConversationArchiveOfficialProject(projects, {
        path: root,
        projectId,
        projectKind: "local",
        projectName: getConversationArchiveProjectName(root) || projectId,
      });
    }
  }

  for (const project of Object.values(getConversationArchiveStateObject(state["remote-projects"]))) {
    const projectRecord = getConversationArchiveStateObject(project);
    addConversationArchiveOfficialProject(projects, {
      hostId: projectRecord.hostId,
      label: projectRecord.label,
      path: projectRecord.remotePath || projectRecord.path,
      projectId: projectRecord.id || projectRecord.projectId,
      projectKind: "remote",
      projectName: projectRecord.label || projectRecord.name,
    });
  }
  return projects;
}

async function readConversationArchiveOfficialProjectState() {
  // 这一段读取 Codex 官方持久化项目状态，不依赖左侧栏 DOM 是否渲染或展开。
  // Read Codex's official persisted project state without depending on whether the sidebar DOM is rendered or visible.
  const globalStatePath = path.join(getCodexHomeDir(), conversationArchiveOfficialGlobalStateFile);
  if (!await isExistingFile(globalStatePath)) {
    throw new Error("未找到 Codex 官方项目状态，已停止会话归档同步以避免错误分类 / Codex official project state was not found; archive sync stopped to avoid wrong grouping");
  }
  let globalState = null;
  try {
    globalState = JSON.parse(await readFile(globalStatePath, "utf8"));
  } catch {
    throw new Error("Codex 官方项目状态暂时不可读，已停止会话归档同步，请稍后重试 / Codex official project state is temporarily unreadable; archive sync stopped, please retry later");
  }
  if (!globalState || typeof globalState !== "object" || Array.isArray(globalState)) {
    throw new Error("Codex 官方项目状态格式异常，已停止会话归档同步以避免错误分类 / Codex official project state has an invalid shape; archive sync stopped to avoid wrong grouping");
  }
  return {
    projects: buildConversationArchiveOfficialProjects(globalState),
    projectlessThreadIds: new Set(getConversationArchiveStateStringArray(globalState["projectless-thread-ids"])),
    threadProjectAssignments: getConversationArchiveStateObject(globalState["thread-project-assignments"]),
    threadWorkspaceRootHints: getConversationArchiveStateObject(globalState["thread-workspace-root-hints"]),
  };
}

function getConversationArchiveOfficialProjectFromAssignment(officialState, assignment) {
  // 这一段按官方显式 thread-project-assignment 定位项目，缺失 registry 时也用 assignment 自身生成稳定身份。
  // Resolve official thread-project assignments, generating a stable identity from the assignment when the registry is missing.
  const value = getConversationArchiveStateObject(assignment);
  const projectKind = String(value.projectKind || "local").trim() || "local";
  const hostId = String(value.hostId || "").trim();
  const projectId = String(value.projectId || value.id || "").trim();
  const pathValue = String(value.path || value.cwd || value.remotePath || "").trim();
  const byProjectId = projectId ? officialState.projects.byProjectId.get(`${projectKind}:${hostId}:${projectId}`) : null;
  if (byProjectId) return byProjectId;
  const byPath = pathValue ? officialState.projects.byPathKey.get(normalizeConversationArchiveOfficialPathKey(pathValue)) : null;
  if (byPath) return byPath;
  if (!projectId && !pathValue) return null;
  return {
    hostId,
    identity: `official-assignment:${projectKind}:${hostId}:${projectId || normalizeConversationArchiveOfficialPathKey(pathValue)}`,
    projectId,
    projectKind,
    projectName: normalizeConversationArchiveGroupName(value.label || value.name || getConversationArchiveProjectName(pathValue) || projectId, conversationArchiveGroupTypeProject),
    path: pathValue,
    pathKey: normalizeConversationArchiveOfficialPathKey(pathValue),
  };
}

function getConversationArchiveOfficialProjectByPathKey(officialState, pathKey) {
  // 这一段把线程 cwd/hint 映射到官方项目根，允许 cwd 位于项目根子目录。
  // Map a thread cwd/hint to an official project root, allowing the cwd to sit inside a project root.
  const normalizedPathKey = normalizeConversationArchiveOfficialPathKey(pathKey);
  if (!normalizedPathKey) return null;
  const exactProject = officialState.projects.byPathKey.get(normalizedPathKey);
  if (exactProject) return exactProject;

  // 这一段只接受带路径分隔符的父子关系，避免 `foo` 误匹配 `foobar`。
  // Accept only separator-delimited parent-child path relationships so `foo` does not match `foobar`.
  return officialState.projects.list.find((project) => {
    const projectPathKey = normalizeConversationArchiveOfficialPathKey(project?.pathKey);
    return Boolean(
      projectPathKey &&
      (normalizedPathKey.startsWith(`${projectPathKey}/`) ||
        normalizedPathKey.startsWith(`${projectPathKey}\\`))
    );
  }) || null;
}

function getConversationArchiveProjectGroup(project, identity) {
  // 这一段把官方项目身份转换成远端安全分组 metadata，只上传盐哈希和显示名。
  // Convert an official project identity into remote-safe group metadata with only salted hash and display name uploaded.
  const projectKey = getConversationArchiveProjectKey(project?.identity, identity);
  if (!projectKey) return null;
  return {
    archiveGroupId: projectKey,
    archiveGroupName: normalizeConversationArchiveGroupName(project?.projectName, conversationArchiveGroupTypeProject),
    archiveGroupType: conversationArchiveGroupTypeProject,
  };
}

function resolveConversationArchiveOfficialThreadProject(officialState, row) {
  // 这一段按官方项目状态解析单个线程，保留显式 assignment 的兼容身份。
  // Resolve one thread against Codex's official project state while preserving explicit assignment fallback identities.
  const threadId = normalizeConversationArchiveThreadId(row?.threadId);
  if (!threadId) {
    return {
      cwdPathKey: "",
      hintPathKey: "",
      project: null,
      threadId: "",
    };
  }

  // 这一段优先使用官方显式 assignment，其次才用官方 hint 或当前保留项目根匹配。
  // Prefer explicit official assignments, then official hints or currently saved project roots.
  const assignmentProject = getConversationArchiveOfficialProjectFromAssignment(
    officialState,
    officialState.threadProjectAssignments[threadId],
  );
  const hintPathKey = normalizeConversationArchiveOfficialPathKey(officialState.threadWorkspaceRootHints[threadId]);
  const cwdPathKey = normalizeConversationArchiveOfficialPathKey(row?.cwd);
  const project = assignmentProject ||
    getConversationArchiveOfficialProjectByPathKey(officialState, hintPathKey) ||
    getConversationArchiveOfficialProjectByPathKey(officialState, cwdPathKey) ||
    null;
  return {
    cwdPathKey,
    hintPathKey,
    project,
    threadId,
  };
}

function isConversationArchiveRemovedProjectThread(officialState, resolvedThread) {
  // 这一段识别“曾有项目路径信号、但已不属于当前项目列表”的旧线程，让它走 deleted 墓碑隐藏。
  // Detect old threads with project path signals that no longer belong to current projects so tombstone hiding can handle them.
  const threadId = normalizeConversationArchiveThreadId(resolvedThread?.threadId);
  if (!threadId || officialState.projectlessThreadIds.has(threadId) || resolvedThread?.project) return false;
  return Boolean(resolvedThread?.hintPathKey || resolvedThread?.cwdPathKey);
}

async function buildConversationArchiveProjectGroups(rows, identity) {
  // 这一段使用 Codex 官方持久化分类信号给单个线程分组，不再从 cwd 或 Git 推断项目。
  // Group each thread from Codex's official persisted classification signals, no longer inferring projects from cwd or Git.
  const officialState = await readConversationArchiveOfficialProjectState();
  const projectGroups = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const resolvedThread = resolveConversationArchiveOfficialThreadProject(officialState, row);
    if (!resolvedThread.threadId || officialState.projectlessThreadIds.has(resolvedThread.threadId)) continue;
    const projectGroup = getConversationArchiveProjectGroup(resolvedThread.project, identity);
    if (projectGroup) projectGroups.set(resolvedThread.threadId, projectGroup);
  }
  return projectGroups;
}

async function applyConversationArchiveThreadGroups(rows, identity) {
  // 这一段把官方项目身份写回线程元数据；已移除项目的旧线程不再回落到普通“对话”。
  // Write official project identity back onto thread metadata; old removed-project threads no longer fall back to Conversations.
  const officialState = await readConversationArchiveOfficialProjectState();
  const groupedRows = [];
  let removedProjectThreadCount = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    const resolvedThread = resolveConversationArchiveOfficialThreadProject(officialState, row);
    if (isConversationArchiveRemovedProjectThread(officialState, resolvedThread)) {
      removedProjectThreadCount += 1;
      continue;
    }
    const projectGroup = getConversationArchiveProjectGroup(resolvedThread.project, identity);
    groupedRows.push({
      ...row,
      ...(projectGroup || {
        archiveGroupId: conversationArchiveDefaultConversationGroupId,
        archiveGroupName: conversationArchiveDefaultConversationGroupName,
        archiveGroupType: conversationArchiveGroupTypeConversation,
      }),
    });
  }
  return {
    removedProjectThreadCount,
    rows: groupedRows,
  };
}

function getConversationArchiveThreadGroup(row, identity = null) {
  // 这一段读取预先解析好的项目分组；缺失时统一归入普通“对话”，不再用 cwd 直接冒充项目。
  // Read pre-resolved project grouping; missing values fall back to Conversations instead of treating raw cwd as a project.
  const archiveGroupType = normalizeConversationArchiveGroupType(row?.archiveGroupType);
  const archiveGroupId = normalizeConversationArchiveGroupId(row?.archiveGroupId, archiveGroupType);
  if (archiveGroupType === conversationArchiveGroupTypeProject && archiveGroupId !== "project_unknown") {
    return {
      archiveGroupId,
      archiveGroupName: normalizeConversationArchiveGroupName(row?.archiveGroupName, archiveGroupType),
      archiveGroupType: conversationArchiveGroupTypeProject,
    };
  }
  return {
    archiveGroupId: conversationArchiveDefaultConversationGroupId,
    archiveGroupName: conversationArchiveDefaultConversationGroupName,
    archiveGroupType: conversationArchiveGroupTypeConversation,
  };
}

function getConversationArchiveSessionTitle(sessionTitles, threadId) {
  // 这一段从 Codex 本地 session_index 读取官方会话标题，避免依赖虚拟化侧栏 DOM。
  // Read Codex's official title from the local session_index, avoiding dependence on virtualized sidebar DOM.
  const title = normalizeConversationArchiveTitle(sessionTitles instanceof Map ? sessionTitles.get(threadId) : "");
  return title && title !== "Untitled session" && !isConversationArchiveGeneratedTitle(title) ? title : "";
}

function pickConversationArchiveTitle(row) {
  // 这一段只使用 Codex 数据库里的标题字段，不从用户首条正文截取伪标题。
  // Use only Codex database title fields and never cut a pseudo-title out of the first user message.
  const candidates = [
    row?.title,
    row?.preview,
  ];
  for (const candidate of candidates) {
    const title = normalizeConversationArchiveTitle(candidate);
    if (title && title !== "Untitled session" && !isConversationArchiveGeneratedTitle(title)) return title;
  }
  for (const candidate of candidates) {
    const title = normalizeConversationArchiveTitle(candidate);
    if (isConversationArchiveGeneratedTitle(title)) return title;
  }
  return "Untitled session";
}

function findExistingConversationArchiveThreadFile(remoteFiles, identity, row) {
  // 这一段按当前正式路径和同 threadId 查找远端记录，目录变化时保留已有标题。
  // Find remote entries by the current formal path and thread id so directory moves keep existing titles.
  const sourceFiles = remoteFiles && typeof remoteFiles === "object" && !Array.isArray(remoteFiles) ? remoteFiles : {};
  const currentPath = getConversationArchiveThreadPath(identity, row);
  if (sourceFiles[currentPath]) return sourceFiles[currentPath];
  for (const [archivePath, file] of Object.entries(sourceFiles)) {
    const pathInfo = parseConversationArchivePath(archivePath);
    if (!pathInfo || pathInfo.deviceId !== identity.deviceId || pathInfo.profileId !== identity.profileId || pathInfo.threadId !== row.threadId) continue;
    return file;
  }
  return null;
}

function getConversationArchiveMigrationPaths(remoteFiles, identity, row) {
  // 这一段找出同一设备、账号和 thread 下除当前路径外仍 active 的正式分组入口，用于项目移动时隐藏旧目录。
  // Find active formal grouped entries for the same device, profile, and thread except the current path, hiding stale groups after project moves.
  const sourceFiles = remoteFiles && typeof remoteFiles === "object" && !Array.isArray(remoteFiles) ? remoteFiles : {};
  const currentPath = getConversationArchiveThreadPath(identity, row);
  const paths = [];
  for (const [archivePath, file] of Object.entries(sourceFiles)) {
    if (archivePath === currentPath || !file || typeof file !== "object" || Array.isArray(file)) continue;
    if (file.packageKind !== conversationArchivePackageKind) continue;
    const pathInfo = parseConversationArchivePath(archivePath);
    if (!pathInfo ||
      pathInfo.deviceId !== identity.deviceId ||
      pathInfo.profileId !== identity.profileId ||
      pathInfo.threadId !== row.threadId ||
      pathInfo.fileName !== "index.md") {
      continue;
    }
    if (getConversationArchiveThreadLifecycle(file).lifecycleStatus === conversationArchiveLifecycleDeleted) continue;
    paths.push(archivePath);
  }
  return paths;
}

function getExistingConversationArchiveTitle(remoteFiles, identity, row) {
  // 这一段复用远端已经存在的短标题，避免本机 SQLite 只剩长首条消息时列表标题退化。
  // Reuse an existing remote short title when local SQLite only has the long first user message.
  const file = findExistingConversationArchiveThreadFile(remoteFiles, identity, row);
  const title = normalizeConversationArchiveTitle(file?.title);
  if (!title || title === "Untitled session" || isConversationArchiveGeneratedTitle(title)) return "";
  return title.length <= conversationArchiveMaxNativeTitleLength ? title : "";
}

function resolveConversationArchiveExportRow(row, remoteFiles, identity) {
  // 这一段在导出前修正显示标题；归档路径仍然只由 thread id 和创建时间决定。
  // Resolve the display title before export while keeping archive paths tied to thread id and creation time.
  const existingTitle = getExistingConversationArchiveTitle(remoteFiles, identity, row);
  if (existingTitle && (row.title === "Untitled session" || isConversationArchiveGeneratedTitle(row.title))) {
    return { ...row, skipReason: "", title: existingTitle };
  }
  return row;
}

function normalizeConversationArchivePreviewFileName(value, fallback) {
  // 这一段把会话标题收敛为本机预览文件名，保留可读文字但移除路径分隔符。
  // Collapse the thread title into a local preview filename, keeping readable text while removing separators.
  const name = normalizeConversationArchiveTitle(value || fallback)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/gu, " ")
    .split(/\s+/u)
    .filter(Boolean)
    .join(" ")
    .slice(0, 80)
    .trim();
  return name || normalizeConversationArchiveTitle(fallback).slice(0, 80);
}

async function cleanupConversationArchivePreviewAliases(pathHash, keepFileName) {
  // 这一段清理同一归档路径旧标题生成的预览文件，避免会话改名后本机残留多份正文。
  // Remove preview files from older titles for the same archive path so renames do not leave duplicate local bodies.
  let entries = [];
  try {
    entries = await readdir(conversationArchivePreviewDir, { withFileTypes: true });
  } catch {
    return;
  }
  const legacySuffix = `-${pathHash}.md`;
  const versionedSuffixPattern = new RegExp(`-${pathHash}-[a-f0-9]{12}\\.md$`, "u");
  for (const entry of entries) {
    const oldThinkingFilePattern = new RegExp(`-thinking-\\d{3,6}-${pathHash}-[a-f0-9]{12}\\.md$`, "u");
    if (!entry.isFile() || entry.name === keepFileName) continue;
    if (!entry.name.endsWith(legacySuffix) && !versionedSuffixPattern.test(entry.name) && !oldThinkingFilePattern.test(entry.name)) continue;
    try {
      await unlink(path.join(conversationArchivePreviewDir, entry.name));
    } catch {
      // 这一段忽略旧预览删除失败，当前文件写入仍可继续。
      // Ignore failures deleting old previews so the current write can still continue.
    }
  }
}

function getConversationArchivePreviewDirectoryName(metadata, pathHash) {
  // 这一段为单个会话生成独立预览目录，目录名保留标题并附带路径哈希避免重名。
  // Build one preview directory per thread, keeping a readable title plus a path hash to avoid collisions.
  const title = normalizeConversationArchivePreviewFileName(metadata.title, metadata.threadId || "conversation");
  return `${title}-${pathHash}`;
}

function getConversationArchivePreviewLink(filePath) {
  // 这一段把本机预览附件路径转成受控绝对链接，避免预览目录依赖当前项目根。
  // Convert local preview attachment paths to controlled absolute links so previews do not depend on the project root.
  const resolvedPath = path.resolve(filePath);
  const previewRoot = path.resolve(conversationArchivePreviewDir);
  const lowerPreviewRoot = previewRoot.toLowerCase();
  const lowerResolvedPath = resolvedPath.toLowerCase();
  if (lowerResolvedPath !== lowerPreviewRoot && !lowerResolvedPath.startsWith(`${lowerPreviewRoot}${path.sep}`)) {
    return "";
  }

  // 这一段统一使用 Markdown/浏览器更稳定的正斜杠绝对路径。
  // Use forward-slash absolute paths because they are more stable in Markdown/browser link targets.
  return resolvedPath.replace(/\\/gu, "/");
}

function rewriteConversationArchivePreviewRelatedLinks(markdown, directoryPath) {
  // 这一段只改本地预览里的 thinking 附件链接，云端 Markdown 包仍保留同目录可移植链接。
  // Rewrite only local preview thinking attachment links; cloud Markdown bundles keep portable same-directory links.
  return String(markdown || "").replace(
    /\]\(<(thinking-\d{3,6}-[a-f0-9]{12}\.md)>\)/gu,
    (match, linkName) => {
      const safeLinkName = normalizeConversationArchiveRelatedLinkName(linkName);
      if (!safeLinkName) return match;
      const previewLink = getConversationArchivePreviewLink(path.join(directoryPath, safeLinkName));
      return previewLink ? `](<${previewLink}>)` : match;
    },
  );
}

async function writeConversationArchivePreviewFile(request, markdown, metadata = {}) {
  // 这一段只把远端 Markdown 写入受控本机状态目录，不再做查看时正文剔除。
  // Write remote Markdown only into the controlled local state directory without view-time body filtering.
  await mkdir(conversationArchivePreviewDir, { recursive: true });
  const pathHash = createHash("sha256").update(request.path, "utf8").digest("hex").slice(0, 16);
  const directoryName = getConversationArchivePreviewDirectoryName(metadata, pathHash);
  const directoryPath = path.join(conversationArchivePreviewDir, directoryName);
  if (path.dirname(path.resolve(directoryPath)) !== path.resolve(conversationArchivePreviewDir)) {
    throw new Error("会话归档预览目录越界 / Conversation archive preview directory escaped");
  }
  await mkdir(directoryPath, { recursive: true });
  const previewMarkdown = rewriteConversationArchivePreviewRelatedLinks(normalizeArchiveNewlines(markdown), directoryPath);
  const contentHash = createHash("sha256").update(previewMarkdown, "utf8").digest("hex").slice(0, 12);
  const fileName = `index-${contentHash}.md`;
  const filePath = path.join(directoryPath, fileName);
  if (path.dirname(path.resolve(filePath)) !== path.resolve(directoryPath)) {
    throw new Error("会话归档预览路径越界 / Conversation archive preview path escaped");
  }
  await cleanupConversationArchivePreviewAliases(pathHash, fileName);
  await writeFileAtomically(filePath, previewMarkdown, "utf8");
  return filePath;
}

async function writeConversationArchiveRelatedPreviewFile(directory, linkName, markdown) {
  // 这一段按主 Markdown 内的相对链接名写入思考附件，保证原生文件预览点击链接能找到本机文件。
  // Write a reasoning attachment with the relative link name used by the main Markdown so native preview links resolve locally.
  const safeLinkName = normalizeConversationArchiveRelatedLinkName(linkName);
  if (!safeLinkName) return "";
  const filePath = path.join(directory, safeLinkName);
  if (path.dirname(path.resolve(filePath)) !== path.resolve(directory)) {
    throw new Error("会话归档附件路径越界 / Conversation archive attachment path escaped");
  }
  await writeFileAtomically(filePath, normalizeArchiveNewlines(markdown), "utf8");
  return filePath;
}

async function cleanupConversationArchivePreviewDirectory(directory, keepFileNames) {
  // 这一段清理同一会话目录里旧版主文件和思考附件，避免多次预览后目录内继续堆积。
  // Clean stale main and reasoning preview files inside one thread directory so repeated previews do not pile up.
  const safeKeepFileNames = keepFileNames instanceof Set ? keepFileNames : new Set();
  let entries = [];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isFile() || safeKeepFileNames.has(entry.name)) continue;
    if (!/^index-[a-f0-9]{12}\.md$/u.test(entry.name) && !/^thinking-\d{3,6}-[a-f0-9]{12}\.md$/u.test(entry.name)) continue;
    try {
      await unlink(path.join(directory, entry.name));
    } catch {
      // 这一段忽略旧预览删除失败，当前预览文件已经可用。
      // Ignore failures deleting stale preview files because the current preview is already usable.
    }
  }
}

function normalizeConversationArchiveDisplayText(value, fallback) {
  // 这一段生成上传到 manifest 的设备和账号显示名，留空时使用本机默认值。
  // Build device/profile display names for the manifest, using local defaults when fields are blank.
  const text = String(value || "")
    .replace(/[\0-\x1f]/gu, " ")
    .split(/\s+/u)
    .filter(Boolean)
    .join(" ")
    .slice(0, conversationArchiveMaxDisplayNameLength)
    .trim();
  return text || fallback;
}

function normalizeConversationArchiveTimestamp(value, fallback = "") {
  // 这一段把数据库或 JSONL 时间统一成 ISO，坏时间回退到调用方提供的默认值。
  // Normalize database or JSONL timestamps to ISO, falling back to caller-provided defaults on bad values.
  const timestamp = typeof value === "number" && Number.isFinite(value)
    ? value
    : Date.parse(String(value || ""));
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : fallback;
}

function normalizeConversationArchiveSqliteTimestamp(value, fallback = "") {
  // 这一段兼容 SQLite 秒级和毫秒级时间戳，归档时间没有独立毫秒列。
  // Accept both second and millisecond SQLite timestamps because archive time has no separate ms column.
  const rawTimestamp = Number(value);
  if (!Number.isFinite(rawTimestamp) || rawTimestamp <= 0) return fallback;
  const timestamp = rawTimestamp < 100000000000 ? rawTimestamp * 1000 : rawTimestamp;
  return normalizeConversationArchiveTimestamp(timestamp, fallback);
}

function normalizeConversationArchiveLifecycleStatus(value) {
  // 这一段把远端和本地生命周期状态收敛为 active/archived/deleted 三种短枚举。
  // Normalize local and remote lifecycle values into the active/archived/deleted enum.
  const status = String(value || "").trim().toLowerCase();
  if (status === conversationArchiveLifecycleArchived) return conversationArchiveLifecycleArchived;
  if (status === conversationArchiveLifecycleDeleted) return conversationArchiveLifecycleDeleted;
  return conversationArchiveLifecycleActive;
}

function getConversationArchiveThreadLifecycle(row) {
  // 这一段从本地线程元数据推导生命周期；删除状态只由同步索引差异推断后传入。
  // Derive lifecycle from local thread metadata; deleted is supplied only by sync-index diff detection.
  const lifecycleStatus = normalizeConversationArchiveLifecycleStatus(row?.lifecycleStatus ||
    (Number(row?.archived) ? conversationArchiveLifecycleArchived : conversationArchiveLifecycleActive));
  const archivedAt = lifecycleStatus === conversationArchiveLifecycleArchived || lifecycleStatus === conversationArchiveLifecycleDeleted
    ? normalizeConversationArchiveSqliteTimestamp(row?.archived_at, normalizeConversationArchiveTimestamp(row?.archivedAt))
    : "";
  const deletedDetectedAt = lifecycleStatus === conversationArchiveLifecycleDeleted
    ? normalizeConversationArchiveTimestamp(row?.deletedDetectedAt)
    : "";
  return {
    archivedAt,
    deletedDetectedAt,
    lifecycleStatus,
  };
}

function isSameConversationArchiveLifecycle(left, right) {
  // 这一段比较生命周期字段，让内容未变但归档/删除状态变化时仍能同步 metadata。
  // Compare lifecycle fields so metadata-only archive/delete changes can sync without body changes.
  const leftLifecycle = getConversationArchiveThreadLifecycle(left);
  const rightLifecycle = getConversationArchiveThreadLifecycle(right);
  return leftLifecycle.lifecycleStatus === rightLifecycle.lifecycleStatus &&
    leftLifecycle.archivedAt === rightLifecycle.archivedAt &&
    leftLifecycle.deletedDetectedAt === rightLifecycle.deletedDetectedAt;
}

function getThreadTimestampMs(row, primaryKey, fallbackKey) {
  // 这一段优先使用毫秒字段，缺失时再解析字符串时间，保证归档目录按稳定月份生成。
  // Prefer millisecond fields and parse string timestamps as fallback so archive month folders stay stable.
  const primary = Number(row?.[primaryKey]);
  if (Number.isFinite(primary) && primary > 0) return Math.floor(primary);
  const fallback = Date.parse(String(row?.[fallbackKey] || ""));
  return Number.isFinite(fallback) ? fallback : Date.now();
}

function getConversationArchiveThreadPath(identity, row) {
  // 这一段按设备、账号、项目/对话分组、创建年月和 thread id 生成稳定路径。
  // Build a stable path by device, profile, project/conversation group, creation year-month, and thread id.
  const createdAtMs = getThreadTimestampMs(row, "created_at_ms", "created_at");
  const date = new Date(createdAtMs);
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const group = getConversationArchiveThreadGroup(row, identity);
  const groupType = normalizeConversationArchiveGroupType(group.archiveGroupType);
  const groupId = normalizeConversationArchiveGroupId(group.archiveGroupId, groupType);
  return `devices/${identity.deviceId}/profiles/${identity.profileId}/${getConversationArchivePathSegmentForGroup(groupType)}/${groupId}/threads/${year}/${month}/${row.threadId}/index.md`;
}

function getConversationArchiveThinkingPath(threadPath, thinkingIndex) {
  // 这一段把单条思考内容放在主会话路径下的独立 Markdown，保持主文档和附件关系清楚。
  // Store one reasoning block as its own Markdown under the parent thread path so the main file and attachment relationship stays clear.
  const normalizedThreadPath = normalizeConversationArchivePath(threadPath);
  const indexText = String(Math.max(1, Math.floor(Number(thinkingIndex) || 1))).padStart(3, "0");
  if (!normalizedThreadPath || !normalizedThreadPath.endsWith("/index.md")) return "";
  return normalizeConversationArchivePath(`${normalizedThreadPath.slice(0, -"/index.md".length)}/thinking-${indexText}.md`);
}

function normalizeConversationArchiveRelatedLinkName(value) {
  // 这一段只允许单文件名作为 Markdown 相对链接，避免远端 metadata 写出本机路径穿越。
  // Allow only a single filename for Markdown relative links so remote metadata cannot traverse local paths.
  const name = String(value || "").trim().slice(0, 180);
  return /^[A-Za-z0-9][A-Za-z0-9._ -]{0,175}\.md$/u.test(name) && !name.includes("/") && !name.includes("\\") ? name : "";
}

function getConversationArchiveThinkingLinkName(row, threadPath, thinkingIndex, markdown) {
  // 这一段生成和内容哈希绑定的本机相对链接名，预览时可避开 Codex 文件缓存。
  // Build a content-hashed local relative link name so preview files avoid Codex file-cache reuse.
  const contentHash = createHash("sha256").update(markdown, "utf8").digest("hex").slice(0, 12);
  const indexText = String(Math.max(1, Math.floor(Number(thinkingIndex) || 1))).padStart(3, "0");
  return normalizeConversationArchiveRelatedLinkName(`thinking-${indexText}-${contentHash}.md`);
}

function formatConversationArchiveThinkingDuration(durationMs) {
  // 这一段把相邻事件时间差格式化成接近 Codex 折叠行的短时长标签。
  // Format the adjacent-event duration into a compact label close to Codex's collapsed reasoning row.
  const totalSeconds = Math.max(0, Math.round(Number(durationMs) / 1000));
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return "";
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function getConversationArchiveProcessingLabel(previousTimestampMs, currentTimestampMs) {
  // 这一段生成主 Markdown 里显示的“已处理 + 时间”标题，缺少时间时保留短标题。
  // Build the visible "processed + duration" heading for the main Markdown, falling back to a short title.
  const duration = Number.isFinite(previousTimestampMs) && Number.isFinite(currentTimestampMs) && currentTimestampMs >= previousTimestampMs
    ? formatConversationArchiveThinkingDuration(currentTimestampMs - previousTimestampMs)
    : "";
  return duration ? `已处理 ${duration}` : "已处理";
}

function serializeConversationArchiveReasoningSummary(summary) {
  // 这一段导出 response_item.reasoning.summary 明文摘要，供思考附件保留可读部分。
  // Export plaintext response_item.reasoning.summary so reasoning attachments keep readable parts.
  if (!Array.isArray(summary)) return "";
  const blocks = [];
  for (const item of summary) {
    if (typeof item === "string") {
      const text = sanitizeConversationArchiveTextBlock(item);
      if (text) blocks.push(text);
      continue;
    }
    if (!item || typeof item !== "object") continue;

    // 这一段兼容不同 summary item 字段名，并沿用正文文本清理规则。
    // Support several summary item field names while reusing the normal body sanitizer.
    const text = sanitizeConversationArchiveTextBlock(item.text || item.summary || item.content || "");
    if (text) blocks.push(text);
  }
  return blocks.filter((block) => block.trim()).join("\n\n").trim();
}

function createConversationArchiveProcessingGroup(startedAfterTimestampMs) {
  // 这一段创建一组 Codex 折叠“已处理”事件，后续会合并成一个附件和一个主文档链接。
  // Create one Codex collapsed "processed" event group that becomes one attachment and one main-document link.
  return {
    lastTimestampMs: NaN,
    messages: [],
    startedAfterTimestampMs,
    toolCounts: {},
  };
}

function appendConversationArchiveProcessingMessage(group, text, eventTimestampMs) {
  // 这一段把 commentary 文本写入当前“已处理”组；这些就是 Codex 折叠区里可读的处理说明。
  // Add commentary text to the current processed group; these are the readable notes in Codex's collapsed area.
  const message = sanitizeConversationArchiveTextBlock(text);
  if (message) group.messages.push(message);
  if (Number.isFinite(eventTimestampMs)) group.lastTimestampMs = eventTimestampMs;
}

function getConversationArchiveToolSummaryLabel(payload) {
  // 这一段把工具调用类型压缩成类似 Codex 折叠区的短摘要，不导出工具参数或输出。
  // Compact tool-call types into short summaries like Codex's collapsed area without exporting arguments or outputs.
  const type = String(payload?.type || "");
  const name = String(payload?.name || "");
  if (type === "function_call" && name === "shell_command") return "命令";
  if (type === "custom_tool_call" && name === "apply_patch") return "文件编辑";
  if (type === "web_search_call") return "网络搜索";
  if (type === "tool_search_call") return "工具搜索";
  if (type === "function_call") return name ? `函数 ${name}` : "函数调用";
  if (type === "custom_tool_call") return name ? `工具 ${name}` : "自定义工具";
  return "";
}

function appendConversationArchiveProcessingToolSummary(group, payload, eventTimestampMs) {
  // 这一段只统计工具调用次数，保持“已处理”附件可读且不把命令输出重新塞进归档。
  // Count tool calls only, keeping processed attachments readable without re-exporting command outputs.
  const label = getConversationArchiveToolSummaryLabel(payload);
  if (label) group.toolCounts[label] = (group.toolCounts[label] || 0) + 1;
  if (Number.isFinite(eventTimestampMs)) group.lastTimestampMs = eventTimestampMs;
}

function serializeConversationArchiveProcessingGroup(group) {
  // 这一段把合并后的“已处理”组序列化为附件正文；没有可读过程时返回空。
  // Serialize a merged processed group into attachment body text, returning empty when no readable process exists.
  if (!group || typeof group !== "object") return "";
  const blocks = [];
  const messages = Array.isArray(group.messages) ? group.messages.filter((block) => block.trim()) : [];
  const toolEntries = Object.entries(group.toolCounts || {}).filter(([, count]) => count > 0);
  if (messages.length > 0) {
    blocks.push(`### 过程消息\n\n${messages.join("\n\n---\n\n")}`);
  }
  if (toolEntries.length > 0) {
    const summaryLines = toolEntries.map(([label, count]) => `- 已运行 ${count} 条${label}`);
    blocks.push(`### 工具执行摘要\n\n${summaryLines.join("\n")}`);
  }
  return blocks.join("\n\n").trim();
}

function createConversationArchiveThinkingMarkdown(row, label, body) {
  // 这一段构造独立“已处理”Markdown；文件名沿用 thinking 前缀以兼容既有云端路径协议。
  // Build standalone processed Markdown; filenames keep the thinking prefix for the existing cloud path protocol.
  const summary = body.trim() || "本地归档没有可导出的处理过程。";
  return `# ${row.title}\n\n## ${label}\n\n${summary.trim()}\n`;
}

function createConversationArchiveMarkdownFile(markdown, archivePath, metadata) {
  // 这一段把 Markdown 正文封装成上传文件对象，并在上传前完成大小和哈希计算。
  // Wrap Markdown content into an upload file object with size and hash computed before upload.
  const markdownBytes = Buffer.byteLength(markdown, "utf8");
  if (markdownBytes > conversationArchiveMaxMarkdownBytes) {
    return {
      markdownBytes,
      skipped: true,
      skipReason: "oversize",
    };
  }
  const markdownSha256 = createHash("sha256").update(markdown, "utf8").digest("hex");
  return {
    contentBase64: Buffer.from(markdown, "utf8").toString("base64"),
    markdownBytes,
    markdownSha256,
    metadata: {
      ...metadata,
      markdownSha256,
    },
    path: archivePath,
  };
}

function decodeConversationArchiveBase64File(file) {
  // 这一段把已封装的 Markdown base64 还原成文本，并复核大小和哈希。
  // Restore a packaged Markdown base64 body into text while checking size and hash.
  const buffer = Buffer.from(String(file?.contentBase64 || ""), "base64");
  const markdownBytes = Math.max(0, Math.floor(Number(file?.markdownBytes) || 0));
  const markdownSha256 = String(file?.markdownSha256 || "").trim().toLowerCase();
  if (buffer.byteLength <= 0 || buffer.byteLength > conversationArchiveMaxMarkdownBytes) return null;
  if (markdownBytes !== buffer.byteLength) return null;
  if (!/^[a-f0-9]{64}$/u.test(markdownSha256)) return null;
  if (createHash("sha256").update(buffer).digest("hex") !== markdownSha256) return null;
  return buffer.toString("utf8");
}

function createConversationArchiveThreadPackage(exported) {
  // 这一段把一个会话的主 Markdown 和所有思考 Markdown 打成单个 gzip JSON 包。
  // Pack one thread's main Markdown and all reasoning Markdown files into one gzipped JSON package.
  const mainMarkdown = decodeConversationArchiveBase64File(exported);
  if (!mainMarkdown) {
    return {
      markdownBytes: Math.max(0, Math.floor(Number(exported?.markdownBytes) || 0)),
      skipped: true,
      skipReason: "invalid-package",
    };
  }

  // 这一段构造包内文件清单；远端只存一个资源，本机预览仍恢复成原来的文件目录。
  // Build the in-package file list; the remote stores one resource while local preview restores the old directory shape.
  const packageFiles = [{
    contentBase64: Buffer.from(mainMarkdown, "utf8").toString("base64"),
    fileRole: "thread",
    linkName: "index.md",
    markdownBytes: exported.markdownBytes,
    markdownSha256: exported.markdownSha256,
  }];
  for (const relatedFile of Array.isArray(exported.relatedFiles) ? exported.relatedFiles : []) {
    const linkName = normalizeConversationArchiveRelatedLinkName(relatedFile?.metadata?.linkName);
    const markdown = linkName ? decodeConversationArchiveBase64File(relatedFile) : "";
    if (!linkName || !markdown) {
      return {
        markdownBytes: Math.max(0, Math.floor(Number(relatedFile?.markdownBytes) || 0)),
        skipped: true,
        skipReason: "invalid-package",
      };
    }
    packageFiles.push({
      contentBase64: Buffer.from(markdown, "utf8").toString("base64"),
      fileRole: "thinking",
      linkName,
      markdownBytes: relatedFile.markdownBytes,
      markdownSha256: relatedFile.markdownSha256,
      thinkingIndex: Math.max(0, Math.floor(Number(relatedFile?.metadata?.thinkingIndex) || 0)),
    });
  }

  // 这一段压缩包体并生成包级哈希；增量上传只比较这一个包哈希。
  // Compress the package body and compute a package-level hash; incremental upload compares only this one package hash.
  const packageText = JSON.stringify({
    files: packageFiles,
    packageFormatVersion: conversationArchivePackageFormatVersion,
    packageKind: conversationArchivePackageKind,
    path: exported.path,
  });
  const packageUncompressedBytes = Buffer.byteLength(packageText, "utf8");
  if (packageUncompressedBytes > conversationArchiveMaxPackageUncompressedBytes) {
    return {
      markdownBytes: packageUncompressedBytes,
      skipped: true,
      skipReason: "oversize",
    };
  }
  const packageBuffer = gzipSync(Buffer.from(packageText, "utf8"));
  if (packageBuffer.byteLength > conversationArchiveMaxPackageBytes) {
    return {
      markdownBytes: packageBuffer.byteLength,
      skipped: true,
      skipReason: "oversize",
    };
  }
  const packageSha256 = createHash("sha256").update(packageBuffer).digest("hex");
  return {
    ...exported,
    packageBase64: packageBuffer.toString("base64"),
    packageBytes: packageBuffer.byteLength,
    packageFileCount: packageFiles.length,
    packageFormatVersion: conversationArchivePackageFormatVersion,
    packageKind: conversationArchivePackageKind,
    packageSha256,
    packageUncompressedBytes,
    metadata: {
      ...exported.metadata,
      packageBytes: packageBuffer.byteLength,
      packageFileCount: packageFiles.length,
      packageFormatVersion: conversationArchivePackageFormatVersion,
      packageKind: conversationArchivePackageKind,
      packageSha256,
      packageUncompressedBytes,
    },
  };
}

function unpackConversationArchiveThreadPackage(buffer, metadata = {}) {
  // 这一段解压远端会话包，并只接受 index.md 与安全的同目录思考文件。
  // Decompress a remote thread package, accepting only index.md and safe same-directory reasoning files.
  if (!Buffer.isBuffer(buffer) || buffer.byteLength <= 0 || buffer.byteLength > conversationArchiveMaxPackageBytes) {
    throw new Error("会话归档包无效 / Invalid conversation archive package");
  }
  const expectedPackageSha256 = String(metadata.packageSha256 || "").trim().toLowerCase();
  if (expectedPackageSha256 && createHash("sha256").update(buffer).digest("hex") !== expectedPackageSha256) {
    throw new Error("会话归档包哈希不一致 / Conversation archive package hash mismatch");
  }
  const packageText = gunzipSync(buffer, { maxOutputLength: conversationArchiveMaxPackageUncompressedBytes }).toString("utf8");
  const packageData = JSON.parse(packageText);
  if (!packageData || typeof packageData !== "object" || Array.isArray(packageData) ||
    packageData.packageKind !== conversationArchivePackageKind ||
    Number(packageData.packageFormatVersion) !== conversationArchivePackageFormatVersion ||
    !Array.isArray(packageData.files)) {
    throw new Error("会话归档包格式无效 / Invalid conversation archive package format");
  }

  // 这一段逐个复核包内 Markdown，避免坏包污染本机预览目录。
  // Verify each Markdown file inside the package so a bad package cannot pollute the local preview directory.
  let markdown = "";
  const relatedFiles = [];
  for (const file of packageData.files.slice(0, conversationArchiveMaxThinkingFilesPerThread + 1)) {
    const linkName = String(file?.linkName || "").trim();
    const content = decodeConversationArchiveBase64File(file);
    if (!content) continue;
    if (linkName === "index.md" && file.fileRole === "thread") {
      markdown = content;
      continue;
    }
    const safeLinkName = normalizeConversationArchiveRelatedLinkName(linkName);
    if (safeLinkName && file.fileRole === "thinking") {
      relatedFiles.push({
        linkName: safeLinkName,
        markdown: content,
      });
    }
  }
  if (!markdown) throw new Error("会话归档包缺少主 Markdown / Conversation archive package is missing index Markdown");
  return {
    markdown,
    relatedFiles,
  };
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

async function getConversationArchiveSqliteCandidate(filePath) {
  // 这一段读取候选 SQLite 文件和 WAL 的修改时间，用于兼容 Codex 新旧数据库目录。
  // Read candidate SQLite and WAL mtimes so both old and new Codex database layouts are supported.
  try {
    const fileStats = await stat(filePath);
    if (!fileStats.isFile()) return null;
    let walMtimeMs = 0;
    try {
      const walStats = await stat(`${filePath}-wal`);
      if (walStats.isFile()) walMtimeMs = walStats.mtimeMs;
    } catch {
      // 这一段允许没有 WAL 的旧库继续作为候选。
      // Allow older databases without a WAL file to remain candidates.
    }
    return {
      filePath,
      mtimeMs: Math.max(fileStats.mtimeMs, walMtimeMs),
    };
  } catch {
    return null;
  }
}

async function getConversationArchiveStateDatabasePath() {
  // 这一段按 Codex 当前和旧版布局查找 state_5.sqlite，优先选择最近仍在写入的库。
  // Locate state_5.sqlite across current and legacy Codex layouts, preferring the actively written database.
  const codexHomeDir = getCodexHomeDir();
  const candidates = await Promise.all([
    getConversationArchiveSqliteCandidate(path.join(codexHomeDir, "sqlite", "state_5.sqlite")),
    getConversationArchiveSqliteCandidate(path.join(codexHomeDir, "state_5.sqlite")),
  ]);
  return candidates
    .filter(Boolean)
    .sort((left, right) => right.mtimeMs - left.mtimeMs)[0]?.filePath || "";
}

async function readConversationArchiveSessionTitles() {
  // 这一段读取 Codex 自己维护的 session_index.jsonl，拿到全量 thread id 到原生短标题的映射。
  // Read Codex's own session_index.jsonl to build the full thread id to native short-title map.
  const sessionIndexPath = path.join(getCodexHomeDir(), "session_index.jsonl");
  let indexStat;
  try {
    indexStat = await stat(sessionIndexPath);
  } catch {
    return new Map();
  }
  if (!indexStat.isFile() || indexStat.size > conversationArchiveMaxSessionIndexBytes) return new Map();

  const titles = new Map();
  const lineReader = createInterface({
    crlfDelay: Infinity,
    input: createReadStream(sessionIndexPath, { encoding: "utf8" }),
  });
  for await (const line of lineReader) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      const threadId = normalizeConversationArchiveThreadId(row?.id);
      const title = normalizeConversationArchiveTitle(row?.thread_name);
      if (!threadId || !title || title === "Untitled session" || isConversationArchiveGeneratedTitle(title)) continue;
      titles.set(threadId, title);
    } catch {
      // 这一段跳过损坏行，避免单条索引记录影响整个归档同步。
      // Skip malformed rows so one bad index entry cannot break archive sync.
    }
  }
  return titles;
}

async function readConversationArchiveThreads(sessionTitles = new Map()) {
  // 这一段只读取 Codex 本地 SQLite 元数据，不读取会话正文；正文解析留给变化项。
  // Read only Codex local SQLite metadata here; conversation bodies are parsed only for changed items.
  const dbPath = await getConversationArchiveStateDatabasePath();
  if (!dbPath) {
    throw new Error("未找到 Codex 本地会话数据库 / Codex local session database not found");
  }

  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    // 这一段探测可选列，让旧 Codex SQLite schema 没有归档字段时仍可同步普通会话。
    // Detect optional columns so older Codex SQLite schemas without archive fields can still sync active threads.
    const threadColumns = getConversationArchiveThreadColumns(db);
    const threadWhere = buildConversationArchiveThreadWhere(threadColumns);
    const archivedSelect = threadColumns.has("archived") ? "archived" : "0 AS archived";
    const archivedAtSelect = threadColumns.has("archived_at") ? "archived_at" : "NULL AS archived_at";
    const cwdSelect = threadColumns.has("cwd") ? "cwd" : "'' AS cwd";
    const threadSourceSelect = threadColumns.has("thread_source") ? "thread_source" : "'' AS thread_source";
    const rows = db.prepare(`
      SELECT id, title, first_user_message, preview, rollout_path, created_at, updated_at, created_at_ms, updated_at_ms, ${archivedSelect}, ${archivedAtSelect}, ${cwdSelect}, ${threadSourceSelect}
      FROM threads
      WHERE ${threadWhere}
      ORDER BY updated_at_ms DESC
    `).all();
    return rows
      .map((row) => {
        // 这一段优先使用 Codex 本地 session_index 的短标题，SQLite 标题只作为兜底。
        // Prefer Codex's local session_index short title, using SQLite titles only as fallback.
        const threadId = normalizeConversationArchiveThreadId(row.id);
        const title = getConversationArchiveSessionTitle(sessionTitles, threadId) || pickConversationArchiveTitle(row);
        const lifecycle = getConversationArchiveThreadLifecycle(row);
        return {
          archived: Number(row.archived) ? 1 : 0,
          archived_at: row.archived_at,
          archivedAt: lifecycle.archivedAt,
          created_at: row.created_at,
          created_at_ms: row.created_at_ms,
          cwd: typeof row.cwd === "string" ? row.cwd : "",
          first_user_message: row.first_user_message,
          lifecycleStatus: lifecycle.lifecycleStatus,
          preview: row.preview,
          rolloutPath: typeof row.rollout_path === "string" ? row.rollout_path : "",
          skipReason: isConversationArchiveGeneratedTitle(title) ? "generated-title" : "",
          threadId,
          threadSource: typeof row.thread_source === "string" ? row.thread_source : "",
          title,
          updated_at: row.updated_at,
          updated_at_ms: row.updated_at_ms,
        };
      })
      .filter((row) => row.threadId && row.rolloutPath);
  } finally {
    db.close();
  }
}

async function readConversationArchiveInternalThreadIds() {
  // 这一段只读取内部线程 id，用于隐藏历史上已经上传过的 subagent/审批归档。
  // Read only internal thread ids so already-uploaded subagent/approval archives can be hidden.
  const dbPath = await getConversationArchiveStateDatabasePath();
  if (!dbPath) return new Set();

  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const threadWhere = buildConversationArchiveThreadWhere(getConversationArchiveThreadColumns(db), { internal: true });
    const rows = db.prepare(`
      SELECT id
      FROM threads
      WHERE ${threadWhere}
    `).all();
    return new Set(rows.map((row) => normalizeConversationArchiveThreadId(row.id)).filter(Boolean));
  } finally {
    db.close();
  }
}

function shouldExportConversationArchiveThread(row, rolloutStat, index, remoteFiles, identity) {
  // 这一段用 SQLite 更新时间、rollout 大小和 mtime 判断是否需要重新解析正文。
  // Use SQLite update time plus rollout size and mtime to decide whether a body parse is needed.
  const previous = index.threads?.[row.threadId];
  const archivePath = getConversationArchiveThreadPath(identity, row);
  if (!previous ||
    normalizeConversationArchivePath(previous.path) !== archivePath ||
    Number(previous.markdownFormatVersion) !== conversationArchiveMarkdownFormatVersion ||
    Number(previous.updatedAtMs) !== getThreadTimestampMs(row, "updated_at_ms", "updated_at") ||
    Number(previous.rolloutSize) !== rolloutStat.size ||
    Math.floor(Number(previous.rolloutMtimeMs) || 0) !== Math.floor(rolloutStat.mtimeMs)) {
    return true;
  }
  if (previous.skipReason && previous.skipReason !== "deleted") {
    return previous.skipReason === "generated-title" && !row.skipReason;
  }
  const remoteFile = remoteFiles?.[archivePath];
  if (!isSameConversationArchiveLifecycle(previous, row)) return true;
  if (remoteFile && !isSameConversationArchiveLifecycle(remoteFile, row)) return true;
  if (remoteFile && normalizeConversationArchiveTitle(remoteFile.title) !== row.title) return true;
  if (getConversationArchiveMigrationPaths(remoteFiles, identity, row).length > 0) return true;
  const packageSha256 = String(previous.packageSha256 || "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(packageSha256)) return true;
  return !remoteFile ||
    remoteFile.packageKind !== conversationArchivePackageKind ||
    remoteFile.packageSha256 !== packageSha256 ||
    remoteFile.markdownSha256 !== previous.markdownSha256;
}

function isConversationArchiveThreadStable(row) {
  // 这一段给刚变化的会话留出稳定窗口，避免用户还在对话时反复导出和上传。
  // Give recently changed sessions a stability window so active conversations are not exported repeatedly.
  const updatedAtMs = getThreadTimestampMs(row, "updated_at_ms", "updated_at");
  return Date.now() - updatedAtMs >= conversationArchiveStableDelayMs;
}

function getConversationArchiveUnstableDecision(index, row, identity) {
  // 这一段给持续活跃的会话设置最长等待时间，避免 90 秒稳定窗口让长对话永远不上传。
  // Set a maximum wait for continuously active threads so the 90-second stability window cannot defer uploads forever.
  const previous = index.threads?.[row.threadId];
  const archivePath = getConversationArchiveThreadPath(identity, row);
  const previousPath = normalizeConversationArchivePath(previous?.unstablePath || previous?.path);
  const previousFirstSeenAtMs = Math.floor(Number(previous?.unstableFirstSeenAtMs) || 0);
  const firstSeenAtMs = previousPath === archivePath && previousFirstSeenAtMs > 0
    ? previousFirstSeenAtMs
    : Date.now();
  return {
    allowExport: Date.now() - firstSeenAtMs >= conversationArchiveMaxUnstableDelayMs,
    firstSeenAtMs,
  };
}

function rememberConversationArchiveUnstableThread(index, row, rolloutStat, identity, firstSeenAtMs) {
  // 这一段只记录不稳定会话的等待起点，不把它伪装成已上传的最新版本。
  // Record only the waiting start for an unstable thread without pretending its latest version was uploaded.
  const previous = index.threads?.[row.threadId] && typeof index.threads[row.threadId] === "object"
    ? index.threads[row.threadId]
    : {};
  index.threads[row.threadId] = {
    ...previous,
    unstableFirstSeenAtMs: Math.max(0, Math.floor(Number(firstSeenAtMs) || Date.now())),
    unstablePath: getConversationArchiveThreadPath(identity, row),
    unstableRolloutMtimeMs: rolloutStat.mtimeMs,
    unstableRolloutSize: rolloutStat.size,
    unstableUpdatedAtMs: getThreadTimestampMs(row, "updated_at_ms", "updated_at"),
  };
}

function rememberConversationArchiveIndexThread(index, row, rolloutStat, values = {}) {
  // 这一段把已检查过的会话写进本地索引，包含正常上传、无消息和超大跳过三种结果。
  // Record checked threads in the local index, covering uploaded, no-message, and oversize skipped results.
  const lifecycle = getConversationArchiveThreadLifecycle(row);
  index.threads[row.threadId] = {
    archivedAt: lifecycle.archivedAt,
    deletedDetectedAt: lifecycle.deletedDetectedAt,
    lifecycleStatus: lifecycle.lifecycleStatus,
    path: values.path || index.threads?.[row.threadId]?.path || "",
    rolloutMtimeMs: rolloutStat.mtimeMs,
    rolloutSize: rolloutStat.size,
    markdownFormatVersion: conversationArchiveMarkdownFormatVersion,
    updatedAtMs: getThreadTimestampMs(row, "updated_at_ms", "updated_at"),
    uploadedAt: new Date().toISOString(),
    ...values,
  };
}

function rememberConversationArchiveIndexLifecycle(index, threadId, values = {}) {
  // 这一段只更新生命周期索引，不需要会话正文或 rollout stat，供删除墓碑同步使用。
  // Update lifecycle-only index fields without rollout stats, used for deleted tombstone sync.
  const previous = index.threads?.[threadId] && typeof index.threads[threadId] === "object" ? index.threads[threadId] : {};
  index.threads[threadId] = {
    ...previous,
    uploadedAt: new Date().toISOString(),
    ...values,
  };
}

function normalizeArchiveNewlines(value) {
  // 这一段把消息正文统一成 LF 换行，避免 Windows/Unix 混合换行造成不必要的远端 diff。
  // Normalize message bodies to LF so mixed Windows/Unix newlines do not create unnecessary remote diffs.
  return String(value || "").replace(/\r\n/gu, "\n").replace(/\r/gu, "\n");
}

function stripConversationArchiveMemoryCitationBlocks(text) {
  // 这一段剔除 Codex 给回答尾部追加的记忆引用标记，它不是用户/助手正文的一部分。
  // Strip Codex memory citation markers appended to replies because they are not user/assistant conversation body.
  return String(text || "")
    .replace(/(?:^|\n)[ \t]*<oai-mem-citation>\s*[\s\S]*?[ \t]*<\/oai-mem-citation>[ \t]*(?=\n|$)/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function sanitizeConversationArchiveTextBlock(value) {
  // 这一段移除 Codex 注入给模型看的上下文和附件包装，只保留用户真正输入的文字。
  // Remove model-facing Codex context and attachment wrappers, keeping only user-authored text.
  const text = normalizeArchiveNewlines(value).replace(/^\n+|\n+$/gu, "").trim();
  if (!text) return "";
  if (/^# AGENTS\.md instructions for\b/iu.test(text) || /^<environment_context>/iu.test(text)) return "";
  if (/^<subagent_notification>/iu.test(text)) return "";
  if (/^<image\b[^>]*>$/iu.test(text) || /^<\/image>$/iu.test(text)) return "";

  // 这一段把截图消息前置的本机临时路径说明剥掉，避免 Markdown 泄露临时文件路径。
  // Strip screenshot preambles with local temp paths so Markdown does not leak temporary file paths.
  const withoutAttachmentPreamble = text
    .replace(/^# Files mentioned by the user:[\s\S]*?## My request for Codex:\s*/u, "")
    .replace(/^## My request for Codex:\s*/u, "")
    .trim();
  return stripConversationArchiveMemoryCitationBlocks(withoutAttachmentPreamble);
}

function serializeConversationArchiveContent(content) {
  // 这一段按 Codex++ 风格只导出用户/助手可见文本和图片占位，不包含工具输出或推理内容。
  // Export only user/assistant visible text and image placeholders like Codex++, excluding tool output and reasoning.
  if (!Array.isArray(content)) return "";
  const blocks = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const blockType = String(block.type || "");
    if (blockType === "input_image") {
      const imageUrl = String(block.image_url || "").trim();
      blocks.push(!imageUrl || imageUrl.startsWith("data:")
        ? "> Image attachment"
        : `> Image attachment\n[Image link](<${imageUrl}>)`);
      continue;
    }
    if (blockType === "input_text" || blockType === "output_text" || blockType === "text") {
      const text = sanitizeConversationArchiveTextBlock(block.text || "");
      if (text.trim()) blocks.push(text);
    }
  }
  return blocks.filter((block) => block.trim()).join("\n\n").trim();
}

function createConversationArchiveFallbackMarkdown(row) {
  // 这一段在 rollout 解析异常时生成安全兜底 Markdown，只包含标题和本机线程元数据。
  // Generate safe fallback Markdown on rollout parse errors, containing only title and local thread metadata.
  const title = normalizeConversationArchiveTitle(row?.title);
  const threadId = normalizeConversationArchiveThreadId(row?.threadId) || "unknown";
  const updatedAt = normalizeConversationArchiveTimestamp(
    getThreadTimestampMs(row, "updated_at_ms", "updated_at"),
    new Date().toISOString(),
  );
  return `# ${title}\n\n- Thread: \`${threadId}\`\n- Updated: \`${updatedAt}\`\n`;
}

function exportConversationArchiveFallbackMarkdown(row, identity, displayNames) {
  // 这一段把兜底 Markdown 封装成和正式导出一致的文件对象，避免 Node/Rust 预览语义分叉。
  // Wrap fallback Markdown in the same file object as normal export so Node/Rust preview semantics stay aligned.
  const archivePath = getConversationArchiveThreadPath(identity, row);
  const sourceUpdatedAt = normalizeConversationArchiveTimestamp(
    getThreadTimestampMs(row, "updated_at_ms", "updated_at"),
    new Date().toISOString(),
  );
  const sourceCreatedAt = normalizeConversationArchiveTimestamp(
    getThreadTimestampMs(row, "created_at_ms", "created_at"),
    sourceUpdatedAt,
  );
  const archiveGroup = getConversationArchiveThreadGroup(row, identity);
  const lifecycle = getConversationArchiveThreadLifecycle(row);
  const fallbackFile = createConversationArchiveMarkdownFile(createConversationArchiveFallbackMarkdown(row), archivePath, {
    archiveGroupId: archiveGroup.archiveGroupId,
    archiveGroupName: archiveGroup.archiveGroupName,
    archiveGroupType: archiveGroup.archiveGroupType,
    deviceId: identity.deviceId,
    deviceName: displayNames.deviceName,
    fileRole: "thread",
    archivedAt: lifecycle.archivedAt,
    deletedDetectedAt: lifecycle.deletedDetectedAt,
    lifecycleStatus: lifecycle.lifecycleStatus,
    messageCount: 0,
    profileId: identity.profileId,
    profileName: displayNames.profileName,
    relatedFiles: [],
    sourceCreatedAt,
    sourceUpdatedAt,
    thinkingCount: 0,
    threadId: row.threadId,
    threadSource: row.threadSource || "user",
    title: row.title,
  });
  if (fallbackFile.skipped) {
    return {
      markdownBytes: fallbackFile.markdownBytes,
      messageCount: 0,
      skipped: true,
      skipReason: fallbackFile.skipReason,
    };
  }
  return {
    ...fallbackFile,
    messageCount: 0,
    parseErrors: 1,
    relatedFiles: [],
  };
}

async function exportConversationArchiveMarkdown(row, identity, displayNames) {
  // 这一段流式解析单个 rollout，只收集用户/助手正文和合并后的“已处理”附件，避免把工具输出导入归档。
  // Stream-parse one rollout and collect user/assistant bodies plus merged processed attachments, excluding tool outputs from the archive.
  const archivePath = getConversationArchiveThreadPath(identity, row);
  const sourceUpdatedAt = normalizeConversationArchiveTimestamp(
    getThreadTimestampMs(row, "updated_at_ms", "updated_at"),
    new Date().toISOString(),
  );
  const sourceCreatedAt = normalizeConversationArchiveTimestamp(
    getThreadTimestampMs(row, "created_at_ms", "created_at"),
    sourceUpdatedAt,
  );
  const archiveGroup = getConversationArchiveThreadGroup(row, identity);
  const messageLines = [`# ${row.title}`, ""];
  let markdownBytesSoFar = Buffer.byteLength(messageLines.join("\n"), "utf8");
  let messageCount = 0;
  let previousSpeaker = "";
  let previousEventTimestampMs = NaN;
  let lastVisibleEventTimestampMs = NaN;
  let pendingProcessingGroup = null;
  let parseErrors = 0;
  const relatedFiles = [];
  const lineReader = createInterface({
    crlfDelay: Infinity,
    input: createReadStream(row.rolloutPath, { encoding: "utf8" }),
  });

  function ensurePendingProcessingGroup() {
    // 这一段按可见消息间隔创建“已处理”组，让 commentary、工具调用和 reasoning 时间共享同一折叠块。
    // Create one processed group per visible-message interval so commentary, tool calls, and reasoning timing share a block.
    if (!pendingProcessingGroup) {
      const startedAfterTimestampMs = Number.isFinite(lastVisibleEventTimestampMs)
        ? lastVisibleEventTimestampMs
        : previousEventTimestampMs;
      pendingProcessingGroup = createConversationArchiveProcessingGroup(startedAfterTimestampMs);
    }
    return pendingProcessingGroup;
  }

  function flushPendingProcessing(endTimestampMs = NaN) {
    // 这一段在下一条可见消息前落盘当前“已处理”组，只生成普通段落链接，不写 Markdown 标题。
    // Flush the current processed group before the next visible message, using a normal paragraph link instead of a Markdown heading.
    if (!pendingProcessingGroup) return null;
    const processingGroup = pendingProcessingGroup;
    pendingProcessingGroup = null;
    const body = serializeConversationArchiveProcessingGroup(processingGroup);
    if (!body) return null;
    if (relatedFiles.length >= conversationArchiveMaxThinkingFilesPerThread) return null;

    const thinkingIndex = relatedFiles.length + 1;
    const label = getConversationArchiveProcessingLabel(
      processingGroup.startedAfterTimestampMs,
      Number.isFinite(endTimestampMs) ? endTimestampMs : processingGroup.lastTimestampMs,
    );
    const thinkingMarkdown = createConversationArchiveThinkingMarkdown(row, label, body);
    const linkName = getConversationArchiveThinkingLinkName(row, archivePath, thinkingIndex, thinkingMarkdown);
    const thinkingPath = getConversationArchiveThinkingPath(archivePath, thinkingIndex);
    const thinkingFile = createConversationArchiveMarkdownFile(thinkingMarkdown, thinkingPath, {
      archiveGroupId: archiveGroup.archiveGroupId,
      archiveGroupName: archiveGroup.archiveGroupName,
      archiveGroupType: archiveGroup.archiveGroupType,
      deviceId: identity.deviceId,
      deviceName: displayNames.deviceName,
      fileRole: "thinking",
      linkName,
      messageCount: 0,
      profileId: identity.profileId,
      profileName: displayNames.profileName,
      sourceCreatedAt,
      sourceUpdatedAt,
      thinkingIndex,
      thinkingLabel: label,
      thinkingParentPath: archivePath,
      threadId: row.threadId,
      threadSource: "thinking",
      title: `${row.title} - ${label}`,
    });
    if (thinkingFile.skipped) {
      return {
        markdownBytes: thinkingFile.markdownBytes,
        messageCount,
        skipped: true,
        skipReason: thinkingFile.skipReason,
      };
    }
    relatedFiles.push(thinkingFile);
    messageLines.push(`[${label}](<${linkName}>)`, "");
    markdownBytesSoFar = Buffer.byteLength(`${messageLines.join("\n").trimEnd()}\n`, "utf8");
    return null;
  }

  for await (const rawLine of lineReader) {
    if (!rawLine.trim()) continue;
    let event;
    try {
      event = JSON.parse(rawLine);
    } catch {
      parseErrors += 1;
      continue;
    }
    if (event?.type !== "response_item") continue;
    const eventTimestampMs = Date.parse(String(event.timestamp || ""));
    const payload = event.payload;
    if (!payload || typeof payload !== "object") {
      if (Number.isFinite(eventTimestampMs)) previousEventTimestampMs = eventTimestampMs;
      continue;
    }

    if (payload.type === "reasoning" && relatedFiles.length < conversationArchiveMaxThinkingFilesPerThread) {
      const processingGroup = ensurePendingProcessingGroup();
      const summary = serializeConversationArchiveReasoningSummary(payload.summary);
      if (summary) appendConversationArchiveProcessingMessage(processingGroup, summary, eventTimestampMs);
      else if (Number.isFinite(eventTimestampMs)) processingGroup.lastTimestampMs = eventTimestampMs;
    } else if (["function_call", "custom_tool_call", "web_search_call", "tool_search_call"].includes(String(payload.type || ""))) {
      appendConversationArchiveProcessingToolSummary(ensurePendingProcessingGroup(), payload, eventTimestampMs);
    } else if (payload.type === "message") {
      const speaker = payload.role === "user" ? "User" : payload.role === "assistant" ? "Assistant" : "";
      if (speaker) {
        const body = serializeConversationArchiveContent(payload.content);
        if (body) {
          if (payload.role === "assistant" && payload.phase === "commentary") {
            appendConversationArchiveProcessingMessage(ensurePendingProcessingGroup(), body, eventTimestampMs);
            if (Number.isFinite(eventTimestampMs)) previousEventTimestampMs = eventTimestampMs;
            continue;
          }
          const nextMessageBytes = Buffer.byteLength(body, "utf8");
          if (nextMessageBytes > conversationArchiveMaxMarkdownBytes) {
            return {
              markdownBytes: nextMessageBytes,
              messageCount: messageCount + 1,
              skipped: true,
              skipReason: "oversize",
            };
          }

          const processingResult = flushPendingProcessing(eventTimestampMs);
          if (processingResult) return processingResult;

          // 这一段只在说话主体切换时写分割线和角色标题；连续同主体消息直接接正文，保持自然换行。
          // Write a divider and role heading only when the speaker changes; repeated speakers append body text with natural spacing.
          if (speaker === previousSpeaker) {
            messageLines.push(body, "");
          } else {
            if (previousSpeaker) messageLines.push("---", "");
            messageLines.push(`### ${speaker}`, "", body, "");
          }
          markdownBytesSoFar = Buffer.byteLength(`${messageLines.join("\n").trimEnd()}\n`, "utf8");
          previousSpeaker = speaker;
          if (Number.isFinite(eventTimestampMs)) lastVisibleEventTimestampMs = eventTimestampMs;
          messageCount += 1;
        }
      }
    }

    if (Number.isFinite(eventTimestampMs)) previousEventTimestampMs = eventTimestampMs;
    if (markdownBytesSoFar > conversationArchiveMaxMarkdownBytes) {
      return {
        markdownBytes: markdownBytesSoFar,
        messageCount,
        skipped: true,
        skipReason: "oversize",
      };
    }
  }

  const processingResult = flushPendingProcessing();
  if (processingResult) return processingResult;

  if (messageCount <= 0) return null;
  const markdown = `${messageLines.join("\n").trimEnd()}\n`;
  const lifecycle = getConversationArchiveThreadLifecycle(row);
  const mainFile = createConversationArchiveMarkdownFile(markdown, archivePath, {
    archiveGroupId: archiveGroup.archiveGroupId,
    archiveGroupName: archiveGroup.archiveGroupName,
    archiveGroupType: archiveGroup.archiveGroupType,
    deviceId: identity.deviceId,
    deviceName: displayNames.deviceName,
    fileRole: "thread",
    archivedAt: lifecycle.archivedAt,
    deletedDetectedAt: lifecycle.deletedDetectedAt,
    lifecycleStatus: lifecycle.lifecycleStatus,
    messageCount,
    profileId: identity.profileId,
    profileName: displayNames.profileName,
    relatedFiles: relatedFiles.map((file) => ({
      fileRole: "thinking",
      linkName: file.metadata.linkName,
      markdownSha256: file.markdownSha256,
      path: file.path,
      thinkingIndex: file.metadata.thinkingIndex,
      title: file.metadata.title,
    })),
    sourceCreatedAt,
    sourceUpdatedAt,
    thinkingCount: relatedFiles.length,
    threadId: row.threadId,
    threadSource: row.threadSource || "user",
    title: row.title,
  });
  if (mainFile.skipped) {
    return {
      markdownBytes: mainFile.markdownBytes,
      messageCount,
      skipped: true,
      skipReason: mainFile.skipReason,
    };
  }
  return {
    ...mainFile,
    messageCount,
    parseErrors,
    relatedFiles,
  };
}

function getConversationArchiveThreadPriorityTimestamp(thread) {
  // 这一段为同一 thread 的多入口去重提取最新写入时间，缺失时回落到源会话更新时间。
  // Extract the newest write timestamp for duplicate thread entries, falling back to the source update time.
  const candidates = [thread?.updatedAt, thread?.sourceUpdatedAt, thread?.sourceCreatedAt];
  for (const candidate of candidates) {
    const timestamp = Date.parse(String(candidate || ""));
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return 0;
}

function shouldPreferConversationArchiveThreadEntry(candidate, previous) {
  // 这一段在同一设备、账号和 thread 出现多个入口时选择最可信的一条，避免迁移残留占住旧目录。
  // Pick the most reliable entry when one device/profile/thread has multiple paths, preventing stale migrated paths from winning.
  if (!previous) return true;
  const candidateTimestamp = getConversationArchiveThreadPriorityTimestamp(candidate);
  const previousTimestamp = getConversationArchiveThreadPriorityTimestamp(previous);
  if (candidateTimestamp !== previousTimestamp) return candidateTimestamp > previousTimestamp;
  if (candidate.archiveGroupType !== previous.archiveGroupType) {
    return candidate.archiveGroupType === conversationArchiveGroupTypeProject;
  }
  return String(candidate.path || "") > String(previous.path || "");
}

function withConversationArchiveGroupDisplayNames(groups) {
  // 这一段让展示名保持 Codex 原生项目名；同名项目仍由内部 group id 区分。
  // Keep display names identical to Codex's native project labels; duplicate projects remain separated by internal group ids.
  const sourceGroups = Array.isArray(groups) ? groups : [];
  return sourceGroups.map((group) => ({
    ...group,
    archiveGroupDisplayName: group.archiveGroupName,
  }));
}

function getConversationArchiveGroupMapKey(groupType, groupId) {
  // 这一段把目录类型和 ID 一起作为 Map key，避免异常远端数据把项目和普通对话合并。
  // Use both group type and id as the map key so abnormal remote data cannot merge projects with conversations.
  return `${normalizeConversationArchiveGroupType(groupType)}:${normalizeConversationArchiveGroupId(groupId, groupType)}`;
}

function buildConversationArchiveDevices(files, options = {}) {
  // 这一段把远端 path-keyed manifest 整理成设置页需要的设备、账号和会话列表。
  // Shape the remote path-keyed manifest into device, profile, and thread lists for the settings UI.
  const sourceFiles = files && typeof files === "object" && !Array.isArray(files) ? files : {};
  const localIdentity = options.identity || null;
  const hiddenThreadIds = options.hiddenThreadIds instanceof Set ? options.hiddenThreadIds : new Set();
  const devicesById = new Map();
  for (const [archivePath, file] of Object.entries(sourceFiles)) {
    if (!normalizeConversationArchivePath(archivePath) || !file || typeof file !== "object" || Array.isArray(file)) continue;
    if (file.packageKind !== conversationArchivePackageKind) continue;
    const fileRole = String(file.fileRole || "thread").trim();
    if (fileRole && fileRole !== "thread") continue;
    const pathInfo = parseConversationArchivePath(archivePath);
    if (!pathInfo) continue;
    const deviceId = getConversationArchiveLocalId(pathInfo.deviceId, "device_");
    const profileId = getConversationArchiveLocalId(pathInfo.profileId, "profile_");
    if (!deviceId || !profileId) continue;
    const threadId = normalizeConversationArchiveThreadId(pathInfo.threadId) || normalizeConversationArchiveThreadId(file.threadId);
    const threadSource = String(file.threadSource || "").trim();
    const isLocalHiddenThread = localIdentity?.deviceId === deviceId && localIdentity?.profileId === profileId && hiddenThreadIds.has(threadId);
    if ((threadSource && threadSource !== "user") || isLocalHiddenThread) continue;
    const lifecycle = getConversationArchiveThreadLifecycle(file);
    if (lifecycle.lifecycleStatus !== conversationArchiveLifecycleActive) continue;
    // 这一段也过滤远端旧 manifest 里的伪标题，确保不重新上传也能立刻隐藏旧脏数据。
    // Also filter generated titles from old remote manifests so stale dirty data is hidden without re-uploading.
    const title = normalizeConversationArchiveTitle(file.title);
    if (isConversationArchiveGeneratedTitle(title)) continue;
    const archiveGroupType = normalizeConversationArchiveGroupType(pathInfo.archiveGroupType);
    const archiveGroupId = normalizeConversationArchiveGroupId(pathInfo.archiveGroupId, archiveGroupType);
    const archiveGroupName = normalizeConversationArchiveGroupName(file.archiveGroupName, archiveGroupType);
    const archiveGroupKey = getConversationArchiveGroupMapKey(archiveGroupType, archiveGroupId);
    if (!devicesById.has(deviceId)) {
      devicesById.set(deviceId, {
        deviceId,
        deviceName: normalizeConversationArchiveDisplayText(file.deviceName, deviceId),
        profiles: new Map(),
      });
    }
    const device = devicesById.get(deviceId);
    if (!device.profiles.has(profileId)) {
      device.profiles.set(profileId, {
        groups: new Map(),
        profileId,
        profileName: normalizeConversationArchiveDisplayText(file.profileName, "Default profile"),
        threads: [],
      });
    }
    const profile = device.profiles.get(profileId);
    if (!profile.groups.has(archiveGroupKey)) {
      profile.groups.set(archiveGroupKey, {
        archiveGroupId,
        archiveGroupName,
        archiveGroupType,
        threads: [],
      });
    }
    const thread = {
      archiveGroupId,
      archiveGroupName,
      archiveGroupType,
      markdownBytes: Math.max(0, Math.floor(Number(file.markdownBytes) || 0)),
      messageCount: Math.max(0, Math.floor(Number(file.messageCount) || 0)),
      archivedAt: lifecycle.archivedAt,
      deletedDetectedAt: lifecycle.deletedDetectedAt,
      lifecycleStatus: lifecycle.lifecycleStatus,
      path: archivePath,
      sourceCreatedAt: normalizeConversationArchiveTimestamp(file.sourceCreatedAt, normalizeConversationArchiveTimestamp(file.sourceUpdatedAt)),
      sourceUpdatedAt: normalizeConversationArchiveTimestamp(file.sourceUpdatedAt),
      threadId,
      title,
      updatedAt: normalizeConversationArchiveTimestamp(file.updatedAt),
    };
    const existingThreadIndex = profile.threads.findIndex((item) => item.threadId === thread.threadId);
    if (existingThreadIndex >= 0) {
      // 这一段遇到同一会话多入口时优先保留最新入口，避免侧栏重复显示或显示旧目录。
      // Prefer the newest entry when one thread has multiple paths so the sidebar does not duplicate or show stale groups.
      const previousThread = profile.threads[existingThreadIndex];
      if (!shouldPreferConversationArchiveThreadEntry(thread, previousThread)) continue;
      profile.threads.splice(existingThreadIndex, 1);
      const previousGroup = profile.groups.get(getConversationArchiveGroupMapKey(previousThread.archiveGroupType, previousThread.archiveGroupId));
      if (previousGroup) {
        previousGroup.threads = previousGroup.threads.filter((item) => item.threadId !== previousThread.threadId);
      }
    }
    profile.threads.push(thread);
    profile.groups.get(archiveGroupKey).threads.push(thread);
  }
  return Array.from(devicesById.values())
    .map((device) => ({
      deviceId: device.deviceId,
      deviceName: device.deviceName,
      profiles: Array.from(device.profiles.values())
        .map((profile) => ({
          ...profile,
          groups: withConversationArchiveGroupDisplayNames(Array.from(profile.groups.values())
            .map((group) => ({
              ...group,
              threads: group.threads.sort((left, right) =>
                Date.parse(right.sourceUpdatedAt || right.sourceCreatedAt || "") - Date.parse(left.sourceUpdatedAt || left.sourceCreatedAt || "")),
            }))
            .filter((group) => group.threads.length > 0)
            .sort((left, right) => {
              const typeDelta = Number(left.archiveGroupType !== conversationArchiveGroupTypeProject) - Number(right.archiveGroupType !== conversationArchiveGroupTypeProject);
              return typeDelta || left.archiveGroupName.localeCompare(right.archiveGroupName);
            })),
          threads: profile.threads.sort((left, right) =>
            Date.parse(right.sourceUpdatedAt || right.sourceCreatedAt || "") - Date.parse(left.sourceUpdatedAt || left.sourceCreatedAt || "")),
        }))
        .sort((left, right) => left.profileName.localeCompare(right.profileName)),
    }))
    .sort((left, right) => left.deviceName.localeCompare(right.deviceName));
}

async function postConversationArchiveJson(endpoint, body, options = {}) {
  // 这一段由 launcher 发送会话归档 JSON，单次只上传一个会话包或读取小型索引。
  // Send conversation-archive JSON from the launcher, uploading one thread package or reading a small index per request.
  const bodyText = JSON.stringify(body);
  if (Buffer.byteLength(bodyText, "utf8") > conversationArchiveMaxBodyBytes) {
    throw new Error("会话归档请求体过大 / Conversation archive request body too large");
  }
  const timeoutMs = Math.max(1000, Math.floor(Number(options.timeoutMs) || conversationArchiveRequestTimeoutMs));
  const response = await fetch(endpoint, {
    body: bodyText,
    headers: { "content-type": "application/json" },
    method: "POST",
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    return {
      data: null,
      error: "会话归档服务返回了非 JSON 响应 / Conversation archive service returned non-JSON",
      ok: false,
      status: response.status,
    };
  }
  const isObjectPayload = payload && typeof payload === "object" && !Array.isArray(payload);
  const isValidSuccess = response.ok && isObjectPayload && payload.ok === true && payload.data && typeof payload.data === "object";
  return {
    data: isObjectPayload && payload.data && typeof payload.data === "object" ? payload.data : null,
    error: isObjectPayload ? String(payload.error || "") : "",
    ok: isValidSuccess,
    retryAfterSeconds: isObjectPayload ? Math.max(0, Math.floor(Number(payload.retryAfterSeconds) || 0)) : 0,
    status: response.status,
  };
}

function wait(ms) {
  // 这一段提供本文件内部的轻量等待能力，用于尊重服务端 429 退避时间。
  // Provide a local lightweight sleep used to honor server-provided 429 backoff windows.
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, Math.floor(Number(ms) || 0)));
  });
}

async function pullConversationArchiveManifest(endpoint, syncKey) {
  // 这一段拉取远端归档索引，失败时保留状态码给页面展示。
  // Pull the remote archive index while preserving status codes for the page UI.
  return await postConversationArchiveJson(endpoint, {
    action: "pull",
    syncKey,
  });
}

function createConversationArchiveBundlePayload(exported) {
  // 这一段把本机会话包收敛为远端协议字段，单包和批量上传共用同一份结构。
  // Shape a local thread package into the remote protocol fields shared by single and batch uploads.
  return {
    markdownBytes: exported.markdownBytes,
    markdownSha256: exported.markdownSha256,
    metadata: exported.metadata,
    packageBase64: exported.packageBase64,
    packageBytes: exported.packageBytes,
    packageFileCount: exported.packageFileCount,
    packageFormatVersion: exported.packageFormatVersion,
    packageKind: exported.packageKind,
    packageSha256: exported.packageSha256,
    packageUncompressedBytes: exported.packageUncompressedBytes,
    path: exported.path,
  };
}

function getConversationArchiveJsonBodyBytes(body) {
  // 这一段按真实 JSON 请求体估算字节数，避免按条数分批时被大包撑爆。
  // Estimate real JSON request-body bytes so size windows are not broken by large packages.
  return Buffer.byteLength(JSON.stringify(body), "utf8");
}

function getConversationArchiveBundleBatchBodyBytes(syncKey, bundles, baseRevision) {
  // 这一段估算批量上传请求大小，sync key 只在内存中参与计算，不写日志。
  // Estimate batch upload request size; the sync key is used only in memory and never logged.
  return getConversationArchiveJsonBodyBytes({
    action: "putBundleBatch",
    baseRevision,
    bundles,
    syncKey,
  });
}

function getConversationArchiveUploadBatchBodyBytes(syncKey, batchItems, baseRevision) {
  // 这一段估算当前本地批次会形成多大的远端请求体。
  // Estimate the remote request-body size produced by the current local batch.
  return getConversationArchiveBundleBatchBodyBytes(
    syncKey,
    batchItems.map((item) => createConversationArchiveBundlePayload(item.packaged)),
    baseRevision,
  );
}

function shouldFlushConversationArchiveUploadBatch(syncKey, batchItems, nextItem, baseRevision) {
  // 这一段按 MB 窗口决定是否先发送已有批次；单个大包会独立发送，不被固定条数拆坏。
  // Decide whether to flush the existing batch by MB window; one large package is sent alone instead of split by count.
  if (!batchItems.length) return false;
  if (batchItems.length >= conversationArchiveMaxBatchItems) return true;
  const nextItems = [...batchItems, nextItem];
  const nextBodyBytes = getConversationArchiveUploadBatchBodyBytes(syncKey, nextItems, baseRevision);
  if (nextBodyBytes > conversationArchiveBatchMaxBodyBytes) return true;
  return nextBodyBytes > conversationArchiveBatchTargetBodyBytes;
}

async function putConversationArchiveFile(endpoint, syncKey, exported, baseRevision) {
  // 这一段上传一个变化过的会话包，正文和思考附件只存在本次请求和云存储中。
  // Upload one changed thread package; the body and reasoning attachments exist only in this request and cloud storage.
  return await postConversationArchiveJson(endpoint, {
    action: "putBundle",
    baseRevision,
    bundle: createConversationArchiveBundlePayload(exported),
    syncKey,
  });
}

async function putConversationArchiveFileBatch(endpoint, syncKey, exportedItems, baseRevision) {
  // 这一段一次提交一个按 MB 窗口聚合的会话包批次，服务端仍按单会话保存。
  // Submit one MB-windowed batch of thread packages while the server still stores each thread separately.
  return await postConversationArchiveJson(endpoint, {
    action: "putBundleBatch",
    baseRevision,
    bundles: exportedItems.map((item) => createConversationArchiveBundlePayload(item)),
    syncKey,
  });
}

async function putConversationArchiveLifecycle(endpoint, syncKey, path, lifecycle, baseRevision) {
  // 这一段只同步会话生命周期 metadata，不上传或删除远端正文包。
  // Sync only conversation lifecycle metadata without uploading or deleting the remote body package.
  return await postConversationArchiveJson(endpoint, {
    action: "putLifecycle",
    baseRevision,
    lifecycle: {
      archivedAt: lifecycle.archivedAt || "",
      deletedDetectedAt: lifecycle.deletedDetectedAt || "",
      lifecycleStatus: normalizeConversationArchiveLifecycleStatus(lifecycle.lifecycleStatus),
    },
    path,
    syncKey,
  });
}

async function resetConversationArchiveManifest(endpoint, syncKey) {
  // 这一段请求云函数清空当前同步密钥下的归档数据，避免本机拿到或打印原始同步密钥。
  // Ask the cloud function to clear only this sync-key archive domain without exposing or logging the raw key locally.
  return await postConversationArchiveJson(endpoint, {
    action: "reset",
    syncKey,
  });
}

async function putConversationArchiveLifecycleBatch(endpoint, syncKey, items, baseRevision) {
  // 这一段一次提交多个生命周期软标记，降低首次回填时删除墓碑的云函数请求数。
  // Submit multiple lifecycle soft markers in one request to reduce function calls during first backfills.
  return await postConversationArchiveJson(endpoint, {
    action: "putLifecycleBatch",
    baseRevision,
    items: items.map((item) => ({
      lifecycle: {
        archivedAt: item.lifecycle.archivedAt || "",
        deletedDetectedAt: item.lifecycle.deletedDetectedAt || "",
        lifecycleStatus: normalizeConversationArchiveLifecycleStatus(item.lifecycle.lifecycleStatus),
      },
      path: item.path,
    })),
    syncKey,
  });
}

async function deleteConversationArchiveDeviceManifest(endpoint, syncKey, deviceId) {
  // 这一段请求云函数只清理当前同步密钥下的指定设备，不上传或读取任何会话正文。
  // Ask the cloud function to clear only one device under the current sync key without uploading or reading conversation bodies.
  return await postConversationArchiveJson(endpoint, {
    action: "deleteDevice",
    deviceId,
    syncKey,
  }, {
    timeoutMs: conversationArchiveDeleteRequestTimeoutMs,
  });
}

async function putConversationArchiveFileWithRateLimitRetry(request, exported, baseRevision) {
  // 这一段只对服务端明确返回的 429 做等待重试，避免首次批量上传被分钟级频控直接打断。
  // Retry only explicit server-side 429 responses so first-time batch uploads are paced instead of aborted.
  let response = null;
  for (let attempt = 0; attempt <= conversationArchiveMaxUploadRateLimitRetries; attempt += 1) {
    response = await putConversationArchiveFile(request.endpoint, request.syncKey, exported, baseRevision);
    if (response.status !== 429) return response;
    const retryAfterMs = Math.max(0, Math.floor(Number(response.retryAfterSeconds) || 0) * 1000);
    if (retryAfterMs > conversationArchiveMaxUploadRateLimitDelayMs) return response;
    if (attempt >= conversationArchiveMaxUploadRateLimitRetries || retryAfterMs <= 0) return response;
    await wait(retryAfterMs);
  }
  return response;
}

async function putConversationArchiveFileBatchWithRateLimitRetry(request, exportedItems, baseRevision) {
  // 这一段给批量会话包复用 429 退避；重试单位是一个 MB 窗口，而不是单条会话。
  // Reuse 429 backoff for package batches; the retry unit is one MB window instead of one thread.
  let response = null;
  for (let attempt = 0; attempt <= conversationArchiveMaxUploadRateLimitRetries; attempt += 1) {
    response = await putConversationArchiveFileBatch(request.endpoint, request.syncKey, exportedItems, baseRevision);
    if (response.status !== 429) return response;
    const retryAfterMs = Math.max(0, Math.floor(Number(response.retryAfterSeconds) || 0) * 1000);
    if (retryAfterMs > conversationArchiveMaxUploadRateLimitDelayMs) return response;
    if (attempt >= conversationArchiveMaxUploadRateLimitRetries || retryAfterMs <= 0) return response;
    await wait(retryAfterMs);
  }
  return response;
}

async function putConversationArchiveLifecycleWithRateLimitRetry(request, path, lifecycle, baseRevision) {
  // 这一段给生命周期软标记复用 429 退避，避免批量删除墓碑被频控直接打断。
  // Reuse 429 backoff for lifecycle soft markers so bulk deleted tombstones are paced instead of aborted.
  let response = null;
  for (let attempt = 0; attempt <= conversationArchiveMaxUploadRateLimitRetries; attempt += 1) {
    response = await putConversationArchiveLifecycle(request.endpoint, request.syncKey, path, lifecycle, baseRevision);
    if (response.status !== 429) return response;
    const retryAfterMs = Math.max(0, Math.floor(Number(response.retryAfterSeconds) || 0) * 1000);
    if (retryAfterMs > conversationArchiveMaxUploadRateLimitDelayMs) return response;
    if (attempt >= conversationArchiveMaxUploadRateLimitRetries || retryAfterMs <= 0) return response;
    await wait(retryAfterMs);
  }
  return response;
}

async function putConversationArchiveLifecycleBatchWithRateLimitRetry(request, items, baseRevision) {
  // 这一段给批量生命周期软标记复用 429 退避，避免批量墓碑被频控直接打断。
  // Reuse 429 backoff for lifecycle batches so tombstone batches are paced instead of aborted.
  let response = null;
  for (let attempt = 0; attempt <= conversationArchiveMaxUploadRateLimitRetries; attempt += 1) {
    response = await putConversationArchiveLifecycleBatch(request.endpoint, request.syncKey, items, baseRevision);
    if (response.status !== 429) return response;
    const retryAfterMs = Math.max(0, Math.floor(Number(response.retryAfterSeconds) || 0) * 1000);
    if (retryAfterMs > conversationArchiveMaxUploadRateLimitDelayMs) return response;
    if (attempt >= conversationArchiveMaxUploadRateLimitRetries || retryAfterMs <= 0) return response;
    await wait(retryAfterMs);
  }
  return response;
}

async function retryConversationArchiveUploadAfterConflict(request, exported, remoteFiles, currentRevision) {
  // 这一段遇到并发更新冲突时重新拉取 manifest，再用最新 revision 重试一次，避免覆盖其它设备刚写入的条目。
  // On concurrent update conflicts, pull the latest manifest and retry once with the newest revision to avoid overwriting other devices.
  const latestResponse = await pullConversationArchiveManifest(request.endpoint, request.syncKey);
  if (!latestResponse.ok) return { response: latestResponse, remoteFiles, revision: currentRevision };
  const latestFiles = latestResponse.data?.files && typeof latestResponse.data.files === "object"
    ? { ...latestResponse.data.files }
    : {};
  const latestFile = latestFiles[exported.path];
  if (latestFile?.packageKind === conversationArchivePackageKind &&
    latestFile?.packageSha256 === exported.packageSha256 &&
    latestFile?.markdownSha256 === exported.markdownSha256 &&
    isSameConversationArchiveLifecycle(latestFile, exported.metadata)) {
    return {
      response: {
        data: {
          file: latestFile,
          revision: Number(latestResponse.data?.revision) || currentRevision,
          updatedAt: latestResponse.data?.updatedAt || "",
        },
        error: "",
        ok: true,
        status: 200,
      },
      remoteFiles: latestFiles,
      revision: Number(latestResponse.data?.revision) || currentRevision,
    };
  }
  const retryRevision = Number(latestResponse.data?.revision) || 0;
  const retryResponse = await putConversationArchiveFileWithRateLimitRetry(request, exported, retryRevision);
  if (retryResponse.ok && retryResponse.data?.file) latestFiles[exported.path] = retryResponse.data.file;
  return {
    response: retryResponse,
    remoteFiles: latestFiles,
    revision: Number(retryResponse.data?.revision) || retryRevision,
  };
}

async function retryConversationArchiveLifecycleAfterConflict(request, path, lifecycle, remoteFiles, currentRevision) {
  // 这一段遇到生命周期 metadata 冲突时重新拉取 manifest，再用最新 revision 重试一次。
  // On lifecycle metadata conflicts, pull the newest manifest and retry once with the latest revision.
  const latestResponse = await pullConversationArchiveManifest(request.endpoint, request.syncKey);
  if (!latestResponse.ok) return { response: latestResponse, remoteFiles, revision: currentRevision };
  const latestFiles = latestResponse.data?.files && typeof latestResponse.data.files === "object"
    ? { ...latestResponse.data.files }
    : {};
  if (latestFiles[path] && isSameConversationArchiveLifecycle(latestFiles[path], lifecycle)) {
    return {
      response: {
        data: {
          file: latestFiles[path],
          revision: Number(latestResponse.data?.revision) || currentRevision,
          updatedAt: latestResponse.data?.updatedAt || "",
        },
        error: "",
        ok: true,
        status: 200,
      },
      remoteFiles: latestFiles,
      revision: Number(latestResponse.data?.revision) || currentRevision,
    };
  }
  const retryRevision = Number(latestResponse.data?.revision) || 0;
  const retryResponse = await putConversationArchiveLifecycleWithRateLimitRetry(request, path, lifecycle, retryRevision);
  if (retryResponse.ok && retryResponse.data?.file) latestFiles[path] = retryResponse.data.file;
  return {
    response: retryResponse,
    remoteFiles: latestFiles,
    revision: Number(retryResponse.data?.revision) || retryRevision,
  };
}

async function uploadConversationArchiveFileIfChanged(request, exported, remoteFiles, uploadRevision) {
  // 这一段上传单个会话包；包内包含主会话和全部思考附件。
  // Upload one thread package; it contains the main thread and all reasoning attachments.
  const existingRemote = remoteFiles[exported.path];
  if (existingRemote?.packageKind === conversationArchivePackageKind &&
    existingRemote?.packageSha256 === exported.packageSha256 &&
    existingRemote?.markdownSha256 === exported.markdownSha256 &&
    isSameConversationArchiveLifecycle(existingRemote, exported.metadata)) {
    return {
      remoteUnchanged: true,
      revision: uploadRevision,
      updatedAt: "",
    };
  }

  let uploadResponse = await putConversationArchiveFileWithRateLimitRetry(request, exported, uploadRevision);
  if (!uploadResponse.ok && uploadResponse.status === 409) {
    const retryResult = await retryConversationArchiveUploadAfterConflict(request, exported, remoteFiles, uploadRevision);
    uploadResponse = retryResult.response;
    uploadRevision = retryResult.revision;
    for (const [pathKey, file] of Object.entries(retryResult.remoteFiles)) {
      remoteFiles[pathKey] = file;
    }
  }
  if (!uploadResponse.ok) {
    return {
      failed: true,
      response: uploadResponse,
      revision: uploadRevision,
      updatedAt: "",
    };
  }

  // 这一段把服务端 5000 条上限淘汰视为正常跳过，避免旧会话拖垮整轮同步。
  // Treat server-side 5000-entry eviction as a normal skip so older threads do not abort the whole sync run.
  if (uploadResponse.data?.retained === false) {
    return {
      remoteLimitSkipped: true,
      revision: Number(uploadResponse.data?.revision) || uploadRevision,
      updatedAt: uploadResponse.data?.updatedAt || "",
    };
  }

  // 这一段要求云端返回可拉取列表使用的 manifest；否则不把本地索引标记为已同步。
  // Require the cloud to return a manifest usable by future list pulls before marking the local index as synced.
  if (!uploadResponse.data?.file) {
    return {
      failed: true,
      response: {
        ...uploadResponse,
        error: uploadResponse.error || "会话归档包索引写入失败 / Archive package manifest was not returned",
        ok: false,
        status: uploadResponse.status || 502,
      },
      revision: uploadRevision,
      updatedAt: "",
    };
  }
  remoteFiles[exported.path] = uploadResponse.data.file;
  return {
    revision: Number(uploadResponse.data?.revision) || uploadRevision,
    updatedAt: uploadResponse.data?.updatedAt || new Date().toISOString(),
    uploaded: true,
  };
}

function normalizeConversationArchiveBatchItemResults(response) {
  // 这一段把批量响应规整成数组，客户端只按 path、file 和状态短字段更新本地索引。
  // Normalize batch responses into an array; the client only uses path, file, and short status fields.
  return Array.isArray(response?.data?.itemResults) ? response.data.itemResults : [];
}

function applyConversationArchiveBatchRemoteFiles(remoteFiles, response) {
  // 这一段把批量响应里的轻量 manifest 合并进本轮远端快照，后续增量判断可直接复用。
  // Merge lightweight manifest entries from a batch response into the current remote snapshot for later delta checks.
  const files = response?.data?.files && typeof response.data.files === "object" ? response.data.files : {};
  for (const [pathKey, file] of Object.entries(files)) {
    if (file?.path) remoteFiles[pathKey] = file;
  }
  for (const item of normalizeConversationArchiveBatchItemResults(response)) {
    if (item?.file?.path) remoteFiles[item.file.path] = item.file;
  }
}

function getConversationArchiveUploadBatchResults(response, batchItems) {
  // 这一段把服务端 itemResults 和本地批次项对齐，保证缺失结果会被当作失败而不是误标成功。
  // Align server itemResults with local batch items so a missing result is treated as failed, not success.
  const byPath = new Map();
  for (const item of normalizeConversationArchiveBatchItemResults(response)) {
    const path = String(item?.path || item?.file?.path || "").trim();
    if (path) byPath.set(path, item);
  }
  return batchItems.map((batchItem) => {
    const item = byPath.get(batchItem.packaged.path);
    if (item) return item;
    return {
      error: response?.error || "会话归档包上传结果缺失 / Archive package upload result is missing",
      path: batchItem.packaged.path,
      status: response?.status || 502,
    };
  });
}

async function uploadConversationArchiveFileBatchIfChanged(request, batchItems, remoteFiles, uploadRevision) {
  // 这一段上传一个按 MB 聚合的会话包批次；未变化的项本地直接记为 remoteUnchanged。
  // Upload one MB-windowed package batch; locally unchanged items are marked remoteUnchanged without hitting the server.
  const itemResults = [];
  const uploadItems = [];
  for (const batchItem of batchItems) {
    const { packaged } = batchItem;
    const existingRemote = remoteFiles[packaged.path];
    if (existingRemote?.packageKind === conversationArchivePackageKind &&
      existingRemote?.packageSha256 === packaged.packageSha256 &&
      existingRemote?.markdownSha256 === packaged.markdownSha256 &&
      isSameConversationArchiveLifecycle(existingRemote, packaged.metadata)) {
      itemResults.push({
        path: packaged.path,
        remoteUnchanged: true,
        revision: uploadRevision,
        updatedAt: "",
      });
      continue;
    }
    uploadItems.push(batchItem);
  }

  if (uploadItems.length === 0) {
    return {
      itemResults,
      revision: uploadRevision,
      updatedAt: "",
    };
  }

  let uploadResponse = await putConversationArchiveFileBatchWithRateLimitRetry(
    request,
    uploadItems.map((item) => item.packaged),
    uploadRevision,
  );
  if (!uploadResponse.ok && uploadResponse.status === 409) {
    const latestResponse = await pullConversationArchiveManifest(request.endpoint, request.syncKey);
    if (!latestResponse.ok) {
      return {
        failed: true,
        itemResults,
        response: latestResponse,
        revision: uploadRevision,
        updatedAt: "",
      };
    }
    const latestFiles = latestResponse.data?.files && typeof latestResponse.data.files === "object"
      ? { ...latestResponse.data.files }
      : {};
    for (const [pathKey, file] of Object.entries(latestFiles)) remoteFiles[pathKey] = file;
    uploadRevision = Number(latestResponse.data?.revision) || 0;
    const retryItems = [];
    for (const batchItem of uploadItems) {
      const { packaged } = batchItem;
      const latestFile = latestFiles[packaged.path];
      if (latestFile?.packageKind === conversationArchivePackageKind &&
        latestFile?.packageSha256 === packaged.packageSha256 &&
        latestFile?.markdownSha256 === packaged.markdownSha256 &&
        isSameConversationArchiveLifecycle(latestFile, packaged.metadata)) {
        itemResults.push({
          path: packaged.path,
          remoteUnchanged: true,
          revision: uploadRevision,
          updatedAt: latestResponse.data?.updatedAt || "",
        });
        continue;
      }
      retryItems.push(batchItem);
    }
    if (retryItems.length === 0) {
      return {
        itemResults,
        revision: uploadRevision,
        updatedAt: latestResponse.data?.updatedAt || "",
      };
    }
    uploadResponse = await putConversationArchiveFileBatchWithRateLimitRetry(
      request,
      retryItems.map((item) => item.packaged),
      uploadRevision,
    );
    uploadItems.length = 0;
    uploadItems.push(...retryItems);
  }

  if (!uploadResponse.ok) {
    return {
      failed: true,
      itemResults,
      response: uploadResponse,
      revision: uploadRevision,
      updatedAt: "",
    };
  }

  applyConversationArchiveBatchRemoteFiles(remoteFiles, uploadResponse);
  const responseResults = getConversationArchiveUploadBatchResults(uploadResponse, uploadItems);
  let failedItem = null;
  for (const item of responseResults) {
    const revision = Number(item.revision || uploadResponse.data?.revision) || uploadRevision;
    const updatedAt = uploadResponse.data?.updatedAt || "";
    if (item.error) {
      failedItem ||= item;
      itemResults.push({
        failed: true,
        path: item.path || "",
        response: {
          data: uploadResponse.data || {},
          error: item.error,
          ok: false,
          status: item.status || uploadResponse.status || 502,
        },
        revision,
        updatedAt,
      });
      continue;
    }
    if (item.retained === false) {
      itemResults.push({
        path: item.path,
        remoteLimitSkipped: true,
        revision,
        updatedAt,
      });
      continue;
    }
    if (!item.file && !item.unchanged) {
      failedItem ||= item;
      itemResults.push({
        failed: true,
        path: item.path || "",
        response: {
          data: uploadResponse.data || {},
          error: "会话归档包索引写入失败 / Archive package manifest was not returned",
          ok: false,
          status: uploadResponse.status || 502,
        },
        revision,
        updatedAt,
      });
      continue;
    }
    itemResults.push({
      metadataUpdated: Boolean(item.metadataUpdated),
      packageUploaded: Boolean(item.uploaded),
      path: item.path || item.file?.path || "",
      revision,
      updatedAt: updatedAt || new Date().toISOString(),
      uploaded: Boolean(item.uploaded || item.metadataUpdated),
    });
  }

  return {
    failed: Boolean(failedItem || uploadResponse.data?.partialFailure),
    itemResults,
    response: failedItem ? {
      data: uploadResponse.data || {},
      error: failedItem.error || "会话归档包上传失败 / Archive package upload failed",
      ok: false,
      status: failedItem.status || uploadResponse.status || 502,
    } : uploadResponse,
    revision: Number(uploadResponse.data?.revision) || uploadRevision,
    updatedAt: uploadResponse.data?.updatedAt || "",
  };
}

async function updateConversationArchiveLifecycleIfChanged(request, path, lifecycle, remoteFiles, uploadRevision) {
  // 这一段更新归档/删除软标记；远端正文包不变，失败时把状态返回给上传流程处理。
  // Update archive/delete soft markers while leaving the remote body package untouched.
  const existingRemote = remoteFiles[path];
  if (!existingRemote || isSameConversationArchiveLifecycle(existingRemote, lifecycle)) {
    return {
      remoteUnchanged: true,
      revision: uploadRevision,
      updatedAt: "",
    };
  }

  let lifecycleResponse = await putConversationArchiveLifecycleWithRateLimitRetry(request, path, lifecycle, uploadRevision);
  if (!lifecycleResponse.ok && lifecycleResponse.status === 409) {
    const retryResult = await retryConversationArchiveLifecycleAfterConflict(request, path, lifecycle, remoteFiles, uploadRevision);
    lifecycleResponse = retryResult.response;
    uploadRevision = retryResult.revision;
    for (const [pathKey, file] of Object.entries(retryResult.remoteFiles)) {
      remoteFiles[pathKey] = file;
    }
  }
  if (!lifecycleResponse.ok) {
    return {
      failed: true,
      response: lifecycleResponse,
      revision: uploadRevision,
      updatedAt: "",
    };
  }
  if (lifecycleResponse.data?.retained === false) {
    delete remoteFiles[path];
    return {
      revision: Number(lifecycleResponse.data?.revision) || uploadRevision,
      updatedAt: lifecycleResponse.data?.updatedAt || new Date().toISOString(),
      uploaded: true,
    };
  }
  if (!lifecycleResponse.data?.file) {
    return {
      failed: true,
      response: {
        ...lifecycleResponse,
        error: lifecycleResponse.error || "会话生命周期标记未写入 / Conversation lifecycle marker was not returned",
        ok: false,
        status: lifecycleResponse.status || 502,
      },
      revision: uploadRevision,
      updatedAt: "",
    };
  }
  if (lifecycleResponse.data?.file) remoteFiles[path] = lifecycleResponse.data.file;
  return {
    revision: Number(lifecycleResponse.data?.revision) || uploadRevision,
    updatedAt: lifecycleResponse.data?.updatedAt || new Date().toISOString(),
    uploaded: true,
  };
}

async function updateConversationArchiveLifecycleBatchIfChanged(request, updates, remoteFiles, uploadRevision) {
  // 这一段批量更新归档/删除软标记；未变化或远端不存在的条目本地直接跳过。
  // Batch archive/delete soft-marker updates; unchanged or missing remote entries are skipped locally.
  const itemResults = [];
  const updateItems = [];
  for (const update of updates) {
    const existingRemote = remoteFiles[update.path];
    if (!existingRemote || isSameConversationArchiveLifecycle(existingRemote, update.lifecycle)) {
      itemResults.push({
        path: update.path,
        remoteUnchanged: true,
        revision: uploadRevision,
        updatedAt: "",
      });
      continue;
    }
    updateItems.push(update);
  }

  if (updateItems.length === 0) {
    return {
      itemResults,
      revision: uploadRevision,
      updatedAt: "",
    };
  }

  let lifecycleResponse = await putConversationArchiveLifecycleBatchWithRateLimitRetry(request, updateItems, uploadRevision);
  if (!lifecycleResponse.ok && lifecycleResponse.status === 409) {
    const latestResponse = await pullConversationArchiveManifest(request.endpoint, request.syncKey);
    if (!latestResponse.ok) {
      return {
        failed: true,
        itemResults,
        response: latestResponse,
        revision: uploadRevision,
        updatedAt: "",
      };
    }
    const latestFiles = latestResponse.data?.files && typeof latestResponse.data.files === "object"
      ? { ...latestResponse.data.files }
      : {};
    for (const [pathKey, file] of Object.entries(latestFiles)) remoteFiles[pathKey] = file;
    uploadRevision = Number(latestResponse.data?.revision) || 0;
    const retryItems = [];
    for (const update of updateItems) {
      const latestFile = latestFiles[update.path];
      if (!latestFile || isSameConversationArchiveLifecycle(latestFile, update.lifecycle)) {
        itemResults.push({
          path: update.path,
          remoteUnchanged: true,
          revision: uploadRevision,
          updatedAt: latestResponse.data?.updatedAt || "",
        });
        continue;
      }
      retryItems.push(update);
    }
    if (retryItems.length === 0) {
      return {
        itemResults,
        revision: uploadRevision,
        updatedAt: latestResponse.data?.updatedAt || "",
      };
    }
    lifecycleResponse = await putConversationArchiveLifecycleBatchWithRateLimitRetry(request, retryItems, uploadRevision);
    updateItems.length = 0;
    updateItems.push(...retryItems);
  }

  if (!lifecycleResponse.ok) {
    return {
      failed: true,
      itemResults,
      response: lifecycleResponse,
      revision: uploadRevision,
      updatedAt: "",
    };
  }

  applyConversationArchiveBatchRemoteFiles(remoteFiles, lifecycleResponse);
  const responseResults = getConversationArchiveUploadBatchResults(lifecycleResponse, updateItems.map((item) => ({
    packaged: { path: item.path },
  })));
  let failedItem = null;
  for (const item of responseResults) {
    const revision = Number(item.revision || lifecycleResponse.data?.revision) || uploadRevision;
    const updatedAt = lifecycleResponse.data?.updatedAt || "";
    if (item.error) {
      failedItem ||= item;
      itemResults.push({
        failed: true,
        path: item.path || "",
        response: {
          data: lifecycleResponse.data || {},
          error: item.error,
          ok: false,
          status: item.status || lifecycleResponse.status || 502,
        },
        revision,
        updatedAt,
      });
      continue;
    }
    if (item.retained === false) {
      delete remoteFiles[item.path];
      itemResults.push({
        path: item.path,
        remoteLimitSkipped: true,
        revision,
        updatedAt,
        uploaded: true,
      });
      continue;
    }
    if (!item.file && !item.unchanged) {
      failedItem ||= item;
      itemResults.push({
        failed: true,
        path: item.path || "",
        response: {
          data: lifecycleResponse.data || {},
          error: "会话生命周期标记未写入 / Conversation lifecycle marker was not returned",
          ok: false,
          status: lifecycleResponse.status || 502,
        },
        revision,
        updatedAt,
      });
      continue;
    }
    if (item.file?.path) remoteFiles[item.file.path] = item.file;
    itemResults.push({
      path: item.path || item.file?.path || "",
      revision,
      updatedAt: updatedAt || new Date().toISOString(),
      uploaded: Boolean(item.lifecycleUpdated),
    });
  }

  return {
    failed: Boolean(failedItem || lifecycleResponse.data?.partialFailure),
    itemResults,
    response: failedItem ? {
      data: lifecycleResponse.data || {},
      error: failedItem.error || "会话生命周期标记同步失败 / Conversation lifecycle marker sync failed",
      ok: false,
      status: failedItem.status || lifecycleResponse.status || 502,
    } : lifecycleResponse,
    revision: Number(lifecycleResponse.data?.revision) || uploadRevision,
    updatedAt: lifecycleResponse.data?.updatedAt || "",
  };
}

async function markConversationArchiveMigrationPathsDeletedIfNeeded(request, row, identity, remoteFiles, uploadRevision) {
  // 这一段在当前分组路径可用后给同 thread 的旧入口写删除软标记，避免迁移期间重复显示或落在旧目录。
  // Mark old entries for the same thread deleted after the current grouped path is available, preventing duplicates or stale groups.
  const migrationPaths = getConversationArchiveMigrationPaths(remoteFiles, identity, row);
  let revision = uploadRevision;
  let updatedAt = "";
  let uploadedCount = 0;
  for (const migrationPath of migrationPaths) {
    const migrationRemote = remoteFiles?.[migrationPath];
    const migrationLifecycle = getConversationArchiveThreadLifecycle(migrationRemote);
    const lifecycleResult = await updateConversationArchiveLifecycleIfChanged(
      request,
      migrationPath,
      {
        archivedAt: migrationLifecycle.archivedAt,
        deletedDetectedAt: new Date().toISOString(),
        lifecycleStatus: conversationArchiveLifecycleDeleted,
      },
      remoteFiles,
      revision,
    );
    revision = lifecycleResult.revision || revision;
    if (lifecycleResult.failed) {
      return {
        ...lifecycleResult,
        failedPath: migrationPath,
        uploadedCount,
      };
    }
    if (lifecycleResult.uploaded) {
      uploadedCount += 1;
      updatedAt = lifecycleResult.updatedAt || updatedAt;
    }
  }
  return {
    revision,
    updatedAt,
    uploaded: uploadedCount > 0,
    uploadedCount,
  };
}

function getConversationArchiveDisplayNames(request) {
  // 这一段确定本次上传使用的显示名；设备名默认用本机 hostname，账号名默认 Default profile。
  // Determine display names for this upload; device defaults to hostname and profile defaults to "Default profile".
  return {
    deviceName: normalizeConversationArchiveDisplayText(request.deviceName, hostname() || "This device"),
    profileName: normalizeConversationArchiveDisplayText(request.profileName, "Default profile"),
  };
}

function countConversationArchiveDeviceThreads(devices) {
  // 这一段统计过滤后真正会展示的会话数量，避免旧内部归档影响列表计数。
  // Count only threads that remain visible after filtering old internal archives.
  return Array.isArray(devices)
    ? devices.reduce((deviceTotal, device) =>
      deviceTotal + (Array.isArray(device.profiles)
        ? device.profiles.reduce((profileTotal, profile) => profileTotal + (Array.isArray(profile.threads) ? profile.threads.length : 0), 0)
        : 0), 0)
    : 0;
}

function getConversationArchiveDeletedLifecycleUpdates(index, remoteFiles, identity, currentThreadIds, options = {}) {
  // 这一段用“以前本机同步过、本轮完整扫描不存在”推断删除，只写本机设备/profile 的软墓碑。
  // Infer deletion from previously synced local index entries missing in a complete scan, writing only local device/profile tombstones.
  if (options.scanTruncated) return [];
  const threads = index?.threads && typeof index.threads === "object" && !Array.isArray(index.threads) ? index.threads : {};
  const localPathPrefix = `devices/${identity.deviceId}/profiles/${identity.profileId}/`;
  const deletedDetectedAt = new Date().toISOString();
  const updates = [];
  for (const [rawThreadId, previous] of Object.entries(threads)) {
    const threadId = normalizeConversationArchiveThreadId(rawThreadId);
    if (!threadId || currentThreadIds.has(threadId) || !previous || typeof previous !== "object" || Array.isArray(previous)) continue;
    const archivePath = normalizeConversationArchivePath(previous.path);
    if (!archivePath || !archivePath.startsWith(localPathPrefix)) continue;
    const remoteFile = remoteFiles?.[archivePath];
    if (!remoteFile || getConversationArchiveThreadLifecycle(remoteFile).lifecycleStatus === conversationArchiveLifecycleDeleted) continue;
    updates.push({
      lifecycle: {
        archivedAt: getConversationArchiveThreadLifecycle(previous).archivedAt || getConversationArchiveThreadLifecycle(remoteFile).archivedAt,
        deletedDetectedAt: normalizeConversationArchiveTimestamp(previous.deletedDetectedAt) || deletedDetectedAt,
        lifecycleStatus: conversationArchiveLifecycleDeleted,
      },
      path: archivePath,
      threadId,
    });
  }
  return updates;
}

function createConversationArchiveProgressReporter(callback) {
  // 这一段把高频上传循环压成低频进度事件，避免 CDP 事件刷屏拖慢上传。
  // Coalesce high-frequency upload loop updates into low-frequency progress events so CDP traffic stays bounded.
  if (typeof callback !== "function") return () => {};
  let lastProgressAt = 0;
  return (progress, options = {}) => {
    const now = Date.now();
    if (!options.force && now - lastProgressAt < conversationArchiveProgressIntervalMs) return;
    lastProgressAt = now;
    const nextProgress = {
      ...progress,
      progressAt: new Date().toISOString(),
    };
    Promise.resolve(callback(nextProgress)).catch(() => {});
  };
}

function getConversationArchiveUploadBytesPerSecond(uploadedBytes, uploadElapsedMs) {
  // 这一段只按已经完成的上传请求估算速度，避免扫描和导出时间稀释网络上传速度。
  // Estimate speed only from completed upload requests so scanning and export time do not dilute network throughput.
  const bytes = Math.max(0, Math.floor(Number(uploadedBytes) || 0));
  const elapsedMs = Math.max(0, Math.floor(Number(uploadElapsedMs) || 0));
  if (bytes <= 0 || elapsedMs <= 0) return 0;
  return Math.max(1, Math.floor(bytes / (elapsedMs / 1000)));
}

function buildConversationArchiveListResponse(response, options = {}) {
  // 这一段把服务端 pull 响应转换成页面可直接渲染的列表响应。
  // Convert a server pull response into a list response that the page can render directly.
  if (!response.ok) return response;
  const files = response.data?.files || {};
  const pendingDeviceDeleteIds = options.pendingDeviceDeleteIds instanceof Set ? options.pendingDeviceDeleteIds : new Set();
  const devices = buildConversationArchiveDevices(files, options)
    .filter((device) => !pendingDeviceDeleteIds.has(device.deviceId));
  return {
    ...response,
    data: {
      ...response.data,
      devices,
      deviceDeletePending: pendingDeviceDeleteIds.size > 0,
      fileCount: countConversationArchiveDeviceThreads(devices),
      localDeviceDeletePending: Boolean(options.identity?.deviceId && pendingDeviceDeleteIds.has(options.identity.deviceId)),
      localDeviceUploadBlockedAfterDelete: Boolean(options.localDeviceUploadBlockedAfterDelete),
    },
  };
}

async function runConversationArchiveListRequest(request, options = {}) {
  // 这一段只拉取远端索引，不读取或写入本机 Codex 会话数据。
  // Pull only the remote index without reading or writing local Codex conversation data.
  const identity = await getConversationArchiveIdentity();
  const syncKeyHash = getConversationArchiveSyncKeyHash(request.syncKey);
  if (options.retryPendingDeletes !== false) await retryConversationArchivePendingDeviceDeletes(request, syncKeyHash);
  const pendingDeviceDeleteIds = await listConversationArchivePendingDeviceDeleteIds(request, syncKeyHash);
  const index = await readConversationArchiveIndex(syncKeyHash, identity);
  const hiddenThreadIds = await readConversationArchiveInternalThreadIds();
  const response = buildConversationArchiveListResponse(await pullConversationArchiveManifest(request.endpoint, request.syncKey), {
    hiddenThreadIds,
    identity,
    localDeviceUploadBlockedAfterDelete: Boolean(index.localDeviceUploadBlockedAfterDeleteAt),
    pendingDeviceDeleteIds,
  });
  if (response.ok) {
    // 这一段附带本机随机设备身份，页面只用来排序和标记“本机”，不暴露账号凭据。
    // Attach the local random device identity only for local-first sorting and labeling, without exposing account credentials.
    response.data.identity = identity;
  }
  return response;
}

async function runConversationArchiveGetFileRequest(request) {
  // 这一段通过服务端临时链接下载单个会话包，并在本机解压成 Markdown 预览内容。
  // Download one thread package through a server temp URL and unpack it locally into Markdown preview content.
  const fileResponse = await postConversationArchiveJson(request.endpoint, {
    action: "getBundle",
    path: request.path,
    syncKey: request.syncKey,
  });
  if (!fileResponse.ok || !fileResponse.data?.packageUrl) return fileResponse;
  const response = await fetch(fileResponse.data.packageUrl, {
    method: "GET",
    signal: AbortSignal.timeout(conversationArchiveRequestTimeoutMs),
  });
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!response.ok || buffer.byteLength <= 0 || buffer.byteLength > conversationArchiveMaxPackageBytes) {
    throw new Error("会话归档包下载失败 / Conversation archive package download failed");
  }
  const unpacked = unpackConversationArchiveThreadPackage(buffer, fileResponse.data?.file || {});
  const markdownBytes = Buffer.byteLength(unpacked.markdown, "utf8");
  return {
    ...fileResponse,
    data: {
      ...fileResponse.data,
      markdown: unpacked.markdown,
      markdownBytes,
      packageUrl: "",
      relatedFiles: unpacked.relatedFiles,
    },
  };
}

async function runConversationArchivePrepareFileRequest(request) {
  // 这一段把远端会话包解压成本机临时目录，供 Codex 原生右侧文件预览打开。
  // Unpack one remote thread package into a local temp directory for Codex's native right-side file preview.
  const response = await runConversationArchiveGetFileRequest(request);
  if (!response.ok) return response;
  const localPath = await writeConversationArchivePreviewFile(
    request,
    response.data?.markdown || "",
    response.data?.file || {},
  );
  const relatedFiles = Array.isArray(response.data?.relatedFiles) ? response.data.relatedFiles : [];
  const previewDirectory = path.dirname(localPath);
  const previewKeepFileNames = new Set([path.basename(localPath), ...relatedFiles.map((file) => file.linkName)]);
  for (const relatedFile of relatedFiles) {
    // 这一段写入包内思考附件；包已下载完成，所以这里不再发起额外网络请求。
    // Write reasoning attachments from the package; no additional network requests are needed after the package download.
    await writeConversationArchiveRelatedPreviewFile(previewDirectory, relatedFile.linkName, relatedFile.markdown || "");
  }
  await cleanupConversationArchivePreviewDirectory(previewDirectory, previewKeepFileNames);
  return {
    ...response,
    data: {
      ...response.data,
      localPath,
      markdown: "",
    },
  };
}

async function runConversationArchivePrepareLocalFileRequest(request) {
  // 这一段按本机官方 threadId 直接导出临时 Markdown，供拖入聊天作为本地文件附件。
  // Export a local temporary Markdown by native threadId so drag-to-chat can attach it as a local file.
  const threadId = normalizeConversationArchiveThreadId(request?.threadId);
  if (!threadId) {
    return {
      data: null,
      error: "无效的会话 ID / Invalid conversation thread id",
      ok: false,
      status: 400,
    };
  }
  const identity = await getConversationArchiveIdentity();
  const displayNames = getConversationArchiveDisplayNames(request);
  const sessionTitles = await readConversationArchiveSessionTitles();
  const rawRows = await readConversationArchiveThreads(sessionTitles);
  let groupedRows = rawRows;
  try {
    groupedRows = (await applyConversationArchiveThreadGroups(rawRows, identity)).rows;
  } catch {
    // 这一段仅对本机临时引用回落到普通对话分组；正式云同步仍继续按官方项目状态失败关闭。
    // For local temporary references only, fall back to Conversations; cloud sync still fails closed on official project-state errors.
    groupedRows = rawRows.map((row) => ({
      ...row,
      archiveGroupId: conversationArchiveDefaultConversationGroupId,
      archiveGroupName: conversationArchiveDefaultConversationGroupName,
      archiveGroupType: conversationArchiveGroupTypeConversation,
    }));
  }
  const row = groupedRows.find((candidate) => candidate.threadId === threadId);
  if (!row) {
    return {
      data: null,
      error: "未找到本机会话 / Local conversation thread not found",
      ok: false,
      status: 404,
    };
  }
  let exported;
  try {
    exported = await exportConversationArchiveMarkdown(row, identity, displayNames);
  } catch {
    exported = exportConversationArchiveFallbackMarkdown(row, identity, displayNames);
  }
  if (!exported) {
    return {
      data: null,
      error: "会话没有可导出的正文 / Conversation has no exportable messages",
      ok: false,
      status: 404,
    };
  }
  if (exported.skipped) {
    return {
      data: {
        skipReason: exported.skipReason || "",
      },
      error: "会话 Markdown 超出限制 / Conversation Markdown exceeds the limit",
      ok: false,
      status: 413,
    };
  }
  const markdown = decodeConversationArchiveBase64File(exported);
  if (!markdown) {
    return {
      data: null,
      error: "会话 Markdown 生成失败 / Conversation Markdown generation failed",
      ok: false,
      status: 500,
    };
  }
  const localRequest = {
    ...request,
    path: exported.path,
  };
  const localPath = await writeConversationArchivePreviewFile(localRequest, markdown, exported.metadata || {});
  const relatedFiles = Array.isArray(exported.relatedFiles) ? exported.relatedFiles : [];
  const previewDirectory = path.dirname(localPath);
  const previewKeepFileNames = new Set([path.basename(localPath)]);
  for (const relatedFile of relatedFiles) {
    const linkName = normalizeConversationArchiveRelatedLinkName(relatedFile?.metadata?.linkName);
    const relatedMarkdown = linkName ? decodeConversationArchiveBase64File(relatedFile) : "";
    if (!linkName || !relatedMarkdown) continue;
    previewKeepFileNames.add(linkName);
    await writeConversationArchiveRelatedPreviewFile(previewDirectory, linkName, relatedMarkdown);
  }
  await cleanupConversationArchivePreviewDirectory(previewDirectory, previewKeepFileNames);
  return {
    data: {
      filePath: localPath,
      localPath,
      markdown: "",
      path: exported.path,
      threadId,
      title: row.title,
    },
    error: "",
    ok: true,
    status: 200,
  };
}

async function runConversationArchiveResetRequest(request) {
  // 这一段执行正式归档 v2 的硬重置：云端清空当前同步域，本机索引清零，下一次 push 全量重传。
  // Hard-reset the formal archive v2 domain: clear the cloud sync domain, reset local index, and let the next push re-upload all threads.
  const identity = await getConversationArchiveIdentity();
  const response = await resetConversationArchiveManifest(request.endpoint, request.syncKey);
  if (!response.ok) return response;
  const syncKeyHash = getConversationArchiveSyncKeyHash(request.syncKey);
  await writeConversationArchiveIndex(syncKeyHash, identity, {
    schemaVersion: conversationArchiveIndexVersion,
    threads: {},
  });
  return {
    ...response,
    data: {
      ...(response.data && typeof response.data === "object" ? response.data : {}),
      identity,
    },
  };
}

function isConversationArchiveTransientDeleteFailure(response) {
  // 这一段只把可重试的删除失败保持为 pending，避免 400 这类永久校验失败锁住 UI。
  // Keep only retryable delete failures pending so permanent 400-style validation errors do not lock the UI.
  const status = Math.floor(Number(response?.status) || 0);
  return status === 0 || status === 408 || status === 429 || status >= 500;
}

function createConversationArchiveDeletePendingResponse(request, identity, deletesLocalDevice) {
  // 这一段统一返回“删除仍在同步中”的结构，前端据此锁住刷新按钮并短轮询确认。
  // Return one consistent "delete still syncing" shape so the sidebar locks refresh and short-polls confirmation.
  return {
    data: {
      deletePending: true,
      deviceDeletePending: true,
      deviceId: request.deviceId,
      identity,
      localDeviceDeletePending: deletesLocalDevice,
      localDeviceUploadBlockedAfterDelete: deletesLocalDevice,
    },
    error: "",
    ok: true,
    status: 202,
  };
}

async function runConversationArchiveDeleteDeviceRequest(request) {
  // 这一段先记录删除意图，再尝试远端确认；远端慢响应时保持待办并返回同步中状态。
  // Persist the delete intent first, then try remote confirmation; slow remote responses keep the intent pending and return a syncing state.
  const identity = await getConversationArchiveIdentity();
  const syncKeyHash = getConversationArchiveSyncKeyHash(request.syncKey);
  const deletesLocalDevice = request.deviceId === identity.deviceId;
  await rememberConversationArchivePendingDeviceDelete(request, syncKeyHash);
  if (deletesLocalDevice) {
    await writeConversationArchiveIndex(syncKeyHash, identity, {
      localDeviceUploadBlockedAfterDeleteAt: new Date().toISOString(),
      schemaVersion: conversationArchiveIndexVersion,
      threads: {},
    });
  }
  let response;
  try {
    response = await deleteConversationArchiveDeviceManifest(request.endpoint, request.syncKey, request.deviceId);
  } catch {
    return createConversationArchiveDeletePendingResponse(request, identity, deletesLocalDevice);
  }
  if (!response.ok && isConversationArchiveTransientDeleteFailure(response)) {
    return createConversationArchiveDeletePendingResponse(request, identity, deletesLocalDevice);
  }
  if (!response.ok) {
    await forgetConversationArchivePendingDeviceDelete(request, syncKeyHash);
    return response;
  }
  await forgetConversationArchivePendingDeviceDelete(request, syncKeyHash);
  return {
    ...response,
    data: {
      ...(response.data && typeof response.data === "object" ? response.data : {}),
      deviceDeletePending: false,
      identity,
      localDeviceDeletePending: false,
      localDeviceUploadBlockedAfterDelete: deletesLocalDevice,
    },
  };
}

async function runConversationArchivePushRequest(request, options = {}) {
  // 这一段执行增量归档：先读小型索引，再只解析变化过的 rollout 并按会话上传单个压缩包。
  // Run incremental archive sync: read small indexes, parse only changed rollouts, and upload one compressed package per thread.
  const reportProgress = createConversationArchiveProgressReporter(options.onProgress);
  reportProgress({ stage: "init" }, { force: true });
  const identity = await getConversationArchiveIdentity();
  const syncKeyHash = getConversationArchiveSyncKeyHash(request.syncKey);
  const pendingDeviceDeleteIdsBeforeRetry = await listConversationArchivePendingDeviceDeleteIds(request, syncKeyHash);
  const hadLocalDeviceDeletePending = pendingDeviceDeleteIdsBeforeRetry.has(identity.deviceId);
  if (pendingDeviceDeleteIdsBeforeRetry.size > 0) await retryConversationArchivePendingDeviceDeletes(request, syncKeyHash);
  if (hadLocalDeviceDeletePending) {
    // 这一段把“删除未确认后的第一次同步”降级为只刷新列表，避免刚删的本机设备被同一次点击立刻重建。
    // Downgrade the first sync after an unconfirmed local-device delete to list-only so the same click cannot recreate the just-deleted device.
    const listResponse = await runConversationArchiveListRequest(request, { retryPendingDeletes: false });
    if (listResponse.ok) {
      return {
        ...listResponse,
        data: {
          ...listResponse.data,
          localDeviceUploadSkippedForPendingDelete: true,
        },
      };
    }
    return listResponse;
  }
  const index = await readConversationArchiveIndex(syncKeyHash, identity);
  if (index.localDeviceUploadBlockedAfterDeleteAt && !request.force) {
    // 这一段阻止自动同步在本机设备刚被删除后立刻重新生成该设备；显式强制同步才解除。
    // Prevent auto sync from recreating a just-deleted local device; only explicit force sync clears this block.
    const listResponse = await runConversationArchiveListRequest(request, { retryPendingDeletes: false });
    if (listResponse.ok) {
      return {
        ...listResponse,
        data: {
          ...listResponse.data,
          localDeviceUploadBlockedAfterDelete: true,
        },
      };
    }
    return listResponse;
  }
  if (index.localDeviceUploadBlockedAfterDeleteAt && request.force) {
    index.localDeviceUploadBlockedAfterDeleteAt = "";
  }
  const displayNames = getConversationArchiveDisplayNames(request);
  reportProgress({ stage: "pull" }, { force: true });
  const remoteResponse = await pullConversationArchiveManifest(request.endpoint, request.syncKey);
  if (!remoteResponse.ok) {
    reportProgress({
      error: remoteResponse.error || "远端归档索引读取失败 / Failed to pull remote archive index",
      stage: "failed",
    }, { force: true });
    return remoteResponse;
  }
  const remoteFiles = {
    ...(remoteResponse.data?.files && typeof remoteResponse.data.files === "object" ? remoteResponse.data.files : {}),
  };
  const hiddenThreadIds = await readConversationArchiveInternalThreadIds();
  const sessionTitles = await readConversationArchiveSessionTitles();
  const groupedThreads = await applyConversationArchiveThreadGroups(await readConversationArchiveThreads(sessionTitles), identity);
  const allRows = groupedThreads.rows;
  const removedProjectThreadCount = groupedThreads.removedProjectThreadCount;
  const rows = allRows.slice(0, conversationArchiveMaxRemoteEntries);
  const currentThreadIds = new Set(rows.map((row) => row.threadId).filter(Boolean));
  const archiveLimitSkippedCount = Math.max(0, allRows.length - rows.length);
  const pendingRows = [];

  let changedCount = 0;
  let deletedMarkedCount = 0;
  let noMessageCount = 0;
  let lifecycleUnchangedCount = 0;
  let remoteLimitSkippedCount = 0;
  let remoteUnchangedCount = 0;
  let scannedThreads = 0;
  let skippedCount = 0;
  let skippedGeneratedTitleCount = 0;
  let unstableCount = 0;
  let unstableForcedCount = 0;
  let skippedOversizeCount = 0;
  let uploadedCount = 0;
  let uploadedBytes = 0;
  let uploadElapsedMs = 0;
  let uploadRevision = Number(remoteResponse.data?.revision) || 0;
  let updatedAt = remoteResponse.data?.updatedAt || "";

  reportProgress({
    pendingThreadCount: 0,
    scannedThreads,
    stage: "scan",
    totalThreads: rows.length,
  }, { force: true });

  for (const row of rows) {
    scannedThreads += 1;
    let rolloutStat;
    try {
      rolloutStat = await stat(row.rolloutPath);
    } catch {
      skippedCount += 1;
      continue;
    }
    if (!rolloutStat.isFile()) continue;
    if (!request.force && !isConversationArchiveThreadStable(row)) {
      const unstableDecision = getConversationArchiveUnstableDecision(index, row, identity);
      if (!unstableDecision.allowExport) {
        unstableCount += 1;
        rememberConversationArchiveUnstableThread(index, row, rolloutStat, identity, unstableDecision.firstSeenAtMs);
        reportProgress({
          pendingThreadCount: pendingRows.length,
          scannedThreads,
          stage: "scan",
          totalThreads: rows.length,
          unstableCount,
        });
        continue;
      }
      unstableForcedCount += 1;
    }
    const exportRow = resolveConversationArchiveExportRow(row, remoteFiles, identity);
    if (exportRow.skipReason === "generated-title") {
      // 这一段把伪标题会话记入本机索引但不上传，保持同步列表接近 Codex 原生侧栏。
      // Record generated-title rows locally without uploading so the sync list stays close to Codex's native sidebar.
      if (!shouldExportConversationArchiveThread(exportRow, rolloutStat, index, remoteFiles, identity)) {
        reportProgress({
          pendingThreadCount: pendingRows.length,
          scannedThreads,
          stage: "scan",
          totalThreads: rows.length,
        });
        continue;
      }
      skippedCount += 1;
      skippedGeneratedTitleCount += 1;
      rememberConversationArchiveIndexThread(index, exportRow, rolloutStat, {
        path: getConversationArchiveThreadPath(identity, exportRow),
        skipReason: exportRow.skipReason,
      });
      reportProgress({
        pendingThreadCount: pendingRows.length,
        scannedThreads,
        skippedCount,
        stage: "scan",
        totalThreads: rows.length,
      });
      continue;
    }
    if (!shouldExportConversationArchiveThread(exportRow, rolloutStat, index, remoteFiles, identity)) {
      reportProgress({
        pendingThreadCount: pendingRows.length,
        scannedThreads,
        stage: "scan",
        totalThreads: rows.length,
      });
      continue;
    }
    pendingRows.push({ row: exportRow, rolloutStat });
    changedCount = pendingRows.length;
    reportProgress({
      changedCount,
      pendingThreadCount: pendingRows.length,
      scannedThreads,
      stage: "scan",
      totalThreads: rows.length,
    });
  }

  reportProgress({
    changedCount,
    pendingThreadCount: pendingRows.length,
    scannedThreads,
    stage: "upload",
    totalThreads: rows.length,
    uploadLimit: conversationArchiveMaxUploadsPerRun,
    uploadedBytes,
    uploadedCount,
    uploadBytesPerSecond: getConversationArchiveUploadBytesPerSecond(uploadedBytes, uploadElapsedMs),
  }, { force: true });

  let processedThreadCount = 0;
  let scheduledUploadCount = 0;
  let uploadLimitReached = false;
  let uploadBatchItems = [];

  async function flushConversationArchiveUploadBatch() {
    // 这一段发送当前 MB 窗口里的会话包，并逐条更新本地增量索引。
    // Send the current MB-windowed package batch and update the local incremental index item by item.
    if (uploadBatchItems.length === 0) return null;
    const batchItems = uploadBatchItems;
    uploadBatchItems = [];
    const currentBatchBytes = getConversationArchiveUploadBatchBodyBytes(request.syncKey, batchItems, uploadRevision);
    reportProgress({
      changedCount,
      currentBatchBytes,
      currentBatchCount: batchItems.length,
      pendingThreadCount: pendingRows.length,
      processedThreadCount,
      stage: "upload",
      totalThreads: rows.length,
      uploadLimit: conversationArchiveMaxUploadsPerRun,
      uploadedBytes,
      uploadedCount,
      uploadBytesPerSecond: getConversationArchiveUploadBytesPerSecond(uploadedBytes, uploadElapsedMs),
    }, { force: true });
    const uploadStartedAtMs = Date.now();
    const uploadResult = await uploadConversationArchiveFileBatchIfChanged(request, batchItems, remoteFiles, uploadRevision);
    uploadElapsedMs += Math.max(0, Date.now() - uploadStartedAtMs);
    uploadRevision = uploadResult.revision;
    const itemResultByPath = new Map();
    for (const item of Array.isArray(uploadResult.itemResults) ? uploadResult.itemResults : []) {
      const pathKey = String(item?.path || "").trim();
      if (pathKey) itemResultByPath.set(pathKey, item);
    }
    for (const batchItem of batchItems) {
      const itemResult = itemResultByPath.get(batchItem.packaged.path) || {
        failed: true,
        path: batchItem.packaged.path,
        response: uploadResult.response || {
          data: {},
          error: "会话归档包上传失败 / Archive package upload failed",
          ok: false,
          status: 502,
        },
        revision: uploadRevision,
        updatedAt: "",
      };
      uploadRevision = itemResult.revision || uploadRevision;
      const uploadBytesPerSecond = getConversationArchiveUploadBytesPerSecond(uploadedBytes, uploadElapsedMs);
      if (itemResult.failed) {
        const failedResponse = {
          ...(itemResult.response || uploadResult.response || {}),
          data: {
            ...((itemResult.response?.data || uploadResult.response?.data) && typeof (itemResult.response?.data || uploadResult.response?.data) === "object" ? (itemResult.response?.data || uploadResult.response?.data) : {}),
            changedCount,
            currentBatchBytes,
            currentBatchCount: batchItems.length,
            failedPath: itemResult.path || batchItem.packaged.path,
            pendingThreadCount: pendingRows.length,
            processedThreadCount,
            totalThreads: rows.length,
            uploadLimit: conversationArchiveMaxUploadsPerRun,
            uploadedBytes,
            uploadedCount,
            uploadBytesPerSecond,
          },
        };
        reportProgress({
          changedCount,
          currentBatchBytes,
          currentBatchCount: batchItems.length,
          error: failedResponse.error || "会话归档包上传失败 / Archive package upload failed",
          failedPath: failedResponse.data.failedPath,
          pendingThreadCount: pendingRows.length,
          processedThreadCount,
          stage: "failed",
          totalThreads: rows.length,
          uploadLimit: conversationArchiveMaxUploadsPerRun,
          uploadedBytes,
          uploadedCount,
          uploadBytesPerSecond,
        }, { force: true });
        return failedResponse;
      }
      if (itemResult.remoteLimitSkipped) {
        skippedCount += 1;
        remoteLimitSkippedCount += 1;
        processedThreadCount += 1;
        updatedAt = itemResult.updatedAt || updatedAt || new Date().toISOString();
        rememberConversationArchiveIndexThread(index, batchItem.exportRow, batchItem.rolloutStat, {
          ...batchItem.indexThreadValues,
          skipReason: "remote-limit",
        });
        continue;
      }
      if (itemResult.uploaded) {
        uploadedCount += 1;
        if (itemResult.packageUploaded) {
          uploadedBytes += Math.max(0, Math.floor(Number(batchItem.packaged.packageBytes) || 0));
        }
        updatedAt = itemResult.updatedAt || updatedAt || new Date().toISOString();
      } else {
        remoteUnchangedCount += 1;
      }
      processedThreadCount += 1;
      reportProgress({
        changedCount,
        currentBatchBytes,
        currentBatchCount: batchItems.length,
        pendingThreadCount: pendingRows.length,
        processedThreadCount,
        stage: "upload",
        totalThreads: rows.length,
        uploadLimit: conversationArchiveMaxUploadsPerRun,
        uploadedBytes,
        uploadedCount,
        uploadBytesPerSecond: getConversationArchiveUploadBytesPerSecond(uploadedBytes, uploadElapsedMs),
      });

      const migrationDeleteResult = await markConversationArchiveMigrationPathsDeletedIfNeeded(request, batchItem.exportRow, identity, remoteFiles, uploadRevision);
      uploadRevision = migrationDeleteResult.revision || uploadRevision;
      if (migrationDeleteResult.failed) {
        const migrationUploadBytesPerSecond = getConversationArchiveUploadBytesPerSecond(uploadedBytes, uploadElapsedMs);
        const failedResponse = {
          ...migrationDeleteResult.response,
          data: {
            ...(migrationDeleteResult.response?.data && typeof migrationDeleteResult.response.data === "object" ? migrationDeleteResult.response.data : {}),
            changedCount,
            currentBatchBytes,
            currentBatchCount: batchItems.length,
            deletedMarkedCount,
            failedPath: migrationDeleteResult.failedPath || migrationDeleteResult.response?.data?.failedPath || "",
            pendingThreadCount: pendingRows.length,
            processedThreadCount,
            totalThreads: rows.length,
            uploadLimit: conversationArchiveMaxUploadsPerRun,
            uploadedBytes,
            uploadedCount,
            uploadBytesPerSecond: migrationUploadBytesPerSecond,
          },
        };
        reportProgress({
          changedCount,
          currentBatchBytes,
          currentBatchCount: batchItems.length,
          deletedMarkedCount,
          error: failedResponse.error || "会话旧目录清理失败 / Conversation migration cleanup failed",
          failedPath: failedResponse.data.failedPath,
          pendingThreadCount: pendingRows.length,
          processedThreadCount,
          stage: "failed",
          totalThreads: rows.length,
          uploadLimit: conversationArchiveMaxUploadsPerRun,
          uploadedBytes,
          uploadedCount,
          uploadBytesPerSecond: migrationUploadBytesPerSecond,
        }, { force: true });
        return failedResponse;
      }
      if (migrationDeleteResult.uploaded) {
        deletedMarkedCount += migrationDeleteResult.uploadedCount || 1;
        updatedAt = migrationDeleteResult.updatedAt || updatedAt || new Date().toISOString();
      }

      rememberConversationArchiveIndexThread(index, batchItem.exportRow, batchItem.rolloutStat, batchItem.indexThreadValues);
    }
    return null;
  }

  for (const pendingRow of pendingRows) {
    if (scheduledUploadCount >= conversationArchiveMaxUploadsPerRun) {
      uploadLimitReached = true;
      break;
    }
    const { row: exportRow, rolloutStat } = pendingRow;
    reportProgress({
      changedCount,
      pendingThreadCount: pendingRows.length,
      processedThreadCount,
      stage: "export",
      totalThreads: rows.length,
      uploadLimit: conversationArchiveMaxUploadsPerRun,
      uploadedBytes,
      uploadedCount,
      uploadBytesPerSecond: getConversationArchiveUploadBytesPerSecond(uploadedBytes, uploadElapsedMs),
    }, { force: true });
    const exported = await exportConversationArchiveMarkdown(exportRow, identity, displayNames);
    if (!exported) {
      noMessageCount += 1;
      processedThreadCount += 1;
      rememberConversationArchiveIndexThread(index, exportRow, rolloutStat, {
        path: getConversationArchiveThreadPath(identity, exportRow),
        skipReason: "no-message",
      });
      continue;
    }
    if (exported.skipped) {
      skippedCount += 1;
      if (exported.skipReason === "oversize") skippedOversizeCount += 1;
      processedThreadCount += 1;
      rememberConversationArchiveIndexThread(index, exportRow, rolloutStat, {
        markdownBytes: exported.markdownBytes,
        messageCount: exported.messageCount,
        path: getConversationArchiveThreadPath(identity, exportRow),
        skipReason: exported.skipReason,
      });
      continue;
    }

    const packaged = createConversationArchiveThreadPackage(exported);
    if (packaged.skipped) {
      skippedCount += 1;
      if (packaged.skipReason === "oversize") skippedOversizeCount += 1;
      processedThreadCount += 1;
      rememberConversationArchiveIndexThread(index, exportRow, rolloutStat, {
        markdownBytes: packaged.markdownBytes,
        messageCount: exported.messageCount,
        path: getConversationArchiveThreadPath(identity, exportRow),
        skipReason: packaged.skipReason,
      });
      continue;
    }
    if (scheduledUploadCount + 1 > conversationArchiveMaxUploadsPerRun) {
      uploadLimitReached = true;
      break;
    }
    const indexThreadValues = {
      markdownSha256: exported.markdownSha256,
      packageSha256: packaged.packageSha256,
      path: exported.path,
      relatedFiles: (Array.isArray(exported.relatedFiles) ? exported.relatedFiles : []).map((file) => ({
        linkName: file.metadata?.linkName || "",
        markdownSha256: file.markdownSha256,
        path: file.path,
      })),
    };
    const batchItem = { exportRow, indexThreadValues, packaged, rolloutStat };
    if (shouldFlushConversationArchiveUploadBatch(request.syncKey, uploadBatchItems, batchItem, uploadRevision)) {
      const failedResponse = await flushConversationArchiveUploadBatch();
      if (failedResponse) return failedResponse;
    }
    uploadBatchItems.push(batchItem);
    scheduledUploadCount += 1;
  }
  {
    const failedResponse = await flushConversationArchiveUploadBatch();
    if (failedResponse) return failedResponse;
  }

  const allDeletedLifecycleUpdates = getConversationArchiveDeletedLifecycleUpdates(index, remoteFiles, identity, currentThreadIds, {
    scanTruncated: archiveLimitSkippedCount > 0,
  });
  const deletedLifecycleUpdates = allDeletedLifecycleUpdates.slice(0, conversationArchiveMaxUploadsPerRun);
  const deletedLifecycleLimitSkippedCount = Math.max(0, allDeletedLifecycleUpdates.length - deletedLifecycleUpdates.length);
  let lifecycleBatchItems = [];
  async function flushConversationArchiveLifecycleBatch() {
    // 这一段批量发送删除/归档软标记，并逐条写回本地 lifecycle index。
    // Send delete/archive soft markers in batches and write each result back to the local lifecycle index.
    if (lifecycleBatchItems.length === 0) return null;
    const batchItems = lifecycleBatchItems;
    lifecycleBatchItems = [];
    reportProgress({
      deletedMarkedCount,
      lifecyclePendingCount: deletedLifecycleUpdates.length,
      stage: "lifecycle",
      totalThreads: rows.length,
    });
    const lifecycleResult = await updateConversationArchiveLifecycleBatchIfChanged(request, batchItems, remoteFiles, uploadRevision);
    uploadRevision = lifecycleResult.revision;
    const resultByPath = new Map();
    for (const item of Array.isArray(lifecycleResult.itemResults) ? lifecycleResult.itemResults : []) {
      const pathKey = String(item?.path || "").trim();
      if (pathKey) resultByPath.set(pathKey, item);
    }
    for (const lifecycleUpdate of batchItems) {
      const itemResult = resultByPath.get(lifecycleUpdate.path) || {
        failed: true,
        path: lifecycleUpdate.path,
        response: lifecycleResult.response || {
          data: {},
          error: "会话生命周期标记同步失败 / Conversation lifecycle marker sync failed",
          ok: false,
          status: 502,
        },
        revision: uploadRevision,
      };
      uploadRevision = itemResult.revision || uploadRevision;
      if (itemResult.failed) {
        const failedResponse = {
          ...(itemResult.response || lifecycleResult.response || {}),
          data: {
            ...((itemResult.response?.data || lifecycleResult.response?.data) && typeof (itemResult.response?.data || lifecycleResult.response?.data) === "object" ? (itemResult.response?.data || lifecycleResult.response?.data) : {}),
            deletedMarkedCount,
            failedPath: itemResult.path || lifecycleUpdate.path,
            lifecyclePendingCount: deletedLifecycleUpdates.length,
            totalThreads: rows.length,
          },
        };
        reportProgress({
          deletedMarkedCount,
          error: failedResponse.error || "会话生命周期标记同步失败 / Conversation lifecycle marker sync failed",
          failedPath: failedResponse.data.failedPath,
          lifecyclePendingCount: deletedLifecycleUpdates.length,
          stage: "failed",
          totalThreads: rows.length,
        }, { force: true });
        return failedResponse;
      }
      if (itemResult.uploaded) {
        deletedMarkedCount += 1;
        updatedAt = itemResult.updatedAt || updatedAt || new Date().toISOString();
      } else {
        lifecycleUnchangedCount += 1;
      }
      rememberConversationArchiveIndexLifecycle(index, lifecycleUpdate.threadId, {
        archivedAt: lifecycleUpdate.lifecycle.archivedAt,
        deletedDetectedAt: lifecycleUpdate.lifecycle.deletedDetectedAt,
        lifecycleStatus: lifecycleUpdate.lifecycle.lifecycleStatus,
        path: lifecycleUpdate.path,
        skipReason: "deleted",
      });
    }
    return null;
  }
  for (const lifecycleUpdate of deletedLifecycleUpdates) {
    lifecycleBatchItems.push(lifecycleUpdate);
    if (lifecycleBatchItems.length >= conversationArchiveMaxBatchItems) {
      const failedResponse = await flushConversationArchiveLifecycleBatch();
      if (failedResponse) return failedResponse;
    }
  }
  {
    const failedResponse = await flushConversationArchiveLifecycleBatch();
    if (failedResponse) return failedResponse;
  }

  const pendingDeviceDeleteIds = await listConversationArchivePendingDeviceDeleteIds(request, syncKeyHash);
  const devices = buildConversationArchiveDevices(remoteFiles, { hiddenThreadIds, identity })
    .filter((device) => !pendingDeviceDeleteIds.has(device.deviceId));
  await writeConversationArchiveIndex(syncKeyHash, identity, index);
  reportProgress({
    changedCount,
    pendingThreadCount: pendingRows.length,
    processedThreadCount,
    remoteLimitSkippedCount,
    removedProjectThreadCount,
    stage: "done",
    totalThreads: rows.length,
    uploadLimit: conversationArchiveMaxUploadsPerRun,
    uploadLimitReached,
    uploadedBytes,
    uploadedCount,
    uploadBytesPerSecond: getConversationArchiveUploadBytesPerSecond(uploadedBytes, uploadElapsedMs),
  }, { force: true });
  return {
    data: {
      changedCount,
      devices,
      deviceDeletePending: pendingDeviceDeleteIds.size > 0,
      fileCount: countConversationArchiveDeviceThreads(devices),
      identity,
      localDeviceDeletePending: pendingDeviceDeleteIds.has(identity.deviceId),
      localDeviceUploadBlockedAfterDelete: Boolean(index.localDeviceUploadBlockedAfterDeleteAt),
      deletedMarkedCount,
      deletedLifecycleLimitSkippedCount,
      lifecycleUnchangedCount,
      noMessageCount,
      pendingThreadCount: pendingRows.length,
      processedThreadCount,
      remoteLimitSkippedCount,
      remoteUnchangedCount,
      removedProjectThreadCount,
      revision: uploadRevision,
      schemaVersion: conversationArchiveIndexVersion,
      skippedCount,
      skippedGeneratedTitleCount,
      skippedOversizeCount,
      totalThreads: rows.length,
      unstableCount,
      unstableForcedCount,
      updatedAt: updatedAt || new Date().toISOString(),
      uploadedBytes,
      uploadedCount,
      uploadBytesPerSecond: getConversationArchiveUploadBytesPerSecond(uploadedBytes, uploadElapsedMs),
      uploadedFileCount: uploadedCount,
      uploadedPackageCount: uploadedCount,
      archiveLimitSkippedCount,
      uploadLimit: conversationArchiveMaxUploadsPerRun,
      uploadLimitReached,
    },
    error: "",
    ok: true,
    status: 200,
  };
}

export async function runConversationArchiveRequest(request, options = {}) {
  // 这一段分发会话归档动作，保持页面只拿到结构化结果、单个预览或本机预览路径。
  // Dispatch conversation archive actions so the page receives only structured results, one preview, or a local preview path.
  if (request.action === "push") return await runConversationArchivePushRequest(request, options);
  if (request.action === "reset") return await runConversationArchiveResetRequest(request);
  if (request.action === "delete-device") return await runConversationArchiveDeleteDeviceRequest(request);
  if (request.action === "get-file") return await runConversationArchiveGetFileRequest(request);
  if (request.action === "prepare-file") return await runConversationArchivePrepareFileRequest(request);
  if (request.action === "prepare-local-file") return await runConversationArchivePrepareLocalFileRequest(request);
  return await runConversationArchiveListRequest(request);
}
