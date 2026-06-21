use super::crypto::ArchiveCrypto;
use super::remote::post_archive_json;
use super::request::ConversationArchiveRequest;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::collections::HashSet;

/// 这一段描述 pending delete 文件。
/// Describes the pending-delete state file.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
struct PendingDeleteState {
    /// 这一段是待确认删除条目。
    /// Pending delete entries.
    pub entries: Map<String, Value>,
    /// 这一段是 schema 版本。
    /// Schema version.
    #[serde(rename = "schemaVersion")]
    pub schema_version: u64,
    /// 这一段是更新时间。
    /// Updated timestamp.
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
}

/// 这一段描述单条 pending delete。
/// Describes one pending delete entry.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
struct PendingDeleteEntry {
    /// 这一段是创建时间。
    /// Created timestamp.
    #[serde(rename = "createdAt")]
    pub created_at: String,
    /// 这一段是设备 ID。
    /// Device ID.
    #[serde(rename = "deviceId")]
    pub device_id: String,
    /// 这一段是 endpoint hash。
    /// Endpoint hash.
    #[serde(rename = "endpointHash")]
    pub endpoint_hash: String,
    /// 这一段是同步密钥 hash。
    /// Sync-key hash.
    #[serde(rename = "syncKeyHash")]
    pub sync_key_hash: String,
    /// 这一段是更新时间。
    /// Updated timestamp.
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
}

/// 这一段删除远端单设备归档。
/// Delete one remote device archive.
pub async fn delete_device(
    request: &ConversationArchiveRequest,
    archive_crypto: &ArchiveCrypto,
) -> anyhow::Result<Value> {
    // 这一段只发送安全 device id，不上传任何会话正文。
    // Send only the safe device id and no conversation body.
    post_archive_json(
        request,
        &json!({
            "action": "deleteDevice",
            "syncKey": archive_crypto.remote_sync_key(),
            "deviceId": request.device_id,
        }),
    )
    .await
}

/// 这一段记录 pending delete。
/// Remember a pending delete.
pub async fn remember_pending_delete(
    request: &ConversationArchiveRequest,
    sync_key_hash: &str,
) -> anyhow::Result<()> {
    // 这一段先落盘删除意图，避免客户端关闭后马上重传同设备。
    // Persist delete intent first so restarting cannot immediately re-upload the same device.
    if request.device_id.is_empty() {
        return Ok(());
    }
    let mut state = read_pending_state().await;
    let key = pending_key(request, sync_key_hash, &request.device_id);
    let now = crate::state::now_text();
    let previous = state
        .entries
        .get(&key)
        .and_then(|value| serde_json::from_value::<PendingDeleteEntry>(value.clone()).ok());
    state.entries.insert(
        key,
        serde_json::to_value(PendingDeleteEntry {
            created_at: previous
                .as_ref()
                .map(|entry| entry.created_at.clone())
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| now.clone()),
            device_id: request.device_id.clone(),
            endpoint_hash: endpoint_hash(&request.endpoint),
            sync_key_hash: sync_key_hash.to_string(),
            updated_at: now.clone(),
        })?,
    );
    state.schema_version = super::state::INDEX_VERSION;
    state.updated_at = now;
    write_pending_state(&state).await
}

/// 这一段清理 pending delete。
/// Clear a pending delete.
pub async fn forget_pending_delete(
    request: &ConversationArchiveRequest,
    sync_key_hash: &str,
    device_id: &str,
) -> anyhow::Result<()> {
    // 这一段只清理当前 endpoint + sync key + device 的待办。
    // Clear only the pending entry for the current endpoint, sync key, and device.
    let mut state = read_pending_state().await;
    state
        .entries
        .remove(&pending_key(request, sync_key_hash, device_id));
    state.updated_at = crate::state::now_text();
    write_pending_state(&state).await
}

/// 这一段列出当前同步域的 pending 设备。
/// List pending devices for the current sync domain.
pub async fn list_pending_device_ids(
    request: &ConversationArchiveRequest,
    sync_key_hash: &str,
) -> HashSet<String> {
    // 这一段按 endpoint hash 和 sync key hash 隔离多套云端。
    // Isolate multiple cloud endpoints by endpoint hash and sync-key hash.
    let endpoint_hash = endpoint_hash(&request.endpoint);
    read_pending_state()
        .await
        .entries
        .into_values()
        .filter_map(|value| serde_json::from_value::<PendingDeleteEntry>(value).ok())
        .filter(|entry| {
            entry.endpoint_hash == endpoint_hash && entry.sync_key_hash == sync_key_hash
        })
        .map(|entry| entry.device_id)
        .collect()
}

/// 这一段幂等重试 pending 删除。
/// Idempotently retry pending deletes.
pub async fn retry_pending_deletes(
    request: &ConversationArchiveRequest,
    sync_key_hash: &str,
    archive_crypto: &ArchiveCrypto,
) -> anyhow::Result<()> {
    // 这一段列表和上传前调用；失败保留待办给下一轮。
    // Called before list and push; failures remain pending for the next round.
    for device_id in list_pending_device_ids(request, sync_key_hash).await {
        let mut retry_request = request.clone();
        retry_request.device_id = device_id.clone();
        if delete_device(&retry_request, archive_crypto)
            .await
            .ok()
            .and_then(|response| response.get("ok").and_then(Value::as_bool))
            == Some(true)
        {
            let _ = forget_pending_delete(request, sync_key_hash, &device_id).await;
        }
    }
    Ok(())
}

/// 这一段判断删除失败是否可重试。
/// Return whether a delete failure is retryable.
pub fn is_transient_delete_failure(response: &Value) -> bool {
    // 这一段对齐旧 Node：0/408/429/5xx 保持 pending，400 这类永久失败释放。
    // Match legacy Node: keep 0/408/429/5xx pending, release permanent 400-style failures.
    let status = response.get("status").and_then(Value::as_u64).unwrap_or(0);
    status == 0 || status == 408 || status == 429 || status >= 500
}

/// 这一段构造 pending 响应。
/// Build a pending delete response.
pub fn pending_response(
    request: &ConversationArchiveRequest,
    identity: &super::identity::ArchiveIdentity,
    deletes_local_device: bool,
) -> Value {
    // 这一段让前端锁住刷新并短轮询确认。
    // Let the frontend lock refresh and poll for confirmation.
    json!({
        "ok": true,
        "status": 202,
        "data": {
            "deletePending": true,
            "deviceDeletePending": true,
            "deviceId": request.device_id,
            "identity": {
                "deviceId": identity.device_id,
                "profileId": identity.profile_id,
            },
            "localDeviceDeletePending": deletes_local_device,
            "localDeviceUploadBlockedAfterDelete": deletes_local_device,
        },
        "error": "",
    })
}

/// 这一段读取 pending state。
/// Read pending state.
async fn read_pending_state() -> PendingDeleteState {
    // 这一段兼容旧裸 deviceIds 文件，读取失败按空状态处理。
    // Support the old bare deviceIds file and treat read failures as empty state.
    let bytes = match tokio::fs::read(pending_path()).await {
        Ok(bytes) => bytes,
        Err(_) => return PendingDeleteState::default(),
    };
    let value = serde_json::from_slice::<Value>(&bytes).unwrap_or(Value::Null);
    if let Ok(state) = serde_json::from_value::<PendingDeleteState>(value.clone()) {
        return state;
    }
    let mut state = PendingDeleteState::default();
    if let Some(device_ids) = value.get("deviceIds").and_then(Value::as_array) {
        for device_id in device_ids.iter().filter_map(Value::as_str) {
            state.entries.insert(
                device_id.to_string(),
                json!({
                    "createdAt": "",
                    "deviceId": device_id,
                    "endpointHash": "",
                    "syncKeyHash": "",
                    "updatedAt": "",
                }),
            );
        }
    }
    state
}

/// 这一段写入 pending state。
/// Write pending state.
async fn write_pending_state(state: &PendingDeleteState) -> anyhow::Result<()> {
    // 这一段原子性由单文件覆盖满足；不写同步密钥原文或 endpoint。
    // Single-file replacement is sufficient here; raw sync keys or endpoints are never written.
    let path = pending_path();
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    tokio::fs::write(path, serde_json::to_vec_pretty(state)?).await?;
    Ok(())
}

/// 这一段返回 pending delete 状态路径。
/// Return the pending delete state path.
fn pending_path() -> std::path::PathBuf {
    // 这一段沿用 Node 版目录名。
    // Keep the Node implementation's directory name.
    codex_pro_core::paths::codex_pro_data_root_dir()
        .join("conversation-archive")
        .join("pending-device-deletes.json")
}

/// 这一段生成 pending key。
/// Build a pending key.
fn pending_key(
    request: &ConversationArchiveRequest,
    sync_key_hash: &str,
    device_id: &str,
) -> String {
    // 这一段只用 hash 和安全 ID，不把 endpoint 或同步密钥写入 key。
    // Use only hashes and safe IDs, never raw endpoint or sync key.
    format!(
        "{}:{}:{device_id}",
        endpoint_hash(&request.endpoint),
        sync_key_hash
    )
}

/// 这一段计算 endpoint hash。
/// Hash an endpoint.
fn endpoint_hash(endpoint: &str) -> String {
    // 这一段隔离不同远端环境。
    // Isolate different remote environments.
    format!("{:x}", Sha256::digest(endpoint.as_bytes()))
}
