import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";

import {
  getCodexHomeDir,
  normalizeNativeBridgeRequestId,
} from "../common.mjs";

const logDatabaseFileName = "logs_2.sqlite";
const logBlockerTriggerName = "block_log_inserts";
const createLogBlockerTriggerSql = "CREATE TRIGGER IF NOT EXISTS block_log_inserts BEFORE INSERT ON logs BEGIN SELECT RAISE(IGNORE); END;";
const dropLogBlockerTriggerSql = "DROP TRIGGER IF EXISTS block_log_inserts;";
const expectedLogBlockerTriggerSchemaSql = "CREATE TRIGGER BLOCK_LOG_INSERTS BEFORE INSERT ON LOGS BEGIN SELECT RAISE(IGNORE); END";
const expectedLogBlockerTriggerCreateSql = "CREATE TRIGGER IF NOT EXISTS BLOCK_LOG_INSERTS BEFORE INSERT ON LOGS BEGIN SELECT RAISE(IGNORE); END";

export function parseCodexSqliteLogBlockerRequest(request) {
  // 这一段只接受短 request id、固定动作和布尔目标状态，不让页面传本机路径或 SQL。
  // Accept only a short request id, fixed action, and boolean desired state; the page cannot pass paths or SQL.
  const requestId = normalizeNativeBridgeRequestId(request?.requestId);
  const action = String(request?.action || "").trim();
  if (!requestId || (action !== "status" && action !== "apply")) return null;
  return {
    action,
    enabled: request?.enabled === true,
    requestId,
    type: "codex-sqlite-log-blocker",
  };
}

export async function runCodexSqliteLogBlockerRequest(request) {
  // 这一段保持 async 形态以对齐其它 native bridge handler，实际 SQLite schema 操作很短。
  // Keep the async shape aligned with other native bridge handlers; the SQLite schema work itself is short.
  return runCodexSqliteLogBlockerBlocking(request);
}

function runCodexSqliteLogBlockerBlocking(request) {
  // 这一段只定位 Codex 用户目录下的日志库，不接受页面输入路径。
  // Resolve only the log database under the Codex home directory and never accept a page-supplied path.
  const dbPath = path.join(getCodexHomeDir(), logDatabaseFileName);
  if (!existsSync(dbPath)) return missingDatabaseResponse(request);
  if (request.action === "status") return readStatusResponse(dbPath);
  return applyStatusResponse(dbPath, request.enabled);
}

function missingDatabaseResponse(request) {
  // 这一段在关闭目标下把缺失数据库视作已满足，开启目标下视作暂不可应用。
  // Treat a missing database as satisfied for disabling, but not applicable for enabling.
  const applied = request.action === "apply" && request.enabled !== true;
  return {
    data: {
      applied,
      enabled: false,
      state: "missingDatabase",
    },
    error: request.enabled === true ? "missingDatabase" : "",
    ok: request.enabled !== true,
    status: request.enabled === true ? 404 : 200,
  };
}

function readStatusResponse(dbPath) {
  // 这一段只用只读连接检查 schema，不会写入或创建数据库。
  // Use a read-only connection to inspect schema without writing or creating the database.
  let db = null;
  try {
    db = openDatabase(dbPath, false);
    const state = readTriggerState(db);
    if (state === "installed") return successResponse("enabled", true, false);
    if (state === "missing") return successResponse("disabled", false, false);
    return failureResponse("triggerConflict", false, "triggerConflict", 409);
  } catch (error) {
    return sqliteErrorResponse(error);
  } finally {
    closeDatabase(db);
  }
}

function applyStatusResponse(dbPath, enabled) {
  // 这一段用读写连接执行 idempotent schema 操作；失败时返回中性状态码。
  // Use a read-write connection for idempotent schema work and return neutral status codes on failure.
  let db = null;
  try {
    db = openDatabase(dbPath, true);
    if (enabled && !tableExists(db, "logs")) return failureResponse("missingLogsTable", false, "missingLogsTable", 404);
    if (enabled) {
      if (readTriggerState(db) === "conflict") return failureResponse("triggerConflict", false, "triggerConflict", 409);
      db.exec(createLogBlockerTriggerSql);
    } else {
      // 这一段只删除我们确认兼容的 trigger；同名冲突 trigger 交给用户处理。
      // Drop only the trigger shape we recognize; leave conflicting same-name triggers to the user.
      const state = readTriggerState(db);
      if (state === "conflict") return failureResponse("triggerConflict", false, "triggerConflict", 409);
      if (state === "installed") db.exec(dropLogBlockerTriggerSql);
    }
    const state = readTriggerState(db);
    if (state === "installed") return successResponse("enabled", true, enabled);
    if (state === "missing") return successResponse("disabled", false, !enabled);
    return failureResponse("triggerConflict", false, "triggerConflict", 409);
  } catch (error) {
    return sqliteErrorResponse(error);
  } finally {
    closeDatabase(db);
  }
}

function openDatabase(dbPath, writable) {
  // 这一段设置短 busy timeout，避免设置页长时间卡在数据库锁上。
  // Set a short busy timeout so the settings page does not hang on database locks.
  const db = new DatabaseSync(dbPath, { readOnly: writable !== true });
  db.exec("PRAGMA busy_timeout=750;");
  return db;
}

function closeDatabase(db) {
  // 这一段兼容旧 Node API 的 close 失败，不让清理错误掩盖真实响应。
  // Tolerate close failures from older Node APIs so cleanup does not hide the real response.
  try {
    db?.close?.();
  } catch {
    // ignored
  }
}

function tableExists(db, tableName) {
  // 这一段只查 sqlite_schema 元数据，不读取任何日志正文。
  // Query only sqlite_schema metadata and never read log row content.
  const row = db.prepare("SELECT 1 AS found FROM sqlite_schema WHERE type='table' AND name=? LIMIT 1").get(tableName);
  return row?.found === 1;
}

function readTriggerState(db) {
  // 这一段读取同名 trigger 的 SQL，用于区分缺失、兼容和冲突。
  // Read the same-name trigger SQL to distinguish missing, compatible, and conflicting states.
  const row = db.prepare("SELECT sql FROM sqlite_schema WHERE type='trigger' AND name=? LIMIT 1").get(logBlockerTriggerName);
  if (!row?.sql) return "missing";
  return isExpectedLogBlockerTriggerSql(row.sql) ? "installed" : "conflict";
}

function isExpectedLogBlockerTriggerSql(sql) {
  // 这一段只接受精确的兼容 trigger 形态，避免关闭时删除带 WHEN 或额外语句的用户 trigger。
  // Accept only the exact compatible trigger shape so disabling cannot delete user triggers with WHEN or extra statements.
  const normalized = normalizeTriggerSql(sql);
  return normalized === expectedLogBlockerTriggerSchemaSql ||
    normalized === expectedLogBlockerTriggerCreateSql;
}

function normalizeTriggerSql(sql) {
  // 这一段只折叠空白、统一大小写并去掉末尾分号，不改变 SQL 结构本身。
  // Collapse whitespace, normalize casing, and trim trailing semicolons without changing the SQL structure itself.
  return String(sql || "").split(/\s+/u).join(" ").toUpperCase().replace(/;+$/u, "");
}

function successResponse(state, enabled, applied) {
  return {
    data: {
      applied,
      enabled,
      state,
    },
    error: "",
    ok: true,
    status: 200,
  };
}

function failureResponse(state, enabled, error, status) {
  return {
    data: {
      applied: false,
      enabled,
      state,
    },
    error,
    ok: false,
    status,
  };
}

function sqliteErrorResponse(error) {
  // 这一段把 SQLite 细节收敛成页面可展示的短状态，不暴露本机路径。
  // Collapse SQLite details into short page states without exposing local paths.
  const message = String(error?.message || error || "").toLowerCase();
  if (message.includes("locked") || message.includes("busy")) {
    return failureResponse("locked", false, "locked", 423);
  }
  return failureResponse("error", false, "sqliteError", 500);
}
