use codex_pro_core::native_bridge::NativeBridgeConfig;
use uuid::Uuid;

/// 这一段定义 Rust native bridge 协议版本。
/// Rust native bridge protocol version.
pub const NATIVE_BRIDGE_PROTOCOL_VERSION: u32 = 71;
/// 这一段定义页面 binding 名称前缀。
/// Page binding name prefix.
pub const NATIVE_BRIDGE_BINDING_PREFIX: &str = "__codexProNativeBridge";
/// 这一段定义 response 事件名。
/// Response event name.
pub const NATIVE_BRIDGE_RESPONSE_EVENT_NAME: &str = "codex-pro:native-bridge-response";
/// 这一段定义请求最大 JSON 字符数。
/// Maximum request JSON payload length.
pub const NATIVE_BRIDGE_MAX_PAYLOAD_LENGTH: usize = 24_000;

/// 这一段创建新的 bridge 配置。
/// Create a new bridge configuration.
pub fn create_native_bridge_config() -> NativeBridgeConfig {
    // 这一段用 UUID 避免旧 worker 处理新页面请求。
    // Use a UUID so stale workers cannot process new page requests.
    let bridge_id = Uuid::new_v4().to_string();
    NativeBridgeConfig {
        binding_name: format!(
            "{}_{}",
            NATIVE_BRIDGE_BINDING_PREFIX,
            bridge_id.replace('-', "")
        ),
        bridge_id,
        protocol_version: NATIVE_BRIDGE_PROTOCOL_VERSION,
    }
}
