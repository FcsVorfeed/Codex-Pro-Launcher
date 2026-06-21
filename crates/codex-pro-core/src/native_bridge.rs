use serde::{Deserialize, Serialize};

/// 这一段描述注入页和 Rust worker 共享的 native bridge 配置。
/// Describes the native bridge configuration shared by the page and Rust worker.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct NativeBridgeConfig {
    /// 这一段是 CDP Runtime binding 名称。
    /// CDP Runtime binding name.
    #[serde(rename = "bindingName")]
    pub binding_name: String,
    /// 这一段是本次 bridge 会话唯一 id。
    /// Unique bridge session id.
    #[serde(rename = "bridgeId")]
    pub bridge_id: String,
    /// 这一段用于淘汰旧 Node worker。
    /// Protocol version used to reject old Node workers.
    #[serde(rename = "protocolVersion")]
    pub protocol_version: u32,
}
