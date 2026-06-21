use crate::handlers::sync_license::{SyncLicenseAuthorization, ensure_sync_license_with_client};
use anyhow::bail;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::collections::HashSet;
use std::time::Duration;
use url::{Host, Url};

/// 这一段定义云同步请求体大小上限。
/// Maximum cloud-sync request body size.
const CLOUD_SYNC_MAX_BODY_BYTES: usize = 20 * 1024;
/// 这一段定义云同步设置 payload 大小上限。
/// Maximum cloud-sync settings payload size.
const CLOUD_SYNC_MAX_SETTINGS_BYTES: usize = 16 * 1024;
/// 这一段定义同步请求超时。
/// Cloud-sync request timeout.
const CLOUD_SYNC_REQUEST_TIMEOUT_MS: u64 = 15_000;
/// 这一段定义同步密钥长度上限。
/// Maximum sync-key length.
const CLOUD_SYNC_MAX_SYNC_KEY_LENGTH: usize = 160;
/// 这一段描述设置同步请求。
/// Describes a cloud settings sync request.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct CloudSyncRequest {
    /// 这一段是请求 id。
    /// Request id.
    #[serde(rename = "requestId")]
    pub request_id: String,
    /// 这一段是同步 endpoint。
    /// Sync endpoint.
    pub endpoint: String,
    /// 这一段是已净化 body。
    /// Sanitized body.
    pub body: Value,
}

/// 这一段解析云端设置同步请求。
/// Parse a cloud settings sync request.
pub fn parse_cloud_sync_request(value: &Value) -> Option<CloudSyncRequest> {
    // 这一段只接受短 request id、安全 endpoint 和 pull/push action。
    // Accept only a short request id, safe endpoint, and pull/push actions.
    let request_id = normalize_request_id(value.get("requestId")?.as_str()?)?;
    let endpoint = normalize_sync_endpoint(value.get("endpoint")?.as_str()?)?;
    let body = sanitize_cloud_sync_body(value.get("body")?)?;
    if serde_json::to_vec(&body).ok()?.len() > CLOUD_SYNC_MAX_BODY_BYTES {
        return None;
    }
    Some(CloudSyncRequest {
        request_id,
        endpoint,
        body,
    })
}

/// 这一段运行云端设置同步请求。
/// Run a cloud settings sync request.
pub async fn run_cloud_sync_request(request: &CloudSyncRequest) -> anyhow::Result<Value> {
    // 这一段由 Rust launcher 发起网络请求，绕开页面 fetch 限制但不开放任意协议。
    // Perform the network request from the launcher without opening arbitrary protocols.
    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(CLOUD_SYNC_REQUEST_TIMEOUT_MS))
        .no_proxy()
        .build()?;
    let authorization = match ensure_sync_license_with_client(
        &client,
        sync_key_from_body(&request.body)?,
        force_license_validation_from_body(&request.body),
    )
    .await
    {
        Ok(authorization) => authorization,
        Err(error) => return Ok(error.into_response()),
    };
    let remote_body = remote_cloud_sync_body(&request.body);
    let response = client
        .post(&request.endpoint)
        .json(&remote_body)
        .send()
        .await?;
    let status = response.status().as_u16();
    let text = response.text().await.unwrap_or_default();
    let mut normalized_response = normalize_cloud_sync_response(status, &text);
    attach_sync_license_authorization(&mut normalized_response, &authorization);
    Ok(normalized_response)
}

/// 这一段从已净化请求体读取同步密钥。
/// Read the sync key from a sanitized body.
fn sync_key_from_body(body: &Value) -> anyhow::Result<&str> {
    body.get("syncKey")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| anyhow::anyhow!("missing sync key"))
}

/// 这一段读取是否需要绕过授权成功缓存。
/// Read whether the license success cache should be bypassed.
fn force_license_validation_from_body(body: &Value) -> bool {
    // 这一段只接受页面净化后的布尔标记，普通同步动作默认命中缓存。
    // Accept only the sanitized boolean marker; ordinary sync actions use the cache by default.
    body.get("forceLicenseValidation")
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

/// 这一段生成发给远端同步服务的请求体。
/// Build the request body sent to the remote sync service.
fn remote_cloud_sync_body(body: &Value) -> Value {
    // 这一段移除仅供本机授权层使用的控制字段，保持远端协议只含业务字段。
    // Remove local authorization-only control fields so the remote contract contains only business fields.
    let mut remote_body = body.clone();
    if let Some(object) = remote_body.as_object_mut() {
        object.remove("forceLicenseValidation");
    }
    remote_body
}

/// 这一段把云函数响应归一化成页面侧旧 Node bridge 期望的形状。
/// Normalize cloud-function responses into the shape expected from the legacy Node bridge.
fn normalize_cloud_sync_response(status: u16, text: &str) -> Value {
    // 这一段只向页面返回 data/error/ok/status，避免把云函数外层包装误当作设置数据。
    // Return only data/error/ok/status so the cloud-function wrapper is not mistaken for settings data.
    let payload = serde_json::from_str::<Value>(text).unwrap_or_else(|_| json!({}));
    let payload_ok = payload.get("ok").and_then(Value::as_bool).unwrap_or(true);
    json!({
        "ok": (200..300).contains(&status) && payload_ok,
        "status": status,
        "data": payload.get("data").cloned().unwrap_or(Value::Null),
        "error": payload.get("error").and_then(Value::as_str).unwrap_or(""),
    })
}

/// 这一段把授权展示信息挂到页面响应顶层，不混入云端设置数据。
/// Attach license display metadata at the page-response top level, separate from cloud settings data.
fn attach_sync_license_authorization(
    response: &mut Value,
    authorization: &SyncLicenseAuthorization,
) {
    if let Some(object) = response.as_object_mut() {
        object.insert(
            "license".to_string(),
            json!({
                "expiresAt": authorization.expires_at,
            }),
        );
    }
}

/// 这一段净化云同步 body。
/// Sanitize a cloud-sync body.
fn sanitize_cloud_sync_body(value: &Value) -> Option<Value> {
    // 这一段只保留 action、syncKey 和安全设置白名单。
    // Keep only action, syncKey, and whitelisted safe settings.
    let object = value.as_object()?;
    let action = object.get("action")?.as_str()?.trim().to_ascii_lowercase();
    if action != "pull" && action != "push" {
        return None;
    }
    let sync_key = object.get("syncKey")?.as_str()?.trim();
    if sync_key.len() < 16
        || sync_key.len() > CLOUD_SYNC_MAX_SYNC_KEY_LENGTH
        || sync_key.contains('\0')
    {
        return None;
    }
    let mut body = Map::new();
    body.insert("action".to_string(), Value::String(action.clone()));
    body.insert("syncKey".to_string(), Value::String(sync_key.to_string()));
    if action == "push" {
        let settings = sanitize_settings(object.get("settings").unwrap_or(&Value::Null))?;
        body.insert("settings".to_string(), Value::Object(settings));
        if let Some(base_revision) = object.get("baseRevision").and_then(Value::as_i64)
            && base_revision >= 0
        {
            body.insert(
                "baseRevision".to_string(),
                Value::Number(base_revision.into()),
            );
        }
    }
    if object
        .get("forceLicenseValidation")
        .and_then(Value::as_bool)
        == Some(true)
    {
        body.insert("forceLicenseValidation".to_string(), Value::Bool(true));
    }
    Some(Value::Object(body))
}

/// 这一段净化设置白名单。
/// Sanitize the settings allow-list.
fn sanitize_settings(value: &Value) -> Option<Map<String, Value>> {
    // 这一段显式白名单，避免同步本机路径、密钥、日志或聊天内容。
    // Use an explicit allow-list to avoid syncing paths, keys, logs, or chat content.
    let allowed = cloud_sync_allowed_setting_keys();
    let object = value.as_object()?;
    let mut output = Map::new();
    for (key, value) in object {
        if !allowed.contains(key.as_str()) {
            continue;
        }
        let sanitized = match key.as_str() {
            "uiLanguage" => {
                let language = value.as_str().unwrap_or_default();
                if language == "zh-CN" || language == "en-US" || language == "ja-JP" {
                    Value::String(language.to_string())
                } else {
                    continue;
                }
            }
            "usagePanelTodayTokenSource" => {
                let source = value.as_str().unwrap_or_default();
                if source == "hidden" || source == "observer" || source == "official" {
                    Value::String(source.to_string())
                } else {
                    continue;
                }
            }
            "backgroundWallpaperImages" => {
                let mut urls = Vec::new();
                for line in value.as_str().unwrap_or_default().lines().map(str::trim) {
                    if is_syncable_background_wallpaper_image_url(line) && !urls.contains(&line) {
                        urls.push(line);
                    }
                }
                let urls = urls.join("\n");
                if urls.is_empty() {
                    continue;
                }
                Value::String(urls)
            }
            _ => value.clone(),
        };
        output.insert(key.clone(), sanitized);
    }
    if serde_json::to_vec(&output).ok()?.len() > CLOUD_SYNC_MAX_SETTINGS_BYTES {
        return None;
    }
    Some(output)
}

/// 这一段判断背景图 URL 是否可安全跨设备同步。
/// Decide whether a wallpaper URL is safe to sync across devices.
fn is_syncable_background_wallpaper_image_url(value: &str) -> bool {
    // 这一段对齐旧 Node bridge：只允许远程 HTTPS，拒绝本机、回环、链路本地和私网地址。
    // Match the legacy Node bridge: allow only remote HTTPS and reject local, loopback, link-local, and private addresses.
    let Ok(url) = Url::parse(value) else {
        return false;
    };
    if url.scheme() != "https" {
        return false;
    }
    match url.host() {
        Some(Host::Domain(hostname)) => {
            let hostname = hostname.to_ascii_lowercase();
            if hostname == "localhost" || hostname == "::1" {
                return false;
            }
            if is_private_ipv4_mapped_ipv6_address(&hostname) {
                return false;
            }
            if is_private_ipv4_address(&hostname) {
                return false;
            }
            true
        }
        Some(Host::Ipv4(address)) => !is_private_ipv4_address(&address.to_string()),
        Some(Host::Ipv6(address)) => {
            if address.is_loopback() || address.is_unique_local() || address.is_unicast_link_local()
            {
                return false;
            }
            if let Some(ipv4) = address.to_ipv4_mapped() {
                return !is_private_ipv4_address(&ipv4.to_string());
            }
            true
        }
        None => false,
    }
}

/// 这一段识别 IPv4 私网、回环和链路本地地址。
/// Detect IPv4 private, loopback, and link-local addresses.
fn is_private_ipv4_address(hostname: &str) -> bool {
    // 这一段用字符串前缀对齐旧 Node 逻辑，避免引入更宽泛的新策略。
    // Use string prefixes to mirror the legacy Node logic without introducing broader policy changes.
    hostname.starts_with("127.")
        || hostname.starts_with("10.")
        || hostname.starts_with("192.168.")
        || hostname.starts_with("169.254.")
        || hostname
            .split_once('.')
            .and_then(|(first, rest)| {
                if first != "172" {
                    return None;
                }
                rest.split_once('.')
                    .and_then(|(second, _)| second.parse::<u8>().ok())
            })
            .is_some_and(|second| (16..=31).contains(&second))
}

/// 这一段识别 Node URL 规范化后的 IPv4-mapped IPv6 地址。
/// Detect Node URL-normalized IPv4-mapped IPv6 addresses.
fn is_private_ipv4_mapped_ipv6_address(value: &str) -> bool {
    // 这一段覆盖旧 Node helper 的 ::ffff:xxxx:xxxx 形态。
    // Cover the ::ffff:xxxx:xxxx shape handled by the legacy Node helper.
    let Some(rest) = value.strip_prefix("::ffff:") else {
        return false;
    };
    let Some((high, low)) = rest.split_once(':') else {
        return false;
    };
    let Ok(high) = u16::from_str_radix(high, 16) else {
        return false;
    };
    let Ok(low) = u16::from_str_radix(low, 16) else {
        return false;
    };
    let octets = [(high >> 8) as u8, high as u8, (low >> 8) as u8, low as u8];
    is_private_ipv4_address(&format!(
        "{}.{}.{}.{}",
        octets[0], octets[1], octets[2], octets[3]
    ))
}

/// 这一段返回同步设置白名单。
/// Return the cloud-sync settings allow-list.
fn cloud_sync_allowed_setting_keys() -> HashSet<&'static str> {
    // 这一段覆盖当前设置页中安全、非隐私的字段。
    // Cover current safe non-private settings fields.
    [
        "backgroundWallpaperImages",
        "backgroundWallpaperIntervalSeconds",
        "backgroundWallpaperOpacity",
        "backgroundWallpaperPosition",
        "backgroundWallpaperRandom",
        "backgroundWallpaperSize",
        "collapseSidebarOnStartup",
        "contextUsageDecimalPlaces",
        "diffHoverFileOpenMode",
        "diffHoverPreviewFontSize",
        "enableBackgroundWallpaper",
        "enableConversationArchiveSidebar",
        "conversationArchiveSidebarDirectoryPanelMode",
        "conversationArchiveSidebarPanelMode",
        "enableContextUsageInline",
        "enableDiffHoverPreview",
        "enableEditedFileCardExternalDiffMiddleClick",
        "enableExternalDiffMiddleClick",
        "enableFileTreeActiveReveal",
        "enableFileTreeFilter",
        "enableMouseGestures",
        "enableStartupSidebar",
        "enableTabDragToChat",
        "enableUsagePanel",
        "hiddenFileTreePatterns",
        "mouseGestureShortcuts",
        "showContextUsageInline",
        "showUsageInLowerLeftPanel",
        "showUsageInEnvironmentPanel",
        "showUsagePanelTokenDetails",
        "showUsagePanelTotalInputTokens",
        "showUsagePanelPing",
        "usagePanelPingEndpoint",
        "usagePanelPingRefreshSeconds",
        "usagePanelTodayTokenSource",
        "uiLanguage",
        "usagePanelAdaptiveWidth",
        "usageRefreshSeconds",
    ]
    .into_iter()
    .collect()
}

/// 这一段校验同步 endpoint。
/// Validate a sync endpoint.
pub fn normalize_sync_endpoint(value: &str) -> Option<String> {
    // 这一段只允许 HTTPS 或本机 HTTP。
    // Allow only HTTPS or local HTTP.
    let raw = value.trim();
    if raw.is_empty() || raw.len() > 500 || raw.contains('\0') {
        return None;
    }
    let url = url::Url::parse(raw).ok()?;
    let local_http =
        url.scheme() == "http" && matches!(url.host_str(), Some("127.0.0.1" | "::1" | "localhost"));
    if url.scheme() != "https" && !local_http {
        return None;
    }
    Some(url.as_str().trim_end_matches('/').to_string())
}

/// 这一段校验 request id。
/// Validate a request id.
pub fn normalize_request_id(value: &str) -> Option<String> {
    // 这一段限制为短安全字符，避免事件回包带任意文本。
    // Restrict ids to short safe characters.
    let raw = value.trim();
    if raw.is_empty()
        || raw.len() > 80
        || !raw
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | ':' | '-'))
    {
        return None;
    }
    Some(raw.to_string())
}

/// 这一段返回错误，供调用方保持类型一致。
/// Return an error while keeping caller type signatures consistent.
pub fn invalid_request(message: &str) -> anyhow::Result<Value> {
    bail!("{message}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parser_drops_unsafe_settings_and_wallpaper_urls() {
        let request = parse_cloud_sync_request(&json!({
            "requestId": "req_cloud",
            "endpoint": "https://example.com/sync",
            "body": {
                "action": "push",
                "syncKey": "1234567890123456",
                "settings": {
                    "uiLanguage": "zh-CN",
                    "localSecretPath": "C:/secret",
                    "backgroundWallpaperImages": "https://example.com/a.webp\nhttps://example.com/a.webp\nhttps://127.0.0.1/b.webp\nhttps://localhost/c.webp\nhttps://10.0.0.1/d.webp\nhttps://192.168.0.1/e.webp\nhttps://172.16.0.1/f.webp\nhttps://169.254.0.1/g.webp\nhttps://[::1]/h.webp\nhttps://[fc00::1]/i.webp\nhttps://[fe80::1]/j.webp\nhttps://[::ffff:127.0.0.1]/k.webp\nhttp://example.com/l.webp"
                }
            }
        })).unwrap();
        assert_eq!(request.body["settings"]["uiLanguage"], "zh-CN");
        assert!(request.body["settings"].get("localSecretPath").is_none());
        assert_eq!(
            request.body["settings"]["backgroundWallpaperImages"],
            "https://example.com/a.webp"
        );
    }

    /// 这一段确认 Rust bridge 保留旧 Node 的冲突保护字段。
    /// Confirm the Rust bridge keeps the legacy Node conflict-protection field.
    #[test]
    fn parser_keeps_base_revision_for_push() {
        // 这一段用设置上传请求模拟多端 revision 冲突保护。
        // Build a settings push request that carries cross-device revision protection.
        let request = parse_cloud_sync_request(&json!({
            "requestId": "req_cloud",
            "endpoint": "https://example.com/sync",
            "body": {
                "action": "push",
                "baseRevision": 7,
                "syncKey": "1234567890123456",
                "settings": {
                    "enableUsagePanel": true
                }
            }
        }))
        .unwrap();

        // 这一段断言 baseRevision 继续传给远端同步服务，而不是在 Rust 净化层丢失。
        // Assert baseRevision still reaches the remote sync service instead of being dropped by Rust sanitization.
        assert_eq!(request.body["baseRevision"], 7);
    }

    /// 这一段确认手动授权重验能绕过 native 成功缓存。
    /// Confirm manual license revalidation can bypass the native success cache.
    #[test]
    fn parser_keeps_force_license_validation_for_pull() {
        // 这一段模拟设置页手动重验和心跳使用的只读拉取请求。
        // Simulate the read-only pull request used by manual revalidation and heartbeat.
        let request = parse_cloud_sync_request(&json!({
            "requestId": "req_cloud",
            "endpoint": "https://example.com/sync",
            "body": {
                "action": "pull",
                "forceLicenseValidation": true,
                "syncKey": "1234567890123456"
            }
        }))
        .unwrap();

        // 这一段断言强制授权标记会保留给 Rust handler，但仍只是布尔控制字段。
        // Assert the force marker reaches the Rust handler while remaining only a boolean control field.
        assert_eq!(request.body["forceLicenseValidation"], true);
    }

    /// 这一段确认本机授权控制字段不会转发到远端同步服务。
    /// Confirm local authorization control fields are not forwarded to the remote sync service.
    #[test]
    fn remote_body_drops_force_license_validation() {
        // 这一段构造已净化的本机请求体，包含强制授权标记。
        // Build a sanitized local request body that includes the force-license marker.
        let body = json!({
            "action": "pull",
            "forceLicenseValidation": true,
            "syncKey": "1234567890123456"
        });

        // 这一段保留业务字段，移除只属于 native bridge 的控制字段。
        // Keep business fields and remove the native-bridge-only control field.
        let remote_body = remote_cloud_sync_body(&body);
        assert_eq!(remote_body["action"], "pull");
        assert_eq!(remote_body["syncKey"], "1234567890123456");
        assert!(remote_body.get("forceLicenseValidation").is_none());
    }

    /// 这一段确认设置 payload 仍受旧 Node 相同大小上限保护。
    /// Confirm settings payloads still use the same size limit as the legacy Node bridge.
    #[test]
    fn parser_rejects_oversized_settings_payload() {
        // 这一段构造超过 16KB 但低于总体 20KB 的设置，专门覆盖设置大小限制。
        // Build settings larger than 16KB but below the overall 20KB body limit to cover the settings limit.
        let oversized_patterns = "a".repeat(17 * 1024);
        let request = parse_cloud_sync_request(&json!({
            "requestId": "req_cloud",
            "endpoint": "https://example.com/sync",
            "body": {
                "action": "push",
                "syncKey": "1234567890123456",
                "settings": {
                    "hiddenFileTreePatterns": oversized_patterns
                }
            }
        }));

        // 这一段拒绝异常大的同步设置，避免原生桥转发超预期 payload。
        // Reject oversized sync settings so the native bridge does not forward unexpected payloads.
        assert!(request.is_none());
    }

    /// 这一段确认同步密钥仍受本机长度上限保护。
    /// Confirm sync keys still use a local maximum length.
    #[test]
    fn parser_rejects_oversized_sync_key() {
        // 这一段构造超过页面输入框上限的密钥，避免原生桥转发异常大授权头。
        // Build a key beyond the page input limit so the bridge does not forward an oversized auth header.
        let request = parse_cloud_sync_request(&json!({
            "requestId": "req_cloud",
            "endpoint": "https://example.com/sync",
            "body": {
                "action": "pull",
                "syncKey": "a".repeat(CLOUD_SYNC_MAX_SYNC_KEY_LENGTH + 1)
            }
        }));

        // 这一段拒绝异常长同步密钥。
        // Reject the oversized sync key.
        assert!(request.is_none());
    }

    /// 这一段确认 Rust 返回形状和旧 Node bridge 保持一致。
    /// Confirm Rust response shape matches the legacy Node bridge.
    #[test]
    fn response_normalization_unwraps_cloud_function_data() {
        // 这一段模拟设置同步接口的真实 pull 响应包装。
        // Simulate the real settings-sync pull response wrapper.
        let response = normalize_cloud_sync_response(
            200,
            r#"{"ok":true,"action":"pull","data":{"exists":false,"revision":0,"settings":{},"updatedAt":null}}"#,
        );

        // 这一段断言页面能直接读取 data.exists，而不是被迫读取 data.data.exists。
        // Assert the page can read data.exists directly instead of data.data.exists.
        assert_eq!(response["ok"], true);
        assert_eq!(response["status"], 200);
        assert_eq!(response["data"]["exists"], false);
        assert!(response["data"].get("data").is_none());
    }

    /// 这一段确认后端 ok=false 不会被 HTTP 200 误判为成功。
    /// Confirm backend ok=false is not misclassified as success under HTTP 200.
    #[test]
    fn response_normalization_honors_backend_failure() {
        // 这一段模拟远端后端用 200 包装业务失败的情况。
        // Simulate a backend business failure wrapped in HTTP 200.
        let response = normalize_cloud_sync_response(
            200,
            r#"{"ok":false,"error":"remote changed","data":{"conflict":true,"currentRevision":8}}"#,
        );

        // 这一段保留错误和 data，让页面冲突处理能正常触发。
        // Keep error and data so page conflict handling can still trigger.
        assert_eq!(response["ok"], false);
        assert_eq!(response["error"], "remote changed");
        assert_eq!(response["data"]["conflict"], true);
    }

    /// 这一段确认授权展示信息位于顶层 license，不污染云端业务 data。
    /// Confirm license display metadata stays under top-level license and does not pollute cloud data.
    #[test]
    fn response_attaches_license_metadata_separately() {
        // 这一段构造已归一化的云端设置响应。
        // Build an already-normalized cloud settings response.
        let mut response = normalize_cloud_sync_response(
            200,
            r#"{"ok":true,"data":{"exists":true,"revision":9}}"#,
        );

        // 这一段附加授权到期时间，只作为页面展示信息。
        // Attach license expiry only as page-display metadata.
        attach_sync_license_authorization(
            &mut response,
            &SyncLicenseAuthorization {
                expires_at: Some("2026-07-01T08:30:00Z".to_string()),
            },
        );

        // 这一段确认设置数据仍维持旧结构。
        // Confirm settings data keeps the old shape.
        assert_eq!(response["data"]["revision"], 9);
        assert!(response["data"].get("license").is_none());
        assert_eq!(response["license"]["expiresAt"], "2026-07-01T08:30:00Z");
    }

    /// 这一段确认 Rust bridge 保留启动侧边栏的真实设置键。
    /// Confirm the Rust bridge keeps the real startup-sidebar setting keys.
    #[test]
    fn parser_keeps_startup_sidebar_settings() {
        // 这一段用页面设置模型和旧 Node bridge 使用的真实键构造同步请求。
        // Build a sync request with the real keys used by the page settings model and old Node bridge.
        let request = parse_cloud_sync_request(&json!({
            "requestId": "req_cloud",
            "endpoint": "https://example.com/sync",
            "body": {
                "action": "push",
                "syncKey": "1234567890123456",
                "settings": {
                    "collapseSidebarOnStartup": true,
                    "enableStartupSidebar": true,
                    "enableStartupSidebarCollapse": true
                }
            }
        }))
        .unwrap();

        // 这一段断言真实键被保留，迁移期误写的旧伪键被丢弃。
        // Assert the real keys survive and the migration typo key is dropped.
        assert_eq!(request.body["settings"]["collapseSidebarOnStartup"], true);
        assert_eq!(request.body["settings"]["enableStartupSidebar"], true);
        assert!(
            request.body["settings"]
                .get("enableStartupSidebarCollapse")
                .is_none()
        );
    }
}
