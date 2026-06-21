use serde_json::Value;
use std::collections::HashMap;

/// 这一段读取 Codex session_index 短标题。
/// Read short titles from Codex session_index.
pub async fn read_session_titles() -> anyhow::Result<HashMap<String, String>> {
    // 这一段按行读取 JSONL，解析失败的行直接跳过。
    // Read JSONL lines and skip malformed entries.
    let path = codex_pro_core::paths::codex_home_dir().join("session_index.jsonl");
    let text = tokio::fs::read_to_string(path).await.unwrap_or_default();
    let mut output = HashMap::new();
    for line in text.lines() {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let id = read_session_index_id(&value);
        let title = read_session_index_title(&value);
        if !id.is_empty() && !title.is_empty() {
            output.insert(id, title);
        }
    }
    Ok(output)
}

/// 这一段读取 session_index 里的 thread id。
/// Read the thread id from one session_index row.
fn read_session_index_id(value: &Value) -> String {
    // 这一段去掉 Codex 列表层可能带上的 local/remote 前缀。
    // Remove local/remote prefixes that may appear in Codex list metadata.
    value
        .get("id")
        .or_else(|| value.get("thread_id"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .trim_start_matches("local:")
        .trim_start_matches("remote:")
        .to_string()
}

/// 这一段读取旧 Node 实现使用的 Codex 官方短标题字段。
/// Read the official Codex short-title field used by the legacy Node implementation.
fn read_session_index_title(value: &Value) -> String {
    // 这一段只接受 thread_name，避免把非官方字段当作会话标题。
    // Accept only thread_name so non-official fields do not become archive titles.
    let title = super::codex_state::normalize_title(
        value
            .get("thread_name")
            .and_then(Value::as_str)
            .unwrap_or_default(),
    );
    if title == "Untitled session" || super::codex_state::is_generated_title(&title) {
        return String::new();
    }
    title
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 这一段确认只使用 Codex 官方 session_index 的 thread_name 字段。
    /// Confirm only Codex's official session_index thread_name field is used.
    #[test]
    fn reads_official_thread_name_field() {
        let value = serde_json::json!({
            "id": "local:thread_123",
            "thread_name": "官方短标题",
            "title": "错误标题",
            "short_title": "错误短标题"
        });

        assert_eq!(read_session_index_id(&value), "thread_123");
        assert_eq!(read_session_index_title(&value), "官方短标题");
    }

    /// 这一段确认缺少 thread_name 时不会回退到其它标题字段。
    /// Confirm missing thread_name does not fall back to other title fields.
    #[test]
    fn ignores_non_official_title_fields() {
        let value = serde_json::json!({
            "id": "thread_123",
            "title": "不应使用",
            "short_title": "也不应使用"
        });

        assert_eq!(read_session_index_title(&value), "");
    }
}
