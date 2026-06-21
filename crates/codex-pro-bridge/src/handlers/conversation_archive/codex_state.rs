use rusqlite::{Connection, Row, types::ValueRef};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

/// 这一段限制单轮上传数量。
/// Maximum uploads per run.
pub const MAX_UPLOADS_PER_RUN: usize = 1000;

/// 这一段描述本地 Codex 会话行。
/// Describes a local Codex thread row.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct ConversationThreadRow {
    /// 这一段是线程 id。
    /// Thread id.
    pub thread_id: String,
    /// 这一段是显示标题。
    /// Display title.
    pub title: String,
    /// 这一段是 rollout JSONL 路径。
    /// Rollout JSONL path.
    pub rollout_path: String,
    /// 这一段是创建时间。
    /// Created timestamp.
    pub created_at: String,
    /// 这一段是创建时间毫秒。
    /// Created timestamp in milliseconds.
    pub created_at_ms: i64,
    /// 这一段是更新时间。
    /// Updated timestamp.
    pub updated_at: String,
    /// 这一段是更新时间毫秒。
    /// Updated timestamp in milliseconds.
    pub updated_at_ms: i64,
    /// 这一段是归档状态。
    /// Lifecycle status.
    pub lifecycle_status: String,
    /// 这一段是归档时间。
    /// Archive timestamp.
    pub archived_at: String,
    /// 这一段是删除检测时间。
    /// Delete detection timestamp.
    pub deleted_detected_at: String,
    /// 这一段是工作区路径，仅用于本机项目匹配。
    /// Workspace path, used only for local project matching.
    pub cwd: String,
    /// 这一段是线程来源。
    /// Thread source.
    pub thread_source: String,
    /// 这一段是归档分组 ID。
    /// Archive group id.
    pub archive_group_id: String,
    /// 这一段是归档分组名称。
    /// Archive group name.
    pub archive_group_name: String,
    /// 这一段是归档分组类型。
    /// Archive group type.
    pub archive_group_type: String,
    /// 这一段是跳过原因。
    /// Skip reason.
    pub skip_reason: String,
}

/// 这一段读取本地 Codex 会话元数据。
/// Read local Codex thread metadata.
pub async fn read_threads(
    session_titles: &HashMap<String, String>,
) -> anyhow::Result<Vec<ConversationThreadRow>> {
    // 这一段 SQLite 是同步 API，放到 blocking 线程里读取。
    // rusqlite is synchronous, so read it on a blocking thread.
    let session_titles = session_titles.clone();
    tokio::task::spawn_blocking(move || read_threads_blocking(&session_titles)).await?
}

/// 这一段同步读取 threads 表。
/// Synchronously read the threads table.
fn read_threads_blocking(
    session_titles: &HashMap<String, String>,
) -> anyhow::Result<Vec<ConversationThreadRow>> {
    // 这一段按当前布局优先、旧版布局兜底查找 state_5.sqlite。
    // Prefer the current layout, then fall back to the legacy layout.
    let db_path = state_database_path().ok_or_else(|| {
        anyhow::anyhow!("未找到 Codex 本地会话数据库 / Codex local session database not found")
    })?;
    let connection =
        Connection::open_with_flags(db_path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let columns = thread_columns(&connection)?;
    let archived_select = optional_column_select(&columns, "archived", "0");
    let archived_at_select = optional_column_select(&columns, "archived_at", "''");
    let cwd_select = if columns.contains("cwd") {
        "cwd"
    } else {
        "'' AS cwd"
    };
    let thread_source_select = if columns.contains("thread_source") {
        "thread_source"
    } else {
        "'' AS thread_source"
    };
    let where_clause = thread_where(&columns, false);
    let sql = format!(
        "SELECT id, title, first_user_message, preview, rollout_path, created_at, updated_at, created_at_ms, updated_at_ms, {archived_select}, {archived_at_select}, {cwd_select}, {thread_source_select} FROM threads WHERE {where_clause} ORDER BY updated_at_ms DESC"
    );
    let mut statement = connection.prepare(&sql)?;
    let rows = statement.query_map([], |row| {
        let thread_id = normalize_thread_id(row.get::<_, String>(0).unwrap_or_default());
        let title_raw = read_optional_text(row, 1);
        let preview_raw = read_optional_text(row, 3);
        let (title, title_skip_reason) =
            resolve_thread_title(session_titles, &thread_id, &title_raw, &preview_raw);
        let created_at_raw = read_optional_text(row, 5);
        let updated_at_raw = read_optional_text(row, 6);
        let created_at_ms = read_optional_i64(row, 7);
        let updated_at_ms = read_optional_i64(row, 8);
        let archived = read_optional_i64(row, 9);
        let archived_at_raw = read_optional_text(row, 10);
        let updated_at = normalize_row_timestamp(updated_at_ms, &updated_at_raw, "");
        let created_at = normalize_row_timestamp(created_at_ms, &created_at_raw, &updated_at);
        let archived_at = if archived != 0 {
            super::state::normalize_timestamp_text(&archived_at_raw, "")
        } else {
            String::new()
        };
        let thread_source = row
            .get::<_, Option<String>>(12)
            .ok()
            .flatten()
            .unwrap_or_default();
        let display_title = title.trim().chars().take(180).collect::<String>();
        let skip_reason = if is_generated_title(&display_title) {
            "generated-title".to_string()
        } else if !title_skip_reason.is_empty() {
            title_skip_reason
        } else {
            String::new()
        };
        Ok(ConversationThreadRow {
            thread_id,
            title: display_title,
            rollout_path: read_optional_text(row, 4),
            created_at,
            created_at_ms,
            updated_at,
            updated_at_ms,
            lifecycle_status: if archived != 0 {
                "archived".to_string()
            } else {
                "active".to_string()
            },
            archived_at,
            deleted_detected_at: String::new(),
            cwd: read_optional_text(row, 11),
            thread_source,
            archive_group_id: "conversation_default".to_string(),
            archive_group_name: "对话".to_string(),
            archive_group_type: "conversation".to_string(),
            skip_reason,
        })
    })?;
    Ok(rows
        .filter_map(Result::ok)
        .filter(|row| !row.thread_id.is_empty() && !row.rollout_path.is_empty())
        .collect())
}

/// 这一段把 SQLite 任意标量读成短文本。
/// Read a SQLite scalar as short text.
fn read_optional_text(row: &Row<'_>, index: usize) -> String {
    // 这一段对齐旧 Node 的宽松读取：integer 时间列不能让整行会话被丢弃。
    // Match legacy Node's loose reads: integer timestamp columns must not drop the whole row.
    match row.get_ref(index) {
        Ok(ValueRef::Text(bytes)) => String::from_utf8_lossy(bytes).to_string(),
        Ok(ValueRef::Integer(value)) => value.to_string(),
        Ok(ValueRef::Real(value)) if value.is_finite() => {
            if value.fract() == 0.0 {
                format!("{}", value as i64)
            } else {
                format!("{value}")
            }
        }
        _ => String::new(),
    }
}

/// 这一段把 SQLite 任意数字标量读成 i64。
/// Read a SQLite numeric scalar as i64.
fn read_optional_i64(row: &Row<'_>, index: usize) -> i64 {
    // 这一段兼容 INTEGER、REAL 和文本数字，缺失或异常时回落 0。
    // Support INTEGER, REAL, and numeric text, falling back to 0 on missing or invalid values.
    match row.get_ref(index) {
        Ok(ValueRef::Integer(value)) => value,
        Ok(ValueRef::Real(value)) if value.is_finite() => value.floor() as i64,
        Ok(ValueRef::Text(bytes)) => std::str::from_utf8(bytes)
            .ok()
            .and_then(|value| value.trim().parse::<f64>().ok())
            .filter(|value| value.is_finite())
            .map(|value| value.floor() as i64)
            .unwrap_or_default(),
        _ => 0,
    }
}

/// 这一段按旧 Node 语义优先使用毫秒列，再回退原始时间文本。
/// Prefer millisecond columns, then fall back to raw timestamp text like the legacy Node path.
fn normalize_row_timestamp(timestamp_ms: i64, raw_text: &str, fallback: &str) -> String {
    // 这一段确保上传 metadata 使用远端能稳定保存的 ISO 时间。
    // Ensure uploaded metadata uses ISO timestamps that the remote service can persist stably.
    if timestamp_ms > 0 {
        return super::state::unix_ms_to_iso_text(timestamp_ms, fallback);
    }
    super::state::normalize_timestamp_text(raw_text, fallback)
}

/// 这一段描述候选 Codex SQLite 状态库。
/// Describes a candidate Codex SQLite state database.
#[derive(Debug)]
struct StateDatabaseCandidate {
    /// 这一段是数据库路径。
    /// Database path.
    path: PathBuf,
    /// 这一段是候选顺序，用于完全并列时保持稳定。
    /// Candidate order, used to keep ties stable.
    order: usize,
    /// 这一段是普通用户线程的最新更新时间。
    /// Latest normal-user thread update timestamp.
    latest_thread_ms: i64,
    /// 这一段是 SQLite 主库、WAL 或 SHM 的最新文件活跃时间。
    /// Latest activity timestamp across the SQLite main, WAL, or SHM files.
    activity_mtime_ms: i64,
}

/// 这一段定位 Codex SQLite 数据库。
/// Locate the Codex SQLite database.
fn state_database_path() -> Option<PathBuf> {
    // 这一段同时检查新旧布局，避免官方 Codex 版本切换写入位置后继续读取旧库。
    // Check both layouts so Codex version changes cannot leave us reading a stale database.
    let home = codex_pro_core::paths::codex_home_dir();
    select_active_database_path([
        home.join("sqlite").join("state_5.sqlite"),
        home.join("state_5.sqlite"),
    ])
}

/// 这一段选择当前真实活跃的 Codex 状态库。
/// Select the currently active Codex state database.
fn select_active_database_path(candidates: impl IntoIterator<Item = PathBuf>) -> Option<PathBuf> {
    // 这一段只保留存在、可读且包含 threads 表核心列的候选库。
    // Keep only candidates that exist, are readable, and expose the core threads columns.
    let candidates = candidates
        .into_iter()
        .enumerate()
        .filter_map(|(order, path)| inspect_state_database_candidate(path, order));

    // 这一段优先按库内最新普通用户会话选择；并列时再看 WAL/SHM 文件活跃时间。
    // Prefer the database with the newest normal-user thread; break ties by WAL/SHM activity.
    candidates
        .max_by(compare_state_database_candidates)
        .map(|candidate| candidate.path)
}

/// 这一段比较两个状态库候选。
/// Compare two state database candidates.
fn compare_state_database_candidates(
    left: &StateDatabaseCandidate,
    right: &StateDatabaseCandidate,
) -> std::cmp::Ordering {
    // 这一段使用明确的字段顺序，最后反转 order 让原始候选顺序在完全并列时保持稳定。
    // Use explicit field priority, reversing order last so original candidate order stays stable on full ties.
    left.latest_thread_ms
        .cmp(&right.latest_thread_ms)
        .then(left.activity_mtime_ms.cmp(&right.activity_mtime_ms))
        .then(right.order.cmp(&left.order))
}

/// 这一段读取一个状态库候选的活跃信息。
/// Read activity information for one state database candidate.
fn inspect_state_database_candidate(path: PathBuf, order: usize) -> Option<StateDatabaseCandidate> {
    // 这一段先排除不存在的普通文件，避免无意义打开 SQLite。
    // First reject missing non-file paths to avoid unnecessary SQLite opens.
    if !path.is_file() {
        return None;
    }

    // 这一段只接受能以只读方式打开且能读取 threads 元数据的数据库。
    // Accept only databases that open read-only and expose readable threads metadata.
    let connection =
        Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).ok()?;
    let columns = thread_columns(&connection).ok()?;
    if !columns.contains("id") || !columns.contains("rollout_path") {
        return None;
    }

    // 这一段读取普通用户线程的最大更新时间，作为判断官方当前写入库的第一信号。
    // Read the newest normal-user thread timestamp as the primary signal for Codex's active database.
    let latest_thread_ms = latest_thread_update_ms(&connection, &columns).unwrap_or_default();

    Some(StateDatabaseCandidate {
        path: path.clone(),
        order,
        latest_thread_ms,
        activity_mtime_ms: sqlite_activity_mtime_ms(&path),
    })
}

/// 这一段读取普通用户线程的最新更新时间。
/// Read the latest update timestamp for normal user threads.
fn latest_thread_update_ms(
    connection: &Connection,
    columns: &HashSet<String>,
) -> rusqlite::Result<i64> {
    // 这一段优先使用毫秒列；旧 schema 缺失时返回 0 并交给文件活跃时间兜底。
    // Prefer the millisecond column; old schemas without it return 0 and fall back to file activity.
    if !columns.contains("updated_at_ms") {
        return Ok(0);
    }

    // 这一段复用普通线程过滤条件，避免 subagent/内部线程把活动库判断带偏。
    // Reuse normal-thread filtering so subagent/internal rows do not skew active database selection.
    let where_clause = thread_where(columns, false);
    let sql = format!("SELECT COALESCE(MAX(updated_at_ms), 0) FROM threads WHERE {where_clause}");
    connection.query_row(&sql, [], |row| Ok(read_optional_i64(row, 0)))
}

/// 这一段读取 SQLite 主库和 sidecar 文件的最新修改时间。
/// Read the latest modified time across a SQLite main file and sidecar files.
fn sqlite_activity_mtime_ms(path: &Path) -> i64 {
    // 这一段把 WAL 纳入活跃判断，因为 Codex 正在运行时最新线程常驻留在 WAL 中。
    // Include WAL in activity checks because active Codex writes commonly live there while running.
    [
        path.to_path_buf(),
        sqlite_sidecar_path(path, "-wal"),
        sqlite_sidecar_path(path, "-shm"),
    ]
    .into_iter()
    .filter_map(|candidate| file_mtime_ms(&candidate))
    .max()
    .unwrap_or_default()
}

/// 这一段拼出 SQLite sidecar 文件路径。
/// Build a SQLite sidecar file path.
fn sqlite_sidecar_path(path: &Path, suffix: &str) -> PathBuf {
    // 这一段直接在完整路径后追加后缀，匹配 SQLite 的 `state_5.sqlite-wal` 命名。
    // Append the suffix to the full path, matching SQLite names like `state_5.sqlite-wal`.
    let mut value = path.as_os_str().to_os_string();
    value.push(suffix);
    PathBuf::from(value)
}

/// 这一段读取文件修改时间毫秒。
/// Read a file modified timestamp in milliseconds.
fn file_mtime_ms(path: &Path) -> Option<i64> {
    // 这一段把系统时间转为可排序的 Unix 毫秒，失败时忽略该文件。
    // Convert system time into sortable Unix milliseconds, ignoring files that cannot be read.
    path.metadata()
        .ok()?
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| i64::try_from(duration.as_millis()).ok())
}

/// 这一段读取 threads 表列名。
/// Read threads table column names.
fn thread_columns(connection: &Connection) -> anyhow::Result<HashSet<String>> {
    // 这一段用 PRAGMA 兼容旧 schema。
    // Use PRAGMA to support old schemas.
    let mut statement = connection.prepare("PRAGMA table_info(threads)")?;
    let rows = statement.query_map([], |row| row.get::<_, String>(1))?;
    Ok(rows.filter_map(Result::ok).collect())
}

/// 这一段构造 threads WHERE。
/// Build the threads WHERE clause.
fn thread_where(columns: &HashSet<String>, internal: bool) -> String {
    // 这一段避免导出 subagent/内部线程。
    // Avoid exporting subagent/internal threads.
    let mut clauses = vec!["rollout_path IS NOT NULL AND rollout_path != ''".to_string()];
    if internal {
        let mut internal_clauses = Vec::new();
        if columns.contains("thread_source") {
            internal_clauses.push(
                "(thread_source IS NOT NULL AND thread_source != '' AND thread_source != 'user')",
            );
        }
        if columns.contains("source") {
            internal_clauses.push("source LIKE '{\"subagent\":%'");
        }
        clauses.push(if internal_clauses.is_empty() {
            "1 = 0".to_string()
        } else {
            format!("({})", internal_clauses.join(" OR "))
        });
    } else {
        if columns.contains("thread_source") {
            clauses.push(
                "(thread_source IS NULL OR thread_source = '' OR thread_source = 'user')"
                    .to_string(),
            );
        }
        if columns.contains("source") {
            clauses.push("(source IS NULL OR source NOT LIKE '{\"subagent\":%')".to_string());
        }
    }
    clauses.join(" AND ")
}

/// 这一段读取内部线程 ID。
/// Read internal thread IDs.
pub async fn read_internal_thread_ids() -> anyhow::Result<HashSet<String>> {
    // 这一段和普通线程读取使用同一个数据库选择逻辑。
    // Use the same database selection as normal thread reads.
    tokio::task::spawn_blocking(read_internal_thread_ids_blocking).await?
}

/// 这一段同步读取内部线程 ID。
/// Synchronously read internal thread IDs.
fn read_internal_thread_ids_blocking() -> anyhow::Result<HashSet<String>> {
    // 这一段只读 ID，用于列表过滤历史内部归档。
    // Read only IDs so list rendering can hide old internal archives.
    let Some(db_path) = state_database_path() else {
        return Ok(HashSet::new());
    };
    let connection =
        Connection::open_with_flags(db_path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let columns = thread_columns(&connection)?;
    let where_clause = thread_where(&columns, true);
    let sql = format!("SELECT id FROM threads WHERE {where_clause}");
    let mut statement = connection.prepare(&sql)?;
    let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
    Ok(rows
        .filter_map(Result::ok)
        .map(normalize_thread_id)
        .filter(|thread_id| !thread_id.is_empty())
        .collect())
}

/// 这一段返回可选列 select 片段。
/// Return a select fragment for an optional column.
fn optional_column_select<'a>(
    columns: &HashSet<String>,
    column: &'a str,
    fallback: &'a str,
) -> &'a str {
    // 这一段只引用真实存在的列，兼容旧 Codex schema。
    // Reference only real columns so older Codex schemas remain readable.
    if columns.contains(column) {
        column
    } else {
        fallback
    }
}

/// 这一段归一化线程 id。
/// Normalize a thread id.
fn normalize_thread_id(value: String) -> String {
    // 这一段去除 local:/remote: 前缀。
    // Remove local:/remote: prefixes.
    value
        .trim()
        .trim_start_matches("local:")
        .trim_start_matches("remote:")
        .to_string()
}

/// 这一段按旧实现顺序解析标题。
/// Resolve titles in the legacy implementation order.
fn resolve_thread_title(
    session_titles: &HashMap<String, String>,
    thread_id: &str,
    sqlite_title: &str,
    sqlite_preview: &str,
) -> (String, String) {
    // 这一段优先使用 session_index 官方短标题，缺失时只回退 SQLite 标题字段。
    // Prefer the official session_index short title, then fall back only to SQLite title fields.
    let title = pick_valid_title(
        [
            session_titles.get(thread_id).map(String::as_str),
            Some(sqlite_title),
            Some(sqlite_preview),
        ]
        .into_iter(),
    );
    if title.is_empty() {
        (String::new(), "missing-title".to_string())
    } else {
        (title.chars().take(180).collect(), String::new())
    }
}

/// 这一段选择第一个可同步标题。
/// Pick the first title that is safe to sync.
fn pick_valid_title<'a>(candidates: impl Iterator<Item = Option<&'a str>>) -> String {
    // 这一段只接受 Codex 已保存的标题/预览字段，避免从正文截取伪标题。
    // Accept only saved Codex title/preview fields so body text is not turned into a pseudo-title.
    candidates
        .filter_map(|value| value.map(normalize_title))
        .find(|value| {
            !value.trim().is_empty() && value != "Untitled session" && !is_generated_title(value)
        })
        .unwrap_or_default()
}

/// 这一段清理短标题文本。
/// Clean short title text.
pub fn normalize_title(value: &str) -> String {
    // 这一段对齐旧 Node 标题清理：移除控制字符、折叠空白并限制长度。
    // Match the legacy Node title cleanup: remove controls, collapse whitespace, and bound length.
    let title = value
        .chars()
        .map(|ch| {
            if ch.is_control() && ch != '\n' && ch != '\r' && ch != '\t' {
                ' '
            } else {
                ch
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(180)
        .collect::<String>()
        .trim()
        .to_string();
    if title.is_empty() {
        "Untitled session".to_string()
    } else {
        title
    }
}

/// 这一段判断远端标题是否等于本机解析出的标题。
/// Return whether the remote title matches the locally resolved title.
pub fn is_same_title(remote_title: &str, row_title: &str) -> bool {
    // 这一段使用同一套标题清理，避免仅因空白或控制字符差异重复上传。
    // Use the same cleanup so whitespace or control characters alone do not force reupload.
    normalize_title(remote_title) == normalize_title(row_title)
}

/// 这一段识别 Codex 生成或内部历史标题。
/// Detect generated or internal-history titles.
pub fn is_generated_title(value: &str) -> bool {
    // 这一段对齐旧 Node 过滤，避免同步侧栏显示代理历史或 transcript 伪标题。
    // Match the legacy Node filter so agent-history or transcript pseudo titles stay hidden.
    let title = value.trim();
    title.starts_with("The following is the Codex agent history")
        || title.starts_with("The following is a transcript")
        || title.contains(">>> TRANSCRIPT")
        || title.contains("APPROVAL REQUEST")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 这一段确认普通线程查询排除内部来源。
    /// Confirm the normal thread query excludes internal sources.
    #[test]
    fn normal_thread_where_excludes_internal_sources() {
        let columns = HashSet::from(["thread_source".to_string(), "source".to_string()]);
        let clause = thread_where(&columns, false);

        assert!(clause.contains("thread_source IS NULL"));
        assert!(clause.contains("source NOT LIKE"));
        assert!(!clause.contains("thread_source != 'user'"));
    }

    /// 这一段确认内部线程查询不会匹配全部 rollout。
    /// Confirm the internal thread query does not match every rollout row.
    #[test]
    fn internal_thread_where_selects_only_internal_sources() {
        let columns = HashSet::from(["thread_source".to_string(), "source".to_string()]);
        let clause = thread_where(&columns, true);

        assert!(clause.contains("thread_source != 'user'"));
        assert!(clause.contains("source LIKE"));
        assert!(!clause.contains("thread_source IS NULL"));
    }

    /// 这一段确认旧库缺少来源列时内部查询返回空集。
    /// Confirm older schemas without source columns return no internal rows.
    #[test]
    fn internal_thread_where_without_source_columns_matches_nothing() {
        let columns = HashSet::new();
        let clause = thread_where(&columns, true);

        assert!(clause.contains("1 = 0"));
    }

    /// 这一段确认会选择包含最新普通用户线程的状态库。
    /// Confirm the state database with the newest normal user thread is selected.
    #[test]
    fn state_database_selection_prefers_newest_user_thread_database() {
        let temp = tempfile::tempdir().unwrap();
        let current_dir = temp.path().join("sqlite");
        std::fs::create_dir_all(&current_dir).unwrap();
        let current = current_dir.join("state_5.sqlite");
        let legacy = temp.path().join("state_5.sqlite");
        create_state_database(&current, "thread_old", 1_781_607_538_452, "user");
        create_state_database(&legacy, "thread_new", 1_781_698_266_658, "user");

        assert_eq!(
            select_active_database_path([current, legacy.clone()]),
            Some(legacy)
        );
    }

    /// 这一段确认内部线程不会影响活跃库选择。
    /// Confirm internal threads do not affect active database selection.
    #[test]
    fn state_database_selection_ignores_internal_thread_activity() {
        let temp = tempfile::tempdir().unwrap();
        let current = temp.path().join("current.sqlite");
        let legacy = temp.path().join("legacy.sqlite");
        create_state_database(&current, "thread_user", 1_781_607_538_452, "user");
        create_state_database(&legacy, "thread_subagent", 1_781_698_266_658, "subagent");

        assert_eq!(
            select_active_database_path([current.clone(), legacy]),
            Some(current)
        );
    }

    /// 这一段确认缺少官方标题时回退 SQLite 标题。
    /// Confirm missing official titles fall back to SQLite titles.
    #[test]
    fn missing_session_title_uses_sqlite_title_fallback() {
        let titles = HashMap::new();

        assert_eq!(
            resolve_thread_title(&titles, "thread_123", "数据库标题", "预览标题"),
            ("数据库标题".to_string(), String::new())
        );
    }

    /// 这一段确认 SQLite 预览只在标题缺失时兜底。
    /// Confirm SQLite preview is used only when the title is missing.
    #[test]
    fn missing_session_and_sqlite_title_uses_preview_fallback() {
        let titles = HashMap::new();

        assert_eq!(
            resolve_thread_title(&titles, "thread_123", "", "预览标题"),
            ("预览标题".to_string(), String::new())
        );
    }

    /// 这一段确认官方标题会被直接使用。
    /// Confirm official session titles are used directly.
    #[test]
    fn session_title_is_used_without_sqlite_fallback() {
        let titles = HashMap::from([("thread_123".to_string(), "官方短标题".to_string())]);

        assert_eq!(
            resolve_thread_title(&titles, "thread_123", "数据库标题", "预览标题"),
            ("官方短标题".to_string(), String::new())
        );
    }

    /// 这一段确认官方内部标题会被跳过。
    /// Confirm internal official titles are skipped.
    #[test]
    fn generated_session_title_is_marked_for_skip() {
        let titles = HashMap::from([(
            "thread_123".to_string(),
            "The following is a transcript".to_string(),
        )]);

        assert_eq!(
            resolve_thread_title(&titles, "thread_123", "", ""),
            (String::new(), "missing-title".to_string())
        );
    }

    /// 这一段确认没有任何可用标题时仍然跳过。
    /// Confirm threads are still skipped when no title source is usable.
    #[test]
    fn missing_all_title_sources_is_marked_for_skip() {
        let titles = HashMap::new();

        assert_eq!(
            resolve_thread_title(&titles, "thread_123", "", ""),
            (String::new(), "missing-title".to_string())
        );
    }

    /// 这一段确认远端标题比较会折叠空白但保留真实标题差异。
    /// Confirm remote title comparison collapses whitespace while preserving real title differences.
    #[test]
    fn title_comparison_normalizes_whitespace_only() {
        assert!(is_same_title("修复   exe\n注入失效", "修复 exe 注入失效"));
        assert!(!is_same_title(
            "为什么我双击 exe 没办法注入",
            "修复 exe 注入失效"
        ));
    }

    /// 这一段确认 integer 时间列可以按文本读取。
    /// Confirm integer timestamp columns can be read as text.
    #[test]
    fn sqlite_integer_timestamp_reads_as_text() {
        let connection = Connection::open_in_memory().unwrap();
        let value = connection
            .query_row("SELECT 1781489405328", [], |row| {
                Ok(read_optional_text(row, 0))
            })
            .unwrap();

        assert_eq!(value, "1781489405328");
    }

    /// 这一段确认文本数字可以按毫秒读取。
    /// Confirm numeric text can be read as milliseconds.
    #[test]
    fn sqlite_numeric_text_reads_as_i64() {
        let connection = Connection::open_in_memory().unwrap();
        let value = connection
            .query_row("SELECT '1781489405328'", [], |row| {
                Ok(read_optional_i64(row, 0))
            })
            .unwrap();

        assert_eq!(value, 1_781_489_405_328);
    }

    /// 这一段确认会话行时间优先按毫秒列归一化成 ISO。
    /// Confirm thread-row timestamps prefer millisecond columns and normalize to ISO.
    #[test]
    fn row_timestamp_prefers_millisecond_column() {
        assert_eq!(
            normalize_row_timestamp(1_700_000_000_000, "1", ""),
            "2023-11-14T22:13:20.000Z"
        );
    }

    /// 这一段创建测试用 Codex 状态库。
    /// Create a Codex state database for tests.
    fn create_state_database(
        path: &Path,
        thread_id: &str,
        updated_at_ms: i64,
        thread_source: &str,
    ) {
        // 这一段写入最小 threads schema，覆盖活跃库选择需要的列。
        // Write the minimal threads schema needed by active database selection.
        let connection = Connection::open(path).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE threads (
                    id TEXT NOT NULL,
                    rollout_path TEXT NOT NULL,
                    updated_at_ms INTEGER NOT NULL,
                    thread_source TEXT,
                    source TEXT
                );",
            )
            .unwrap();

        // 这一段写入单条线程，source 保持普通 user 值，避免 subagent JSON 过滤误判。
        // Insert one thread, keeping source as a normal user value unless the thread_source excludes it.
        connection
            .execute(
                "INSERT INTO threads (id, rollout_path, updated_at_ms, thread_source, source)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                rusqlite::params![
                    thread_id,
                    "rollout.jsonl",
                    updated_at_ms,
                    thread_source,
                    "user"
                ],
            )
            .unwrap();
    }
}
