use super::codex_state::{self, ConversationThreadRow};
use super::identity::ArchiveIdentity;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

/// 这一段定义本地增量索引版本。
/// Local incremental index version.
pub const INDEX_VERSION: u64 = 3;
/// 这一段定义 Markdown 导出格式版本。
/// Markdown export format version.
pub const MARKDOWN_FORMAT_VERSION: u64 = 15;
/// 这一段定义活跃会话稳定窗口。
/// Active-thread stability window.
pub const STABLE_DELAY_MS: i64 = 90_000;
/// 这一段定义活跃会话最长等待。
/// Active-thread maximum wait.
pub const MAX_UNSTABLE_DELAY_MS: i64 = 5 * 60_000;

/// 这一段描述本地增量索引。
/// Describes the local incremental index.
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
pub struct ArchiveIndex {
    /// 这一段是索引版本。
    /// Index version.
    pub version: u64,
    /// 这一段按 thread id 保存导出状态。
    /// Export state keyed by thread id.
    pub threads: HashMap<String, ArchiveIndexThread>,
    /// 这一段记录本机设备删除后的上传阻断时间。
    /// Upload-block timestamp after local device deletion.
    #[serde(rename = "localDeviceUploadBlockedAfterDeleteAt")]
    pub local_device_upload_blocked_after_delete_at: String,
    /// 这一段记录旧明文同步域清理完成时间。
    /// Legacy plaintext sync-domain cleanup timestamp.
    #[serde(rename = "legacyPlaintextCleanedAt")]
    pub legacy_plaintext_cleaned_at: String,
}

/// 这一段描述单会话增量状态。
/// Describes one thread's incremental state.
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
pub struct ArchiveIndexThread {
    /// 这一段是归档路径。
    /// Archive path.
    pub path: String,
    /// 这一段是包 SHA-256。
    /// Package SHA-256.
    #[serde(rename = "packageSha256")]
    pub package_sha256: String,
    /// 这一段是 Markdown SHA-256。
    /// Markdown SHA-256.
    #[serde(rename = "markdownSha256")]
    pub markdown_sha256: String,
    /// 这一段是 Markdown 格式版本。
    /// Markdown format version.
    #[serde(rename = "markdownFormatVersion")]
    pub markdown_format_version: u64,
    /// 这一段是 rollout 文件大小。
    /// Rollout file size.
    #[serde(rename = "rolloutSize")]
    pub rollout_size: u64,
    /// 这一段是 rollout 修改时间。
    /// Rollout modified time.
    #[serde(rename = "rolloutMtimeMs")]
    pub rollout_mtime_ms: i64,
    /// 这一段是 SQLite 更新时间。
    /// SQLite update time.
    #[serde(rename = "updatedAtMs")]
    pub updated_at_ms: i64,
    /// 这一段是归档时间。
    /// Archive timestamp.
    #[serde(rename = "archivedAt")]
    pub archived_at: String,
    /// 这一段是删除检测时间。
    /// Delete detection timestamp.
    #[serde(rename = "deletedDetectedAt")]
    pub deleted_detected_at: String,
    /// 这一段是生命周期。
    /// Lifecycle status.
    #[serde(rename = "lifecycleStatus")]
    pub lifecycle_status: String,
    /// 这一段是跳过原因。
    /// Skip reason.
    #[serde(rename = "skipReason")]
    pub skip_reason: String,
    /// 这一段是不稳定会话首次观察时间。
    /// First observed time for an unstable thread.
    #[serde(rename = "unstableFirstSeenAtMs")]
    pub unstable_first_seen_at_ms: i64,
    /// 这一段是不稳定会话路径。
    /// Unstable thread path.
    #[serde(rename = "unstablePath")]
    pub unstable_path: String,
}

/// 这一段描述 rollout 文件状态。
/// Describes rollout file state.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RolloutStat {
    /// 这一段是文件大小。
    /// File size.
    pub size: u64,
    /// 这一段是修改时间毫秒。
    /// Modified time in milliseconds.
    pub mtime_ms: i64,
}

/// 这一段读取本地增量索引。
/// Read the local incremental index.
pub async fn read_index(
    sync_key: &str,
    identity: &ArchiveIdentity,
) -> anyhow::Result<ArchiveIndex> {
    // 这一段缺失或损坏时返回空索引，让下一轮全量重建。
    // Return an empty index when missing or damaged so the next run rebuilds.
    let path = index_path(sync_key, identity);
    if let Some(file_name) = path.file_name() {
        for legacy_dir in super::identity::legacy_state_dirs() {
            super::identity::seed_state_file_from_legacy(&legacy_dir.join(file_name), &path).await;
        }
    }
    let bytes = match tokio::fs::read(path).await {
        Ok(bytes) => bytes,
        Err(_) => {
            return Ok(ArchiveIndex {
                version: INDEX_VERSION,
                ..ArchiveIndex::default()
            });
        }
    };
    let mut index = serde_json::from_slice::<ArchiveIndex>(&bytes).unwrap_or_default();
    if index.version != INDEX_VERSION {
        index.version = INDEX_VERSION;
    }
    Ok(index)
}

/// 这一段写入本地增量索引。
/// Write the local incremental index.
pub async fn write_index(
    sync_key: &str,
    identity: &ArchiveIdentity,
    index: &ArchiveIndex,
) -> anyhow::Result<()> {
    // 这一段只写同步密钥 hash，不把原始密钥落盘。
    // Write only a sync-key hash and never persist the raw sync key.
    let path = index_path(sync_key, identity);
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    tokio::fs::write(path, serde_json::to_vec_pretty(index)?).await?;
    Ok(())
}

/// 这一段读取 rollout 文件状态。
/// Read rollout file state.
pub fn read_rollout_stat(row: &ConversationThreadRow) -> RolloutStat {
    // 这一段读取失败时返回空状态，让导出路径自行 fallback。
    // Return an empty state on failure and let the export path fall back.
    let Ok(metadata) = std::fs::metadata(&row.rollout_path) else {
        return RolloutStat::default();
    };
    RolloutStat {
        size: metadata.len(),
        mtime_ms: metadata
            .modified()
            .ok()
            .and_then(system_time_to_unix_ms)
            .unwrap_or_default(),
    }
}

/// 这一段判断活跃会话是否已经稳定。
/// Return whether an active thread is stable.
pub fn is_thread_stable(row: &ConversationThreadRow, now_ms: i64) -> bool {
    // 这一段给刚更新的会话留稳定窗口，避免反复导出正在进行的对话。
    // Give recently updated threads a stability window to avoid repeatedly exporting active conversations.
    now_ms.saturating_sub(row.updated_at_ms) >= STABLE_DELAY_MS
}

/// 这一段判断不稳定会话是否达到最长等待。
/// Decide whether an unstable thread reached the maximum wait.
pub fn unstable_decision(
    index: &ArchiveIndex,
    row: &ConversationThreadRow,
    path: &str,
    now_ms: i64,
) -> (bool, i64) {
    // 这一段沿用旧 Node 语义：同一路径持续活跃超过 5 分钟后允许导出。
    // Match the legacy Node semantics: allow export after the same path stays active for five minutes.
    let previous = index.threads.get(&row.thread_id);
    let first_seen = previous
        .filter(|entry| entry.unstable_path == path && entry.unstable_first_seen_at_ms > 0)
        .map(|entry| entry.unstable_first_seen_at_ms)
        .unwrap_or(now_ms);
    (
        now_ms.saturating_sub(first_seen) >= MAX_UNSTABLE_DELAY_MS,
        first_seen,
    )
}

/// 这一段记录不稳定会话。
/// Remember an unstable thread.
pub fn remember_unstable_thread(
    index: &mut ArchiveIndex,
    row: &ConversationThreadRow,
    path: &str,
    stat: &RolloutStat,
    first_seen_ms: i64,
) {
    // 这一段不把未上传的新内容伪装成已同步，仅保存等待起点。
    // Do not pretend unsynced content was uploaded; store only the waiting point.
    let previous = index
        .threads
        .get(&row.thread_id)
        .cloned()
        .unwrap_or_default();
    index.threads.insert(
        row.thread_id.clone(),
        ArchiveIndexThread {
            rollout_mtime_ms: stat.mtime_ms,
            rollout_size: stat.size,
            unstable_first_seen_at_ms: first_seen_ms,
            unstable_path: path.to_string(),
            updated_at_ms: row.updated_at_ms,
            ..previous
        },
    );
}

/// 这一段判断是否需要重新导出。
/// Return whether the thread should be exported again.
pub fn should_export_thread(
    row: &ConversationThreadRow,
    path: &str,
    stat: &RolloutStat,
    index: &ArchiveIndex,
    remote_files: &Map<String, Value>,
) -> bool {
    // 这一段用本地索引、rollout 元数据和远端包摘要共同判断增量导出。
    // Use the local index, rollout metadata, and remote package summary together for incremental export decisions.
    let Some(previous) = index.threads.get(&row.thread_id) else {
        return true;
    };
    if previous.path != path
        || previous.markdown_format_version != MARKDOWN_FORMAT_VERSION
        || previous.updated_at_ms != row.updated_at_ms
        || previous.rollout_size != stat.size
        || previous.rollout_mtime_ms != stat.mtime_ms
    {
        return true;
    }
    if !previous.skip_reason.is_empty() && row.skip_reason.is_empty() {
        return true;
    }
    let Some(remote_file) = remote_files.get(path) else {
        return true;
    };
    if previous.lifecycle_status != row.lifecycle_status
        || previous.archived_at != row.archived_at
        || previous.deleted_detected_at != row.deleted_detected_at
    {
        return true;
    }
    if !same_remote_lifecycle(remote_file, row) {
        return true;
    }
    let remote_title = remote_file
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if !codex_state::is_same_title(remote_title, &row.title) {
        return true;
    }
    let remote_package = remote_file
        .get("packageSha256")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let remote_markdown = remote_file
        .get("markdownSha256")
        .and_then(Value::as_str)
        .unwrap_or_default();
    remote_package != previous.package_sha256 || remote_markdown != previous.markdown_sha256
}

/// 这一段记录已成功导出的会话。
/// Remember a successfully exported thread.
pub fn remember_exported_thread(
    index: &mut ArchiveIndex,
    row: &ConversationThreadRow,
    path: &str,
    stat: &RolloutStat,
    package_sha256: &str,
    markdown_sha256: &str,
) {
    // 这一段清除不稳定等待状态，并记录真实上传摘要。
    // Clear unstable waiting state and record the actual uploaded summary.
    index.threads.insert(
        row.thread_id.clone(),
        ArchiveIndexThread {
            markdown_format_version: MARKDOWN_FORMAT_VERSION,
            markdown_sha256: markdown_sha256.to_string(),
            package_sha256: package_sha256.to_string(),
            path: path.to_string(),
            archived_at: row.archived_at.clone(),
            deleted_detected_at: row.deleted_detected_at.clone(),
            lifecycle_status: row.lifecycle_status.clone(),
            rollout_mtime_ms: stat.mtime_ms,
            rollout_size: stat.size,
            skip_reason: String::new(),
            unstable_first_seen_at_ms: 0,
            unstable_path: String::new(),
            updated_at_ms: row.updated_at_ms,
        },
    );
}

/// 这一段记录已检查但跳过的会话。
/// Remember a checked but skipped thread.
pub fn remember_skipped_thread(
    index: &mut ArchiveIndex,
    row: &ConversationThreadRow,
    path: &str,
    stat: &RolloutStat,
    skip_reason: &str,
) {
    // 这一段写入 skipReason，下一轮仍可在标题或内容恢复后重新导出。
    // Store skipReason so a later title/body recovery can trigger export again.
    index.threads.insert(
        row.thread_id.clone(),
        ArchiveIndexThread {
            archived_at: row.archived_at.clone(),
            deleted_detected_at: row.deleted_detected_at.clone(),
            lifecycle_status: row.lifecycle_status.clone(),
            markdown_format_version: MARKDOWN_FORMAT_VERSION,
            path: path.to_string(),
            rollout_mtime_ms: stat.mtime_ms,
            rollout_size: stat.size,
            skip_reason: skip_reason.to_string(),
            updated_at_ms: row.updated_at_ms,
            ..ArchiveIndexThread::default()
        },
    );
}

/// 这一段描述待同步生命周期。
/// Describes a pending lifecycle update.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LifecycleUpdate {
    /// 这一段是远端路径。
    /// Remote path.
    pub path: String,
    /// 这一段是线程 ID。
    /// Thread ID.
    pub thread_id: String,
    /// 这一段是生命周期。
    /// Lifecycle status.
    pub lifecycle_status: String,
    /// 这一段是归档时间。
    /// Archive timestamp.
    pub archived_at: String,
    /// 这一段是删除检测时间。
    /// Delete detection timestamp.
    pub deleted_detected_at: String,
}

/// 这一段查找本机已删除线程的软墓碑。
/// Find soft tombstones for locally deleted threads.
pub fn deleted_lifecycle_updates(
    index: &ArchiveIndex,
    remote_files: &Map<String, Value>,
    identity: &ArchiveIdentity,
    current_thread_ids: &std::collections::HashSet<String>,
    scan_truncated: bool,
) -> Vec<LifecycleUpdate> {
    // 这一段只在完整扫描时推断删除，避免截断扫描误删远端列表。
    // Infer deletes only after a complete scan to avoid false tombstones from truncation.
    if scan_truncated {
        return Vec::new();
    }
    let local_prefix = format!(
        "devices/{}/profiles/{}/",
        identity.device_id, identity.profile_id
    );
    let deleted_detected_at = now_iso_fallback();
    index
        .threads
        .iter()
        .filter_map(|(thread_id, previous)| {
            if thread_id.is_empty()
                || current_thread_ids.contains(thread_id)
                || !previous.path.starts_with(&local_prefix)
            {
                return None;
            }
            let remote_file = remote_files.get(&previous.path)?;
            if remote_file.get("lifecycleStatus").and_then(Value::as_str) == Some("deleted") {
                return None;
            }
            Some(LifecycleUpdate {
                archived_at: previous.archived_at.clone(),
                deleted_detected_at: if previous.deleted_detected_at.is_empty() {
                    deleted_detected_at.clone()
                } else {
                    previous.deleted_detected_at.clone()
                },
                lifecycle_status: "deleted".to_string(),
                path: previous.path.clone(),
                thread_id: thread_id.clone(),
            })
        })
        .collect()
}

/// 这一段记录生命周期同步结果。
/// Remember a lifecycle sync result.
pub fn remember_lifecycle_update(index: &mut ArchiveIndex, update: &LifecycleUpdate) {
    // 这一段不需要 rollout 统计，只更新生命周期字段。
    // No rollout stat is needed; update only lifecycle fields.
    let previous = index
        .threads
        .get(&update.thread_id)
        .cloned()
        .unwrap_or_default();
    index.threads.insert(
        update.thread_id.clone(),
        ArchiveIndexThread {
            archived_at: update.archived_at.clone(),
            deleted_detected_at: update.deleted_detected_at.clone(),
            lifecycle_status: update.lifecycle_status.clone(),
            path: update.path.clone(),
            skip_reason: "deleted".to_string(),
            ..previous
        },
    );
}

/// 这一段比较远端生命周期和本地线程。
/// Compare remote lifecycle with a local row.
fn same_remote_lifecycle(remote_file: &Value, row: &ConversationThreadRow) -> bool {
    // 这一段只比较轻量字段，内容 hash 由调用方另行比较。
    // Compare only lightweight lifecycle fields; content hashes are checked by the caller.
    remote_file
        .get("lifecycleStatus")
        .and_then(Value::as_str)
        .unwrap_or("active")
        == row.lifecycle_status
        && remote_file
            .get("archivedAt")
            .and_then(Value::as_str)
            .unwrap_or("")
            == row.archived_at
        && remote_file
            .get("deletedDetectedAt")
            .and_then(Value::as_str)
            .unwrap_or("")
            == row.deleted_detected_at
}

/// 这一段返回用于墓碑的 ISO 时间兜底。
/// Return an ISO timestamp fallback for tombstones.
fn now_iso_fallback() -> String {
    // 这一段生成远端可稳定接受的 UTC ISO 时间，避免反复清空 metadata。
    // Generate a remotely stable UTC ISO timestamp so metadata does not get cleared repeatedly.
    unix_ms_to_iso_text(now_unix_ms(), "")
}

/// 这一段返回当前 Unix 毫秒时间。
/// Return current Unix milliseconds.
pub fn now_unix_ms() -> i64 {
    // 这一段对系统时间异常做饱和兜底。
    // Saturate on system-time anomalies.
    system_time_to_unix_ms(SystemTime::now()).unwrap_or_default()
}

/// 这一段把 SQLite/JSON 时间文本归一化为 UTC ISO。
/// Normalize SQLite/JSON timestamp text into UTC ISO.
pub fn normalize_timestamp_text(value: &str, fallback: &str) -> String {
    // 这一段兼容 SQLite 常见的秒级/毫秒级数字时间戳；非数字 ISO 文本保持原样。
    // Support common SQLite second/millisecond numeric timestamps; keep non-numeric ISO text as-is.
    let text = value.trim();
    if text.is_empty() {
        return fallback.to_string();
    }
    if let Ok(raw_timestamp) = text.parse::<f64>() {
        if !raw_timestamp.is_finite() || raw_timestamp <= 0.0 {
            return fallback.to_string();
        }
        let timestamp_ms = if raw_timestamp < 100_000_000_000.0 {
            raw_timestamp * 1000.0
        } else {
            raw_timestamp
        };
        if timestamp_ms > i64::MAX as f64 {
            return fallback.to_string();
        }
        return unix_ms_to_iso_text(timestamp_ms.floor() as i64, fallback);
    }
    text.to_string()
}

/// 这一段把 Unix 毫秒时间格式化成 UTC ISO 文本。
/// Format Unix milliseconds as UTC ISO text.
pub fn unix_ms_to_iso_text(timestamp_ms: i64, fallback: &str) -> String {
    // 这一段只处理正向 Unix 时间；异常值回退给调用方。
    // Handle forward Unix timestamps only; abnormal values fall back to the caller.
    let Some((year, month, day, hour, minute, second, millis)) = unix_ms_to_utc_parts(timestamp_ms)
    else {
        return fallback.to_string();
    };
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z")
}

/// 这一段生成索引路径。
/// Build the index path.
fn index_path(sync_key: &str, identity: &ArchiveIdentity) -> PathBuf {
    // 这一段文件名只使用 sync key 哈希和随机身份，不包含原始密钥或用户名。
    // Use only the sync-key hash and random identity in the filename, never the raw key or user name.
    codex_pro_core::paths::codex_pro_data_root_dir()
        .join("conversation-archive")
        .join(format!(
            "sync-index-{}-{}-{}.json",
            sync_key_hash(sync_key).chars().take(16).collect::<String>(),
            identity.device_id,
            identity.profile_id,
        ))
}

/// 这一段计算同步密钥 hash。
/// Hash a sync key.
pub fn sync_key_hash(sync_key: &str) -> String {
    // 这一段只用于状态隔离，不泄露原始同步密钥。
    // This is only for state isolation and does not reveal the raw sync key.
    format!("{:x}", Sha256::digest(sync_key.as_bytes()))
}

/// 这一段转换系统时间为 Unix 毫秒。
/// Convert system time to Unix milliseconds.
fn system_time_to_unix_ms(time: SystemTime) -> Option<i64> {
    // 这一段避免 mtime 计算使用 elapsed 反推导致漂移。
    // Avoid drift from computing mtimes by subtracting elapsed durations.
    Some(time.duration_since(UNIX_EPOCH).ok()?.as_millis() as i64)
}

/// 这一段把 Unix 毫秒拆成 UTC 日期时间字段。
/// Split Unix milliseconds into UTC date-time fields.
fn unix_ms_to_utc_parts(timestamp_ms: i64) -> Option<(i64, u32, u32, i64, i64, i64, i64)> {
    // 这一段使用纯整数公历算法，避免给 bridge 增加额外时间依赖。
    // Use an integer Gregorian conversion so the bridge does not need an extra time dependency.
    if timestamp_ms < 0 {
        return None;
    }
    let total_seconds = timestamp_ms.div_euclid(1000);
    let millis = timestamp_ms.rem_euclid(1000);
    let days = total_seconds.div_euclid(86_400);
    let seconds_of_day = total_seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    let hour = seconds_of_day / 3_600;
    let minute = (seconds_of_day % 3_600) / 60;
    let second = seconds_of_day % 60;
    Some((year, month, day, hour, minute, second, millis))
}

/// 这一段把 Unix epoch 后的天数转换为公历年月日。
/// Convert days since Unix epoch into Gregorian year, month, and day.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    // 这一段实现 Howard Hinnant civil_from_days 算法，保持 UTC 日期换算稳定。
    // Implement Howard Hinnant's civil_from_days algorithm for stable UTC date conversion.
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 }.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096).div_euclid(365);
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2).div_euclid(153);
    let day = doy - (153 * mp + 2).div_euclid(5) + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    let year = y + if month <= 2 { 1 } else { 0 };
    (year, month as u32, day as u32)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 这一段构造测试会话行。
    /// Build a test thread row.
    fn row(updated_at_ms: i64) -> ConversationThreadRow {
        ConversationThreadRow {
            archive_group_id: "conversation_default".to_string(),
            archive_group_name: "对话".to_string(),
            archive_group_type: "conversation".to_string(),
            archived_at: String::new(),
            created_at: "2026-06-14T00:00:00.000Z".to_string(),
            created_at_ms: 0,
            cwd: String::new(),
            deleted_detected_at: String::new(),
            lifecycle_status: "active".to_string(),
            rollout_path: "rollout.jsonl".to_string(),
            skip_reason: String::new(),
            thread_id: "thread_123".to_string(),
            thread_source: "user".to_string(),
            title: "测试会话".to_string(),
            updated_at: "2026-06-14T00:01:00.000Z".to_string(),
            updated_at_ms,
        }
    }

    /// 这一段确认 force 不会绕过增量导出判断本身。
    /// Confirm force does not bypass the incremental export decision itself.
    #[test]
    fn incremental_decision_keeps_unchanged_thread_skipped() {
        let mut index = ArchiveIndex {
            version: INDEX_VERSION,
            ..ArchiveIndex::default()
        };
        let stat = RolloutStat {
            size: 10,
            mtime_ms: 20,
        };
        remember_exported_thread(
            &mut index,
            &row(100),
            "devices/device_local/profiles/profile_default/conversations/conversation_default/threads/2026/06/thread_123/index.md",
            &stat,
            "a".repeat(64).as_str(),
            "b".repeat(64).as_str(),
        );
        let mut remote_files = Map::new();
        remote_files.insert(
            "devices/device_local/profiles/profile_default/conversations/conversation_default/threads/2026/06/thread_123/index.md".to_string(),
            serde_json::json!({
                "markdownSha256": "b".repeat(64),
                "packageSha256": "a".repeat(64),
                "title": "测试会话",
            }),
        );

        assert!(!should_export_thread(
            &row(100),
            "devices/device_local/profiles/profile_default/conversations/conversation_default/threads/2026/06/thread_123/index.md",
            &stat,
            &index,
            &remote_files,
        ));
    }

    /// 这一段确认远端标题错误时即使正文 hash 没变也会重传。
    /// Confirm a wrong remote title forces reupload even when body hashes are unchanged.
    #[test]
    fn incremental_decision_reuploads_when_remote_title_differs() {
        let mut index = ArchiveIndex {
            version: INDEX_VERSION,
            ..ArchiveIndex::default()
        };
        let stat = RolloutStat {
            mtime_ms: 200,
            size: 10,
        };
        remember_exported_thread(
            &mut index,
            &row(100),
            "devices/device_local/profiles/profile_default/conversations/conversation_default/threads/2026/06/thread_123/index.md",
            &stat,
            "a".repeat(64).as_str(),
            "b".repeat(64).as_str(),
        );
        let mut remote_files = Map::new();
        remote_files.insert(
            "devices/device_local/profiles/profile_default/conversations/conversation_default/threads/2026/06/thread_123/index.md".to_string(),
            serde_json::json!({
                "markdownSha256": "b".repeat(64),
                "packageSha256": "a".repeat(64),
                "title": "错误首条正文标题",
            }),
        );

        assert!(should_export_thread(
            &row(100),
            "devices/device_local/profiles/profile_default/conversations/conversation_default/threads/2026/06/thread_123/index.md",
            &stat,
            &index,
            &remote_files,
        ));
    }

    /// 这一段确认之前缺官方标题跳过的会话在标题出现后会重传。
    /// Confirm a previously skipped missing-title thread reuploads once the official title appears.
    #[test]
    fn incremental_decision_reuploads_when_missing_title_becomes_available() {
        let mut index = ArchiveIndex {
            version: INDEX_VERSION,
            ..ArchiveIndex::default()
        };
        let stat = RolloutStat {
            mtime_ms: 200,
            size: 10,
        };
        remember_skipped_thread(
            &mut index,
            &row(100),
            "devices/device_local/profiles/profile_default/conversations/conversation_default/threads/2026/06/thread_123/index.md",
            &stat,
            "missing-title",
        );
        let mut remote_files = Map::new();
        remote_files.insert(
            "devices/device_local/profiles/profile_default/conversations/conversation_default/threads/2026/06/thread_123/index.md".to_string(),
            serde_json::json!({
                "markdownSha256": "",
                "packageSha256": "",
                "title": "# 旧正文伪标题",
            }),
        );

        assert!(should_export_thread(
            &row(100),
            "devices/device_local/profiles/profile_default/conversations/conversation_default/threads/2026/06/thread_123/index.md",
            &stat,
            &index,
            &remote_files,
        ));
    }

    /// 这一段确认 SQLite 秒级归档时间会转为后端可保存的 ISO。
    /// Confirm SQLite second archive timestamps become backend-stable ISO text.
    #[test]
    fn numeric_second_timestamp_normalizes_to_iso() {
        assert_eq!(
            normalize_timestamp_text("1", ""),
            "1970-01-01T00:00:01.000Z"
        );
    }

    /// 这一段确认毫秒级时间不会被误当成秒级时间。
    /// Confirm millisecond timestamps are not mistaken for second timestamps.
    #[test]
    fn numeric_millisecond_timestamp_normalizes_to_iso() {
        assert_eq!(
            normalize_timestamp_text("1700000000000", ""),
            "2023-11-14T22:13:20.000Z"
        );
    }

    /// 这一段确认稳定窗口和最长等待语义。
    /// Confirm stability-window and maximum-wait semantics.
    #[test]
    fn unstable_thread_waits_then_forces_after_max_delay() {
        let mut index = ArchiveIndex {
            version: INDEX_VERSION,
            ..ArchiveIndex::default()
        };
        let active_row = row(1_000);
        let path = "devices/device_local/profiles/profile_default/conversations/conversation_default/threads/2026/06/thread_123/index.md";
        assert!(!is_thread_stable(&active_row, 1_000 + STABLE_DELAY_MS - 1));
        let (allow, first_seen) = unstable_decision(&index, &active_row, path, 2_000);
        assert!(!allow);
        remember_unstable_thread(
            &mut index,
            &active_row,
            path,
            &RolloutStat::default(),
            first_seen,
        );
        let (allow, reused_first_seen) =
            unstable_decision(&index, &active_row, path, 2_000 + MAX_UNSTABLE_DELAY_MS);
        assert!(allow);
        assert_eq!(reused_first_seen, first_seen);
    }
}
