use super::codex_state::ConversationThreadRow;
use super::identity::ArchiveIdentity;
use super::project::{GROUP_TYPE_CONVERSATION, GROUP_TYPE_PROJECT};

/// 这一段返回会话远端路径。
/// Return a thread remote path.
pub fn thread_archive_path(identity: &ArchiveIdentity, row: &ConversationThreadRow) -> String {
    // 这一段使用安全设备/profile id，不上传本机完整路径。
    // Use safe device/profile ids and never upload local full paths.
    let device_id = identity.device_id.as_str();
    let profile_id = identity.profile_id.as_str();
    let (year, month) = year_month_from_row(row);
    let group_type = if row.archive_group_type == GROUP_TYPE_PROJECT {
        GROUP_TYPE_PROJECT
    } else {
        GROUP_TYPE_CONVERSATION
    };
    let group_segment = if group_type == GROUP_TYPE_PROJECT {
        "projects"
    } else {
        "conversations"
    };
    let group_id = safe_path_part(&row.archive_group_id);
    format!(
        "devices/{device_id}/profiles/{profile_id}/{group_segment}/{group_id}/threads/{year}/{month}/{}/index.md",
        safe_path_part(&row.thread_id)
    )
}

/// 这一段从线程时间取年份月份。
/// Resolve year and month from a thread row.
fn year_month_from_row(row: &ConversationThreadRow) -> (String, String) {
    // 这一段优先使用 Codex SQLite 的毫秒时间，避免 integer created_at 被当成普通字符串。
    // Prefer Codex SQLite millisecond timestamps so integer created_at values are not treated as plain strings.
    if row.created_at_ms > 0 {
        return year_month_from_unix_ms(row.created_at_ms);
    }

    // 这一段保留旧字符串 ISO 兜底，无法解析时回退 1970/01。
    // Keep the old ISO-string fallback and return 1970/01 when parsing is unavailable.
    let text = if row.created_at.len() >= 7 {
        &row.created_at
    } else {
        ""
    };
    if text.len() >= 7 && text.as_bytes().get(4) == Some(&b'-') {
        (text[0..4].to_string(), text[5..7].to_string())
    } else {
        ("1970".to_string(), "01".to_string())
    }
}

/// 这一段从 Unix 毫秒换算 UTC 年月。
/// Convert Unix milliseconds to UTC year and month.
fn year_month_from_unix_ms(timestamp_ms: i64) -> (String, String) {
    // 这一段只需要年月，使用整数日期算法避免引入额外时间依赖。
    // Only year and month are needed, so use an integer date algorithm without an extra time dependency.
    let days = timestamp_ms.div_euclid(86_400_000);
    let (year, month, _) = civil_from_days(days);
    (format!("{year:04}"), format!("{month:02}"))
}

/// 这一段把 Unix epoch 天数转换成公历日期。
/// Convert Unix epoch days to a civil date.
fn civil_from_days(days: i64) -> (i64, i64, i64) {
    // 这一段使用 Howard Hinnant 的 civil_from_days 整数算法。
    // Use Howard Hinnant's civil_from_days integer algorithm.
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
    (year, month, day)
}

/// 这一段清洗路径片段。
/// Sanitize one path part.
fn safe_path_part(value: &str) -> String {
    // 这一段只允许 ASCII 安全字符。
    // Allow only ASCII safe characters.
    let part = value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-' | '.') {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>();
    if part.is_empty() {
        "thread_unknown".to_string()
    } else {
        part
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 这一段构造测试会话行。
    /// Build a test thread row.
    fn row(created_at: &str, created_at_ms: i64) -> ConversationThreadRow {
        ConversationThreadRow {
            archive_group_id: "conversation_default".to_string(),
            archive_group_name: "对话".to_string(),
            archive_group_type: GROUP_TYPE_CONVERSATION.to_string(),
            archived_at: String::new(),
            created_at: created_at.to_string(),
            created_at_ms,
            cwd: String::new(),
            deleted_detected_at: String::new(),
            lifecycle_status: "active".to_string(),
            rollout_path: "rollout.jsonl".to_string(),
            skip_reason: String::new(),
            thread_id: "thread_123".to_string(),
            thread_source: "user".to_string(),
            title: "测试会话".to_string(),
            updated_at: String::new(),
            updated_at_ms: 0,
        }
    }

    /// 这一段确认毫秒时间会生成真实年月。
    /// Confirm millisecond timestamps produce real year and month folders.
    #[test]
    fn year_month_prefers_created_at_ms() {
        assert_eq!(
            year_month_from_row(&row("1781489405328", 1_781_489_405_328)),
            ("2026".to_string(), "06".to_string())
        );
    }

    /// 这一段确认 ISO 字符串仍可作为兜底。
    /// Confirm ISO strings remain a fallback.
    #[test]
    fn year_month_uses_iso_fallback() {
        assert_eq!(
            year_month_from_row(&row("2026-06-15T00:00:00.000Z", 0)),
            ("2026".to_string(), "06".to_string())
        );
    }
}
