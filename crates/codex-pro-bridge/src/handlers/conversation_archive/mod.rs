pub mod codex_state;
pub mod crypto;
pub mod device_delete;
pub mod identity;
pub mod lifecycle;
pub mod markdown;
pub mod package;
pub mod preview;
pub mod progress;
pub mod project;
pub mod remote;
pub mod request;
pub mod rollout_reader;
pub mod session_index;
pub mod state;

pub use request::{ConversationArchiveRequest, parse_conversation_archive_request};

use crate::handlers::sync_license::ensure_sync_license;
use serde_json::{Value, json};
use std::collections::HashSet;
use std::time::{Duration, Instant};

const DEFAULT_PROFILE_NAME: &str = "Default profile";

/// 这一段运行会话归档请求。
/// Run a conversation archive request.
pub async fn run_conversation_archive_request(
    request: &ConversationArchiveRequest,
    progress_sender: Option<progress::ProgressSender>,
) -> anyhow::Result<Value> {
    // 这一段只放行本地导出动作；所有远端归档读写都必须先校验同一把同步密钥。
    // Allow only local export without a key; all remote archive reads/writes must validate the same sync key first.
    if request.action != "prepare-local-file"
        && let Err(error) = ensure_sync_license(&request.sync_key).await
    {
        return Ok(error.into_response());
    }

    // 这一段按 action 分发，具体逻辑保持在拆分模块里。
    // Dispatch by action while keeping implementation in split modules.
    match request.action.as_str() {
        "list" => list_archive(request).await,
        "reset" => reset_archive(request).await,
        "delete-device" => delete_device_archive(request).await,
        "get-file" => get_archive_file(request).await,
        "prepare-file" => prepare_archive_file(request).await,
        "prepare-local-file" => prepare_local_archive_file(request).await,
        "push" => push_archive(request, progress_sender).await,
        _ => Ok(
            json!({ "ok": false, "status": 400, "data": null, "error": "Unsupported archive action" }),
        ),
    }
}

/// 这一段描述远端会话包读取结果。
/// Describes a resolved remote archive bundle.
#[derive(Clone, Debug)]
struct ResolvedArchiveBundle {
    /// 这一段是原始远端响应。
    /// Original remote response.
    response: Value,
    /// 这一段是本次预览读取的性能数据。
    /// Performance data for this preview read.
    performance: ArchivePreviewPerformance,
    /// 这一段是解包后的会话内容；远端失败时为空。
    /// Unpacked thread content; empty when the remote response failed.
    unpacked: Option<package::UnpackedThreadPackage>,
}

/// 这一段描述会话归档预览打开的分段耗时。
/// Describes segmented timing for opening an archived thread preview.
#[derive(Clone, Debug, Default)]
struct ArchivePreviewPerformance {
    /// 这一段是同步密钥派生耗时。
    /// Sync-key derivation duration.
    key_derivation_ms: u64,
    /// 这一段是 getBundle 云函数请求耗时。
    /// getBundle cloud-function request duration.
    get_bundle_ms: u64,
    /// 这一段是包体归一化耗时，packageUrl 模式下包含临时 URL 下载。
    /// Package normalization duration; includes temp-URL download when packageUrl is used.
    package_resolve_ms: u64,
    /// 这一段是临时 URL 下载耗时。
    /// Temp-URL download duration.
    package_download_ms: u64,
    /// 这一段是解密和解包耗时。
    /// Decryption and unpack duration.
    unpack_package_ms: u64,
    /// 这一段是写入本机预览文件耗时。
    /// Local preview-file write duration.
    write_preview_ms: u64,
    /// 这一段是原生桥处理 prepare-file 的总耗时。
    /// Total native prepare-file duration.
    total_native_ms: u64,
    /// 这一段是包体来源。
    /// Package body transport source.
    package_transport: String,
    /// 这一段是服务端 manifest 记录的包字节数。
    /// Package bytes recorded in the server manifest.
    package_bytes: u64,
    /// 这一段是临时 URL 下载到的密文字节数。
    /// Ciphertext bytes downloaded from the temp URL.
    downloaded_package_bytes: u64,
    /// 这一段是主 Markdown 字节数。
    /// Main Markdown byte count.
    markdown_bytes: u64,
    /// 这一段是思考附件数量。
    /// Reasoning attachment count.
    related_file_count: usize,
}

/// 这一段读取并解包远端会话包。
/// Read and unpack one remote archive bundle.
async fn read_archive_bundle(
    request: &ConversationArchiveRequest,
) -> anyhow::Result<ResolvedArchiveBundle> {
    let total_started_at = Instant::now();
    let mut performance = ArchivePreviewPerformance::default();

    // 这一段每次预览只派生一次密钥，后续下载和解密复用同一上下文。
    // Derive keys once per preview request and reuse the same context for download and decrypt.
    let key_started_at = Instant::now();
    let archive_crypto = crypto::ArchiveCrypto::derive(&request.sync_key)?;
    performance.key_derivation_ms = elapsed_ms(key_started_at);

    // 这一段先读取云函数 getBundle 响应，失败时原样返回给页面。
    // First read the cloud-function getBundle response and preserve failures for the page.
    let get_bundle_started_at = Instant::now();
    let response = remote::get_bundle(request, &archive_crypto).await?;
    performance.get_bundle_ms = elapsed_ms(get_bundle_started_at);
    if response.get("ok").and_then(Value::as_bool) != Some(true) {
        performance.total_native_ms = elapsed_ms(total_started_at);
        return Ok(ResolvedArchiveBundle {
            response,
            performance,
            unpacked: None,
        });
    }
    if !archive_bundle_response_has_package(&response) {
        performance.total_native_ms = elapsed_ms(total_started_at);
        return Ok(ResolvedArchiveBundle {
            response,
            performance,
            unpacked: None,
        });
    }

    // 这一段按旧 Node 协议下载 packageUrl 并解成同一个 thread-bundle 包。
    // Download packageUrl using the legacy Node protocol and resolve it into the same thread-bundle package.
    let resolve_started_at = Instant::now();
    let resolved = remote::resolve_bundle_package(&response).await?;
    performance.package_resolve_ms = elapsed_ms(resolve_started_at);
    performance.package_download_ms = resolved.download_ms;
    performance.package_transport = resolved.transport;
    performance.downloaded_package_bytes = resolved.downloaded_bytes as u64;

    // 这一段解密、校验并展开 gzip JSON 包，同时记录正文规模。
    // Decrypt, verify, and unpack the gzip JSON package while recording content size.
    let unpack_started_at = Instant::now();
    let unpacked = package::unpack_thread_package_response(&resolved.response, &archive_crypto)?;
    performance.unpack_package_ms = elapsed_ms(unpack_started_at);
    performance.package_bytes = archive_bundle_numeric_field(&resolved.response, "packageBytes")
        .unwrap_or(performance.downloaded_package_bytes);
    performance.markdown_bytes = unpacked.markdown.len() as u64;
    performance.related_file_count = unpacked.related_files.len();
    performance.total_native_ms = elapsed_ms(total_started_at);
    Ok(ResolvedArchiveBundle {
        response: resolved.response,
        performance,
        unpacked: Some(unpacked),
    })
}

/// 这一段读取远端会话包并返回 Markdown 正文。
/// Read a remote archive bundle and return the Markdown body.
async fn get_archive_file(request: &ConversationArchiveRequest) -> anyhow::Result<Value> {
    // 这一段复用共享解包逻辑，恢复旧 Node get-file 的 data.markdown 返回协议。
    // Reuse the shared unpack path and restore the legacy Node get-file data.markdown response contract.
    let ResolvedArchiveBundle {
        response,
        performance,
        unpacked,
    } = read_archive_bundle(request).await?;
    let Some(unpacked) = unpacked else {
        return Ok(response);
    };
    Ok(build_archive_file_response(
        response,
        &unpacked,
        &performance,
    ))
}

/// 这一段把远端会话包解压成本机预览文件。
/// Unpack a remote archive bundle into a local preview file.
async fn prepare_archive_file(request: &ConversationArchiveRequest) -> anyhow::Result<Value> {
    // 这一段复用 get-file 的下载解包链路，只在成功时写入本机受控预览目录。
    // Reuse the get-file download/unpack chain and write the controlled local preview only after success.
    let prepare_started_at = Instant::now();
    let ResolvedArchiveBundle {
        response,
        mut performance,
        unpacked,
    } = read_archive_bundle(request).await?;
    let Some(unpacked) = unpacked else {
        return Ok(response);
    };
    let write_started_at = Instant::now();
    let mut response = preview::write_preview_file(request, &unpacked).await?;
    performance.write_preview_ms = elapsed_ms(write_started_at);
    performance.total_native_ms = elapsed_ms(prepare_started_at);
    attach_archive_performance(&mut response, &performance);
    Ok(response)
}

/// 这一段按本机 Codex threadId 导出临时 Markdown 附件文件。
/// Export a local temporary Markdown attachment file by native Codex threadId.
async fn prepare_local_archive_file(request: &ConversationArchiveRequest) -> anyhow::Result<Value> {
    // 这一段只接受已经由 request parser 归一化过的短 threadId。
    // Accept only the short threadId already normalized by the request parser.
    if request.thread_id.trim().is_empty() {
        return Ok(json!({
            "data": null,
            "error": "无效的会话 ID / Invalid conversation thread id",
            "ok": false,
            "status": 400,
        }));
    }

    // 这一段读取本机身份和 Codex 会话元数据；正文仍到选中 thread 后才解析。
    // Read local identity and Codex thread metadata; body parsing is deferred until the selected thread is known.
    let identity = identity::read_or_create_identity().await?;
    let session_titles = session_index::read_session_titles()
        .await
        .unwrap_or_default();
    let raw_rows = codex_state::read_threads(&session_titles).await?;
    let grouped_rows = match project::apply_thread_groups(raw_rows.clone(), &identity).await {
        Ok(grouped) => grouped.rows,
        Err(_) => raw_rows
            .into_iter()
            .map(|mut row| {
                project::apply_default_conversation_group(&mut row);
                row
            })
            .collect(),
    };
    let Some(row) = grouped_rows
        .into_iter()
        .find(|row| row.thread_id == request.thread_id)
    else {
        return Ok(json!({
            "data": null,
            "error": "未找到本机会话 / Local conversation thread not found",
            "ok": false,
            "status": 404,
        }));
    };

    // 这一段复用会话归档 Markdown 导出格式，再写入受控预览目录供 composer 附件引用。
    // Reuse the conversation archive Markdown format, then write it into the controlled preview directory for composer attachment.
    let archive_path = lifecycle::thread_archive_path(&identity, &row);
    let exported = match rollout_reader::export_thread_archive(&row, &archive_path).await {
        Ok(Some(exported)) => exported,
        Ok(None) => {
            return Ok(json!({
                "data": null,
                "error": "会话没有可导出的正文 / Conversation has no exportable messages",
                "ok": false,
                "status": 404,
            }));
        }
        Err(_) => rollout_reader::ExportedThreadMarkdown {
            markdown: markdown::create_fallback_markdown(&row),
            message_count: 0,
            parse_errors: 1,
            related_files: Vec::new(),
        },
    };
    let package = package::UnpackedThreadPackage {
        markdown: exported.markdown,
        related_files: exported
            .related_files
            .into_iter()
            .map(|file| package::UnpackedRelatedFile {
                link_name: file.link_name,
                markdown: file.markdown,
            })
            .collect(),
        title: row.title.clone(),
    };
    let mut preview_request = request.clone();
    preview_request.path = archive_path.clone();
    let mut response = preview::write_preview_file(&preview_request, &package).await?;
    if let Some(data) = response.get_mut("data").and_then(Value::as_object_mut) {
        data.insert("path".to_string(), json!(archive_path));
        data.insert("threadId".to_string(), json!(row.thread_id));
        data.insert("title".to_string(), json!(row.title));
    }
    Ok(response)
}

/// 这一段构造 get-file 的页面响应。
/// Build the page response for get-file.
fn build_archive_file_response(
    mut response: Value,
    unpacked: &package::UnpackedThreadPackage,
    performance: &ArchivePreviewPerformance,
) -> Value {
    // 这一段确保 data 是对象，避免不同云函数包装形态导致写入失败。
    // Ensure data is an object so different cloud-function wrappers cannot break response shaping.
    if !response.get("data").is_some_and(Value::is_object) {
        response["data"] = json!({});
    }

    // 这一段只返回页面需要的 Markdown 和附件，不暴露临时下载链接或包 base64。
    // Return only the Markdown and related attachments needed by the page, without exposing temp URLs or package base64.
    if let Some(data) = response.get_mut("data").and_then(Value::as_object_mut) {
        remove_archive_package_body_fields(data);
        data.insert("markdown".to_string(), json!(unpacked.markdown.as_str()));
        data.insert("markdownBytes".to_string(), json!(unpacked.markdown.len()));
        data.insert("packageUrl".to_string(), json!(""));
        data.insert(
            "relatedFiles".to_string(),
            Value::Array(
                unpacked
                    .related_files
                    .iter()
                    .map(|file| {
                        json!({
                            "linkName": file.link_name.as_str(),
                            "markdown": file.markdown.as_str(),
                        })
                    })
                    .collect(),
            ),
        );
    }
    attach_archive_performance(&mut response, performance);
    response
}

/// 这一段把预览打开耗时挂到响应 data.performance。
/// Attach preview-open timing to response data.performance.
fn attach_archive_performance(response: &mut Value, performance: &ArchivePreviewPerformance) {
    // 这一段保证响应 data 可写，并且只加入非敏感计时和字节数。
    // Ensure response data is writable and add only non-sensitive timings and byte counts.
    if !response.get("data").is_some_and(Value::is_object) {
        response["data"] = json!({});
    }
    if let Some(data) = response.get_mut("data").and_then(Value::as_object_mut) {
        data.insert(
            "performance".to_string(),
            archive_performance_value(performance),
        );
    }
}

/// 这一段生成前端可消费的性能 JSON。
/// Build frontend-consumable performance JSON.
fn archive_performance_value(performance: &ArchivePreviewPerformance) -> Value {
    // 这一段只包含阶段名、耗时和大小，不包含同步密钥、正文或本机路径。
    // Include only stage names, timings, and sizes; never include sync keys, body text, or local paths.
    json!({
        "downloadedPackageBytes": performance.downloaded_package_bytes,
        "getBundleMs": performance.get_bundle_ms,
        "keyDerivationMs": performance.key_derivation_ms,
        "markdownBytes": performance.markdown_bytes,
        "packageBytes": performance.package_bytes,
        "packageDownloadMs": performance.package_download_ms,
        "packageResolveMs": performance.package_resolve_ms,
        "packageTransport": performance.package_transport,
        "relatedFileCount": performance.related_file_count,
        "totalNativeMs": performance.total_native_ms,
        "unpackPackageMs": performance.unpack_package_ms,
        "writePreviewMs": performance.write_preview_ms,
    })
}

/// 这一段读取 getBundle 响应里的数字 metadata。
/// Read numeric metadata from a getBundle response.
fn archive_bundle_numeric_field(response: &Value, field_name: &str) -> Option<u64> {
    // 这一段兼容顶层 data、嵌套 data 和 file manifest 三种位置。
    // Support top-level data, nested data, and file manifest locations.
    let data = response.get("data").unwrap_or(response);
    data.get(field_name)
        .and_then(Value::as_u64)
        .or_else(|| {
            data.get("data")
                .and_then(|value| value.get(field_name))
                .and_then(Value::as_u64)
        })
        .or_else(|| {
            data.get("file")
                .and_then(|value| value.get(field_name))
                .and_then(Value::as_u64)
        })
        .or_else(|| {
            data.get("data")
                .and_then(|value| value.get("file"))
                .and_then(|value| value.get(field_name))
                .and_then(Value::as_u64)
        })
}

/// 这一段把 Instant 耗时转换成安全毫秒数。
/// Convert Instant elapsed time into a bounded millisecond value.
fn elapsed_ms(started_at: Instant) -> u64 {
    // 这一段避免极端长耗时超过 JSON 数字的常用整数范围。
    // Keep extreme durations within the usual JSON integer range.
    started_at.elapsed().as_millis().min(u128::from(u64::MAX)) as u64
}

/// 这一段移除 get-file 响应里不应暴露给页面的包体字段。
/// Remove package-body fields that get-file must not expose to the page.
fn remove_archive_package_body_fields(data: &mut serde_json::Map<String, Value>) {
    // 这一段清理顶层字段，匹配旧 Node 返回 Markdown 后清空下载链接的边界。
    // Clean top-level fields, matching the legacy Node boundary after Markdown is returned.
    data.remove("packageBase64");
    data.remove("packageUrl");

    // 这一段兼容双层 data 包装，避免嵌套包体或临时链接随响应泄露。
    // Also clean a nested data wrapper so package bodies or temp URLs cannot leak through it.
    if let Some(nested) = data.get_mut("data").and_then(Value::as_object_mut) {
        nested.remove("packageBase64");
        nested.remove("packageUrl");
    }
}

/// 这一段判断 getBundle 成功响应是否真的带会话包。
/// Check whether a successful getBundle response actually carries a thread package.
fn archive_bundle_response_has_package(response: &Value) -> bool {
    // 这一段兼容 native wrapper 和远端 body 的双层 data 包装。
    // Support both the native wrapper and the remote body nested data wrapper.
    let data = response.get("data").unwrap_or(response);
    let package_data = if data.get("packageBase64").is_some() || data.get("packageUrl").is_some() {
        data
    } else {
        data.get("data").unwrap_or(data)
    };

    // 这一段只在确实存在非空包体或临时链接时继续解包，保持旧 Node 的原样返回边界。
    // Continue unpacking only when a non-empty package body or temp URL exists, preserving the legacy Node passthrough boundary.
    ["packageBase64", "packageUrl"].iter().any(|key| {
        package_data
            .get(*key)
            .and_then(Value::as_str)
            .is_some_and(|value| !value.trim().is_empty())
    })
}

/// 这一段拉取远端归档列表。
/// List remote conversation archives.
async fn list_archive(request: &ConversationArchiveRequest) -> anyhow::Result<Value> {
    // 这一段用持久 identity 标记本机设备，避免列表和上传使用不同设备 ID。
    // Use the persistent identity for local-device marking so list and upload share the same device ID.
    let archive_crypto = crypto::ArchiveCrypto::derive(&request.sync_key)?;
    let identity = identity::read_or_create_identity().await?;
    let sync_key_hash = state::sync_key_hash(&request.sync_key);
    device_delete::retry_pending_deletes(request, &sync_key_hash, &archive_crypto).await?;
    let pending_device_ids = device_delete::list_pending_device_ids(request, &sync_key_hash).await;
    let index = state::read_index(&request.sync_key, &identity).await?;
    let hidden_thread_ids = codex_state::read_internal_thread_ids()
        .await
        .unwrap_or_default();
    Ok(remote::build_archive_list_response_with_options(
        remote::pull_manifest(request, &archive_crypto).await?,
        request,
        remote::ArchiveListOptions {
            hidden_thread_ids,
            identity: Some(identity),
            local_device_upload_blocked_after_delete: !index
                .local_device_upload_blocked_after_delete_at
                .is_empty(),
            pending_device_ids,
        },
    ))
}

/// 这一段重置会话归档。
/// Reset conversation archive.
async fn reset_archive(request: &ConversationArchiveRequest) -> anyhow::Result<Value> {
    // 这一段远端清空成功后重置本机索引，让下一轮全量重建。
    // Reset the local index after the remote domain is cleared so the next push rebuilds everything.
    let archive_crypto = crypto::ArchiveCrypto::derive(&request.sync_key)?;
    let identity = identity::read_or_create_identity().await?;
    let response = remote::reset_manifest(request, &archive_crypto).await?;
    if response.get("ok").and_then(Value::as_bool) == Some(true) {
        state::write_index(
            &request.sync_key,
            &identity,
            &state::ArchiveIndex {
                version: state::INDEX_VERSION,
                ..state::ArchiveIndex::default()
            },
        )
        .await?;
    }
    Ok(response)
}

/// 这一段删除单设备会话归档。
/// Delete one device archive.
async fn delete_device_archive(request: &ConversationArchiveRequest) -> anyhow::Result<Value> {
    // 这一段先持久化删除意图，再尝试远端确认。
    // Persist delete intent before trying remote confirmation.
    let archive_crypto = crypto::ArchiveCrypto::derive(&request.sync_key)?;
    let identity = identity::read_or_create_identity().await?;
    let sync_key_hash = state::sync_key_hash(&request.sync_key);
    let deletes_local_device = request.device_id == identity.device_id;
    device_delete::remember_pending_delete(request, &sync_key_hash).await?;
    if deletes_local_device {
        state::write_index(
            &request.sync_key,
            &identity,
            &state::ArchiveIndex {
                local_device_upload_blocked_after_delete_at: crate::state::now_text(),
                version: state::INDEX_VERSION,
                ..state::ArchiveIndex::default()
            },
        )
        .await?;
    }
    let response = match device_delete::delete_device(request, &archive_crypto).await {
        Ok(response) => response,
        Err(_) => {
            return Ok(device_delete::pending_response(
                request,
                &identity,
                deletes_local_device,
            ));
        }
    };
    if response.get("ok").and_then(Value::as_bool) != Some(true) {
        if device_delete::is_transient_delete_failure(&response) {
            return Ok(device_delete::pending_response(
                request,
                &identity,
                deletes_local_device,
            ));
        }
        let _ =
            device_delete::forget_pending_delete(request, &sync_key_hash, &request.device_id).await;
        return Ok(response);
    }
    device_delete::forget_pending_delete(request, &sync_key_hash, &request.device_id).await?;
    Ok(json!({
        "ok": true,
        "status": response.get("status").and_then(Value::as_u64).unwrap_or(200),
        "data": {
            "deviceDeletePending": false,
            "identity": {
                "deviceId": identity.device_id,
                "profileId": identity.profile_id,
            },
            "localDeviceDeletePending": false,
            "localDeviceUploadBlockedAfterDelete": deletes_local_device,
        },
        "error": response.get("error").and_then(Value::as_str).unwrap_or(""),
    }))
}

/// 这一段执行会话归档上传。
/// Push local conversation archive bundles.
async fn push_archive(
    request: &ConversationArchiveRequest,
    progress_sender: Option<progress::ProgressSender>,
) -> anyhow::Result<Value> {
    let mut reporter = progress::ProgressReporter::new(progress_sender);
    reporter.report_force(json!({ "stage": "init" }));
    // 这一段先读取本机身份、远端索引和本地增量索引。
    // Read local identity, remote manifest, and local incremental index first.
    let archive_crypto = crypto::ArchiveCrypto::derive(&request.sync_key)?;
    let identity = identity::read_or_create_identity().await?;
    let sync_key_hash = state::sync_key_hash(&request.sync_key);
    let pending_before = device_delete::list_pending_device_ids(request, &sync_key_hash).await;
    let had_local_pending_delete = pending_before.contains(&identity.device_id);
    if !pending_before.is_empty() {
        device_delete::retry_pending_deletes(request, &sync_key_hash, &archive_crypto).await?;
    }
    if had_local_pending_delete {
        let mut list_response = list_archive(request).await?;
        if let Some(data) = list_response.get_mut("data").and_then(Value::as_object_mut) {
            data.insert(
                "localDeviceUploadSkippedForPendingDelete".to_string(),
                json!(true),
            );
        }
        return Ok(list_response);
    }
    let mut index = state::read_index(&request.sync_key, &identity).await?;
    if !index.local_device_upload_blocked_after_delete_at.is_empty() && !request.force {
        let mut list_response = list_archive(request).await?;
        if let Some(data) = list_response.get_mut("data").and_then(Value::as_object_mut) {
            data.insert(
                "localDeviceUploadBlockedAfterDelete".to_string(),
                json!(true),
            );
        }
        return Ok(list_response);
    }
    if !index.local_device_upload_blocked_after_delete_at.is_empty() && request.force {
        index.local_device_upload_blocked_after_delete_at.clear();
    }
    if index.legacy_plaintext_cleaned_at.is_empty() {
        reporter.report_force(json!({ "stage": "cleanup" }));
        let cleanup_response = remote::cleanup_legacy_manifest(request, &archive_crypto).await?;
        if cleanup_response.get("ok").and_then(Value::as_bool) != Some(true) {
            reporter.report_force(json!({
                "stage": "failed",
                "error": cleanup_response.get("error").and_then(Value::as_str).unwrap_or("旧会话归档清理失败，请先部署新版归档云函数 / Failed to clean legacy archive; deploy the updated archive cloud function first"),
            }));
            return Ok(cleanup_response);
        }
        if !remote::is_legacy_cleanup_response(&cleanup_response) {
            let failed_response = json!({
                "data": cleanup_response.get("data").cloned().unwrap_or(Value::Null),
                "error": "旧会话归档清理接口不可用，请先部署新版归档云函数 / Legacy archive cleanup is unavailable; deploy the updated archive cloud function first",
                "ok": false,
                "status": 426,
            });
            reporter.report_force(json!({
                "stage": "failed",
                "error": failed_response.get("error").and_then(Value::as_str).unwrap_or("旧会话归档清理接口不可用 / Legacy archive cleanup is unavailable"),
            }));
            return Ok(failed_response);
        }
        index.legacy_plaintext_cleaned_at = crate::state::now_text();
        state::write_index(&request.sync_key, &identity, &index).await?;
    }
    reporter.report_force(json!({ "stage": "pull" }));
    let remote_response = remote::pull_manifest(request, &archive_crypto).await?;
    if remote_response.get("ok").and_then(Value::as_bool) != Some(true) {
        reporter.report_force(json!({
            "stage": "failed",
            "error": remote_response.get("error").and_then(Value::as_str).unwrap_or("远端归档索引读取失败 / Failed to pull remote archive index"),
        }));
        return Ok(remote_response);
    }
    let mut upload_revision = remote_response
        .pointer("/data/revision")
        .and_then(Value::as_u64);
    let mut remote_files = remote_response
        .pointer("/data/files")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let now_ms = state::now_unix_ms();
    let hidden_thread_ids = codex_state::read_internal_thread_ids()
        .await
        .unwrap_or_default();
    let display_names = archive_display_names(request);

    // 这一段读取本机会话元数据和短标题。
    // Read local thread metadata and short titles.
    let session_titles = session_index::read_session_titles()
        .await
        .unwrap_or_default();
    let grouped_threads =
        project::apply_thread_groups(codex_state::read_threads(&session_titles).await?, &identity)
            .await?;
    let all_rows = grouped_threads.rows;
    let removed_project_thread_count = grouped_threads.removed_project_thread_count;
    let archive_limit_skipped_count = all_rows.len().saturating_sub(remote::MAX_REMOTE_ENTRIES);
    let rows = all_rows
        .into_iter()
        .take(remote::MAX_REMOTE_ENTRIES)
        .collect::<Vec<_>>();
    let current_thread_ids = rows
        .iter()
        .map(|row| row.thread_id.clone())
        .collect::<HashSet<_>>();
    let total_thread_count = rows.len();
    let mut pending_rows = Vec::new();
    let mut scanned_threads = 0usize;
    let mut skipped_count = 0usize;
    let mut skipped_generated_title_count = 0usize;
    let mut skipped_missing_title_count = 0usize;
    let mut skipped_unchanged_count = 0usize;
    let mut unstable_count = 0usize;
    let mut unstable_forced_count = 0usize;
    reporter.report_force(json!({
        "pendingThreadCount": 0,
        "scannedThreads": 0,
        "stage": "scan",
        "totalThreads": total_thread_count,
    }));
    for original_row in rows.iter() {
        scanned_threads += 1;
        let archive_path = lifecycle::thread_archive_path(&identity, original_row);
        let row = original_row.clone();
        let rollout_stat = state::read_rollout_stat(&row);
        if rollout_stat.size == 0 {
            skipped_count += 1;
            continue;
        }
        if !request.force && !state::is_thread_stable(&row, now_ms) {
            let (allow_export, first_seen_ms) =
                state::unstable_decision(&index, &row, &archive_path, now_ms);
            if !allow_export {
                unstable_count += 1;
                state::remember_unstable_thread(
                    &mut index,
                    &row,
                    &archive_path,
                    &rollout_stat,
                    first_seen_ms,
                );
                reporter.report(json!({
                    "pendingThreadCount": pending_rows.len(),
                    "scannedThreads": scanned_threads,
                    "stage": "scan",
                    "totalThreads": total_thread_count,
                    "unstableCount": unstable_count,
                }));
                continue;
            }
            unstable_forced_count += 1;
        }
        if !row.skip_reason.is_empty() {
            if state::should_export_thread(
                &row,
                &archive_path,
                &rollout_stat,
                &index,
                &remote_files,
            ) {
                skipped_count += 1;
                if row.skip_reason == "generated-title" {
                    skipped_generated_title_count += 1;
                }
                if row.skip_reason == "missing-title" {
                    skipped_missing_title_count += 1;
                }
                state::remember_skipped_thread(
                    &mut index,
                    &row,
                    &archive_path,
                    &rollout_stat,
                    &row.skip_reason,
                );
            }
            continue;
        }
        if !state::should_export_thread(&row, &archive_path, &rollout_stat, &index, &remote_files) {
            skipped_unchanged_count += 1;
            continue;
        }
        pending_rows.push((row.clone(), archive_path, rollout_stat));
        reporter.report(json!({
            "changedCount": pending_rows.len(),
            "pendingThreadCount": pending_rows.len(),
            "scannedThreads": scanned_threads,
            "stage": "scan",
            "totalThreads": total_thread_count,
        }));
    }

    // 这一段没有可上传会话时也返回成功，避免误报。
    // Return success even when no changed thread is available.
    reporter.report_force(json!({
        "changedCount": pending_rows.len(),
        "pendingThreadCount": pending_rows.len(),
        "preparedThreadCount": 0,
        "processedThreadCount": 0,
        "scannedThreads": scanned_threads,
        "stage": "export",
        "totalThreads": total_thread_count,
        "uploadLimit": codex_state::MAX_UPLOADS_PER_RUN,
        "uploadBytesPerSecond": 0,
        "uploadedBytes": 0,
        "uploadedCount": 0,
    }));
    let mut uploaded_count = 0usize;
    let mut uploaded_bytes = 0usize;
    let mut upload_elapsed_ms = 0u64;
    let mut deleted_marked_count = 0usize;
    let mut no_message_count = 0usize;
    let mut processed_thread_count = 0usize;
    let mut remote_limit_skipped_count = 0usize;
    let mut remote_unchanged_count = 0usize;
    let mut skipped_oversize_count = 0usize;
    let mut upload_limit_reached = false;
    let mut batch = Vec::<BatchItem>::new();
    for (row, archive_path, rollout_stat) in pending_rows.iter() {
        if uploaded_count + batch.len() >= codex_state::MAX_UPLOADS_PER_RUN {
            upload_limit_reached = true;
            break;
        }
        reporter.report_force(json!({
            "changedCount": pending_rows.len(),
            "pendingThreadCount": pending_rows.len(),
            "preparedThreadCount": processed_thread_count + batch.len(),
            "processedThreadCount": processed_thread_count,
            "stage": "export",
            "totalThreads": total_thread_count,
            "uploadLimit": codex_state::MAX_UPLOADS_PER_RUN,
            "uploadBytesPerSecond": upload_bytes_per_second(uploaded_bytes, upload_elapsed_ms),
            "uploadedBytes": uploaded_bytes,
            "uploadedCount": uploaded_count,
        }));
        let exported = match rollout_reader::export_thread_archive(row, archive_path).await {
            Ok(Some(exported)) => exported,
            Ok(None) => {
                no_message_count += 1;
                processed_thread_count += 1;
                state::remember_skipped_thread(
                    &mut index,
                    row,
                    archive_path,
                    rollout_stat,
                    "no-message",
                );
                continue;
            }
            Err(_) => rollout_reader::ExportedThreadMarkdown {
                markdown: markdown::create_fallback_markdown(row),
                message_count: 0,
                parse_errors: 1,
                related_files: Vec::new(),
            },
        };
        let mut bundle = match package::create_thread_package_with_related_files_and_counts(
            archive_path,
            row,
            &exported.markdown,
            &exported.related_files,
            exported.message_count,
            &archive_crypto,
        ) {
            Ok(bundle) => bundle,
            Err(error) if is_package_oversize_error(&error) => {
                skipped_count += 1;
                skipped_oversize_count += 1;
                processed_thread_count += 1;
                state::remember_skipped_thread(
                    &mut index,
                    row,
                    archive_path,
                    rollout_stat,
                    "oversize",
                );
                continue;
            }
            Err(error) => return Err(error),
        };
        bundle.metadata.device_name = display_names.device_name.clone();
        bundle.metadata.profile_name = display_names.profile_name.clone();
        let batch_item = BatchItem {
            archive_path: archive_path.clone(),
            bundle,
            row: row.clone(),
            rollout_stat: rollout_stat.clone(),
        };
        let flush_scope = FlushBundleBatchScope {
            request,
            archive_crypto: &archive_crypto,
            identity: &identity,
        };
        if remote::should_flush_bundle_batch(
            request,
            &archive_crypto,
            &batch
                .iter()
                .map(|item| item.bundle.clone())
                .collect::<Vec<_>>(),
            &batch_item.bundle,
            upload_revision,
        ) {
            let outcome = flush_bundle_batch(
                &flush_scope,
                &mut index,
                &mut remote_files,
                &mut upload_revision,
                &mut reporter,
                &mut batch,
                FlushContext {
                    pending_count: pending_rows.len(),
                    processed_count: processed_thread_count,
                    total_threads: total_thread_count,
                    upload_elapsed_ms,
                    uploaded_bytes,
                    uploaded_count,
                },
            )
            .await?;
            if let Some(failed_response) = outcome.failed_response {
                return Ok(failed_response);
            }
            let stats = outcome.stats;
            uploaded_count += stats.uploaded_count;
            uploaded_bytes += stats.uploaded_bytes;
            upload_elapsed_ms += stats.upload_elapsed_ms;
            deleted_marked_count += stats.deleted_marked_count;
            remote_limit_skipped_count += stats.remote_limit_skipped_count;
            remote_unchanged_count += stats.remote_unchanged_count;
            processed_thread_count += stats.processed_count;
        }
        batch.push(batch_item);
    }
    let flush_scope = FlushBundleBatchScope {
        request,
        archive_crypto: &archive_crypto,
        identity: &identity,
    };
    let outcome = flush_bundle_batch(
        &flush_scope,
        &mut index,
        &mut remote_files,
        &mut upload_revision,
        &mut reporter,
        &mut batch,
        FlushContext {
            pending_count: pending_rows.len(),
            processed_count: processed_thread_count,
            total_threads: total_thread_count,
            upload_elapsed_ms,
            uploaded_bytes,
            uploaded_count,
        },
    )
    .await?;
    if let Some(failed_response) = outcome.failed_response {
        return Ok(failed_response);
    }
    let stats = outcome.stats;
    uploaded_count += stats.uploaded_count;
    uploaded_bytes += stats.uploaded_bytes;
    upload_elapsed_ms += stats.upload_elapsed_ms;
    deleted_marked_count += stats.deleted_marked_count;
    remote_limit_skipped_count += stats.remote_limit_skipped_count;
    remote_unchanged_count += stats.remote_unchanged_count;
    processed_thread_count += stats.processed_count;

    let lifecycle_updates = state::deleted_lifecycle_updates(
        &index,
        &remote_files,
        &identity,
        &current_thread_ids,
        archive_limit_skipped_count > 0,
    );
    for updates in lifecycle_updates.chunks(remote::MAX_BATCH_ITEMS) {
        reporter.report(json!({
            "deletedMarkedCount": deleted_marked_count,
            "lifecyclePendingCount": lifecycle_updates.len(),
            "stage": "lifecycle",
            "totalThreads": total_thread_count,
        }));
        let response = remote::put_lifecycle_batch_with_retry(
            request,
            &archive_crypto,
            updates,
            upload_revision,
        )
        .await?;
        if response.get("ok").and_then(Value::as_bool) != Some(true) {
            reporter.report_force(json!({
                "deletedMarkedCount": deleted_marked_count,
                "error": response.get("error").and_then(Value::as_str).unwrap_or("会话生命周期标记同步失败 / Conversation lifecycle marker sync failed"),
                "lifecyclePendingCount": lifecycle_updates.len(),
                "stage": "failed",
                "totalThreads": total_thread_count,
            }));
            return Ok(response);
        }
        upload_revision = response
            .pointer("/data/revision")
            .and_then(Value::as_u64)
            .or(upload_revision);
        merge_remote_files(&mut remote_files, &response);
        let item_results = remote::item_results(&response);
        for update in updates {
            let item_result = find_batch_item_result(&item_results, &update.path);
            let Some(item_result) = item_result else {
                let failed_response = build_lifecycle_failed_response(
                    &response,
                    "会话归档包上传结果缺失 / Archive package upload result is missing",
                    deleted_marked_count,
                    lifecycle_updates.len(),
                    total_thread_count,
                    &update.path,
                );
                reporter.report_force(build_lifecycle_failed_progress(
                    &failed_response,
                    deleted_marked_count,
                    lifecycle_updates.len(),
                    total_thread_count,
                ));
                return Ok(failed_response);
            };
            if let Some(failed_response) = validate_lifecycle_item_result(
                &response,
                item_result,
                &update.path,
                deleted_marked_count,
                lifecycle_updates.len(),
                total_thread_count,
            ) {
                reporter.report_force(build_lifecycle_failed_progress(
                    &failed_response,
                    deleted_marked_count,
                    lifecycle_updates.len(),
                    total_thread_count,
                ));
                return Ok(failed_response);
            }
            if item_result.get("retained").and_then(Value::as_bool) == Some(false) {
                remote_files.remove(&update.path);
            }
            state::remember_lifecycle_update(&mut index, update);
            if item_result
                .get("lifecycleUpdated")
                .and_then(Value::as_bool)
                .unwrap_or(true)
            {
                deleted_marked_count += 1;
            }
        }
    }

    state::write_index(&request.sync_key, &identity, &index).await?;
    let pending_device_ids = device_delete::list_pending_device_ids(request, &sync_key_hash).await;
    reporter.report_force(json!({
        "changedCount": pending_rows.len(),
        "pendingThreadCount": pending_rows.len(),
        "processedThreadCount": processed_thread_count,
        "remoteLimitSkippedCount": remote_limit_skipped_count,
        "removedProjectThreadCount": removed_project_thread_count,
        "stage": "done",
        "totalThreads": total_thread_count,
        "uploadLimit": codex_state::MAX_UPLOADS_PER_RUN,
        "uploadBytesPerSecond": upload_bytes_per_second(uploaded_bytes, upload_elapsed_ms),
        "uploadLimitReached": upload_limit_reached,
        "uploadedBytes": uploaded_bytes,
        "uploadedCount": uploaded_count,
    }));
    let mut response = remote::build_archive_list_response_with_options(
        json!({
            "ok": true,
            "status": 200,
            "data": {
                "files": remote_files,
                "revision": upload_revision,
            },
            "error": "",
        }),
        request,
        remote::ArchiveListOptions {
            hidden_thread_ids,
            identity: Some(identity.clone()),
            local_device_upload_blocked_after_delete: !index
                .local_device_upload_blocked_after_delete_at
                .is_empty(),
            pending_device_ids,
        },
    );
    if let Some(data) = response.get_mut("data").and_then(Value::as_object_mut) {
        data.insert(
            "archiveLimitSkippedCount".to_string(),
            json!(archive_limit_skipped_count),
        );
        data.insert("changedCount".to_string(), json!(pending_rows.len()));
        data.insert(
            "deletedMarkedCount".to_string(),
            json!(deleted_marked_count),
        );
        data.insert("noMessageCount".to_string(), json!(no_message_count));
        data.insert("pendingThreadCount".to_string(), json!(pending_rows.len()));
        data.insert(
            "processedThreadCount".to_string(),
            json!(processed_thread_count),
        );
        data.insert(
            "remoteLimitSkippedCount".to_string(),
            json!(remote_limit_skipped_count),
        );
        data.insert(
            "remoteUnchangedCount".to_string(),
            json!(remote_unchanged_count),
        );
        data.insert(
            "removedProjectThreadCount".to_string(),
            json!(removed_project_thread_count),
        );
        data.insert(
            "skippedGeneratedTitleCount".to_string(),
            json!(skipped_generated_title_count),
        );
        data.insert(
            "skippedMissingTitleCount".to_string(),
            json!(skipped_missing_title_count),
        );
        data.insert(
            "skippedOversizeCount".to_string(),
            json!(skipped_oversize_count),
        );
        data.insert("skippedCount".to_string(), json!(skipped_count));
        data.insert("totalThreads".to_string(), json!(total_thread_count));
        data.insert(
            "skippedUnchangedCount".to_string(),
            json!(skipped_unchanged_count),
        );
        data.insert("unstableCount".to_string(), json!(unstable_count));
        data.insert(
            "unstableForcedCount".to_string(),
            json!(unstable_forced_count),
        );
        data.insert(
            "uploadLimit".to_string(),
            json!(codex_state::MAX_UPLOADS_PER_RUN),
        );
        data.insert(
            "uploadLimitReached".to_string(),
            json!(upload_limit_reached),
        );
        data.insert(
            "uploadBytesPerSecond".to_string(),
            json!(upload_bytes_per_second(uploaded_bytes, upload_elapsed_ms)),
        );
        data.insert("uploadedBytes".to_string(), json!(uploaded_bytes));
        data.insert("uploadedCount".to_string(), json!(uploaded_count));
        data.insert("uploadedFileCount".to_string(), json!(uploaded_count));
        data.insert("uploadedPackageCount".to_string(), json!(uploaded_count));
    }
    Ok(response)
}

/// 这一段描述显示名。
/// Describes upload display names.
#[derive(Clone, Debug, PartialEq, Eq)]
struct ArchiveDisplayNames {
    /// 这一段是设备显示名。
    /// Device display name.
    device_name: String,
    /// 这一段是账号显示名。
    /// Profile display name.
    profile_name: String,
}

/// 这一段把 Duration 收敛为毫秒。
/// Convert a Duration into milliseconds.
fn duration_millis(duration: Duration) -> u64 {
    // 这一段限制极端值，避免平台计时异常溢出页面进度字段。
    // Clamp extreme values so platform timer oddities cannot overflow page progress fields.
    duration.as_millis().min(u64::MAX as u128) as u64
}

/// 这一段按已完成上传请求估算上传速度。
/// Estimate upload speed from completed upload requests.
fn upload_bytes_per_second(uploaded_bytes: usize, upload_elapsed_ms: u64) -> usize {
    // 这一段对齐旧 Node，只用真实上传请求耗时，避免扫描和导出稀释速度。
    // Match legacy Node by using only real upload-request time, avoiding scan/export dilution.
    if uploaded_bytes == 0 || upload_elapsed_ms == 0 {
        return 0;
    }
    let bytes_per_second = (uploaded_bytes as u128 * 1000) / upload_elapsed_ms as u128;
    bytes_per_second.max(1).min(usize::MAX as u128) as usize
}

/// 这一段识别可跳过的打包超限错误。
/// Identify skippable package-size errors.
fn is_package_oversize_error(error: &anyhow::Error) -> bool {
    // 这一段只把明确的大小上限命中当作 oversize，其它打包错误继续失败暴露。
    // Treat only explicit size-limit hits as oversize; other package errors remain real failures.
    let message = error.to_string();
    message.contains("exceeds uncompressed size limit")
        || message.contains("exceeds compressed size limit")
}

/// 这一段生成归档显示名。
/// Build archive display names.
fn archive_display_names(request: &ConversationArchiveRequest) -> ArchiveDisplayNames {
    // 这一段设备名默认取系统主机名，账号默认 Default profile。
    // Default the device name to the host name and profile to "Default profile".
    ArchiveDisplayNames {
        device_name: if request.device_name.trim().is_empty() {
            std::env::var("COMPUTERNAME")
                .or_else(|_| std::env::var("HOSTNAME"))
                .unwrap_or_else(|_| "This device".to_string())
        } else {
            request.device_name.clone()
        },
        profile_name: if request.profile_name.trim().is_empty() {
            DEFAULT_PROFILE_NAME.to_string()
        } else {
            request.profile_name.clone()
        },
    }
}

/// 这一段描述上传批次项。
/// Describes one upload batch item.
#[derive(Clone, Debug)]
struct BatchItem {
    /// 这一段是远端路径。
    /// Remote path.
    archive_path: String,
    /// 这一段是会话包。
    /// Thread bundle.
    bundle: package::ThreadBundlePayload,
    /// 这一段是线程行。
    /// Thread row.
    row: codex_state::ConversationThreadRow,
    /// 这一段是 rollout 状态。
    /// Rollout stat.
    rollout_stat: state::RolloutStat,
}

/// 这一段收纳 flush 批次里的只读服务依赖。
/// Holds read-only service dependencies used by a flush batch.
struct FlushBundleBatchScope<'a> {
    /// 这一段是页面侧归档请求。
    /// Page-side archive request.
    request: &'a ConversationArchiveRequest,
    /// 这一段是会话归档加密器。
    /// Conversation archive crypto helper.
    archive_crypto: &'a crypto::ArchiveCrypto,
    /// 这一段是当前归档身份。
    /// Current archive identity.
    identity: &'a identity::ArchiveIdentity,
}

/// 这一段描述 flush 上下文。
/// Describes upload flush context.
#[derive(Clone, Copy, Debug)]
struct FlushContext {
    /// 这一段是待处理数量。
    /// Pending count.
    pending_count: usize,
    /// 这一段是已处理数量。
    /// Processed count.
    processed_count: usize,
    /// 这一段是总会话数。
    /// Total thread count.
    total_threads: usize,
    /// 这一段是进入当前批次前的上传耗时。
    /// Upload elapsed time before the current batch.
    upload_elapsed_ms: u64,
    /// 这一段是进入当前批次前的上传字节数。
    /// Uploaded byte count before the current batch.
    uploaded_bytes: usize,
    /// 这一段是进入当前批次前的上传数量。
    /// Uploaded item count before the current batch.
    uploaded_count: usize,
}

/// 这一段描述 flush 结果。
/// Describes upload flush result.
#[derive(Clone, Copy, Debug, Default)]
struct FlushStats {
    /// 这一段是本轮标记删除数量。
    /// Deleted marker count.
    deleted_marked_count: usize,
    /// 这一段是已处理数量。
    /// Processed item count.
    processed_count: usize,
    /// 这一段是远端上限跳过数量。
    /// Remote-limit skipped count.
    remote_limit_skipped_count: usize,
    /// 这一段是远端未变化数量。
    /// Remote unchanged count.
    remote_unchanged_count: usize,
    /// 这一段是上传字节数。
    /// Uploaded byte count.
    uploaded_bytes: usize,
    /// 这一段是上传数量。
    /// Uploaded item count.
    uploaded_count: usize,
    /// 这一段是本批次上传耗时。
    /// Upload elapsed time for this batch.
    upload_elapsed_ms: u64,
}

/// 这一段描述 flush 结果或结构化失败响应。
/// Describes either successful flush stats or a structured failure response.
#[derive(Clone, Debug)]
struct FlushOutcome {
    /// 这一段是失败时直接返回给页面的响应。
    /// Page response to return when the flush failed.
    failed_response: Option<Value>,
    /// 这一段是成功时累计的统计。
    /// Stats accumulated when the flush succeeded.
    stats: FlushStats,
}

/// 这一段构造成功 flush 结果。
/// Build a successful flush outcome.
fn flush_success(stats: FlushStats) -> FlushOutcome {
    // 这一段只封装成功统计，不改变调用方计数逻辑。
    // Wrap success stats without changing caller-side counting.
    FlushOutcome {
        failed_response: None,
        stats,
    }
}

/// 这一段构造失败 flush 结果。
/// Build a failed flush outcome.
fn flush_failed(response: Value) -> FlushOutcome {
    // 这一段保留旧 Node 的结构化错误响应，避免 router 降级为 status 0。
    // Preserve the legacy Node structured error response instead of letting the router degrade it to status 0.
    FlushOutcome {
        failed_response: Some(response),
        stats: FlushStats::default(),
    }
}

/// 这一段 flush 会话包批次。
/// Flush a thread-bundle batch.
async fn flush_bundle_batch(
    scope: &FlushBundleBatchScope<'_>,
    index: &mut state::ArchiveIndex,
    remote_files: &mut serde_json::Map<String, Value>,
    upload_revision: &mut Option<u64>,
    reporter: &mut progress::ProgressReporter,
    batch: &mut Vec<BatchItem>,
    mut context: FlushContext,
) -> anyhow::Result<FlushOutcome> {
    // 这一段按旧协议只发送当前窗口，成功后逐项更新索引。
    // Send only the current window and update the index item by item after success.
    if batch.is_empty() {
        return Ok(flush_success(FlushStats::default()));
    }
    let initial_upload_elapsed_ms = context.upload_elapsed_ms;
    let items = std::mem::take(batch);
    let bundles = items
        .iter()
        .map(|item| item.bundle.clone())
        .collect::<Vec<_>>();
    let current_batch_bytes = serde_json::to_vec(&remote::build_put_bundle_batch_body(
        scope.request,
        scope.archive_crypto,
        &bundles,
        *upload_revision,
    ))
    .map(|body| body.len())
    .unwrap_or_default();
    reporter.report_force(json!({
        "currentBatchBytes": current_batch_bytes,
        "currentBatchCount": bundles.len(),
        "pendingThreadCount": context.pending_count,
        "preparedThreadCount": context.processed_count + bundles.len(),
        "processedThreadCount": context.processed_count,
        "stage": "upload",
        "totalThreads": context.total_threads,
        "uploadBytesPerSecond": upload_bytes_per_second(context.uploaded_bytes, context.upload_elapsed_ms),
        "uploadedBytes": context.uploaded_bytes,
        "uploadedCount": context.uploaded_count,
    }));
    let upload_started_at = Instant::now();
    let mut response = remote::put_bundle_batch_with_retry(
        scope.request,
        scope.archive_crypto,
        &bundles,
        *upload_revision,
    )
    .await?;
    context.upload_elapsed_ms += duration_millis(upload_started_at.elapsed());
    if response.get("ok").and_then(Value::as_bool) != Some(true)
        && response.get("status").and_then(Value::as_u64) == Some(409)
    {
        let latest = remote::pull_manifest(scope.request, scope.archive_crypto).await?;
        if latest.get("ok").and_then(Value::as_bool) == Some(true) {
            *upload_revision = latest.pointer("/data/revision").and_then(Value::as_u64);
            if let Some(files) = latest.pointer("/data/files").and_then(Value::as_object) {
                *remote_files = files.clone();
            }
            let retry_started_at = Instant::now();
            response = remote::put_bundle_batch_with_retry(
                scope.request,
                scope.archive_crypto,
                &bundles,
                *upload_revision,
            )
            .await?;
            context.upload_elapsed_ms += duration_millis(retry_started_at.elapsed());
        }
    }
    if response.get("ok").and_then(Value::as_bool) != Some(true) {
        let failed_response = build_upload_failed_response(
            &response,
            "会话归档包上传失败 / Archive package upload failed",
            &context,
            current_batch_bytes,
            bundles.len(),
            "",
        );
        reporter.report_force(build_upload_failed_progress(&failed_response));
        return Ok(flush_failed(failed_response));
    }
    *upload_revision = response
        .pointer("/data/revision")
        .and_then(Value::as_u64)
        .or(*upload_revision);
    merge_remote_files(remote_files, &response);
    let item_results = remote::item_results(&response);
    let mut stats = FlushStats::default();
    for item in items {
        let item_result = find_batch_item_result(&item_results, &item.archive_path);
        let Some(item_result) = item_result else {
            let failed_response = build_upload_failed_response(
                &response,
                "会话归档包上传结果缺失 / Archive package upload result is missing",
                &context,
                current_batch_bytes,
                bundles.len(),
                &item.archive_path,
            );
            reporter.report_force(build_upload_failed_progress(&failed_response));
            return Ok(flush_failed(failed_response));
        };
        if let Some(failed_response) = validate_batch_item_result(
            &response,
            item_result,
            &item.archive_path,
            &context,
            current_batch_bytes,
            bundles.len(),
        ) {
            reporter.report_force(build_upload_failed_progress(&failed_response));
            return Ok(flush_failed(failed_response));
        }
        if item_result.get("retained").and_then(Value::as_bool) == Some(false) {
            stats.remote_limit_skipped_count += 1;
            stats.processed_count += 1;
            context.processed_count += 1;
            state::remember_skipped_thread(
                index,
                &item.row,
                &item.archive_path,
                &item.rollout_stat,
                "remote-limit",
            );
            continue;
        }
        if item_result.get("unchanged").and_then(Value::as_bool) == Some(true) {
            stats.remote_unchanged_count += 1;
        } else {
            stats.uploaded_count += 1;
            context.uploaded_count += 1;
            if item_result
                .get("uploaded")
                .and_then(Value::as_bool)
                .unwrap_or(true)
            {
                stats.uploaded_bytes += item.bundle.package_bytes;
                context.uploaded_bytes += item.bundle.package_bytes;
            }
        }
        stats.processed_count += 1;
        context.processed_count += 1;
        state::remember_exported_thread(
            index,
            &item.row,
            &item.archive_path,
            &item.rollout_stat,
            &item.bundle.package_sha256,
            &item.bundle.markdown_sha256,
        );
        let migration_result = mark_migration_paths_deleted(
            scope.request,
            scope.archive_crypto,
            scope.identity,
            remote_files,
            item.archive_path.as_str(),
            item.row.thread_id.as_str(),
            *upload_revision,
        )
        .await?;
        if let Some(failed_response) = migration_result.failed_response {
            let failed_response = build_upload_failed_response(
                &failed_response,
                "会话旧目录清理失败 / Conversation migration cleanup failed",
                &context,
                current_batch_bytes,
                bundles.len(),
                failed_response
                    .pointer("/data/failedPath")
                    .and_then(Value::as_str)
                    .unwrap_or(""),
            );
            reporter.report_force(build_upload_failed_progress(&failed_response));
            return Ok(flush_failed(failed_response));
        }
        *upload_revision = migration_result.revision.or(*upload_revision);
        stats.deleted_marked_count += migration_result.uploaded_count;
        reporter.report(json!({
            "currentBatchBytes": current_batch_bytes,
            "currentBatchCount": bundles.len(),
            "pendingThreadCount": context.pending_count,
            "preparedThreadCount": context.processed_count,
            "processedThreadCount": context.processed_count,
            "stage": "upload",
            "totalThreads": context.total_threads,
            "uploadBytesPerSecond": upload_bytes_per_second(context.uploaded_bytes, context.upload_elapsed_ms),
            "uploadedBytes": context.uploaded_bytes,
            "uploadedCount": context.uploaded_count,
        }));
    }
    stats.upload_elapsed_ms = context
        .upload_elapsed_ms
        .saturating_sub(initial_upload_elapsed_ms);
    Ok(flush_success(stats))
}

/// 这一段查找服务端返回的批次项结果。
/// Find the server result for one batch item.
fn find_batch_item_result<'a>(item_results: &'a [Value], archive_path: &str) -> Option<&'a Value> {
    // 这一段按 path 或 file.path 对齐，和旧 Node 的 byPath 逻辑一致。
    // Align by path or file.path, matching the legacy Node byPath logic.
    item_results.iter().find(|result| {
        result.get("path").and_then(Value::as_str) == Some(archive_path)
            || result
                .get("file")
                .and_then(|file| file.get("path"))
                .and_then(Value::as_str)
                == Some(archive_path)
    })
}

/// 这一段校验服务端逐项上传结果。
/// Validate one server batch item result.
fn validate_batch_item_result(
    response: &Value,
    item_result: &Value,
    archive_path: &str,
    context: &FlushContext,
    current_batch_bytes: usize,
    current_batch_count: usize,
) -> Option<Value> {
    // 这一段把服务端明确错误保持为页面可展示的结构化失败。
    // Preserve explicit server item errors as structured page-visible failures.
    let item_error = item_result
        .get("error")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if item_result.get("failed").and_then(Value::as_bool) == Some(true) || !item_error.is_empty() {
        return Some(build_upload_failed_response(
            response,
            if item_error.is_empty() {
                "会话归档包上传失败 / Archive package upload failed"
            } else {
                item_error
            },
            context,
            current_batch_bytes,
            current_batch_count,
            archive_path,
        ));
    }

    // 这一段允许远端上限和未变化结果，其他成功项必须返回 manifest file。
    // Allow remote-limit and unchanged results; every other success must return a manifest file.
    if item_result.get("retained").and_then(Value::as_bool) == Some(false)
        || item_result.get("unchanged").and_then(Value::as_bool) == Some(true)
        || item_result.get("remoteUnchanged").and_then(Value::as_bool) == Some(true)
    {
        return None;
    }
    if item_result.get("file").and_then(Value::as_object).is_none() {
        return Some(build_upload_failed_response(
            response,
            "会话归档包索引写入失败 / Archive package manifest was not returned",
            context,
            current_batch_bytes,
            current_batch_count,
            archive_path,
        ));
    }
    None
}

/// 这一段校验服务端逐项生命周期结果。
/// Validate one server lifecycle item result.
fn validate_lifecycle_item_result(
    response: &Value,
    item_result: &Value,
    archive_path: &str,
    deleted_marked_count: usize,
    lifecycle_pending_count: usize,
    total_threads: usize,
) -> Option<Value> {
    // 这一段把服务端明确错误保持为页面可展示的结构化失败。
    // Preserve explicit server item errors as structured page-visible failures.
    let item_error = item_result
        .get("error")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if item_result.get("failed").and_then(Value::as_bool) == Some(true) || !item_error.is_empty() {
        return Some(build_lifecycle_failed_response(
            response,
            if item_error.is_empty() {
                "会话生命周期标记同步失败 / Conversation lifecycle marker sync failed"
            } else {
                item_error
            },
            deleted_marked_count,
            lifecycle_pending_count,
            total_threads,
            archive_path,
        ));
    }

    // 这一段允许远端上限和未变化结果，其他成功项必须返回 manifest file。
    // Allow remote-limit and unchanged results; every other success must return a manifest file.
    if item_result.get("retained").and_then(Value::as_bool) == Some(false)
        || item_result.get("unchanged").and_then(Value::as_bool) == Some(true)
        || item_result.get("remoteUnchanged").and_then(Value::as_bool) == Some(true)
    {
        return None;
    }
    if item_result.get("file").and_then(Value::as_object).is_none() {
        return Some(build_lifecycle_failed_response(
            response,
            "会话生命周期标记未写入 / Conversation lifecycle marker was not returned",
            deleted_marked_count,
            lifecycle_pending_count,
            total_threads,
            archive_path,
        ));
    }
    None
}

/// 这一段构造生命周期失败响应并补充进度上下文。
/// Build a lifecycle failure response and attach progress context.
fn build_lifecycle_failed_response(
    response: &Value,
    fallback_error: &str,
    deleted_marked_count: usize,
    lifecycle_pending_count: usize,
    total_threads: usize,
    failed_path: &str,
) -> Value {
    // 这一段保留服务端原始 data，同时覆盖页面需要的结构化错误字段。
    // Preserve original server data while overriding page-facing structured error fields.
    let mut failed_response = if remote::is_partial_upload_failure(response) {
        remote::partial_upload_failure_response(response)
    } else {
        response.clone()
    };
    failed_response["ok"] = Value::Bool(false);
    if failed_response
        .get("status")
        .and_then(Value::as_u64)
        .unwrap_or(0)
        == 0
    {
        failed_response["status"] = json!(
            response
                .get("status")
                .and_then(Value::as_u64)
                .unwrap_or(502)
        );
    }
    let existing_error = failed_response
        .get("error")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if existing_error.is_empty() {
        failed_response["error"] = Value::String(fallback_error.to_string());
    }
    if !failed_response.get("data").is_some_and(Value::is_object) {
        failed_response["data"] = json!({});
    }
    if let Some(data) = failed_response
        .get_mut("data")
        .and_then(Value::as_object_mut)
    {
        data.insert(
            "deletedMarkedCount".to_string(),
            json!(deleted_marked_count),
        );
        data.insert("failedPath".to_string(), json!(failed_path));
        data.insert(
            "lifecyclePendingCount".to_string(),
            json!(lifecycle_pending_count),
        );
        data.insert("totalThreads".to_string(), json!(total_threads));
    }
    failed_response
}

/// 这一段构造生命周期失败进度。
/// Build lifecycle failure progress.
fn build_lifecycle_failed_progress(
    failed_response: &Value,
    deleted_marked_count: usize,
    lifecycle_pending_count: usize,
    total_threads: usize,
) -> Value {
    // 这一段只回传状态和计数，不包含会话正文。
    // Return only status and counts, never conversation bodies.
    json!({
        "deletedMarkedCount": deleted_marked_count,
        "error": failed_response.get("error").and_then(Value::as_str).unwrap_or("会话生命周期标记同步失败 / Conversation lifecycle marker sync failed"),
        "failedPath": failed_response.pointer("/data/failedPath").and_then(Value::as_str).unwrap_or(""),
        "lifecyclePendingCount": lifecycle_pending_count,
        "stage": "failed",
        "totalThreads": total_threads,
    })
}

/// 这一段构造上传失败响应并补充进度上下文。
/// Build an upload failure response and attach progress context.
fn build_upload_failed_response(
    response: &Value,
    fallback_error: &str,
    context: &FlushContext,
    current_batch_bytes: usize,
    current_batch_count: usize,
    failed_path: &str,
) -> Value {
    // 这一段保留服务端 data，同时确保页面看到 ok=false 和本轮上下文。
    // Preserve server data while ensuring the page sees ok=false and this-run context.
    let mut failed_response = if remote::is_partial_upload_failure(response) {
        remote::partial_upload_failure_response(response)
    } else {
        response.clone()
    };
    failed_response["ok"] = Value::Bool(false);
    if failed_response
        .get("status")
        .and_then(Value::as_u64)
        .is_none()
    {
        failed_response["status"] = json!(
            response
                .get("status")
                .and_then(Value::as_u64)
                .unwrap_or(502)
        );
    }
    let existing_error = failed_response
        .get("error")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    if existing_error.is_empty() {
        failed_response["error"] = Value::String(fallback_error.to_string());
    }
    if !failed_response.get("data").is_some_and(Value::is_object) {
        failed_response["data"] = json!({});
    }
    if let Some(data) = failed_response
        .get_mut("data")
        .and_then(Value::as_object_mut)
    {
        data.insert("currentBatchBytes".to_string(), json!(current_batch_bytes));
        data.insert("currentBatchCount".to_string(), json!(current_batch_count));
        data.insert(
            "pendingThreadCount".to_string(),
            json!(context.pending_count),
        );
        data.insert(
            "processedThreadCount".to_string(),
            json!(context.processed_count),
        );
        data.insert("totalThreads".to_string(), json!(context.total_threads));
        data.insert(
            "uploadBytesPerSecond".to_string(),
            json!(upload_bytes_per_second(
                context.uploaded_bytes,
                context.upload_elapsed_ms
            )),
        );
        data.insert("uploadedBytes".to_string(), json!(context.uploaded_bytes));
        data.insert("uploadedCount".to_string(), json!(context.uploaded_count));
        if !failed_path.trim().is_empty() {
            data.insert("failedPath".to_string(), json!(failed_path));
        }
    }
    failed_response
}

/// 这一段从结构化失败响应生成进度事件。
/// Build a progress event from a structured failure response.
fn build_upload_failed_progress(response: &Value) -> Value {
    // 这一段只读取 response.data，避免调用点重复拼接失败进度。
    // Read response.data only so callers do not duplicate failure-progress assembly.
    let data = response.get("data").and_then(Value::as_object);
    json!({
        "currentBatchBytes": data.and_then(|data| data.get("currentBatchBytes")).cloned().unwrap_or(Value::Null),
        "currentBatchCount": data.and_then(|data| data.get("currentBatchCount")).cloned().unwrap_or(Value::Null),
        "error": response.get("error").and_then(Value::as_str).unwrap_or("会话归档包上传失败 / Archive package upload failed"),
        "failedPath": data.and_then(|data| data.get("failedPath")).cloned().unwrap_or(Value::Null),
        "pendingThreadCount": data.and_then(|data| data.get("pendingThreadCount")).cloned().unwrap_or(Value::Null),
        "processedThreadCount": data.and_then(|data| data.get("processedThreadCount")).cloned().unwrap_or(Value::Null),
        "stage": "failed",
        "totalThreads": data.and_then(|data| data.get("totalThreads")).cloned().unwrap_or(Value::Null),
        "uploadBytesPerSecond": data.and_then(|data| data.get("uploadBytesPerSecond")).cloned().unwrap_or(Value::Null),
        "uploadedBytes": data.and_then(|data| data.get("uploadedBytes")).cloned().unwrap_or(Value::Null),
        "uploadedCount": data.and_then(|data| data.get("uploadedCount")).cloned().unwrap_or(Value::Null),
    })
}

/// 这一段描述旧路径墓碑结果。
/// Describes stale-path tombstone result.
#[derive(Clone, Debug, Default)]
struct MigrationDeleteStats {
    /// 这一段是失败时返回给页面的结构化响应。
    /// Structured page response when cleanup failed.
    failed_response: Option<Value>,
    /// 这一段是最新远端 revision。
    /// Latest remote revision.
    revision: Option<u64>,
    /// 这一段是本轮写入的墓碑数量。
    /// Number of tombstones written in this round.
    uploaded_count: usize,
}

/// 这一段构造旧路径清理失败响应。
/// Build a stale-path cleanup failure response.
fn build_migration_failed_response(
    response: &Value,
    fallback_error: &str,
    failed_path: &str,
) -> Value {
    // 这一段保留服务端错误并补 failedPath，方便页面和日志定位具体旧归档入口。
    // Preserve the server error and attach failedPath so the page and logs can identify the stale archive entry.
    let mut failed_response = if remote::is_partial_upload_failure(response) {
        remote::partial_upload_failure_response(response)
    } else {
        response.clone()
    };
    failed_response["ok"] = Value::Bool(false);
    if failed_response
        .get("status")
        .and_then(Value::as_u64)
        .is_none()
    {
        failed_response["status"] = json!(
            response
                .get("status")
                .and_then(Value::as_u64)
                .unwrap_or(502)
        );
    }
    let existing_error = failed_response
        .get("error")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    if existing_error.is_empty() {
        failed_response["error"] = Value::String(fallback_error.to_string());
    }
    if !failed_response.get("data").is_some_and(Value::is_object) {
        failed_response["data"] = json!({});
    }
    if let Some(data) = failed_response
        .get_mut("data")
        .and_then(Value::as_object_mut)
    {
        data.insert("failedPath".to_string(), json!(failed_path));
    }
    failed_response
}

/// 这一段把同 thread 的旧路径标记删除。
/// Mark stale paths for the same thread as deleted.
async fn mark_migration_paths_deleted(
    request: &ConversationArchiveRequest,
    archive_crypto: &crypto::ArchiveCrypto,
    identity: &identity::ArchiveIdentity,
    remote_files: &mut serde_json::Map<String, Value>,
    current_path: &str,
    thread_id: &str,
    upload_revision: Option<u64>,
) -> anyhow::Result<MigrationDeleteStats> {
    // 这一段只在当前正式路径已成功后清理同设备账号下的旧分组入口。
    // Clean stale grouped entries only after the current formal path has succeeded.
    let mut stats = MigrationDeleteStats {
        failed_response: None,
        revision: upload_revision,
        uploaded_count: 0,
    };
    for path in remote::migration_paths(remote_files, identity, current_path, thread_id) {
        let existing = remote_files.get(&path).cloned().unwrap_or_default();
        let update = state::LifecycleUpdate {
            archived_at: existing
                .get("archivedAt")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            deleted_detected_at: crate::state::now_text(),
            lifecycle_status: "deleted".to_string(),
            path: path.clone(),
            thread_id: thread_id.to_string(),
        };
        let updates = vec![update.clone()];
        let response = remote::put_lifecycle_batch_with_retry(
            request,
            archive_crypto,
            &updates,
            stats.revision,
        )
        .await?;
        if response.get("ok").and_then(Value::as_bool) != Some(true)
            || remote::is_partial_upload_failure(&response)
        {
            stats.failed_response = Some(build_migration_failed_response(
                &response,
                "会话旧目录清理失败 / Conversation migration cleanup failed",
                &path,
            ));
            return Ok(stats);
        }
        stats.revision = response
            .pointer("/data/revision")
            .and_then(Value::as_u64)
            .or(stats.revision);
        merge_remote_files(remote_files, &response);
        stats.uploaded_count += 1;
    }
    Ok(stats)
}

/// 这一段合并远端 files。
/// Merge remote files from a response.
fn merge_remote_files(remote_files: &mut serde_json::Map<String, Value>, response: &Value) {
    // 这一段同时处理 data.files 和 itemResults[].file。
    // Handle both data.files and itemResults[].file.
    if let Some(files) = response.pointer("/data/files").and_then(Value::as_object) {
        for (path, file) in files {
            remote_files.insert(path.clone(), file.clone());
        }
    }
    for item in remote::item_results(response) {
        if let Some(file) = item.get("file").and_then(Value::as_object)
            && let Some(path) = file.get("path").and_then(Value::as_str)
        {
            remote_files.insert(path.to_string(), Value::Object(file.clone()));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 这一段构造会话归档测试加密上下文。
    /// Build a conversation-archive test crypto context.
    fn test_crypto() -> crypto::ArchiveCrypto {
        crypto::ArchiveCrypto::derive("test-sync-key-1234567890").unwrap()
    }

    /// 这一段构造测试用会话行。
    /// Build a test conversation row.
    fn test_thread_row() -> codex_state::ConversationThreadRow {
        // 这一段只填充打包与响应测试会读取的字段。
        // Fill only the fields read by package and response-shaping tests.
        codex_state::ConversationThreadRow {
            archive_group_id: "conversation_default".to_string(),
            archive_group_name: "默认会话".to_string(),
            archive_group_type: "conversation".to_string(),
            archived_at: String::new(),
            created_at: "2026-06-15T00:00:00.000Z".to_string(),
            created_at_ms: 1_781_467_200_000,
            cwd: String::new(),
            deleted_detected_at: String::new(),
            lifecycle_status: "active".to_string(),
            rollout_path: String::new(),
            skip_reason: String::new(),
            thread_id: "thread_123".to_string(),
            thread_source: "user".to_string(),
            title: "测试会话".to_string(),
            updated_at: "2026-06-15T00:01:00.000Z".to_string(),
            updated_at_ms: 1_781_467_260_000,
        }
    }

    /// 这一段构造测试用 flush 上下文。
    /// Build a test flush context.
    fn test_flush_context() -> FlushContext {
        // 这一段提供失败响应需要的计数和累计上传字段。
        // Provide the count and cumulative upload fields needed by failure responses.
        FlushContext {
            pending_count: 3,
            processed_count: 1,
            total_threads: 8,
            upload_elapsed_ms: 2_000,
            uploaded_bytes: 4_096,
            uploaded_count: 2,
        }
    }

    /// 这一段确认上传速度只按上传耗时计算。
    /// Confirm upload speed is calculated only from upload elapsed time.
    #[test]
    fn upload_speed_uses_uploaded_bytes_and_upload_elapsed_time() {
        assert_eq!(upload_bytes_per_second(0, 2_000), 0);
        assert_eq!(upload_bytes_per_second(4_096, 2_000), 2_048);
        assert_eq!(upload_bytes_per_second(1, 2_000), 1);
    }

    /// 这一段确认上传失败响应保留累计进度字段。
    /// Confirm upload failure responses preserve cumulative progress fields.
    #[test]
    fn upload_failed_response_includes_cumulative_progress() {
        let response = build_upload_failed_response(
            &json!({ "ok": false, "status": 502, "data": {}, "error": "" }),
            "fallback",
            &test_flush_context(),
            12_345,
            4,
            "devices/device_local/profiles/profile_default/conversations/conversation_default/threads/2026/06/thread_123/index.md",
        );
        let progress = build_upload_failed_progress(&response);

        assert_eq!(response["data"]["uploadedBytes"], json!(4_096));
        assert_eq!(response["data"]["uploadedCount"], json!(2));
        assert_eq!(response["data"]["uploadBytesPerSecond"], json!(2_048));
        assert_eq!(progress["uploadedBytes"], json!(4_096));
        assert_eq!(progress["uploadedCount"], json!(2));
        assert_eq!(progress["uploadBytesPerSecond"], json!(2_048));
    }

    /// 这一段确认只有明确大小上限错误会转成 oversize 跳过。
    /// Confirm only explicit size-limit errors become oversize skips.
    #[test]
    fn package_oversize_error_classifier_is_narrow() {
        let compressed =
            anyhow::anyhow!("conversation archive package exceeds compressed size limit");
        let uncompressed =
            anyhow::anyhow!("conversation archive package exceeds uncompressed size limit");
        let other = anyhow::anyhow!("gzip encoder failed");

        assert!(is_package_oversize_error(&compressed));
        assert!(is_package_oversize_error(&uncompressed));
        assert!(!is_package_oversize_error(&other));
    }

    /// 这一段确认 getBundle 成功响应缺少包字段时不会继续解包。
    /// Confirm successful getBundle responses without package fields are not unpacked.
    #[test]
    fn package_presence_check_requires_non_empty_package_field() {
        assert!(archive_bundle_response_has_package(&json!({
            "ok": true,
            "data": { "packageUrl": "https://example.com/package" }
        })));
        assert!(archive_bundle_response_has_package(&json!({
            "ok": true,
            "data": { "data": { "packageBase64": "abc" } }
        })));
        assert!(!archive_bundle_response_has_package(&json!({
            "ok": true,
            "data": { "file": { "title": "missing package" } }
        })));
        assert!(!archive_bundle_response_has_package(&json!({
            "ok": true,
            "data": { "packageUrl": " " }
        })));
    }

    /// 这一段确认 get-file 响应恢复旧 Node 的 Markdown 正文协议。
    /// Confirm get-file responses restore the legacy Node Markdown body contract.
    #[test]
    fn get_file_response_returns_markdown_and_hides_package_body() {
        let archive_crypto = test_crypto();
        let payload = package::create_thread_package_with_related_files(
            "devices/device_local/profiles/profile_default/conversations/conversation_default/threads/2026/06/thread_123/index.md",
            &test_thread_row(),
            "# 测试会话\n\n[已处理](<thinking-001-abcdef123456.md>)",
            &[package::RelatedMarkdownFile {
                link_name: "thinking-001-abcdef123456.md".to_string(),
                markdown: "# 已处理\n\n摘要".to_string(),
                thinking_index: 1,
            }],
            &archive_crypto,
        )
        .unwrap();
        let unpacked = package::unpack_thread_package_response(
            &json!({
                "ok": true,
                "data": {
                    "encryptedPackageSha256": payload.encrypted_package_sha256,
                    "packageBase64": payload.package_base64,
                    "packageEncryption": payload.package_encryption,
                    "packageSha256": payload.package_sha256,
                    "path": payload.path,
                }
            }),
            &archive_crypto,
        )
        .unwrap();

        let response = build_archive_file_response(
            json!({
                "ok": true,
                "status": 200,
                "data": {
                    "data": {
                        "packageBase64": "nested-should-not-leak",
                        "packageUrl": "https://example.com/nested-temp-package"
                    },
                    "file": { "title": "测试会话" },
                    "packageBase64": "should-not-leak",
                    "packageUrl": "https://example.com/temp-package"
                },
                "error": ""
            }),
            &unpacked,
            &ArchivePreviewPerformance::default(),
        );

        assert_eq!(response["ok"], true);
        assert_eq!(
            response["data"]["markdown"].as_str(),
            Some(unpacked.markdown.as_str())
        );
        assert_eq!(
            response["data"]["markdownBytes"].as_u64(),
            Some(unpacked.markdown.len() as u64)
        );
        assert_eq!(response["data"]["packageUrl"], "");
        assert!(response["data"].get("packageBase64").is_none());
        assert!(response["data"]["data"].get("packageBase64").is_none());
        assert!(response["data"]["data"].get("packageUrl").is_none());
        assert!(response["data"].get("performance").is_some());
        assert_eq!(
            response["data"]["relatedFiles"][0]["linkName"],
            "thinking-001-abcdef123456.md"
        );
        assert!(
            response["data"]["relatedFiles"][0]["markdown"]
                .as_str()
                .unwrap_or_default()
                .contains("摘要")
        );
    }

    /// 这一段确认逐项结果能通过 file.path 对齐。
    /// Confirm item results can be matched by file.path.
    #[test]
    fn batch_item_result_matches_file_path() {
        let path = "devices/device_local/profiles/profile_default/conversations/conversation_default/threads/2026/06/thread_123/index.md";
        let results = vec![json!({
            "file": { "path": path },
            "uploaded": true
        })];

        assert!(find_batch_item_result(&results, path).is_some());
        assert!(find_batch_item_result(&results, "missing").is_none());
    }

    /// 这一段确认缺少 manifest file 的成功项会变成结构化失败。
    /// Confirm a success item without a manifest file becomes a structured failure.
    #[test]
    fn batch_item_without_manifest_file_is_failure() {
        let path = "devices/device_local/profiles/profile_default/conversations/conversation_default/threads/2026/06/thread_123/index.md";
        let response = json!({
            "ok": true,
            "status": 200,
            "data": {
                "itemResults": [
                    { "path": path, "uploaded": true }
                ]
            },
            "error": ""
        });
        let item = &response["data"]["itemResults"][0];
        let failed =
            validate_batch_item_result(&response, item, path, &test_flush_context(), 1024, 1)
                .expect("missing manifest file should fail");

        assert_eq!(failed["ok"], false);
        assert_eq!(
            failed["error"],
            "会话归档包索引写入失败 / Archive package manifest was not returned"
        );
        assert_eq!(failed["data"]["failedPath"], path);
        assert_eq!(failed["data"]["pendingThreadCount"], 3);
    }

    /// 这一段确认远端未变化项可以不带 manifest file。
    /// Confirm remote-unchanged items do not need a manifest file.
    #[test]
    fn batch_item_remote_unchanged_without_manifest_file_is_allowed() {
        let path = "devices/device_local/profiles/profile_default/conversations/conversation_default/threads/2026/06/thread_123/index.md";
        let response = json!({
            "ok": true,
            "status": 200,
            "data": {
                "itemResults": [
                    { "path": path, "remoteUnchanged": true }
                ]
            },
            "error": ""
        });
        let item = &response["data"]["itemResults"][0];

        assert!(
            validate_batch_item_result(&response, item, path, &test_flush_context(), 1024, 1)
                .is_none()
        );
    }

    /// 这一段确认生命周期成功项缺少 manifest file 会失败。
    /// Confirm a lifecycle success item without a manifest file fails.
    #[test]
    fn lifecycle_item_without_manifest_file_is_failure() {
        let path = "devices/device_local/profiles/profile_default/conversations/conversation_default/threads/2026/06/thread_123/index.md";
        let response = json!({
            "ok": true,
            "status": 200,
            "data": {
                "itemResults": [
                    { "path": path, "lifecycleUpdated": true }
                ]
            },
            "error": ""
        });
        let item = &response["data"]["itemResults"][0];
        let failed = validate_lifecycle_item_result(&response, item, path, 2, 5, 9)
            .expect("missing lifecycle manifest should fail");

        assert_eq!(failed["ok"], false);
        assert_eq!(
            failed["error"],
            "会话生命周期标记未写入 / Conversation lifecycle marker was not returned"
        );
        assert_eq!(failed["data"]["failedPath"], path);
        assert_eq!(failed["data"]["deletedMarkedCount"], 2);
        assert_eq!(failed["data"]["lifecyclePendingCount"], 5);
    }

    /// 这一段确认生命周期远端上限项可以不带 manifest file。
    /// Confirm remote-limit lifecycle items do not need a manifest file.
    #[test]
    fn lifecycle_item_remote_limit_without_manifest_file_is_allowed() {
        let path = "devices/device_local/profiles/profile_default/conversations/conversation_default/threads/2026/06/thread_123/index.md";
        let response = json!({
            "ok": true,
            "status": 200,
            "data": {
                "itemResults": [
                    { "path": path, "retained": false }
                ]
            },
            "error": ""
        });
        let item = &response["data"]["itemResults"][0];

        assert!(validate_lifecycle_item_result(&response, item, path, 2, 5, 9).is_none());
    }
}
