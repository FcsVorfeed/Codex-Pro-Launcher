use crate::handlers::cloud_sync::{normalize_request_id, normalize_sync_endpoint};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// 这一段描述会话归档请求。
/// Describes a conversation archive request.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct ConversationArchiveRequest {
    /// 这一段是 request id。
    /// Request id.
    #[serde(rename = "requestId")]
    pub request_id: String,
    /// 这一段是 action。
    /// Action.
    pub action: String,
    /// 这一段是 endpoint。
    /// Endpoint.
    pub endpoint: String,
    /// 这一段是同步密钥。
    /// Sync key.
    #[serde(rename = "syncKey")]
    pub sync_key: String,
    /// 这一段是设备显示名。
    /// Device display name.
    #[serde(rename = "deviceName")]
    pub device_name: String,
    /// 这一段是安全设备 id。
    /// Safe device id.
    #[serde(rename = "deviceId")]
    pub device_id: String,
    /// 这一段是 profile 显示名。
    /// Profile display name.
    #[serde(rename = "profileName")]
    pub profile_name: String,
    /// 这一段是远端归档路径。
    /// Remote archive path.
    pub path: String,
    /// 这一段是本机 Codex 线程 ID。
    /// Local Codex thread ID.
    #[serde(rename = "threadId")]
    pub thread_id: String,
    /// 这一段是手动强制上传标记。
    /// Manual force-upload flag.
    pub force: bool,
}

/// 这一段解析会话归档请求。
/// Parse a conversation archive request.
pub fn parse_conversation_archive_request(value: &Value) -> Option<ConversationArchiveRequest> {
    // 这一段只接受已知 action 和短安全字段。
    // Accept only known actions and short safe fields.
    let request_id = normalize_request_id(value.get("requestId")?.as_str()?)?;
    let action = value.get("action")?.as_str()?.trim().to_ascii_lowercase();
    let is_local_file_action = action == "prepare-local-file";
    if ![
        "push",
        "list",
        "get-file",
        "prepare-file",
        "prepare-local-file",
        "reset",
        "delete-device",
    ]
    .contains(&action.as_str())
    {
        return None;
    }
    let endpoint = if is_local_file_action {
        String::new()
    } else {
        normalize_sync_endpoint(value.get("endpoint")?.as_str()?)?
    };
    let sync_key = if is_local_file_action {
        ""
    } else {
        value.get("syncKey")?.as_str()?.trim()
    };
    if !is_local_file_action && (sync_key.len() < 16 || sync_key.contains('\0')) {
        return None;
    }
    let device_name = short_text(
        value
            .get("deviceName")
            .and_then(Value::as_str)
            .unwrap_or_default(),
        120,
    )?;
    let device_id = short_text(
        value
            .get("deviceId")
            .and_then(Value::as_str)
            .unwrap_or_default(),
        120,
    )?;
    let profile_name = short_text(
        value
            .get("profileName")
            .and_then(Value::as_str)
            .unwrap_or_default(),
        120,
    )?;
    let path = short_text(
        value
            .get("path")
            .and_then(Value::as_str)
            .unwrap_or_default(),
        500,
    )?;
    if (action == "get-file" || action == "prepare-file") && !is_safe_archive_path(&path) {
        return None;
    }
    let thread_id = if is_local_file_action {
        normalize_thread_id(
            value
                .get("threadId")
                .and_then(Value::as_str)
                .unwrap_or_default(),
        )?
    } else {
        String::new()
    };
    if is_local_file_action && thread_id.is_empty() {
        return None;
    }
    if action == "delete-device" && !device_id.is_empty() && !is_safe_id(&device_id) {
        return None;
    }
    Some(ConversationArchiveRequest {
        request_id,
        action: action.clone(),
        endpoint,
        sync_key: sync_key.to_string(),
        device_name,
        device_id,
        profile_name,
        path,
        thread_id,
        force: action == "push" && value.get("force").and_then(Value::as_bool) == Some(true),
    })
}

/// 这一段归一化页面传入的本机会话 ID。
/// Normalize a local thread id provided by the page.
fn normalize_thread_id(value: &str) -> Option<String> {
    // 这一段去掉侧栏可能携带的 local/remote 前缀，并拒绝原型污染特殊键。
    // Strip possible local/remote sidebar prefixes and reject prototype-pollution sentinel keys.
    let thread_id = value
        .trim()
        .trim_start_matches("local:")
        .trim_start_matches("remote:");
    if thread_id.is_empty()
        || matches!(thread_id, "__proto__" | "prototype" | "constructor")
        || thread_id.len() > 180
    {
        return None;
    }
    if thread_id
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-' | '.' | ':'))
    {
        Some(thread_id.to_string())
    } else {
        None
    }
}

/// 这一段限制短文本字段。
/// Bound a short text field.
fn short_text(value: &str, max_len: usize) -> Option<String> {
    // 这一段拒绝控制字符。
    // Reject control characters.
    let raw = value.trim();
    if raw.len() > max_len || raw.contains('\0') || raw.contains('\r') || raw.contains('\n') {
        return None;
    }
    Some(raw.to_string())
}

/// 这一段判断安全 id。
/// Return whether an id is safe.
pub fn is_safe_id(value: &str) -> bool {
    // 这一段只接受短 ASCII id。
    // Accept only short ASCII ids.
    !value.is_empty()
        && value.len() <= 120
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-' | '.'))
}

/// 这一段判断归档远端路径是否安全。
/// Return whether a remote archive path is safe.
fn is_safe_archive_path(value: &str) -> bool {
    // 这一段拒绝上跳和旧版无 devices/profile 前缀路径。
    // Reject traversal and legacy paths without devices/profile prefixes.
    let normalized = value.replace('\\', "/");
    normalized.starts_with("devices/")
        && normalized.contains("/profiles/")
        && normalized.ends_with("/index.md")
        && !normalized
            .split('/')
            .any(|part| part.is_empty() || part == "..")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// 这一段确认本机预览 action 不需要云端 endpoint 或同步密钥。
    /// Confirm the local preview action does not require a cloud endpoint or sync key.
    #[test]
    fn local_prepare_accepts_only_thread_id() {
        let request = parse_conversation_archive_request(&json!({
            "action": "prepare-local-file",
            "requestId": "req_local_preview",
            "threadId": "local:thread_12345678"
        }))
        .expect("local prepare request should parse");

        assert_eq!(request.action, "prepare-local-file");
        assert_eq!(request.thread_id, "thread_12345678");
        assert_eq!(request.endpoint, "");
        assert_eq!(request.sync_key, "");
    }

    /// 这一段确认旧远端 action 仍不要求 threadId。
    /// Confirm existing remote actions still do not require a threadId.
    #[test]
    fn remote_list_does_not_require_thread_id() {
        let request = parse_conversation_archive_request(&json!({
            "action": "list",
            "endpoint": "https://example.com/archive",
            "requestId": "req_remote_list",
            "syncKey": "1234567890123456"
        }))
        .expect("remote list request should parse");

        assert_eq!(request.action, "list");
        assert_eq!(request.thread_id, "");
    }
}
