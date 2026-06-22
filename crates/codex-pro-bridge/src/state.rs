use codex_pro_core::native_bridge::NativeBridgeConfig;
use codex_pro_core::paths::codex_pro_data_root_dir;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// 这一段描述 native bridge 状态文件内容。
/// Describes native bridge state-file contents.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct NativeBridgeState {
    /// 这一段是 CDP 调试端口。
    /// CDP debug port.
    #[serde(rename = "debugPort")]
    pub debug_port: u16,
    /// 这一段是 bridge 配置。
    /// Bridge configuration.
    #[serde(rename = "nativeBridge")]
    pub native_bridge: NativeBridgeConfig,
    /// 这一段是启动 worker 时的硬禁用系统列表。
    /// Hard-disabled systems used when the worker was started.
    #[serde(rename = "disabledSystems", default)]
    pub disabled_systems: Vec<String>,
    /// 这一段是 worker pid。
    /// Worker pid.
    pub pid: u32,
    /// 这一段是启动时间。
    /// Start timestamp.
    #[serde(rename = "startedAt")]
    pub started_at: String,
    /// 这一段是 worker 最近心跳。
    /// Latest worker heartbeat timestamp.
    #[serde(rename = "workerHeartbeatAt")]
    pub worker_heartbeat_at: String,
}

/// 这一段返回 bridge 状态文件路径。
/// Return the bridge state-file path.
pub fn native_bridge_state_path(debug_port: u16) -> PathBuf {
    codex_pro_data_root_dir().join(format!("native-bridge-{debug_port}.json"))
}

/// 这一段读取状态文件。
/// Read the bridge state file.
pub async fn read_native_bridge_state(debug_port: u16) -> Option<NativeBridgeState> {
    // 这一段解析失败时按无可复用 worker 处理。
    // Treat parse failures as no reusable worker.
    let path = native_bridge_state_path(debug_port);
    let text = tokio::fs::read_to_string(path).await.ok()?;
    serde_json::from_str(&text).ok()
}

/// 这一段写入状态文件。
/// Write the bridge state file.
pub async fn write_native_bridge_state(state: &NativeBridgeState) -> anyhow::Result<()> {
    // 这一段确保数据根目录存在。
    // Ensure the data root exists.
    let path = native_bridge_state_path(state.debug_port);
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    tokio::fs::write(path, serde_json::to_vec_pretty(state)?).await?;
    Ok(())
}

/// 这一段只清理匹配 bridgeId 的状态文件。
/// Clear only the state file matching a bridge id.
pub async fn clear_native_bridge_state(debug_port: u16, bridge_id: &str) {
    // 这一段避免旧 worker 删除新 worker 状态。
    // Avoid letting an old worker remove a new worker state.
    if let Some(state) = read_native_bridge_state(debug_port).await
        && !bridge_id.is_empty()
        && state.native_bridge.bridge_id != bridge_id
    {
        return;
    }
    let _ = tokio::fs::remove_file(native_bridge_state_path(debug_port)).await;
}

/// 这一段返回当前时间文本。
/// Return the current timestamp text.
pub fn now_text() -> String {
    // 这一段使用 UNIX 毫秒，避免额外时间格式依赖。
    // Use UNIX milliseconds to avoid an extra time formatting dependency.
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    millis.to_string()
}

/// 这一段判断状态心跳是否新鲜。
/// Return whether a state heartbeat is fresh.
pub fn heartbeat_is_fresh(state: &NativeBridgeState, max_age_ms: u128) -> bool {
    // 这一段解析 UNIX 毫秒格式，解析失败视为陈旧。
    // Parse UNIX milliseconds; parse failures are stale.
    let Ok(millis) = state.worker_heartbeat_at.parse::<u128>() else {
        return false;
    };
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    now.saturating_sub(millis) <= max_age_ms
}
