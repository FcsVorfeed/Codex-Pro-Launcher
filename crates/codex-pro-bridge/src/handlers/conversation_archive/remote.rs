use super::crypto::ArchiveCrypto;
use super::package::ThreadBundlePayload;
use super::request::ConversationArchiveRequest;
use anyhow::{Context, bail};
use base64::Engine;
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, HashSet};
use std::time::{Duration, Instant};

/// 这一段定义会话归档请求超时。
/// Conversation archive request timeout.
const ARCHIVE_REQUEST_TIMEOUT_MS: u64 = 120_000;
/// 这一段定义远端 gzip 包下载大小上限。
/// Maximum remote gzip package download size.
const ARCHIVE_PACKAGE_DOWNLOAD_MAX_BYTES: usize = 12 * 1024 * 1024;
/// 这一段定义批次目标请求体大小。
/// Target request-body bytes for one upload batch.
pub const BATCH_TARGET_BODY_BYTES: usize = 5 * 1024 * 1024;
/// 这一段定义批次最大请求体大小。
/// Maximum request-body bytes for one upload batch.
pub const BATCH_MAX_BODY_BYTES: usize = 7 * 1024 * 1024;
/// 这一段定义批次最大条数。
/// Maximum items per upload batch.
pub const MAX_BATCH_ITEMS: usize = 80;
/// 这一段定义本地扫描参与同步的最大远端入口数。
/// Maximum remote entries considered in one local scan.
pub const MAX_REMOTE_ENTRIES: usize = 5000;
/// 这一段定义 429 最大本地等待次数。
/// Maximum local retries for 429 responses.
const MAX_RATE_LIMIT_RETRIES: usize = 4;
/// 这一段定义 429 最大本地等待秒数。
/// Maximum local wait seconds for 429 responses.
const MAX_RATE_LIMIT_WAIT_SECONDS: u64 = 65;

/// 这一段描述列表构建选项。
/// Describes archive-list build options.
#[derive(Clone, Debug, Default)]
pub struct ArchiveListOptions {
    /// 这一段是本机身份。
    /// Local identity.
    pub identity: Option<super::identity::ArchiveIdentity>,
    /// 这一段是待确认删除设备。
    /// Pending delete device ids.
    pub pending_device_ids: HashSet<String>,
    /// 这一段是需要隐藏的本机内部线程。
    /// Local internal thread ids to hide.
    pub hidden_thread_ids: HashSet<String>,
    /// 这一段是本机设备上传阻断。
    /// Local-device upload block flag.
    pub local_device_upload_blocked_after_delete: bool,
}

/// 这一段描述远端会话包解析结果和下载耗时。
/// Describes remote thread-package resolution output and download timing.
#[derive(Clone, Debug)]
pub struct ResolvedBundlePackage {
    /// 这一段是带 packageBase64 的归一化响应。
    /// Normalized response carrying packageBase64.
    pub response: Value,
    /// 这一段是包体来源。
    /// Package-body transport source.
    pub transport: String,
    /// 这一段是临时 URL 下载到的密文字节数。
    /// Ciphertext bytes downloaded from the temp URL.
    pub downloaded_bytes: usize,
    /// 这一段是临时 URL 下载耗时。
    /// Temp-URL package download duration.
    pub download_ms: u64,
}

/// 这一段拉取远端 manifest。
/// Pull the remote manifest.
pub async fn pull_manifest(
    request: &ConversationArchiveRequest,
    archive_crypto: &ArchiveCrypto,
) -> anyhow::Result<Value> {
    // 这一段保持现有远端 action 名。
    // Keep the existing remote action name.
    post_archive_json(
        request,
        &json!({ "action": "pull", "syncKey": archive_crypto.remote_sync_key() }),
    )
    .await
}

/// 这一段拉取并转换远端 manifest 为页面列表结构。
/// Pull and convert the remote manifest into the page list structure.
pub async fn list_manifest(
    request: &ConversationArchiveRequest,
    archive_crypto: &ArchiveCrypto,
) -> anyhow::Result<Value> {
    // 这一段保持页面只读取 devices/profiles/groups/threads，不暴露云函数内部索引形状。
    // Keep the page reading only devices/profiles/groups/threads instead of cloud-function internals.
    let response = pull_manifest(request, archive_crypto).await?;
    Ok(build_archive_list_response(response, request))
}

/// 这一段把远端文件 manifest 转成旧 Node bridge 的列表响应。
/// Convert remote file manifests into the legacy Node bridge list response.
pub fn build_archive_list_response(response: Value, request: &ConversationArchiveRequest) -> Value {
    build_archive_list_response_with_options(response, request, ArchiveListOptions::default())
}

/// 这一段把远端文件 manifest 转成带选项的列表响应。
/// Convert remote file manifests into a list response with options.
pub fn build_archive_list_response_with_options(
    mut response: Value,
    request: &ConversationArchiveRequest,
    options: ArchiveListOptions,
) -> Value {
    // 这一段失败响应原样返回，成功响应补 devices、fileCount 和 identity。
    // Return failures unchanged, and enrich successful responses with devices, fileCount, and identity.
    if response.get("ok").and_then(Value::as_bool) != Some(true) {
        return response;
    }
    let files = response
        .pointer("/data/files")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let devices = build_archive_devices(&files, &options)
        .into_iter()
        .filter(|device| {
            let device_id = device
                .get("deviceId")
                .and_then(Value::as_str)
                .unwrap_or_default();
            !options.pending_device_ids.contains(device_id)
        })
        .collect::<Vec<_>>();
    let file_count = devices
        .iter()
        .flat_map(|device| {
            device
                .get("profiles")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
        })
        .map(|profile| {
            profile
                .get("threads")
                .and_then(Value::as_array)
                .map(Vec::len)
                .unwrap_or(0)
        })
        .sum::<usize>();
    if !response.get("data").is_some_and(Value::is_object) {
        response["data"] = json!({});
    }
    let data = response
        .get_mut("data")
        .and_then(Value::as_object_mut)
        .expect("archive list response data was normalized to an object");
    data.insert("devices".to_string(), Value::Array(devices));
    data.insert(
        "deviceDeletePending".to_string(),
        Value::Bool(!options.pending_device_ids.is_empty()),
    );
    data.insert("fileCount".to_string(), json!(file_count));
    let local_identity = options.identity.as_ref();
    data.insert(
        "localDeviceDeletePending".to_string(),
        Value::Bool(
            local_identity
                .is_some_and(|identity| options.pending_device_ids.contains(&identity.device_id)),
        ),
    );
    data.insert(
        "localDeviceUploadBlockedAfterDelete".to_string(),
        Value::Bool(options.local_device_upload_blocked_after_delete),
    );
    data.insert(
        "identity".to_string(),
        json!({
            "deviceId": local_identity.map(|identity| identity.device_id.as_str()).unwrap_or(if request.device_id.is_empty() { "device_local" } else { request.device_id.as_str() }),
            "profileId": local_identity.map(|identity| identity.profile_id.as_str()).unwrap_or("profile_default"),
        }),
    );
    response
}

/// 这一段把 path-keyed 文件整理成设备树。
/// Shape path-keyed files into the device tree.
fn build_archive_devices(files: &Map<String, Value>, options: &ArchiveListOptions) -> Vec<Value> {
    // 这一段用有序 map 保持稳定输出，方便测试和 UI diff。
    // Use ordered maps for stable output, which helps tests and UI diffs.
    let mut devices: BTreeMap<String, DeviceBuild> = BTreeMap::new();
    for (path, file) in files {
        let Some(path_info) = parse_archive_path(path) else {
            continue;
        };
        if file.get("packageKind").and_then(Value::as_str)
            != Some(super::package::PACKAGE_KIND_THREAD_BUNDLE)
        {
            continue;
        }
        let file_role = file
            .get("fileRole")
            .and_then(Value::as_str)
            .unwrap_or("thread");
        if file_role != "thread" {
            continue;
        }
        let lifecycle_status = file
            .get("lifecycleStatus")
            .and_then(Value::as_str)
            .unwrap_or("active");
        if lifecycle_status != "active" {
            continue;
        }
        let thread_source = file
            .get("threadSource")
            .and_then(Value::as_str)
            .unwrap_or("user");
        if thread_source != "user" {
            continue;
        }
        if options.identity.as_ref().is_some_and(|identity| {
            identity.device_id == path_info.device_id
                && identity.profile_id == path_info.profile_id
                && options.hidden_thread_ids.contains(&path_info.thread_id)
        }) {
            continue;
        }
        let title = short_text(
            file.get("title")
                .and_then(Value::as_str)
                .unwrap_or("Untitled session"),
            180,
        );
        if is_generated_title(&title) {
            continue;
        }
        let group_name = short_text(
            file.get("archiveGroupName")
                .and_then(Value::as_str)
                .unwrap_or(if path_info.archive_group_type == "project" {
                    "项目"
                } else {
                    "对话"
                }),
            120,
        );
        let source_updated_at = short_text(
            file.get("sourceUpdatedAt")
                .or_else(|| file.get("updatedAt"))
                .and_then(Value::as_str)
                .unwrap_or(""),
            80,
        );
        let source_created_at = short_text(
            file.get("sourceCreatedAt")
                .or_else(|| file.get("sourceUpdatedAt"))
                .and_then(Value::as_str)
                .unwrap_or(""),
            80,
        );
        let thread = json!({
            "archiveGroupId": path_info.archive_group_id,
            "archiveGroupName": group_name,
            "archiveGroupType": path_info.archive_group_type,
            "markdownBytes": file.get("markdownBytes").and_then(Value::as_u64).unwrap_or(0),
            "messageCount": file.get("messageCount").and_then(Value::as_u64).unwrap_or(0),
            "archivedAt": file.get("archivedAt").and_then(Value::as_str).unwrap_or(""),
            "deletedDetectedAt": file.get("deletedDetectedAt").and_then(Value::as_str).unwrap_or(""),
            "lifecycleStatus": lifecycle_status,
            "path": path,
            "sourceCreatedAt": source_created_at,
            "sourceUpdatedAt": source_updated_at,
            "threadId": path_info.thread_id,
            "title": title,
            "updatedAt": file.get("updatedAt").and_then(Value::as_str).unwrap_or(""),
        });
        let device = devices
            .entry(path_info.device_id.clone())
            .or_insert_with(|| DeviceBuild {
                device_id: path_info.device_id.clone(),
                device_name: short_text(
                    file.get("deviceName")
                        .and_then(Value::as_str)
                        .unwrap_or(&path_info.device_id),
                    120,
                ),
                profiles: BTreeMap::new(),
            });
        let profile = device
            .profiles
            .entry(path_info.profile_id.clone())
            .or_insert_with(|| ProfileBuild {
                groups: BTreeMap::new(),
                profile_id: path_info.profile_id.clone(),
                profile_name: short_text(
                    file.get("profileName")
                        .and_then(Value::as_str)
                        .unwrap_or(super::DEFAULT_PROFILE_NAME),
                    120,
                ),
                threads: Vec::new(),
            });
        if let Some(existing_index) = profile.threads.iter().position(|entry| {
            entry.get("threadId").and_then(Value::as_str) == Some(&path_info.thread_id)
        }) {
            let previous_thread = profile.threads[existing_index].clone();
            if !should_prefer_thread_entry(&thread, &previous_thread) {
                continue;
            }
            profile.threads.remove(existing_index);
            let previous_group_key = group_key_from_thread(&previous_thread);
            if let Some(previous_group) = profile.groups.get_mut(&previous_group_key) {
                previous_group.threads.retain(|entry| {
                    entry.get("threadId").and_then(Value::as_str) != Some(&path_info.thread_id)
                });
            }
        }
        let group_key = group_key(&path_info.archive_group_type, &path_info.archive_group_id);
        let group = profile
            .groups
            .entry(group_key)
            .or_insert_with(|| GroupBuild {
                archive_group_id: path_info.archive_group_id.clone(),
                archive_group_name: group_name.clone(),
                archive_group_type: path_info.archive_group_type.clone(),
                threads: Vec::new(),
            });
        profile.threads.push(thread.clone());
        group.threads.push(thread);
    }
    devices.into_values().map(DeviceBuild::into_value).collect()
}

/// 这一段找出同 thread 的旧分组路径。
/// Find stale grouped paths for the same thread.
pub fn migration_paths(
    files: &Map<String, Value>,
    identity: &super::identity::ArchiveIdentity,
    current_path: &str,
    thread_id: &str,
) -> Vec<String> {
    // 这一段只给同设备、同账号、同 thread 的 active 主入口写墓碑。
    // Tombstone only active main entries for the same device, profile, and thread.
    files
        .iter()
        .filter_map(|(path, file)| {
            if path == current_path
                || file.get("packageKind").and_then(Value::as_str)
                    != Some(super::package::PACKAGE_KIND_THREAD_BUNDLE)
                || file
                    .get("fileRole")
                    .and_then(Value::as_str)
                    .unwrap_or("thread")
                    != "thread"
                || file
                    .get("lifecycleStatus")
                    .and_then(Value::as_str)
                    .unwrap_or("active")
                    == "deleted"
            {
                return None;
            }
            let path_info = parse_archive_path(path)?;
            if path_info.device_id == identity.device_id
                && path_info.profile_id == identity.profile_id
                && path_info.thread_id == thread_id
            {
                Some(path.clone())
            } else {
                None
            }
        })
        .collect()
}

/// 这一段返回分组 map key。
/// Return a group map key.
fn group_key(group_type: &str, group_id: &str) -> String {
    // 这一段同时使用类型和 ID，避免项目与普通对话目录合并。
    // Use both type and ID so project and conversation groups cannot merge.
    format!("{group_type}:{group_id}")
}

/// 这一段从会话 JSON 返回分组 map key。
/// Return the group map key for a thread JSON object.
fn group_key_from_thread(thread: &Value) -> String {
    // 这一段和列表插入时使用同一 key 形状。
    // Use the same key shape as list insertion.
    group_key(
        thread
            .get("archiveGroupType")
            .and_then(Value::as_str)
            .unwrap_or("conversation"),
        thread
            .get("archiveGroupId")
            .and_then(Value::as_str)
            .unwrap_or("conversation_default"),
    )
}

/// 这一段判断 candidate 是否应替代 previous。
/// Return whether candidate should replace previous.
fn should_prefer_thread_entry(candidate: &Value, previous: &Value) -> bool {
    // 这一段对齐旧 Node：先比较写入/源时间，再让项目目录优先，最后按路径稳定打破平局。
    // Match old Node: compare write/source time first, prefer project groups, then break ties by path.
    let candidate_timestamp = thread_priority_timestamp(candidate);
    let previous_timestamp = thread_priority_timestamp(previous);
    if candidate_timestamp != previous_timestamp {
        return candidate_timestamp > previous_timestamp;
    }
    let candidate_group = candidate
        .get("archiveGroupType")
        .and_then(Value::as_str)
        .unwrap_or("conversation");
    let previous_group = previous
        .get("archiveGroupType")
        .and_then(Value::as_str)
        .unwrap_or("conversation");
    if candidate_group != previous_group {
        return candidate_group == "project";
    }
    candidate.get("path").and_then(Value::as_str).unwrap_or("")
        > previous.get("path").and_then(Value::as_str).unwrap_or("")
}

/// 这一段提取会话优先级时间。
/// Extract a thread priority timestamp.
fn thread_priority_timestamp(thread: &Value) -> String {
    // 这一段使用 ISO 文本比较，空值自然落后。
    // Use ISO text comparison so empty values naturally sort last.
    ["updatedAt", "sourceUpdatedAt", "sourceCreatedAt"]
        .iter()
        .find_map(|key| {
            let value = thread.get(*key).and_then(Value::as_str).unwrap_or("");
            if value.is_empty() {
                None
            } else {
                Some(value.to_string())
            }
        })
        .unwrap_or_default()
}

/// 这一段保存解析后的归档路径。
/// Stores a parsed archive path.
struct ArchivePathInfo {
    archive_group_id: String,
    archive_group_type: String,
    device_id: String,
    profile_id: String,
    thread_id: String,
}

/// 这一段解析正式分组归档路径。
/// Parse the formal grouped archive path.
fn parse_archive_path(path: &str) -> Option<ArchivePathInfo> {
    // 这一段只接受 devices/profile/projects-or-conversations/threads/index.md 形状。
    // Accept only devices/profile/projects-or-conversations/threads/index.md shape.
    let parts = path.split('/').collect::<Vec<_>>();
    if parts.len() != 11
        || parts[0] != "devices"
        || parts[2] != "profiles"
        || (parts[4] != "projects" && parts[4] != "conversations")
        || parts[6] != "threads"
        || parts[10] != "index.md"
        || !is_safe_segment(parts[1])
        || !is_safe_segment(parts[3])
        || !is_safe_segment(parts[5])
        || !is_safe_segment(parts[9])
    {
        return None;
    }
    Some(ArchivePathInfo {
        archive_group_id: parts[5].to_string(),
        archive_group_type: if parts[4] == "projects" {
            "project".to_string()
        } else {
            "conversation".to_string()
        },
        device_id: parts[1].to_string(),
        profile_id: parts[3].to_string(),
        thread_id: parts[9].to_string(),
    })
}

/// 这一段判断路径片段是否安全。
/// Return whether a path segment is safe.
fn is_safe_segment(value: &str) -> bool {
    // 这一段只允许短 ASCII 片段。
    // Allow only short ASCII segments.
    !value.is_empty()
        && value.len() <= 128
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-' | '.'))
}

/// 这一段清理短文本。
/// Clean short display text.
fn short_text(value: &str, max_len: usize) -> String {
    // 这一段移除控制字符并限制长度。
    // Remove control characters and bound length.
    value
        .chars()
        .filter(|ch| !ch.is_control())
        .take(max_len)
        .collect::<String>()
        .trim()
        .to_string()
}

/// 这一段识别 Codex 生成标题占位。
/// Detect generated Codex title placeholders.
fn is_generated_title(value: &str) -> bool {
    // 这一段对齐旧 Node 过滤，避免旧脏数据出现在侧栏。
    // Match the legacy Node filter so stale dirty data does not show in the sidebar.
    let title = value.trim();
    title.is_empty()
        || title.starts_with("Untitled")
        || title.starts_with("New chat")
        || title == "新建聊天"
        || is_markdown_heading_title(title)
}

/// 这一段识别正文 Markdown 标题污染的远端旧标题。
/// Detect stale remote titles polluted by Markdown body headings.
fn is_markdown_heading_title(value: &str) -> bool {
    // 这一段只匹配 Markdown heading 语法，避免误伤 C# 这类正常标题。
    // Match only Markdown heading syntax so normal titles such as C# are not affected.
    let hash_count = value.chars().take_while(|ch| *ch == '#').count();
    if hash_count == 0 || hash_count > 6 {
        return false;
    }
    value
        .chars()
        .nth(hash_count)
        .is_some_and(|ch| ch.is_whitespace())
}

/// 这一段保存设备构建态。
/// Device build state.
struct DeviceBuild {
    device_id: String,
    device_name: String,
    profiles: BTreeMap<String, ProfileBuild>,
}

/// 这一段保存账号构建态。
/// Profile build state.
struct ProfileBuild {
    groups: BTreeMap<String, GroupBuild>,
    profile_id: String,
    profile_name: String,
    threads: Vec<Value>,
}

/// 这一段保存分组构建态。
/// Group build state.
struct GroupBuild {
    archive_group_id: String,
    archive_group_name: String,
    archive_group_type: String,
    threads: Vec<Value>,
}

impl DeviceBuild {
    /// 这一段转换成页面消费的 JSON。
    /// Convert into page-consumable JSON.
    fn into_value(self) -> Value {
        // 这一段保持 profile 按名称稳定排序。
        // Keep profiles in a stable name order.
        let profiles = self
            .profiles
            .into_values()
            .map(ProfileBuild::into_value)
            .collect::<Vec<_>>();
        json!({
            "deviceId": self.device_id,
            "deviceName": self.device_name,
            "profiles": profiles,
        })
    }
}

impl ProfileBuild {
    /// 这一段转换成页面消费的 JSON。
    /// Convert into page-consumable JSON.
    fn into_value(self) -> Value {
        // 这一段输出分组和扁平 threads，兼容设置页和侧栏两处浏览器。
        // Output both groups and flat threads for the settings page and sidebar browsers.
        let groups = self
            .groups
            .into_values()
            .filter(|group| !group.threads.is_empty())
            .map(GroupBuild::into_value)
            .collect::<Vec<_>>();
        json!({
            "groups": groups,
            "profileId": self.profile_id,
            "profileName": self.profile_name,
            "threads": self.threads,
        })
    }
}

impl GroupBuild {
    /// 这一段转换成页面消费的 JSON。
    /// Convert into page-consumable JSON.
    fn into_value(self) -> Value {
        // 这一段保留 archiveGroupDisplayName 字段，避免侧栏二次推断。
        // Keep archiveGroupDisplayName so the sidebar does not need to infer it again.
        json!({
            "archiveGroupDisplayName": self.archive_group_name,
            "archiveGroupId": self.archive_group_id,
            "archiveGroupName": self.archive_group_name,
            "archiveGroupType": self.archive_group_type,
            "threads": self.threads,
        })
    }
}

/// 这一段拉取单会话包。
/// Get one thread bundle.
pub async fn get_bundle(
    request: &ConversationArchiveRequest,
    archive_crypto: &ArchiveCrypto,
) -> anyhow::Result<Value> {
    // 这一段只传远端路径，不传本机路径。
    // Send only the remote path, never a local path.
    post_archive_json(
        request,
        &json!({
            "action": "getBundle",
            "syncKey": archive_crypto.remote_sync_key(),
            "path": request.path,
        }),
    )
    .await
}

/// 这一段把 getBundle 响应归一化为带 packageBase64 的形态。
/// Normalize a getBundle response into a packageBase64-bearing shape.
pub async fn resolve_bundle_package(response: &Value) -> anyhow::Result<ResolvedBundlePackage> {
    // 这一段优先复用服务端直接返回的 packageBase64。
    // Reuse packageBase64 directly when the service returns it.
    let data = bundle_response_data(response);
    if data
        .get("packageBase64")
        .and_then(Value::as_str)
        .is_some_and(|value| !value.is_empty())
    {
        return Ok(ResolvedBundlePackage {
            response: response.clone(),
            transport: "packageBase64".to_string(),
            downloaded_bytes: 0,
            download_ms: 0,
        });
    }

    // 这一段兼容既有 getBundle 返回 packageUrl 的协议。
    // Support the existing getBundle protocol that returns packageUrl.
    let package_url = data
        .get("packageUrl")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if package_url.is_empty() {
        return Ok(ResolvedBundlePackage {
            response: response.clone(),
            transport: "missing".to_string(),
            downloaded_bytes: 0,
            download_ms: 0,
        });
    }
    let download_started_at = Instant::now();
    let bytes = download_bundle_package(package_url).await?;
    let download_ms = elapsed_ms(download_started_at);
    let downloaded_bytes = bytes.len();
    let mut next_data = data.clone();
    let object = next_data
        .as_object_mut()
        .ok_or_else(|| anyhow::anyhow!("conversation archive bundle data is not an object"))?;
    object.insert(
        "packageBase64".to_string(),
        Value::String(base64::engine::general_purpose::STANDARD.encode(bytes)),
    );
    Ok(ResolvedBundlePackage {
        response: json!({
        "ok": response.get("ok").and_then(Value::as_bool).unwrap_or(true),
        "status": response.get("status").and_then(Value::as_u64).unwrap_or(200),
        "data": next_data,
        "error": response.get("error").and_then(Value::as_str).unwrap_or(""),
        }),
        transport: "packageUrl".to_string(),
        downloaded_bytes,
        download_ms,
    })
}

/// 这一段上传会话包批次。
/// Upload a batch of thread bundles.
pub async fn put_bundle_batch(
    request: &ConversationArchiveRequest,
    archive_crypto: &ArchiveCrypto,
    bundles: &[ThreadBundlePayload],
) -> anyhow::Result<Value> {
    // 这一段保持每个会话一个 bundle，避免破坏单条预览和墓碑模型。
    // Keep one bundle per thread so preview and tombstones remain per-thread.
    let body = build_put_bundle_batch_body(request, archive_crypto, bundles, None);
    post_archive_json(request, &body).await
}

/// 这一段上传带真实 baseRevision 的会话包批次。
/// Upload a thread-bundle batch with a real baseRevision.
pub async fn put_bundle_batch_with_base_revision(
    request: &ConversationArchiveRequest,
    archive_crypto: &ArchiveCrypto,
    bundles: &[ThreadBundlePayload],
    base_revision: Option<u64>,
) -> anyhow::Result<Value> {
    // 这一段由 push 主流程传入 pull 得到的 revision，避免并发覆盖其它设备。
    // The push flow passes the revision from pull to avoid overwriting other devices concurrently.
    let body = build_put_bundle_batch_body(request, archive_crypto, bundles, base_revision);
    post_archive_json(request, &body).await
}

/// 这一段上传带短 429 退避的会话包批次。
/// Upload a thread-bundle batch with short 429 backoff.
pub async fn put_bundle_batch_with_retry(
    request: &ConversationArchiveRequest,
    archive_crypto: &ArchiveCrypto,
    bundles: &[ThreadBundlePayload],
    base_revision: Option<u64>,
) -> anyhow::Result<Value> {
    // 这一段重试单位是一个 MB 窗口，不按单会话逐个重试。
    // Retry one MB-window batch at a time, not one thread at a time.
    let body = build_put_bundle_batch_body(request, archive_crypto, bundles, base_revision);
    post_archive_json_with_rate_limit_retry(request, &body).await
}

/// 这一段构造批量上传请求体。
/// Build a putBundleBatch request body.
pub fn build_put_bundle_batch_body(
    _request: &ConversationArchiveRequest,
    archive_crypto: &ArchiveCrypto,
    bundles: &[ThreadBundlePayload],
    base_revision: Option<u64>,
) -> Value {
    // 这一段只在有真实远端 revision 时写入 baseRevision，避免伪造 0 触发冲突。
    // Include baseRevision only when a real remote revision exists, avoiding a fabricated zero conflict token.
    let mut body = Map::new();
    body.insert(
        "action".to_string(),
        Value::String("putBundleBatch".to_string()),
    );
    body.insert(
        "syncKey".to_string(),
        Value::String(archive_crypto.remote_sync_key().to_string()),
    );
    body.insert("bundles".to_string(), json!(bundles));
    if let Some(revision) = base_revision {
        body.insert("baseRevision".to_string(), json!(revision));
    }
    Value::Object(body)
}

/// 这一段判断加入下一项后是否应 flush 当前上传批次。
/// Return whether adding the next item should flush the current upload batch.
pub fn should_flush_bundle_batch(
    request: &ConversationArchiveRequest,
    archive_crypto: &ArchiveCrypto,
    batch: &[ThreadBundlePayload],
    next: &ThreadBundlePayload,
    base_revision: Option<u64>,
) -> bool {
    // 这一段按真实 JSON 请求体大小决定窗口，而不是只按条数切分。
    // Use real JSON body bytes for batching instead of item count only.
    if batch.is_empty() {
        return false;
    }
    if batch.len() >= MAX_BATCH_ITEMS {
        return true;
    }
    let mut next_batch = batch.to_vec();
    next_batch.push(next.clone());
    let body = build_put_bundle_batch_body(request, archive_crypto, &next_batch, base_revision);
    let bytes = serde_json::to_vec(&body)
        .map(|body| body.len())
        .unwrap_or(usize::MAX);
    bytes > BATCH_MAX_BODY_BYTES || bytes > BATCH_TARGET_BODY_BYTES
}

/// 这一段构造生命周期批量请求体。
/// Build a lifecycle batch request body.
pub fn build_lifecycle_batch_body(
    _request: &ConversationArchiveRequest,
    archive_crypto: &ArchiveCrypto,
    updates: &[super::state::LifecycleUpdate],
    base_revision: Option<u64>,
) -> Value {
    // 这一段只同步 metadata，不上传或删除正文包。
    // Sync only metadata and never upload or delete package bodies.
    let mut body = Map::new();
    body.insert(
        "action".to_string(),
        Value::String("putLifecycleBatch".to_string()),
    );
    body.insert(
        "syncKey".to_string(),
        Value::String(archive_crypto.remote_sync_key().to_string()),
    );
    body.insert(
        "items".to_string(),
        Value::Array(
            updates
                .iter()
                .map(|update| {
                    json!({
                        "path": update.path,
                        "lifecycle": {
                            "archivedAt": update.archived_at,
                            "deletedDetectedAt": update.deleted_detected_at,
                            "lifecycleStatus": update.lifecycle_status,
                        },
                    })
                })
                .collect(),
        ),
    );
    if let Some(revision) = base_revision {
        body.insert("baseRevision".to_string(), json!(revision));
    }
    Value::Object(body)
}

/// 这一段同步生命周期批次。
/// Sync a lifecycle batch.
pub async fn put_lifecycle_batch_with_retry(
    request: &ConversationArchiveRequest,
    archive_crypto: &ArchiveCrypto,
    updates: &[super::state::LifecycleUpdate],
    base_revision: Option<u64>,
) -> anyhow::Result<Value> {
    // 这一段使用和包上传相同的短 429 退避。
    // Use the same short 429 backoff as package uploads.
    let body = build_lifecycle_batch_body(request, archive_crypto, updates, base_revision);
    post_archive_json_with_rate_limit_retry(request, &body).await
}

/// 这一段从响应提取 itemResults。
/// Extract itemResults from a response.
pub fn item_results(response: &Value) -> Vec<Value> {
    // 这一段缺失时返回空数组，由调用方按失败处理。
    // Return an empty array when missing; callers treat missing items as failures.
    response
        .pointer("/data/itemResults")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

/// 这一段判断批量上传是否有服务端逐项失败。
/// Return whether a batch upload contains per-item failures.
pub fn is_partial_upload_failure(response: &Value) -> bool {
    // 这一段对齐旧 Node：部分失败不能当成设置页成功。
    // Match legacy Node behavior: partial failures must not be reported as a successful settings upload.
    response
        .pointer("/data/partialFailure")
        .and_then(Value::as_bool)
        == Some(true)
        || response
            .pointer("/data/failedCount")
            .and_then(Value::as_u64)
            .unwrap_or(0)
            > 0
        || response
            .pointer("/data/itemResults")
            .and_then(Value::as_array)
            .is_some_and(|items| {
                items.iter().any(|item| {
                    item.get("failed").and_then(Value::as_bool) == Some(true)
                        || item
                            .get("error")
                            .and_then(Value::as_str)
                            .is_some_and(|error| !error.trim().is_empty())
                })
            })
}

/// 这一段把批量上传部分失败转换成页面错误响应。
/// Convert a partial batch upload failure into a page error response.
pub fn partial_upload_failure_response(response: &Value) -> Value {
    // 这一段尽量取第一条失败 item 的错误，保留原始 data 供页面展示进度。
    // Prefer the first failed item error while preserving data for progress display.
    let item_error = response
        .pointer("/data/itemResults")
        .and_then(Value::as_array)
        .and_then(|items| {
            items.iter().find_map(|item| {
                item.get("error")
                    .and_then(Value::as_str)
                    .filter(|message| !message.trim().is_empty())
            })
        })
        .unwrap_or("会话归档包上传失败 / Archive package upload failed");
    json!({
        "ok": false,
        "status": response.get("status").and_then(Value::as_u64).unwrap_or(502),
        "data": response.get("data").cloned().unwrap_or(Value::Null),
        "error": item_error,
    })
}

/// 这一段统计页面视角的有效上传数。
/// Count effective uploads from the page's perspective.
pub fn effective_uploaded_count(response: &Value) -> usize {
    // 这一段对齐旧 Node：包体上传和 metadata-only 更新都代表本轮有会话被同步。
    // Match legacy Node: both package uploads and metadata-only updates count as synced this run.
    let explicit_uploaded = response
        .pointer("/data/uploadedCount")
        .and_then(Value::as_u64)
        .unwrap_or(0) as usize;
    let explicit_metadata = response
        .pointer("/data/metadataUpdatedCount")
        .and_then(Value::as_u64)
        .unwrap_or(0) as usize;
    let item_count = response
        .pointer("/data/itemResults")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter(|item| {
                    item.get("uploaded").and_then(Value::as_bool) == Some(true)
                        || item.get("metadataUpdated").and_then(Value::as_bool) == Some(true)
                })
                .count()
        })
        .unwrap_or(0);
    explicit_uploaded.max(explicit_metadata).max(item_count)
}

/// 这一段重置远端归档域。
/// Reset the remote archive domain.
pub async fn reset_manifest(
    request: &ConversationArchiveRequest,
    archive_crypto: &ArchiveCrypto,
) -> anyhow::Result<Value> {
    // 这一段请求当前加密同步域 reset，并附带旧明文域哈希供服务端清理。
    // Reset the current encrypted sync domain and include the legacy plaintext domain hash for cleanup.
    post_archive_json(
        request,
        &json!({
            "action": "reset",
            "legacySyncKeyHash": archive_crypto.legacy_sync_key_hash(),
            "syncKey": archive_crypto.remote_sync_key(),
        }),
    )
    .await
}

/// 这一段清理旧明文远端归档域。
/// Clean the legacy plaintext remote archive domain.
pub async fn cleanup_legacy_manifest(
    request: &ConversationArchiveRequest,
    archive_crypto: &ArchiveCrypto,
) -> anyhow::Result<Value> {
    // 这一段只发送旧同步域 hash，不把原始同步密钥交给服务端。
    // Send only the legacy sync-domain hash and never the raw sync key.
    post_archive_json(
        request,
        &json!({
            "action": "cleanupLegacy",
            "legacySyncKeyHash": archive_crypto.legacy_sync_key_hash(),
            "syncKey": archive_crypto.remote_sync_key(),
        }),
    )
    .await
}

/// 这一段判断响应是否来自新版旧明文清理接口。
/// Return whether the response came from the new legacy-cleanup endpoint.
pub fn is_legacy_cleanup_response(response: &Value) -> bool {
    // 这一段避免旧云函数把未知 cleanupLegacy action 当 pull 成功返回后被误判为已清理。
    // Prevent old cloud functions from treating an unknown cleanupLegacy action as pull success.
    response
        .pointer("/data/legacyRootRemoved")
        .and_then(Value::as_bool)
        .is_some()
        || response
            .pointer("/data/legacyFileDocumentCount")
            .and_then(Value::as_u64)
            .is_some()
}

/// 这一段发送会话归档 JSON。
/// Send conversation archive JSON.
pub async fn post_archive_json(
    request: &ConversationArchiveRequest,
    body: &Value,
) -> anyhow::Result<Value> {
    // 这一段使用 Rust 网络请求并限制超时。
    // Use Rust networking with bounded timeout.
    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(ARCHIVE_REQUEST_TIMEOUT_MS))
        .no_proxy()
        .build()?;
    let response = client.post(&request.endpoint).json(body).send().await?;
    let status = response.status().as_u16();
    let text = response.text().await.unwrap_or_default();
    Ok(normalize_archive_response(status, &text))
}

/// 这一段发送 JSON 并处理短 429 退避。
/// Send JSON and handle short 429 backoff.
async fn post_archive_json_with_rate_limit_retry(
    request: &ConversationArchiveRequest,
    body: &Value,
) -> anyhow::Result<Value> {
    // 这一段只等待服务端明确给出的短 retryAfterSeconds。
    // Wait only for explicit short retryAfterSeconds from the server.
    let mut response = Value::Null;
    for attempt in 0..=MAX_RATE_LIMIT_RETRIES {
        response = post_archive_json(request, body).await?;
        if response.get("status").and_then(Value::as_u64) != Some(429) {
            return Ok(response);
        }
        let retry_after = response
            .get("retryAfterSeconds")
            .or_else(|| response.pointer("/data/retryAfterSeconds"))
            .and_then(Value::as_u64)
            .unwrap_or(0);
        if attempt >= MAX_RATE_LIMIT_RETRIES
            || retry_after == 0
            || retry_after > MAX_RATE_LIMIT_WAIT_SECONDS
        {
            return Ok(response);
        }
        tokio::time::sleep(Duration::from_secs(retry_after)).await;
    }
    Ok(response)
}

/// 这一段把云函数响应归一化成旧 Node bridge 返回给页面的形状。
/// Normalize cloud-function responses into the shape the legacy Node bridge returned to the page.
pub fn normalize_archive_response(status: u16, text: &str) -> Value {
    // 这一段解开 action/data/ok 外层，避免页面侧被迫读取 data.data。
    // Unwrap the action/data/ok envelope so the page does not need to read data.data.
    let payload = serde_json::from_str::<Value>(text).unwrap_or_else(|_| json!({ "text": text }));
    let payload_ok = payload.get("ok").and_then(Value::as_bool).unwrap_or(true);
    let data = payload
        .get("data")
        .cloned()
        .unwrap_or_else(|| payload.clone());
    let error = payload
        .get("error")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    json!({
        "ok": (200..300).contains(&status) && payload_ok,
        "status": status,
        "data": data,
        "error": error,
    })
}

/// 这一段定位 getBundle 响应里的包 metadata。
/// Locate package metadata inside a getBundle response.
fn bundle_response_data(response: &Value) -> &Value {
    // 这一段兼容 native wrapper 和远端 body 双层 data 包装。
    // Support both the native wrapper and remote body data nesting.
    let data = response.get("data").unwrap_or(response);
    if data.get("packageBase64").is_some() || data.get("packageUrl").is_some() {
        data
    } else {
        data.get("data").unwrap_or(data)
    }
}

/// 这一段下载远端 gzip 包，只接受 HTTPS 临时 URL。
/// Download the remote gzip package from an HTTPS temporary URL only.
async fn download_bundle_package(package_url: &str) -> anyhow::Result<Vec<u8>> {
    // 这一段拒绝本机、明文和非 URL 输入，避免把原生桥变成任意读取器。
    // Reject local, plaintext, and malformed inputs so the bridge cannot become an arbitrary reader.
    let url = url::Url::parse(package_url).context("invalid conversation archive package URL")?;
    if url.scheme() != "https" || url.host_str().unwrap_or_default().is_empty() {
        bail!("conversation archive package URL must be HTTPS");
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(ARCHIVE_REQUEST_TIMEOUT_MS))
        .no_proxy()
        .build()?;
    let response = client.get(url).send().await?.error_for_status()?;
    let bytes = response.bytes().await?;
    if bytes.len() > ARCHIVE_PACKAGE_DOWNLOAD_MAX_BYTES {
        bail!("conversation archive package download exceeds size limit");
    }
    Ok(bytes.to_vec())
}

/// 这一段把 Instant 耗时转换成安全毫秒数。
/// Convert Instant elapsed time into a bounded millisecond value.
fn elapsed_ms(started_at: Instant) -> u64 {
    // 这一段避免极端长耗时超过 JSON 数字的常用整数范围。
    // Keep extreme durations within the usual JSON integer range.
    started_at.elapsed().as_millis().min(u128::from(u64::MAX)) as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 这一段构造远端请求测试加密上下文。
    /// Build a remote-request test crypto context.
    fn test_crypto() -> ArchiveCrypto {
        ArchiveCrypto::derive("1234567890123456").unwrap()
    }

    /// 这一段确认归档响应会解开远端外层包装。
    /// Confirm archive responses unwrap the remote envelope.
    #[test]
    fn response_normalization_unwraps_archive_cloud_function_data() {
        let response = normalize_archive_response(
            200,
            r#"{"ok":true,"action":"pull","data":{"exists":true,"revision":7,"files":{"p":{"path":"p"}}}}"#,
        );

        assert_eq!(response["ok"], true);
        assert_eq!(response["status"], 200);
        assert_eq!(response["data"]["exists"], true);
        assert_eq!(response["data"]["revision"], 7);
        assert!(response["data"].get("data").is_none());
    }

    /// 这一段确认批量上传没有远端 revision 时不伪造 baseRevision=0。
    /// Confirm batch uploads do not fabricate baseRevision=0 when no remote revision exists.
    #[test]
    fn put_bundle_batch_body_omits_base_revision_when_absent() {
        let request = ConversationArchiveRequest {
            action: "push".to_string(),
            device_id: "device_local".to_string(),
            device_name: "Desk".to_string(),
            endpoint: "https://example.com/archive-sync".to_string(),
            force: false,
            path: "".to_string(),
            profile_name: "Default profile".to_string(),
            request_id: "req_archive".to_string(),
            sync_key: "1234567890123456".to_string(),
            thread_id: String::new(),
        };
        let crypto = test_crypto();
        let body = build_put_bundle_batch_body(&request, &crypto, &[], None);

        assert!(body.get("baseRevision").is_none());
        assert_eq!(body["action"], "putBundleBatch");
        assert_eq!(body["syncKey"], crypto.remote_sync_key());
        assert_ne!(body["syncKey"], "1234567890123456");
    }

    /// 这一段确认旧版 pull 响应不会被误判为旧明文清理成功。
    /// Confirm a legacy pull response is not mistaken for successful legacy cleanup.
    #[test]
    fn legacy_cleanup_response_requires_legacy_fields() {
        assert!(is_legacy_cleanup_response(&json!({
            "ok": true,
            "data": {
                "legacyFileDocumentCount": 0,
                "legacyRootRemoved": false
            }
        })));
        assert!(!is_legacy_cleanup_response(&json!({
            "ok": true,
            "data": {
                "files": {},
                "revision": 0
            }
        })));
    }

    /// 这一段确认批量上传部分失败不会被包装成成功响应。
    /// Confirm partial batch failures are not wrapped as successful responses.
    #[test]
    fn partial_upload_failure_becomes_page_error() {
        let response = json!({
            "ok": true,
            "status": 200,
            "data": {
                "failedCount": 1,
                "itemResults": [
                    {
                        "error": "Invalid thread package metadata",
                        "path": "devices/device_local/profiles/profile_default/conversations/conversation_default/threads/2026/06/thread_123/index.md"
                    }
                ],
                "partialFailure": true,
                "uploadedCount": 0
            },
            "error": ""
        });

        assert!(is_partial_upload_failure(&response));
        let page_response = partial_upload_failure_response(&response);
        assert_eq!(page_response["ok"], false);
        assert_eq!(page_response["error"], "Invalid thread package metadata");
        assert_eq!(page_response["data"]["failedCount"], 1);
    }

    /// 这一段确认 item 级错误即使外层 ok=true 也算部分失败。
    /// Confirm item-level errors count as partial failures even when the envelope is ok=true.
    #[test]
    fn item_error_counts_as_partial_upload_failure() {
        let response = json!({
            "ok": true,
            "status": 200,
            "data": {
                "itemResults": [
                    {
                        "error": "会话归档包上传结果缺失 / Archive package upload result is missing",
                        "path": "devices/device_local/profiles/profile_default/conversations/conversation_default/threads/2026/06/thread_123/index.md"
                    }
                ]
            },
            "error": ""
        });

        assert!(is_partial_upload_failure(&response));
        let page_response = partial_upload_failure_response(&response);
        assert_eq!(page_response["ok"], false);
        assert_eq!(
            page_response["error"],
            "会话归档包上传结果缺失 / Archive package upload result is missing"
        );
    }

    /// 这一段确认 metadata-only 更新也计入页面上传数。
    /// Confirm metadata-only updates also count as page uploads.
    #[test]
    fn effective_upload_count_includes_metadata_updates() {
        let response = json!({
            "ok": true,
            "status": 200,
            "data": {
                "itemResults": [
                    { "metadataUpdated": true, "uploaded": false },
                    { "uploaded": true },
                    { "unchanged": true }
                ],
                "metadataUpdatedCount": 1,
                "uploadedCount": 1
            },
            "error": ""
        });

        assert_eq!(effective_uploaded_count(&response), 2);
    }

    /// 这一段确认 pull 的 files 会转换成页面使用的设备树。
    /// Confirm pull files are converted into the device tree consumed by the page.
    #[test]
    fn list_response_builds_devices_profiles_groups_and_threads() {
        let request = ConversationArchiveRequest {
            action: "list".to_string(),
            device_id: "device_local".to_string(),
            device_name: "Desk".to_string(),
            endpoint: "https://example.com/archive-sync".to_string(),
            force: false,
            path: "".to_string(),
            profile_name: "Default profile".to_string(),
            request_id: "req_archive".to_string(),
            sync_key: "1234567890123456".to_string(),
            thread_id: String::new(),
        };
        let response = json!({
            "ok": true,
            "status": 200,
            "data": {
                "revision": 7,
                "files": {
                    "devices/device_local/profiles/profile_default/projects/project_abc/threads/2026/06/thread_123/index.md": {
                        "archiveGroupName": "Codex-Pro",
                        "deviceName": "Desk",
                        "fileRole": "thread",
                        "lifecycleStatus": "active",
                        "markdownBytes": 42,
                        "packageKind": "thread-bundle",
                        "profileName": "Default profile",
                        "sourceUpdatedAt": "2026-06-14T00:00:00.000Z",
                        "threadSource": "user",
                        "title": "真实会话"
                    },
                    "devices/device_local/profiles/profile_default/projects/project_abc/threads/2026/06/thread_123/thinking-001.md": {
                        "fileRole": "thinking",
                        "packageKind": "thread-bundle",
                        "title": "不应显示"
                    },
                    "devices/device_local/profiles/profile_default/projects/project_abc/threads/2026/06/thread_deleted/index.md": {
                        "fileRole": "thread",
                        "lifecycleStatus": "deleted",
                        "packageKind": "thread-bundle",
                        "title": "不应显示"
                    },
                    "devices/device_local/profiles/profile_default/projects/project_abc/threads/2026/06/thread_dirty_title/index.md": {
                        "fileRole": "thread",
                        "lifecycleStatus": "active",
                        "packageKind": "thread-bundle",
                        "sourceUpdatedAt": "2026-06-14T00:00:00.000Z",
                        "threadSource": "user",
                        "title": "# 情况说明不应显示"
                    }
                }
            },
            "error": ""
        });
        let response = build_archive_list_response(response, &request);

        assert_eq!(response["data"]["revision"], 7);
        assert_eq!(response["data"]["fileCount"], 1);
        assert_eq!(response["data"]["identity"]["deviceId"], "device_local");
        assert_eq!(response["data"]["devices"][0]["deviceName"], "Desk");
        assert_eq!(
            response["data"]["devices"][0]["profiles"][0]["groups"][0]["archiveGroupDisplayName"],
            "Codex-Pro"
        );
        assert_eq!(
            response["data"]["devices"][0]["profiles"][0]["groups"][0]["threads"][0]["title"],
            "真实会话"
        );
    }

    /// 这一段确认同 thread 多入口时只保留优先入口。
    /// Confirm duplicate entries for one thread keep only the preferred entry.
    #[test]
    fn list_response_deduplicates_thread_entries_by_priority() {
        let request = ConversationArchiveRequest {
            action: "list".to_string(),
            device_id: "device_local".to_string(),
            device_name: "Desk".to_string(),
            endpoint: "https://example.com/archive-sync".to_string(),
            force: false,
            path: "".to_string(),
            profile_name: "Default profile".to_string(),
            request_id: "req_archive".to_string(),
            sync_key: "1234567890123456".to_string(),
            thread_id: String::new(),
        };
        let response = json!({
            "ok": true,
            "status": 200,
            "data": {
                "files": {
                    "devices/device_local/profiles/profile_default/conversations/conversation_default/threads/2026/06/thread_123/index.md": {
                        "archiveGroupName": "对话",
                        "fileRole": "thread",
                        "lifecycleStatus": "active",
                        "packageKind": "thread-bundle",
                        "sourceUpdatedAt": "2026-06-14T00:00:00.000Z",
                        "threadSource": "user",
                        "title": "旧入口"
                    },
                    "devices/device_local/profiles/profile_default/projects/project_abc/threads/2026/06/thread_123/index.md": {
                        "archiveGroupName": "Codex-Pro",
                        "fileRole": "thread",
                        "lifecycleStatus": "active",
                        "packageKind": "thread-bundle",
                        "sourceUpdatedAt": "2026-06-14T00:01:00.000Z",
                        "threadSource": "user",
                        "title": "新入口"
                    }
                }
            },
            "error": ""
        });

        let response = build_archive_list_response(response, &request);
        let profile = &response["data"]["devices"][0]["profiles"][0];
        assert_eq!(profile["threads"].as_array().unwrap().len(), 1);
        assert_eq!(profile["threads"][0]["title"], "新入口");
        assert_eq!(profile["groups"].as_array().unwrap().len(), 1);
        assert_eq!(profile["groups"][0]["archiveGroupName"], "Codex-Pro");
    }

    /// 这一段确认迁移路径只匹配同设备账号和同 thread 的 active 主入口。
    /// Confirm migration paths match only active main entries for the same device/profile/thread.
    #[test]
    fn migration_paths_find_only_stale_same_thread_entries() {
        let identity = super::super::identity::ArchiveIdentity {
            device_id: "device_local".to_string(),
            profile_id: "profile_default".to_string(),
            project_salt: "salt_test".to_string(),
        };
        let current_path = "devices/device_local/profiles/profile_default/projects/project_new/threads/2026/06/thread_123/index.md";
        let mut files = Map::new();
        files.insert(
            current_path.to_string(),
            json!({ "fileRole": "thread", "lifecycleStatus": "active", "packageKind": "thread-bundle" }),
        );
        files.insert(
            "devices/device_local/profiles/profile_default/conversations/conversation_default/threads/2026/06/thread_123/index.md".to_string(),
            json!({ "fileRole": "thread", "lifecycleStatus": "active", "packageKind": "thread-bundle" }),
        );
        files.insert(
            "devices/device_local/profiles/profile_default/projects/project_old/threads/2026/06/thread_123/thinking-001.md".to_string(),
            json!({ "fileRole": "thinking", "lifecycleStatus": "active", "packageKind": "thread-bundle" }),
        );
        files.insert(
            "devices/device_other/profiles/profile_default/projects/project_old/threads/2026/06/thread_123/index.md".to_string(),
            json!({ "fileRole": "thread", "lifecycleStatus": "active", "packageKind": "thread-bundle" }),
        );
        files.insert(
            "devices/device_local/profiles/profile_default/projects/project_old/threads/2026/06/thread_999/index.md".to_string(),
            json!({ "fileRole": "thread", "lifecycleStatus": "active", "packageKind": "thread-bundle" }),
        );
        files.insert(
            "devices/device_local/profiles/profile_default/projects/project_deleted/threads/2026/06/thread_123/index.md".to_string(),
            json!({ "fileRole": "thread", "lifecycleStatus": "deleted", "packageKind": "thread-bundle" }),
        );

        let paths = migration_paths(&files, &identity, current_path, "thread_123");

        assert_eq!(paths.len(), 1);
        assert_eq!(
            paths[0],
            "devices/device_local/profiles/profile_default/conversations/conversation_default/threads/2026/06/thread_123/index.md"
        );
    }
}
