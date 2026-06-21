use crate::handlers::cloud_sync::{normalize_request_id, normalize_sync_endpoint};
use crate::handlers::sync_license::ensure_sync_license;
use anyhow::bail;
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use url::Url;
use uuid::Uuid;

/// 这一段定义宠物同步请求超时。
/// Pet-sync request timeout.
const PET_SYNC_REQUEST_TIMEOUT_MS: u64 = 60_000;
/// 这一段定义宠物同步请求体大小上限。
/// Maximum pet-sync request body size.
const PET_SYNC_MAX_BODY_BYTES: usize = 14 * 1024 * 1024;
/// 这一段定义描述字段长度上限。
/// Maximum description length.
const PET_SYNC_MAX_DESCRIPTION_LENGTH: usize = 500;
/// 这一段定义显示名称长度上限。
/// Maximum display-name length.
const PET_SYNC_MAX_DISPLAY_NAME_LENGTH: usize = 160;
/// 这一段定义 manifest 大小上限。
/// Maximum manifest size.
const PET_SYNC_MAX_MANIFEST_BYTES: usize = 8 * 1024;
/// 这一段定义同步宠物数量上限。
/// Maximum synced pet count.
const PET_SYNC_MAX_PET_COUNT: usize = 20;
/// 这一段定义宠物 ID 长度上限。
/// Maximum pet id length.
const PET_SYNC_MAX_PET_ID_LENGTH: usize = 80;
/// 这一段定义同步密钥长度上限。
/// Maximum sync-key length accepted from the page.
const PET_SYNC_MAX_SYNC_KEY_LENGTH: usize = 160;
/// 这一段定义 spritesheet 单文件大小上限。
/// Maximum spritesheet size.
const PET_SYNC_MAX_SPRITESHEET_BYTES: usize = 5 * 1024 * 1024;
/// 这一段定义单次上传 spritesheet 总大小上限。
/// Maximum total spritesheet size per upload.
const PET_SYNC_MAX_TOTAL_SPRITESHEET_BYTES: usize = 10 * 1024 * 1024;
/// 这一段定义固定 spritesheet 文件名。
/// Fixed spritesheet filename.
const PET_SYNC_SPRITESHEET_FILE_NAME: &str = "spritesheet.webp";

/// 这一段描述宠物同步请求。
/// Describes a pet sync request.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct PetSyncRequest {
    /// 这一段是 request id。
    /// Request id.
    #[serde(rename = "requestId")]
    pub request_id: String,
    /// 这一段是 pull/push action。
    /// Pull/push action.
    pub action: String,
    /// 这一段是 endpoint。
    /// Endpoint.
    pub endpoint: String,
    /// 这一段是同步密钥。
    /// Sync key.
    #[serde(rename = "syncKey")]
    pub sync_key: String,
    /// 这一段是远端 revision。
    /// Remote revision.
    #[serde(rename = "baseRevision")]
    pub base_revision: Option<u64>,
}

/// 这一段保存本机宠物快照。
/// Stores a local pet snapshot.
#[derive(Clone, Debug, PartialEq)]
struct LocalPetSnapshot {
    /// 这一段是可上传的宠物包。
    /// Uploadable pet packages.
    pets: Vec<Value>,
    /// 这一段是本机已选中的自定义宠物。
    /// Selected custom pet.
    selected_avatar_id: String,
    /// 这一段是被跳过的宠物 ID。
    /// Skipped pet ids.
    skipped_pet_ids: Vec<String>,
}

/// 这一段保存云端可拉取宠物包。
/// Stores a cloud pet package ready to pull.
#[derive(Clone, Debug, PartialEq)]
struct PulledPetPackage {
    /// 这一段是宠物 ID。
    /// Pet id.
    id: String,
    /// 这一段是净化后的 manifest。
    /// Sanitized manifest.
    manifest: Value,
    /// 这一段是 spritesheet 字节数。
    /// Spritesheet byte size.
    spritesheet_bytes: usize,
    /// 这一段是 spritesheet SHA-256。
    /// Spritesheet SHA-256.
    spritesheet_sha256: String,
    /// 这一段是 spritesheet 临时下载 URL。
    /// Spritesheet temporary download URL.
    spritesheet_url: String,
}

/// 这一段解析宠物同步请求。
/// Parse a pet sync request.
pub fn parse_pet_sync_request(value: &Value) -> Option<PetSyncRequest> {
    // 这一段只允许页面传控制字段，不允许传文件内容。
    // Allow only control fields from the page, never file contents.
    let request_id = normalize_request_id(value.get("requestId")?.as_str()?)?;
    let action = value.get("action")?.as_str()?.trim().to_ascii_lowercase();
    if action != "pull" && action != "push" {
        return None;
    }

    // 这一段复用设置同步的 endpoint 安全边界。
    // Reuse the cloud-sync endpoint safety boundary.
    let endpoint = normalize_sync_endpoint(value.get("endpoint")?.as_str()?)?;
    let sync_key = truncate_text(
        value.get("syncKey")?.as_str()?.trim(),
        PET_SYNC_MAX_SYNC_KEY_LENGTH,
    );
    if sync_key.len() < 16 || sync_key.contains('\0') {
        return None;
    }

    Some(PetSyncRequest {
        request_id,
        action,
        endpoint,
        sync_key,
        base_revision: value.get("baseRevision").and_then(Value::as_u64),
    })
}

/// 这一段运行宠物同步请求。
/// Run a pet sync request.
pub async fn run_pet_sync_request(request: &PetSyncRequest) -> anyhow::Result<Value> {
    // 这一段先校验同一把同步密钥，避免宠物同步绕过设置同步授权。
    // Validate the same sync key first so pet sync cannot bypass settings-sync authorization.
    if let Err(error) = ensure_sync_license(&request.sync_key).await {
        return Ok(error.into_response());
    }

    // 这一段根据 action 选择 push 或 pull。
    // Dispatch by action.
    if request.action == "push" {
        push_pets(request).await
    } else {
        pull_pets(request).await
    }
}

/// 这一段上传本机宠物资源。
/// Push local pet resources.
async fn push_pets(request: &PetSyncRequest) -> anyhow::Result<Value> {
    // 这一段读取本机自定义宠物目录并打包成旧 Node bridge 相同的 JSON。
    // Read local custom pet directories and package them as the legacy Node bridge JSON.
    let snapshot = read_local_pet_snapshot().await?;
    let body = build_pet_push_body(request, &snapshot);
    let mut response = post_pet_json(&request.endpoint, &body).await?;

    // 这一段把本机跳过项补回 data，让页面侧仍能获得轻量摘要。
    // Add skipped local package ids back to data so the page can keep a light summary.
    if !snapshot.skipped_pet_ids.is_empty()
        && let Some(data) = response.get_mut("data").and_then(Value::as_object_mut)
    {
        data.insert("skippedPetIds".to_string(), json!(snapshot.skipped_pet_ids));
    }
    Ok(response)
}

/// 这一段拉取远端宠物资源。
/// Pull remote pet resources.
async fn pull_pets(request: &PetSyncRequest) -> anyhow::Result<Value> {
    // 这一段先请求远端 manifest，失败或空快照直接把标准响应交回页面。
    // Request the remote manifest first; failures or empty snapshots return the normalized response.
    let response = post_pet_json(
        &request.endpoint,
        &json!({
            "action": "pull",
            "syncKey": request.sync_key.as_str(),
        }),
    )
    .await?;
    if response.get("ok").and_then(Value::as_bool) != Some(true)
        || response.pointer("/data/exists").and_then(Value::as_bool) != Some(true)
    {
        return Ok(response);
    }

    // 这一段下载并写入通过校验的宠物包，然后把落盘摘要并回 data。
    // Download and write verified packages, then merge the local write summary into data.
    let client = create_pet_http_client()?;
    let applied =
        apply_pulled_pet_snapshot(&client, response.get("data").unwrap_or(&Value::Null)).await?;
    Ok(merge_pet_pull_applied_data(response, applied))
}

/// 这一段构造上传请求体。
/// Build the push request body.
fn build_pet_push_body(request: &PetSyncRequest, snapshot: &LocalPetSnapshot) -> Value {
    // 这一段只在页面传入 baseRevision 时保留冲突保护字段，force 覆盖时不写 0。
    // Keep baseRevision only when the page supplies it; force overwrite must not send zero.
    let mut body = Map::new();
    body.insert("action".to_string(), Value::String("push".to_string()));
    body.insert("pets".to_string(), Value::Array(snapshot.pets.clone()));
    body.insert(
        "selectedAvatarId".to_string(),
        Value::String(snapshot.selected_avatar_id.clone()),
    );
    body.insert(
        "syncKey".to_string(),
        Value::String(request.sync_key.clone()),
    );
    if let Some(base_revision) = request.base_revision {
        body.insert("baseRevision".to_string(), json!(base_revision));
    }
    Value::Object(body)
}

/// 这一段读取本机宠物快照。
/// Read the local pet snapshot.
async fn read_local_pet_snapshot() -> anyhow::Result<LocalPetSnapshot> {
    // 这一段从当前 Codex home 读取真实宠物目录。
    // Read the real pet directory from the current Codex home.
    let codex_home = codex_pro_core::paths::codex_home_dir();
    read_local_pet_snapshot_from(&codex_home).await
}

/// 这一段按指定 Codex home 读取本机宠物快照。
/// Read a local pet snapshot from a specific Codex home.
async fn read_local_pet_snapshot_from(codex_home: &Path) -> anyhow::Result<LocalPetSnapshot> {
    // 这一段扫描本机自定义宠物根目录，并限制数量和总资源大小。
    // Scan the local custom-pet root while bounding count and total resource size.
    let pets_root = get_codex_pets_root_dir(codex_home);
    let mut entries = Vec::new();
    if let Ok(mut read_dir) = tokio::fs::read_dir(&pets_root).await {
        while let Some(entry) = read_dir.next_entry().await? {
            if entry
                .file_type()
                .await
                .is_ok_and(|file_type| file_type.is_dir())
            {
                entries.push(entry);
            }
        }
    }
    entries.sort_by_key(|left| left.file_name());

    // 这一段逐个读取合法宠物包，任何坏包只跳过不中断整个同步。
    // Read valid pet packages one by one; invalid packages are skipped without aborting sync.
    let mut pets = Vec::new();
    let mut skipped_pet_ids = Vec::new();
    let mut total_spritesheet_bytes = 0usize;
    for entry in entries {
        let entry_name = entry.file_name().to_string_lossy().to_string();
        if pets.len() >= PET_SYNC_MAX_PET_COUNT {
            skipped_pet_ids.push(entry_name);
            continue;
        }

        let Some(pet_package) = read_local_pet_package(&pets_root, &entry_name).await? else {
            skipped_pet_ids.push(entry_name);
            continue;
        };
        let spritesheet_bytes = pet_package
            .get("spritesheetBytes")
            .and_then(Value::as_u64)
            .unwrap_or(0) as usize;
        if total_spritesheet_bytes + spritesheet_bytes > PET_SYNC_MAX_TOTAL_SPRITESHEET_BYTES {
            skipped_pet_ids.push(
                pet_package
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or(&entry_name)
                    .to_string(),
            );
            continue;
        }
        total_spritesheet_bytes += spritesheet_bytes;
        pets.push(pet_package);
    }

    // 这一段只同步仍存在于本次快照中的自定义宠物选择。
    // Sync only the custom avatar selection that still exists in this snapshot.
    let pet_ids = pets
        .iter()
        .filter_map(|pet| pet.get("id").and_then(Value::as_str).map(str::to_string))
        .collect::<HashSet<_>>();
    let selected_avatar_id = normalize_custom_avatar_id(
        &read_selected_custom_avatar_id_from(codex_home).await?,
        Some(&pet_ids),
    );
    Ok(LocalPetSnapshot {
        pets,
        selected_avatar_id,
        skipped_pet_ids: skipped_pet_ids
            .into_iter()
            .take(PET_SYNC_MAX_PET_COUNT)
            .collect(),
    })
}

/// 这一段读取单个本机宠物包。
/// Read one local pet package.
async fn read_local_pet_package(
    pets_root: &Path,
    entry_name: &str,
) -> anyhow::Result<Option<Value>> {
    // 这一段用目录名作为 fallback id，并再次校验最终路径不逃逸。
    // Use the directory name as the fallback id and verify the final path cannot escape.
    let Some(fallback_id) = normalize_pet_id(entry_name) else {
        return Ok(None);
    };
    let Some(pet_dir) = resolve_pet_directory(pets_root, &fallback_id) else {
        return Ok(None);
    };

    // 这一段读取并净化 pet.json，只保留 Codex 宠物包契约字段。
    // Read and sanitize pet.json, keeping only Codex pet-package contract fields.
    let raw_manifest = match tokio::fs::read(pet_dir.join("pet.json")).await {
        Ok(bytes) if bytes.len() <= PET_SYNC_MAX_MANIFEST_BYTES => bytes,
        _ => return Ok(None),
    };
    let Some(manifest_source) = parse_pet_json_bytes(&raw_manifest) else {
        return Ok(None);
    };
    let Some(manifest) = sanitize_pet_manifest(Some(&manifest_source), &fallback_id) else {
        return Ok(None);
    };
    let pet_id = manifest
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();

    // 这一段读取固定 spritesheet 文件并计算完整性元数据。
    // Read the fixed spritesheet file and compute integrity metadata.
    let spritesheet = match tokio::fs::read(pet_dir.join(PET_SYNC_SPRITESHEET_FILE_NAME)).await {
        Ok(bytes) if !bytes.is_empty() && bytes.len() <= PET_SYNC_MAX_SPRITESHEET_BYTES => bytes,
        _ => return Ok(None),
    };
    Ok(Some(json!({
        "id": pet_id,
        "manifest": manifest,
        "spritesheetBase64": base64::engine::general_purpose::STANDARD.encode(&spritesheet),
        "spritesheetBytes": spritesheet.len(),
        "spritesheetSha256": sha256_hex(&spritesheet),
    })))
}

/// 这一段应用云端宠物快照。
/// Apply a pulled pet snapshot.
async fn apply_pulled_pet_snapshot(
    client: &reqwest::Client,
    data: &Value,
) -> anyhow::Result<Value> {
    // 这一段从当前 Codex home 写入真实宠物目录。
    // Write into the real pet directory under the current Codex home.
    let codex_home = codex_pro_core::paths::codex_home_dir();
    apply_pulled_pet_snapshot_from(client, &codex_home, data).await
}

/// 这一段按指定 Codex home 应用云端宠物快照。
/// Apply a pulled pet snapshot into a specific Codex home.
async fn apply_pulled_pet_snapshot_from(
    client: &reqwest::Client,
    codex_home: &Path,
    data: &Value,
) -> anyhow::Result<Value> {
    // 这一段收敛云端返回的包结构，拒绝缺少临时 URL 或完整性字段的条目。
    // Collapse cloud-returned package structures and reject entries missing temp URLs or integrity fields.
    let pet_packages = data
        .get("pets")
        .and_then(Value::as_array)
        .map(|pets| {
            pets.iter()
                .filter_map(sanitize_pulled_pet_package)
                .take(PET_SYNC_MAX_PET_COUNT)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    // 这一段只覆盖同名宠物包，不删除用户本机已有的其它宠物。
    // Overwrite same-name packages only; do not delete any other local pets.
    let pets_root = get_codex_pets_root_dir(codex_home);
    tokio::fs::create_dir_all(&pets_root).await?;
    for pet_package in &pet_packages {
        write_pulled_pet_package(client, &pets_root, pet_package).await?;
    }

    // 这一段只在云端选择指向已写入宠物时更新 selected-avatar-id。
    // Update selected-avatar-id only when the cloud selection points at a written pet.
    let written_pet_ids = pet_packages
        .iter()
        .map(|pet| pet.id.clone())
        .collect::<HashSet<_>>();
    let selected_avatar_id = normalize_custom_avatar_id(
        data.get("selectedAvatarId")
            .and_then(Value::as_str)
            .unwrap_or_default(),
        Some(&written_pet_ids),
    );
    let selected_avatar_updated =
        write_selected_custom_avatar_id_from(codex_home, &selected_avatar_id, &written_pet_ids)
            .await?;
    Ok(json!({
        "petCount": pet_packages.len(),
        "selectedAvatarId": if selected_avatar_updated { selected_avatar_id } else { String::new() },
    }))
}

/// 这一段写入单个拉取到的宠物包。
/// Write one pulled pet package.
async fn write_pulled_pet_package(
    client: &reqwest::Client,
    pets_root: &Path,
    pet_package: &PulledPetPackage,
) -> anyhow::Result<()> {
    // 这一段先下载并校验 spritesheet，校验失败不写入本机。
    // Download and verify the spritesheet before writing anything locally.
    let spritesheet = download_pet_spritesheet(client, pet_package).await?;
    let Some(pet_dir) = resolve_pet_directory(pets_root, &pet_package.id) else {
        bail!("宠物 ID 无效 / Invalid pet id");
    };

    // 这一段使用临时文件写入，避免中断时留下半个资源文件。
    // Write through temporary files so interruptions do not leave partial assets.
    tokio::fs::create_dir_all(&pet_dir).await?;
    let manifest_text = format!("{}\n", serde_json::to_string_pretty(&pet_package.manifest)?);
    write_file_atomically(&pet_dir.join("pet.json"), manifest_text.as_bytes()).await?;
    write_file_atomically(&pet_dir.join(PET_SYNC_SPRITESHEET_FILE_NAME), &spritesheet).await?;
    Ok(())
}

/// 这一段下载并校验 spritesheet。
/// Download and verify a spritesheet.
async fn download_pet_spritesheet(
    client: &reqwest::Client,
    pet_package: &PulledPetPackage,
) -> anyhow::Result<Vec<u8>> {
    // 这一段只请求已经净化过的 HTTPS 或本机 HTTP 临时链接。
    // Request only sanitized HTTPS or local HTTP temporary URLs.
    let response = client.get(&pet_package.spritesheet_url).send().await?;
    if !response.status().is_success() {
        bail!("宠物资源下载失败 / Pet resource download failed");
    }
    let spritesheet = response.bytes().await?.to_vec();

    // 这一段用字节数和 SHA-256 双重校验云端下载内容。
    // Verify the cloud download with both byte size and SHA-256.
    if spritesheet.len() != pet_package.spritesheet_bytes
        || spritesheet.len() > PET_SYNC_MAX_SPRITESHEET_BYTES
    {
        bail!("宠物资源大小校验失败 / Pet resource size verification failed");
    }
    if sha256_hex(&spritesheet) != pet_package.spritesheet_sha256 {
        bail!("宠物资源哈希校验失败 / Pet resource hash verification failed");
    }
    Ok(spritesheet)
}

/// 这一段发送宠物同步 JSON。
/// Send pet-sync JSON.
async fn post_pet_json(endpoint: &str, body: &Value) -> anyhow::Result<Value> {
    // 这一段在网络请求前检查 base64 后的 JSON 体积，保持旧 Node 14 MiB 上限。
    // Check the base64-expanded JSON body before the request, keeping the legacy 14 MiB limit.
    let body_bytes = serde_json::to_vec(body)?;
    if body_bytes.len() > PET_SYNC_MAX_BODY_BYTES {
        bail!("宠物同步请求体过大 / Pet sync request body too large");
    }

    // 这一段使用 Rust 网络请求并限制超时。
    // Use Rust networking with bounded timeout.
    let client = create_pet_http_client()?;
    let response = client
        .post(endpoint)
        .header("content-type", "application/json")
        .body(body_bytes)
        .send()
        .await?;
    let status = response.status().as_u16();
    let text = response.text().await.unwrap_or_default();
    Ok(normalize_pet_sync_response(status, &text))
}

/// 这一段创建宠物同步 HTTP client。
/// Create a pet-sync HTTP client.
fn create_pet_http_client() -> anyhow::Result<reqwest::Client> {
    // 这一段禁用代理并设置整体超时，对齐旧 launcher 直接执行请求的边界。
    // Disable proxies and set an overall timeout to match the legacy launcher request boundary.
    Ok(reqwest::Client::builder()
        .timeout(Duration::from_millis(PET_SYNC_REQUEST_TIMEOUT_MS))
        .no_proxy()
        .build()?)
}

/// 这一段把云函数响应归一化成旧 Node bridge 期望形状。
/// Normalize cloud-function responses into the legacy Node bridge shape.
fn normalize_pet_sync_response(status: u16, text: &str) -> Value {
    // 这一段只向页面返回 data/error/ok/status，避免把云函数外层包装当成业务数据。
    // Return only data/error/ok/status so the cloud wrapper is not mistaken for business data.
    let payload = serde_json::from_str::<Value>(text).unwrap_or_else(|_| json!({}));
    let payload_ok = payload.get("ok").and_then(Value::as_bool).unwrap_or(true);
    json!({
        "ok": (200..300).contains(&status) && payload_ok,
        "status": status,
        "data": payload.get("data").cloned().unwrap_or(Value::Null),
        "error": payload.get("error").and_then(Value::as_str).unwrap_or(""),
    })
}

/// 这一段把拉取落盘结果并回响应 data。
/// Merge pulled write results into response data.
fn merge_pet_pull_applied_data(mut response: Value, applied: Value) -> Value {
    // 这一段保持响应外层不变，只补充 data.petCount 和 data.selectedAvatarId。
    // Keep the response wrapper unchanged and only add data.petCount and data.selectedAvatarId.
    if let (Some(data), Some(applied)) = (
        response.get_mut("data").and_then(Value::as_object_mut),
        applied.as_object(),
    ) {
        for (key, value) in applied {
            data.insert(key.clone(), value.clone());
        }
    }
    response
}

/// 这一段净化云端返回的宠物包。
/// Sanitize a pulled pet package.
fn sanitize_pulled_pet_package(value: &Value) -> Option<PulledPetPackage> {
    // 这一段只接受对象，并把 manifest 收敛到本机可写的最小结构。
    // Accept only objects and collapse manifest into the smallest local writable shape.
    let source = value.as_object()?;
    let manifest = sanitize_pet_manifest(
        source.get("manifest"),
        source.get("id").and_then(Value::as_str).unwrap_or_default(),
    )?;
    let id = manifest.get("id")?.as_str()?.to_string();
    let spritesheet_url = normalize_pet_sync_download_url(
        source
            .get("spritesheetUrl")
            .or_else(|| source.get("spritesheetURL"))
            .or_else(|| source.get("tempFileURL"))
            .and_then(Value::as_str)
            .unwrap_or_default(),
    )?;
    let spritesheet_sha256 = normalize_pet_sync_hash(
        source
            .get("spritesheetSha256")
            .and_then(Value::as_str)
            .unwrap_or_default(),
    )?;
    let spritesheet_bytes = source.get("spritesheetBytes")?.as_u64()? as usize;
    if spritesheet_bytes == 0 || spritesheet_bytes > PET_SYNC_MAX_SPRITESHEET_BYTES {
        return None;
    }
    Some(PulledPetPackage {
        id,
        manifest,
        spritesheet_bytes,
        spritesheet_sha256,
        spritesheet_url,
    })
}

/// 这一段净化宠物 manifest。
/// Sanitize a pet manifest.
fn sanitize_pet_manifest(value: Option<&Value>, fallback_id: &str) -> Option<Value> {
    // 这一段把 pet.json 收敛到 Codex 宠物包契约字段，排除本机路径或扩展字段。
    // Collapse pet.json to the Codex pet-package contract, excluding local paths or extension fields.
    let source = value.and_then(Value::as_object);
    let id = source
        .and_then(|object| object.get("id"))
        .and_then(Value::as_str)
        .and_then(normalize_pet_id)
        .or_else(|| normalize_pet_id(fallback_id))?;
    let description = source
        .and_then(|object| object.get("description"))
        .and_then(Value::as_str)
        .map(|text| normalize_pet_text(text, PET_SYNC_MAX_DESCRIPTION_LENGTH))
        .unwrap_or_default();
    let display_name = source
        .and_then(|object| object.get("displayName"))
        .and_then(Value::as_str)
        .map(|text| normalize_pet_text(text, PET_SYNC_MAX_DISPLAY_NAME_LENGTH))
        .filter(|text| !text.is_empty())
        .unwrap_or_else(|| id.clone());

    // 这一段固定 spritesheetPath，并只保留合法 kind。
    // Fix spritesheetPath and keep only a valid kind marker.
    let mut manifest = Map::new();
    manifest.insert("description".to_string(), Value::String(description));
    manifest.insert("displayName".to_string(), Value::String(display_name));
    manifest.insert("id".to_string(), Value::String(id));
    manifest.insert(
        "spritesheetPath".to_string(),
        Value::String(PET_SYNC_SPRITESHEET_FILE_NAME.to_string()),
    );
    if let Some(kind) = source
        .and_then(|object| object.get("kind"))
        .and_then(Value::as_str)
        .and_then(normalize_pet_kind)
    {
        manifest.insert("kind".to_string(), Value::String(kind));
    }
    Some(Value::Object(manifest))
}

/// 这一段解析 pet.json 字节。
/// Parse pet.json bytes.
fn parse_pet_json_bytes(bytes: &[u8]) -> Option<Value> {
    // 这一段兼容带 UTF-8 BOM 的 pet.json，避免合法自定义宠物被跳过。
    // Support UTF-8 BOM in pet.json so valid custom pets are not skipped.
    let text = String::from_utf8_lossy(bytes);
    serde_json::from_str(text.trim_start_matches('\u{feff}')).ok()
}

/// 这一段读取本机自定义宠物选择。
/// Read the local selected custom avatar id.
async fn read_selected_custom_avatar_id_from(codex_home: &Path) -> anyhow::Result<String> {
    // 这一段只读取 config.toml 中 selected-avatar-id 一行，失败时视为没有可同步选择。
    // Read only selected-avatar-id from config.toml; failures mean no syncable selection.
    let config_text = match tokio::fs::read_to_string(get_codex_config_path(codex_home)).await {
        Ok(text) => text,
        Err(_) => return Ok(String::new()),
    };
    Ok(config_text
        .lines()
        .find_map(parse_selected_avatar_id_line)
        .map(|value| normalize_custom_avatar_id(&value, None))
        .unwrap_or_default())
}

/// 这一段写入本机自定义宠物选择。
/// Write the local selected custom avatar id.
async fn write_selected_custom_avatar_id_from(
    codex_home: &Path,
    selected_avatar_id: &str,
    known_pet_ids: &HashSet<String>,
) -> anyhow::Result<bool> {
    // 这一段只在选择项有效且指向已写入宠物时更新配置。
    // Update config only when the selection is valid and points at a written pet.
    let normalized_avatar_id = normalize_custom_avatar_id(selected_avatar_id, Some(known_pet_ids));
    if normalized_avatar_id.is_empty() {
        return Ok(false);
    }

    // 这一段保留其它配置行，只替换或追加 selected-avatar-id。
    // Preserve other config lines and only replace or append selected-avatar-id.
    let config_path = get_codex_config_path(codex_home);
    let config_text = tokio::fs::read_to_string(&config_path)
        .await
        .unwrap_or_default();
    let next_line = format!(
        "selected-avatar-id = \"{}\"",
        escape_toml_string(&normalized_avatar_id)
    );
    let mut replaced = false;
    let mut output = String::new();
    for line in config_text.lines() {
        if !replaced && parse_selected_avatar_id_line(line).is_some() {
            output.push_str(&next_line);
            replaced = true;
        } else {
            output.push_str(line);
        }
        output.push('\n');
    }
    if !replaced {
        if !output.trim().is_empty() && !output.ends_with('\n') {
            output.push('\n');
        }
        output.push_str(&next_line);
        output.push('\n');
    }
    write_file_atomically(&config_path, output.as_bytes()).await?;
    Ok(true)
}

/// 这一段解析 selected-avatar-id 配置行。
/// Parse a selected-avatar-id config line.
fn parse_selected_avatar_id_line(line: &str) -> Option<String> {
    // 这一段对齐旧 Node 正则，只读取双引号中的单行值。
    // Match the legacy Node regex by reading one quoted single-line value.
    let trimmed = line.trim_start();
    let rest = trimmed.strip_prefix("selected-avatar-id")?.trim_start();
    let rest = rest.strip_prefix('=')?.trim_start();
    let rest = rest.strip_prefix('"')?;
    let end = rest.find('"')?;
    Some(rest[..end].to_string())
}

/// 这一段转义 TOML 字符串。
/// Escape a TOML string.
fn escape_toml_string(value: &str) -> String {
    // 这一段只转义写回所需的最小字符集合。
    // Escape only the minimal character set needed for writes.
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

/// 这一段返回宠物根目录。
/// Return the pets root directory.
fn get_codex_pets_root_dir(codex_home: &Path) -> PathBuf {
    // 这一段固定在 Codex home 下的 pets 目录。
    // Keep pet packages under the pets directory in Codex home.
    codex_home.join("pets")
}

/// 这一段返回 Codex 配置路径。
/// Return the Codex config path.
fn get_codex_config_path(codex_home: &Path) -> PathBuf {
    // 这一段只用于 selected-avatar-id 读写。
    // Used only for selected-avatar-id reads and writes.
    codex_home.join("config.toml")
}

/// 这一段解析宠物目录路径。
/// Resolve a pet directory path.
fn resolve_pet_directory(pets_root: &Path, pet_id: &str) -> Option<PathBuf> {
    // 这一段用已净化宠物 ID 组合路径，并拒绝空路径。
    // Join a sanitized pet id and reject empty paths.
    normalize_pet_id(pet_id).map(|id| pets_root.join(id))
}

/// 这一段清洗宠物 id。
/// Sanitize a pet id.
fn normalize_pet_id(value: &str) -> Option<String> {
    // 这一段只接受单段安全文件夹名，避免写入 ~/.codex/pets 之外。
    // Accept only one safe folder segment so writes cannot escape ~/.codex/pets.
    let raw = truncate_text(value.trim(), PET_SYNC_MAX_PET_ID_LENGTH);
    if raw == "." || raw == ".." {
        return None;
    }
    let mut chars = raw.chars();
    let first = chars.next()?;
    if !first.is_ascii_alphanumeric() {
        return None;
    }
    if !chars.all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-')) {
        return None;
    }
    Some(raw)
}

/// 这一段清洗 manifest 文本。
/// Sanitize manifest text.
fn normalize_pet_text(value: &str, max_length: usize) -> String {
    // 这一段去掉控制字符并按旧 Node 上限截断。
    // Remove control characters and truncate with the legacy Node limits.
    truncate_text(
        value
            .chars()
            .filter(|ch| !is_removed_pet_text_control_char(*ch))
            .collect::<String>()
            .trim(),
        max_length,
    )
}

/// 这一段判断 manifest 文本中应移除的控制字符。
/// Decide which manifest text control characters should be removed.
fn is_removed_pet_text_control_char(ch: char) -> bool {
    // 这一段对齐旧 Node 正则，保留 tab/newline/carriage-return。
    // Match the legacy Node regex while keeping tab, newline, and carriage return.
    matches!(ch, '\u{0}'..='\u{8}' | '\u{b}' | '\u{c}' | '\u{e}'..='\u{1f}')
}

/// 这一段清洗 manifest kind。
/// Sanitize manifest kind.
fn normalize_pet_kind(value: &str) -> Option<String> {
    // 这一段只保留简短 ASCII kind 标记。
    // Keep only a short ASCII kind marker.
    let kind = truncate_text(value.trim(), 40);
    if kind.is_empty()
        || !kind
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | ':' | '-'))
    {
        return None;
    }
    Some(kind)
}

/// 这一段清洗自定义宠物选择。
/// Sanitize a custom avatar id.
fn normalize_custom_avatar_id(value: &str, known_pet_ids: Option<&HashSet<String>>) -> String {
    // 这一段只接受 custom:<pet-id>，避免把内置头像或其它 Codex 配置混入同步域。
    // Accept only custom:<pet-id> so built-in avatars or other Codex config stay outside this sync domain.
    let raw = truncate_text(value.trim(), 120);
    let Some(pet_id) = raw.strip_prefix("custom:").and_then(normalize_pet_id) else {
        return String::new();
    };
    if known_pet_ids.is_some_and(|ids| !ids.contains(&pet_id)) {
        return String::new();
    }
    format!("custom:{pet_id}")
}

/// 这一段清洗 SHA-256 字符串。
/// Sanitize a SHA-256 string.
fn normalize_pet_sync_hash(value: &str) -> Option<String> {
    // 这一段只接受 SHA-256 十六进制哈希。
    // Accept only SHA-256 hex hashes.
    let hash = value.trim().to_ascii_lowercase();
    if hash.len() != 64 || !hash.chars().all(|ch| ch.is_ascii_hexdigit()) {
        return None;
    }
    Some(hash)
}

/// 这一段清洗云端临时下载 URL。
/// Sanitize a cloud temporary download URL.
fn normalize_pet_sync_download_url(value: &str) -> Option<String> {
    // 这一段只允许 HTTPS 或本机 HTTP，避免云端文档驱动本机请求任意协议。
    // Allow only HTTPS or local HTTP so cloud docs cannot drive arbitrary native requests.
    let raw = value.trim();
    if raw.is_empty() || raw.len() > 2000 || raw.contains('\0') {
        return None;
    }
    let url = Url::parse(raw).ok()?;
    let is_local_http =
        url.scheme() == "http" && matches!(url.host_str(), Some("127.0.0.1" | "::1" | "localhost"));
    if url.scheme() != "https" && !is_local_http {
        return None;
    }
    Some(url.to_string())
}

/// 这一段截断字符串。
/// Truncate a string by characters.
fn truncate_text(value: &str, max_length: usize) -> String {
    // 这一段按 char 截断，避免 UTF-8 中间截断导致无效字符串。
    // Truncate by char so UTF-8 strings are not cut in the middle.
    value.chars().take(max_length).collect()
}

/// 这一段计算 sha256 hex。
/// Compute sha256 hex.
fn sha256_hex(bytes: &[u8]) -> String {
    // 这一段用于校验远端和本机 spritesheet 内容。
    // Used to verify local and remote spritesheet content.
    format!("{:x}", Sha256::digest(bytes))
}

/// 这一段原子写入文件。
/// Write a file atomically.
async fn write_file_atomically(path: &Path, content: &[u8]) -> anyhow::Result<()> {
    // 这一段先创建父目录并写临时文件。
    // Create the parent directory and write a temporary file first.
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("codex-pro-file");
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    let temp_path = path.with_file_name(format!(
        "{file_name}.codex-pro-tmp-{}-{timestamp}-{}",
        std::process::id(),
        Uuid::new_v4()
    ));
    if let Err(error) = write_file_atomically_inner(path, &temp_path, content).await {
        let _ = tokio::fs::remove_file(&temp_path).await;
        return Err(error);
    }
    Ok(())
}

/// 这一段执行原子写入主体。
/// Execute the atomic write body.
async fn write_file_atomically_inner(
    path: &Path,
    temp_path: &Path,
    content: &[u8],
) -> anyhow::Result<()> {
    // 这一段先写完整临时文件，再替换目标文件。
    // Write the full temporary file before replacing the target.
    tokio::fs::write(temp_path, content).await?;
    match tokio::fs::rename(temp_path, path).await {
        Ok(()) => Ok(()),
        Err(first_error) => {
            // 这一段处理 Windows 上 rename 不覆盖既有文件的情况。
            // Handle Windows rename behavior where existing files may not be overwritten.
            if tokio::fs::try_exists(path).await.unwrap_or(false) {
                tokio::fs::remove_file(path).await?;
                tokio::fs::rename(temp_path, path).await?;
                Ok(())
            } else {
                Err(first_error.into())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// 这一段构造测试请求。
    /// Build a test request.
    fn test_request(base_revision: Option<u64>) -> PetSyncRequest {
        // 这一段固定可复用的宠物同步控制请求。
        // Keep a reusable pet-sync control request.
        PetSyncRequest {
            action: "push".to_string(),
            base_revision,
            endpoint: "https://example.com/pet-sync".to_string(),
            request_id: "req_pet".to_string(),
            sync_key: "1234567890123456".to_string(),
        }
    }

    /// 这一段写入测试宠物包。
    /// Write a test pet package.
    fn write_test_pet(codex_home: &Path) {
        // 这一段创建带 BOM 和多余字段的本机宠物包，覆盖旧 Node 的净化路径。
        // Create a local pet package with BOM and extra fields to cover legacy sanitization.
        let pet_dir = codex_home.join("pets").join("sherry");
        fs::create_dir_all(&pet_dir).unwrap();
        fs::write(
            pet_dir.join("pet.json"),
            b"\xEF\xBB\xBF{\"id\":\"sherry\",\"displayName\":\" Sherry \",\"description\":\" hi\\u0001 \",\"spritesheetPath\":\"ignored.webp\",\"kind\":\"person\",\"localPath\":\"C:/secret\"}",
        )
        .unwrap();
        fs::write(pet_dir.join("spritesheet.webp"), b"sprite-bytes").unwrap();
        fs::write(
            codex_home.join("config.toml"),
            "model = \"gpt\"\nselected-avatar-id = \"custom:sherry\"\n",
        )
        .unwrap();
    }

    /// 这一段确认上传体匹配旧 Node bridge 和云函数契约。
    /// Confirm the push body matches the legacy Node bridge and cloud-function contract.
    #[tokio::test]
    async fn push_body_matches_legacy_pet_sync_contract() {
        // 这一段从临时 Codex home 读取本机宠物快照。
        // Read a local pet snapshot from a temporary Codex home.
        let temp = tempfile::tempdir().unwrap();
        write_test_pet(temp.path());
        let snapshot = read_local_pet_snapshot_from(temp.path()).await.unwrap();
        let body = build_pet_push_body(&test_request(Some(2)), &snapshot);

        // 这一段断言上传体使用 id/spritesheetBytes/selectedAvatarId，而不是迁移期 petId 形状。
        // Assert the upload body uses id/spritesheetBytes/selectedAvatarId instead of the migration petId shape.
        assert_eq!(body["action"], "push");
        assert_eq!(body["baseRevision"], 2);
        assert_eq!(body["selectedAvatarId"], "custom:sherry");
        assert_eq!(body["pets"][0]["id"], "sherry");
        assert!(body["pets"][0].get("petId").is_none());
        assert_eq!(body["pets"][0]["spritesheetBytes"], 12);
        assert_eq!(
            body["pets"][0]["spritesheetSha256"],
            sha256_hex(b"sprite-bytes")
        );
        assert_eq!(
            body["pets"][0]["manifest"]["spritesheetPath"],
            "spritesheet.webp"
        );
        assert_eq!(body["pets"][0]["manifest"]["displayName"], "Sherry");
        assert_eq!(body["pets"][0]["manifest"]["description"], "hi");
        assert!(body["pets"][0]["manifest"].get("localPath").is_none());
    }

    /// 这一段确认 force 覆盖时不伪造 baseRevision=0。
    /// Confirm force overwrite does not fabricate baseRevision=0.
    #[tokio::test]
    async fn push_body_omits_base_revision_when_absent() {
        // 这一段构造没有 baseRevision 的上传体。
        // Build a push body without baseRevision.
        let temp = tempfile::tempdir().unwrap();
        write_test_pet(temp.path());
        let snapshot = read_local_pet_snapshot_from(temp.path()).await.unwrap();
        let body = build_pet_push_body(&test_request(None), &snapshot);

        // 这一段断言没有 revision 时字段不存在，而不是写成 0。
        // Assert the field is absent when no revision is provided instead of being set to zero.
        assert!(body.get("baseRevision").is_none());
    }

    /// 这一段确认宠物同步响应会解开远端外层包装。
    /// Confirm pet-sync responses unwrap the remote wrapper.
    #[test]
    fn response_normalization_unwraps_pet_cloud_function_data() {
        // 这一段模拟真实 pull 响应。
        // Simulate a real pull response.
        let response = normalize_pet_sync_response(
            200,
            r#"{"ok":true,"action":"pull","data":{"exists":true,"petCount":1,"revision":3,"updatedAt":"2026-06-08T10:20:00.000Z"}}"#,
        );

        // 这一段断言页面能直接读取 data.exists 和 data.revision。
        // Assert the page can read data.exists and data.revision directly.
        assert_eq!(response["ok"], true);
        assert_eq!(response["status"], 200);
        assert_eq!(response["data"]["exists"], true);
        assert_eq!(response["data"]["revision"], 3);
        assert!(response["data"].get("data").is_none());
    }

    /// 这一段确认冲突响应保留失败状态和业务 data。
    /// Confirm conflict responses keep failure status and business data.
    #[test]
    fn response_normalization_preserves_pet_conflict() {
        // 这一段模拟远端 409 冲突响应。
        // Simulate a remote 409 conflict response.
        let response = normalize_pet_sync_response(
            409,
            r#"{"ok":false,"data":{"conflict":true,"currentRevision":9},"error":"remote changed"}"#,
        );

        // 这一段断言页面冲突确认逻辑仍能触发。
        // Assert the page conflict-confirm flow can still trigger.
        assert_eq!(response["ok"], false);
        assert_eq!(response["status"], 409);
        assert_eq!(response["data"]["conflict"], true);
        assert_eq!(response["error"], "remote changed");
    }

    /// 这一段确认拉取包使用云函数当前 URL 契约。
    /// Confirm pulled packages use the current cloud-function URL contract.
    #[test]
    fn pulled_pet_package_uses_temp_url_contract() {
        // 这一段构造云函数返回的轻量 manifest 加临时 URL。
        // Build the light manifest plus temporary URL returned by the cloud function.
        let package = sanitize_pulled_pet_package(&json!({
            "id": "sherry",
            "manifest": {
                "id": "sherry",
                "displayName": "Sherry",
                "description": "pet",
                "spritesheetPath": "ignored.webp"
            },
            "spritesheetBytes": 12,
            "spritesheetSha256": sha256_hex(b"sprite-bytes"),
            "spritesheetUrl": "https://example.com/spritesheet.webp"
        }))
        .unwrap();

        // 这一段断言 Rust 不再期待旧的 spritesheetBase64 拉取形状。
        // Assert Rust no longer expects the old spritesheetBase64 pull shape.
        assert_eq!(package.id, "sherry");
        assert_eq!(package.spritesheet_bytes, 12);
        assert_eq!(package.manifest["spritesheetPath"], "spritesheet.webp");
        assert!(
            sanitize_pulled_pet_package(&json!({
                "petId": "sherry",
                "manifest": { "id": "sherry" },
                "spritesheetBase64": "abc",
                "spritesheetSha256": sha256_hex(b"sprite-bytes")
            }))
            .is_none()
        );
    }

    /// 这一段确认 selected-avatar-id 只在指向已写入宠物时更新。
    /// Confirm selected-avatar-id updates only when it points at a written pet.
    #[tokio::test]
    async fn selected_avatar_write_is_limited_to_known_custom_pet() {
        // 这一段准备带已有配置的临时 Codex home。
        // Prepare a temporary Codex home with existing config.
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("config.toml"), "model = \"gpt\"\n").unwrap();
        let known = HashSet::from(["sherry".to_string()]);

        // 这一段写入合法选择，并拒绝未知宠物选择。
        // Write a valid selection and reject an unknown pet selection.
        assert!(
            write_selected_custom_avatar_id_from(temp.path(), "custom:sherry", &known)
                .await
                .unwrap()
        );
        assert_eq!(
            read_selected_custom_avatar_id_from(temp.path())
                .await
                .unwrap(),
            "custom:sherry"
        );
        assert!(
            !write_selected_custom_avatar_id_from(temp.path(), "custom:missing", &known)
                .await
                .unwrap()
        );
        assert_eq!(
            read_selected_custom_avatar_id_from(temp.path())
                .await
                .unwrap(),
            "custom:sherry"
        );
    }
}
