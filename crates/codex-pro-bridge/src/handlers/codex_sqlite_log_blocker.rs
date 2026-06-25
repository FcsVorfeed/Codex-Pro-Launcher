use crate::handlers::cloud_sync::normalize_request_id;
use rusqlite::{Connection, OpenFlags, OptionalExtension, params};
use serde_json::{Value, json};
use std::path::PathBuf;
use std::time::Duration;

/// 这一段定义 Codex SQLite 日志库文件名。
/// Codex SQLite log database file name.
const LOG_DATABASE_FILE_NAME: &str = "logs_2.sqlite";
/// 这一段定义用于拦截日志写入的 trigger 名称。
/// Trigger name used to block log inserts.
const LOG_BLOCKER_TRIGGER_NAME: &str = "block_log_inserts";
/// 这一段定义短忙等待，避免设置页长时间卡在数据库锁上。
/// Short busy timeout so the settings page does not hang on database locks.
const LOG_BLOCKER_BUSY_TIMEOUT: Duration = Duration::from_millis(750);
/// 这一段定义创建拦截 trigger 的 SQL。
/// SQL used to create the log insert blocker trigger.
const CREATE_LOG_BLOCKER_TRIGGER_SQL: &str = "CREATE TRIGGER IF NOT EXISTS block_log_inserts BEFORE INSERT ON logs BEGIN SELECT RAISE(IGNORE); END;";
/// 这一段定义 SQLite schema 中兼容 trigger 的规范化 SQL 形态。
/// Normalized SQL shape for a compatible trigger stored in sqlite_schema.
const EXPECTED_LOG_BLOCKER_TRIGGER_SCHEMA_SQL: &str =
    "CREATE TRIGGER BLOCK_LOG_INSERTS BEFORE INSERT ON LOGS BEGIN SELECT RAISE(IGNORE); END";
/// 这一段定义源码创建语句的规范化 SQL 形态，兼容直接检查常量的测试。
/// Normalized SQL shape for the source creation statement, used by direct constant checks.
const EXPECTED_LOG_BLOCKER_TRIGGER_CREATE_SQL: &str =
    "CREATE TRIGGER IF NOT EXISTS BLOCK_LOG_INSERTS BEFORE INSERT ON LOGS BEGIN SELECT RAISE(IGNORE); END";
/// 这一段定义删除拦截 trigger 的 SQL。
/// SQL used to drop the log insert blocker trigger.
const DROP_LOG_BLOCKER_TRIGGER_SQL: &str = "DROP TRIGGER IF EXISTS block_log_inserts;";

/// 这一段描述 Codex SQLite 日志拦截请求。
/// Describes a Codex SQLite log blocker request.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CodexSqliteLogBlockerRequest {
    /// 这一段是页面请求 id。
    /// Page request id.
    pub request_id: String,
    /// 这一段是查询或应用动作。
    /// Query or apply action.
    pub action: CodexSqliteLogBlockerAction,
    /// 这一段是 apply 动作的目标开关状态。
    /// Desired enabled state for apply actions.
    pub enabled: bool,
}

/// 这一段描述 Codex SQLite 日志拦截动作。
/// Describes Codex SQLite log blocker actions.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CodexSqliteLogBlockerAction {
    /// 这一段只读取当前 trigger 状态。
    /// Read only the current trigger state.
    Status,
    /// 这一段把 trigger 调整为目标状态。
    /// Reconcile the trigger to the desired state.
    Apply,
}

/// 这一段描述已安装 trigger 的形态。
/// Describes the installed trigger shape.
#[derive(Clone, Debug, PartialEq, Eq)]
enum LogBlockerTriggerState {
    /// 这一段表示没有找到 trigger。
    /// No trigger was found.
    Missing,
    /// 这一段表示 trigger 与预期 SQL 兼容。
    /// The trigger matches the expected SQL shape.
    Installed,
    /// 这一段表示同名 trigger 不是 Codex-Pro 创建的形态。
    /// A same-name trigger exists but does not match the Codex-Pro shape.
    Conflict,
}

/// 这一段解析 Codex SQLite 日志拦截请求。
/// Parse a Codex SQLite log blocker request.
pub fn parse_codex_sqlite_log_blocker_request(
    value: &Value,
) -> Option<CodexSqliteLogBlockerRequest> {
    // 这一段只接受短 request id、固定动作和布尔目标状态，不让页面传本机路径或 SQL。
    // Accept only a short request id, fixed action, and boolean desired state; the page cannot pass paths or SQL.
    let request_id = normalize_request_id(value.get("requestId")?.as_str()?)?;
    let action = match value.get("action")?.as_str()? {
        "status" => CodexSqliteLogBlockerAction::Status,
        "apply" => CodexSqliteLogBlockerAction::Apply,
        _ => return None,
    };
    Some(CodexSqliteLogBlockerRequest {
        request_id,
        action,
        enabled: value
            .get("enabled")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    })
}

/// 这一段运行 Codex SQLite 日志拦截请求。
/// Run a Codex SQLite log blocker request.
pub async fn run_codex_sqlite_log_blocker_request(
    request: &CodexSqliteLogBlockerRequest,
) -> anyhow::Result<Value> {
    // 这一段把同步 SQLite schema 操作放到 blocking 线程，避免阻塞 bridge 异步任务。
    // Run synchronous SQLite schema work on a blocking thread so the bridge async task is not blocked.
    let request = request.clone();
    Ok(
        tokio::task::spawn_blocking(move || run_codex_sqlite_log_blocker_blocking(&request))
            .await?,
    )
}

fn run_codex_sqlite_log_blocker_blocking(request: &CodexSqliteLogBlockerRequest) -> Value {
    // 这一段只定位 Codex 用户目录下的日志库，不接受页面输入路径。
    // Resolve only the log database under the Codex home directory and never accept a page-supplied path.
    let db_path = log_database_path();
    if !db_path.is_file() {
        return missing_database_response(request);
    }

    match request.action {
        CodexSqliteLogBlockerAction::Status => read_status_response(&db_path),
        CodexSqliteLogBlockerAction::Apply => apply_status_response(&db_path, request.enabled),
    }
}

fn log_database_path() -> PathBuf {
    // 这一段沿用 Codex home 解析规则，支持 CODEX_HOME 隔离环境。
    // Reuse Codex home resolution so CODEX_HOME-isolated environments work.
    codex_pro_core::paths::codex_home_dir().join(LOG_DATABASE_FILE_NAME)
}

fn missing_database_response(request: &CodexSqliteLogBlockerRequest) -> Value {
    // 这一段在关闭目标下把缺失数据库视作已满足，开启目标下视作暂不可应用。
    // Treat a missing database as satisfied for disabling, but not applicable for enabling.
    let applied = matches!(request.action, CodexSqliteLogBlockerAction::Apply) && !request.enabled;
    json!({
        "data": {
            "applied": applied,
            "enabled": false,
            "state": "missingDatabase",
        },
        "error": if request.enabled { "missingDatabase" } else { "" },
        "ok": !request.enabled,
        "status": if request.enabled { 404 } else { 200 },
    })
}

fn read_status_response(db_path: &PathBuf) -> Value {
    // 这一段只用只读连接检查 schema，不会写入或创建数据库。
    // Use a read-only connection to inspect schema without writing or creating the database.
    let connection = match open_connection(db_path, false) {
        Ok(connection) => connection,
        Err(error) => return sqlite_error_response(error),
    };
    match read_trigger_state(&connection) {
        Ok(LogBlockerTriggerState::Installed) => success_response("enabled", true, false),
        Ok(LogBlockerTriggerState::Missing) => success_response("disabled", false, false),
        Ok(LogBlockerTriggerState::Conflict) => {
            failure_response("triggerConflict", false, "triggerConflict", 409)
        }
        Err(error) => sqlite_error_response(error),
    }
}

fn apply_status_response(db_path: &PathBuf, enabled: bool) -> Value {
    // 这一段用读写连接执行 idempotent schema 操作；失败时返回中性状态码。
    // Use a read-write connection for idempotent schema work and return neutral status codes on failure.
    let connection = match open_connection(db_path, true) {
        Ok(connection) => connection,
        Err(error) => return sqlite_error_response(error),
    };
    if enabled && !table_exists(&connection, "logs").unwrap_or(false) {
        return failure_response("missingLogsTable", false, "missingLogsTable", 404);
    }
    if enabled {
        if matches!(
            read_trigger_state(&connection),
            Ok(LogBlockerTriggerState::Conflict)
        ) {
            return failure_response("triggerConflict", false, "triggerConflict", 409);
        }
        if let Err(error) = connection.execute_batch(CREATE_LOG_BLOCKER_TRIGGER_SQL) {
            return sqlite_error_response(error);
        }
    } else {
        // 这一段只删除我们确认兼容的 trigger；同名冲突 trigger 交给用户处理。
        // Drop only the trigger shape we recognize; leave conflicting same-name triggers to the user.
        match read_trigger_state(&connection) {
            Ok(LogBlockerTriggerState::Installed) => {
                if let Err(error) = connection.execute_batch(DROP_LOG_BLOCKER_TRIGGER_SQL) {
                    return sqlite_error_response(error);
                }
            }
            Ok(LogBlockerTriggerState::Missing) => {}
            Ok(LogBlockerTriggerState::Conflict) => {
                return failure_response("triggerConflict", false, "triggerConflict", 409);
            }
            Err(error) => return sqlite_error_response(error),
        }
    }
    match read_trigger_state(&connection) {
        Ok(LogBlockerTriggerState::Installed) => success_response("enabled", true, enabled),
        Ok(LogBlockerTriggerState::Missing) => success_response("disabled", false, !enabled),
        Ok(LogBlockerTriggerState::Conflict) => {
            failure_response("triggerConflict", false, "triggerConflict", 409)
        }
        Err(error) => sqlite_error_response(error),
    }
}

fn open_connection(db_path: &PathBuf, writable: bool) -> rusqlite::Result<Connection> {
    // 这一段显式使用 NO_CREATE 语义，避免用户还没有日志库时被我们新建空库。
    // Use explicit no-create semantics so we do not create an empty log database for users.
    let flags = if writable {
        OpenFlags::SQLITE_OPEN_READ_WRITE
    } else {
        OpenFlags::SQLITE_OPEN_READ_ONLY
    };
    let connection = Connection::open_with_flags(db_path, flags)?;
    connection.busy_timeout(LOG_BLOCKER_BUSY_TIMEOUT)?;
    Ok(connection)
}

fn table_exists(connection: &Connection, table_name: &str) -> rusqlite::Result<bool> {
    // 这一段只查 sqlite_schema 元数据，不读取任何日志正文。
    // Query only sqlite_schema metadata and never read log row content.
    connection
        .query_row(
            "SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?1 LIMIT 1",
            params![table_name],
            |_| Ok(true),
        )
        .optional()
        .map(|value| value.unwrap_or(false))
}

fn read_trigger_state(connection: &Connection) -> rusqlite::Result<LogBlockerTriggerState> {
    // 这一段读取同名 trigger 的 SQL，用于区分缺失、兼容和冲突。
    // Read the same-name trigger SQL to distinguish missing, compatible, and conflicting states.
    let sql: Option<String> = connection
        .query_row(
            "SELECT sql FROM sqlite_schema WHERE type='trigger' AND name=?1 LIMIT 1",
            params![LOG_BLOCKER_TRIGGER_NAME],
            |row| row.get(0),
        )
        .optional()?;
    let Some(sql) = sql else {
        return Ok(LogBlockerTriggerState::Missing);
    };
    if is_expected_log_blocker_trigger_sql(&sql) {
        Ok(LogBlockerTriggerState::Installed)
    } else {
        Ok(LogBlockerTriggerState::Conflict)
    }
}

fn is_expected_log_blocker_trigger_sql(sql: &str) -> bool {
    // 这一段只接受精确的兼容 trigger 形态，避免关闭时删除带 WHEN 或额外语句的用户 trigger。
    // Accept only the exact compatible trigger shape so disabling cannot delete user triggers with WHEN or extra statements.
    let normalized = normalize_trigger_sql(sql);
    normalized == EXPECTED_LOG_BLOCKER_TRIGGER_SCHEMA_SQL
        || normalized == EXPECTED_LOG_BLOCKER_TRIGGER_CREATE_SQL
}

fn normalize_trigger_sql(sql: &str) -> String {
    // 这一段只折叠空白、统一大小写并去掉末尾分号，不改变 SQL 结构本身。
    // Collapse whitespace, normalize casing, and trim trailing semicolons without changing the SQL structure itself.
    let mut normalized = sql
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_ascii_uppercase();
    while normalized.ends_with(';') {
        normalized.pop();
    }
    normalized
}

fn success_response(state: &str, enabled: bool, applied: bool) -> Value {
    json!({
        "data": {
            "applied": applied,
            "enabled": enabled,
            "state": state,
        },
        "error": "",
        "ok": true,
        "status": 200,
    })
}

fn failure_response(state: &str, enabled: bool, error: &str, status: u16) -> Value {
    json!({
        "data": {
            "applied": false,
            "enabled": enabled,
            "state": state,
        },
        "error": error,
        "ok": false,
        "status": status,
    })
}

fn sqlite_error_response(error: rusqlite::Error) -> Value {
    // 这一段把 SQLite 细节收敛成页面可展示的短状态，不暴露本机路径。
    // Collapse SQLite details into short page states without exposing local paths.
    let message = error.to_string().to_ascii_lowercase();
    if message.contains("locked") || message.contains("busy") {
        return failure_response("locked", false, "locked", 423);
    }
    failure_response("error", false, "sqliteError", 500)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    #[test]
    fn trigger_signature_accepts_expected_sql() {
        assert!(is_expected_log_blocker_trigger_sql(
            CREATE_LOG_BLOCKER_TRIGGER_SQL
        ));
    }

    #[test]
    fn trigger_signature_rejects_unrelated_sql() {
        assert!(!is_expected_log_blocker_trigger_sql(
            "CREATE TRIGGER block_log_inserts AFTER INSERT ON logs BEGIN SELECT 1; END;"
        ));
    }

    #[test]
    fn trigger_signature_rejects_conditional_or_extra_sql() {
        assert!(!is_expected_log_blocker_trigger_sql(
            "CREATE TRIGGER block_log_inserts BEFORE INSERT ON logs WHEN 1 BEGIN SELECT RAISE(IGNORE); END;"
        ));
        assert!(!is_expected_log_blocker_trigger_sql(
            "CREATE TRIGGER block_log_inserts BEFORE INSERT ON logs BEGIN SELECT RAISE(IGNORE); SELECT 1; END;"
        ));
    }

    #[test]
    fn apply_creates_and_drops_trigger() {
        let temp = tempfile::NamedTempFile::new().unwrap();
        let db_path = temp.path().to_path_buf();
        let connection = Connection::open(&db_path).unwrap();
        connection
            .execute_batch("CREATE TABLE logs(id INTEGER);")
            .unwrap();
        drop(connection);

        let enabled = apply_status_response(&db_path, true);
        assert_eq!(enabled["ok"], true);
        assert_eq!(enabled["data"]["enabled"], true);

        let disabled = apply_status_response(&db_path, false);
        assert_eq!(disabled["ok"], true);
        assert_eq!(disabled["data"]["enabled"], false);
    }

    #[test]
    fn apply_enable_requires_logs_table() {
        let temp = tempfile::NamedTempFile::new().unwrap();
        let db_path = temp.path().to_path_buf();
        Connection::open(&db_path).unwrap();

        let response = apply_status_response(&db_path, true);
        assert_eq!(response["ok"], false);
        assert_eq!(response["data"]["state"], "missingLogsTable");
    }

    #[test]
    fn apply_disable_preserves_conflicting_trigger() {
        let temp = tempfile::NamedTempFile::new().unwrap();
        let db_path = temp.path().to_path_buf();
        let connection = Connection::open(&db_path).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE logs(id INTEGER);
                 CREATE TRIGGER block_log_inserts AFTER INSERT ON logs BEGIN SELECT 1; END;",
            )
            .unwrap();
        drop(connection);

        let response = apply_status_response(&db_path, false);
        assert_eq!(response["ok"], false);
        assert_eq!(response["data"]["state"], "triggerConflict");

        let connection = Connection::open(&db_path).unwrap();
        assert_eq!(
            read_trigger_state(&connection).unwrap(),
            LogBlockerTriggerState::Conflict
        );
    }
}
