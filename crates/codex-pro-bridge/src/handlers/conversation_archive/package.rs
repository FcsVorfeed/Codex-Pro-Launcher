use super::codex_state::ConversationThreadRow;
use super::crypto::{ArchiveCrypto, PackageEncryption};
use anyhow::bail;
use base64::Engine;
use flate2::{Compression, read::GzDecoder, write::GzEncoder};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};

/// 这一段定义包解压后大小上限。
/// Maximum uncompressed package size.
const MAX_PACKAGE_UNCOMPRESSED_BYTES: usize = 10 * 1024 * 1024;
/// 这一段定义压缩后包大小上限。
/// Maximum compressed package size.
const MAX_PACKAGE_BYTES: usize = 5 * 1024 * 1024;
/// 这一段定义归档包格式版本。
/// Thread package format version.
pub const PACKAGE_FORMAT_VERSION: u64 = 1;
/// 这一段定义归档包类型。
/// Thread package kind.
pub const PACKAGE_KIND_THREAD_BUNDLE: &str = "thread-bundle";

/// 这一段描述上传的会话包。
/// Describes an uploaded thread package.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct ThreadBundlePayload {
    /// 这一段是远端路径。
    /// Remote path.
    pub path: String,
    /// 这一段是 Markdown 字节数。
    /// Markdown byte size.
    #[serde(rename = "markdownBytes")]
    pub markdown_bytes: usize,
    /// 这一段是 Markdown SHA-256。
    /// Markdown SHA-256.
    #[serde(rename = "markdownSha256")]
    pub markdown_sha256: String,
    /// 这一段是远端列表 metadata。
    /// Remote listing metadata.
    pub metadata: ThreadBundleMetadata,
    /// 这一段是包字节数。
    /// Package byte size.
    #[serde(rename = "packageBytes")]
    pub package_bytes: usize,
    /// 这一段是包内文件数量。
    /// Package file count.
    #[serde(rename = "packageFileCount")]
    pub package_file_count: usize,
    /// 这一段是包格式版本。
    /// Package format version.
    #[serde(rename = "packageFormatVersion")]
    pub package_format_version: u64,
    /// 这一段是包类型。
    /// Package kind.
    #[serde(rename = "packageKind")]
    pub package_kind: String,
    /// 这一段是密文 base64 包。
    /// Encrypted base64 package.
    #[serde(rename = "packageBase64")]
    pub package_base64: String,
    /// 这一段是密文 SHA-256。
    /// Encrypted package SHA-256.
    #[serde(rename = "encryptedPackageSha256")]
    pub encrypted_package_sha256: String,
    /// 这一段是包体加密元数据。
    /// Package encryption metadata.
    #[serde(rename = "packageEncryption")]
    pub package_encryption: PackageEncryption,
    /// 这一段是包 sha256。
    /// Package sha256.
    #[serde(rename = "packageSha256")]
    pub package_sha256: String,
    /// 这一段是包解压后字节数。
    /// Package uncompressed byte size.
    #[serde(rename = "packageUncompressedBytes")]
    pub package_uncompressed_bytes: usize,
}

/// 这一段描述上传到远端 manifest 的会话 metadata。
/// Describes metadata uploaded into the remote manifest.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct ThreadBundleMetadata {
    /// 这一段是归档分组 ID。
    /// Archive group id.
    #[serde(rename = "archiveGroupId")]
    pub archive_group_id: String,
    /// 这一段是归档分组名称。
    /// Archive group name.
    #[serde(rename = "archiveGroupName")]
    pub archive_group_name: String,
    /// 这一段是归档分组类型。
    /// Archive group type.
    #[serde(rename = "archiveGroupType")]
    pub archive_group_type: String,
    /// 这一段是账号显示名。
    /// Profile display name.
    #[serde(rename = "profileName")]
    pub profile_name: String,
    /// 这一段是设备显示名。
    /// Device display name.
    #[serde(rename = "deviceName")]
    pub device_name: String,
    /// 这一段是文件角色。
    /// File role.
    #[serde(rename = "fileRole")]
    pub file_role: String,
    /// 这一段是归档时间。
    /// Archive timestamp.
    #[serde(rename = "archivedAt")]
    pub archived_at: String,
    /// 这一段是删除检测时间。
    /// Delete detection timestamp.
    #[serde(rename = "deletedDetectedAt")]
    pub deleted_detected_at: String,
    /// 这一段是生命周期。
    /// Lifecycle status.
    #[serde(rename = "lifecycleStatus")]
    pub lifecycle_status: String,
    /// 这一段是主文件相对链接名。
    /// Main file link name.
    #[serde(rename = "linkName")]
    pub link_name: String,
    /// 这一段是 Markdown SHA-256。
    /// Markdown SHA-256.
    #[serde(rename = "markdownSha256")]
    pub markdown_sha256: String,
    /// 这一段是消息数量。
    /// Message count.
    #[serde(rename = "messageCount")]
    pub message_count: usize,
    /// 这一段是包字节数。
    /// Package byte size.
    #[serde(rename = "packageBytes")]
    pub package_bytes: usize,
    /// 这一段是包内文件数量。
    /// Package file count.
    #[serde(rename = "packageFileCount")]
    pub package_file_count: usize,
    /// 这一段是包格式版本。
    /// Package format version.
    #[serde(rename = "packageFormatVersion")]
    pub package_format_version: u64,
    /// 这一段是包类型。
    /// Package kind.
    #[serde(rename = "packageKind")]
    pub package_kind: String,
    /// 这一段是包 SHA-256。
    /// Package SHA-256.
    #[serde(rename = "packageSha256")]
    pub package_sha256: String,
    /// 这一段是包解压后字节数。
    /// Package uncompressed byte size.
    #[serde(rename = "packageUncompressedBytes")]
    pub package_uncompressed_bytes: usize,
    /// 这一段是关联思考附件元数据。
    /// Related reasoning attachment metadata.
    #[serde(rename = "relatedFiles")]
    pub related_files: Vec<RelatedFileMetadata>,
    /// 这一段是创建时间。
    /// Source creation time.
    #[serde(rename = "sourceCreatedAt")]
    pub source_created_at: String,
    /// 这一段是更新时间。
    /// Source update time.
    #[serde(rename = "sourceUpdatedAt")]
    pub source_updated_at: String,
    /// 这一段是思考附件数量。
    /// Reasoning attachment count.
    #[serde(rename = "thinkingCount")]
    pub thinking_count: usize,
    /// 这一段是线程来源。
    /// Thread source.
    #[serde(rename = "threadSource")]
    pub thread_source: String,
    /// 这一段是线程 ID。
    /// Thread ID.
    #[serde(rename = "threadId")]
    pub thread_id: String,
    /// 这一段是标题。
    /// Title.
    pub title: String,
}

/// 这一段描述准备打包的思考附件。
/// Describes a reasoning attachment ready to package.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct RelatedMarkdownFile {
    /// 这一段是本地预览链接名。
    /// Local preview link name.
    pub link_name: String,
    /// 这一段是 Markdown 正文。
    /// Markdown body.
    pub markdown: String,
    /// 这一段是思考附件序号。
    /// Reasoning attachment index.
    pub thinking_index: usize,
}

/// 这一段描述上传 manifest 里的思考附件轻量元数据。
/// Describes lightweight reasoning metadata in the upload manifest.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct RelatedFileMetadata {
    /// 这一段是文件角色。
    /// File role.
    #[serde(rename = "fileRole")]
    pub file_role: String,
    /// 这一段是本地预览链接名。
    /// Local preview link name.
    #[serde(rename = "linkName")]
    pub link_name: String,
    /// 这一段是 Markdown SHA-256。
    /// Markdown SHA-256.
    #[serde(rename = "markdownSha256")]
    pub markdown_sha256: String,
    /// 这一段是远端附件路径。
    /// Remote attachment path.
    pub path: String,
    /// 这一段是思考附件序号。
    /// Reasoning attachment index.
    #[serde(rename = "thinkingIndex")]
    pub thinking_index: usize,
    /// 这一段是附件标题。
    /// Attachment title.
    pub title: String,
}

/// 这一段描述解包后的思考附件。
/// Describes an unpacked reasoning attachment.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct UnpackedRelatedFile {
    /// 这一段是本地预览链接名。
    /// Local preview link name.
    pub link_name: String,
    /// 这一段是 Markdown 正文。
    /// Markdown body.
    pub markdown: String,
}

/// 这一段描述解包后的预览内容。
/// Describes unpacked preview content.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct UnpackedThreadPackage {
    /// 这一段是主 Markdown。
    /// Main Markdown.
    pub markdown: String,
    /// 这一段是标题。
    /// Title.
    pub title: String,
    /// 这一段是思考附件。
    /// Reasoning attachments.
    pub related_files: Vec<UnpackedRelatedFile>,
}

/// 这一段创建单会话 gzip JSON 包。
/// Create a gzipped JSON package for one thread.
pub fn create_thread_package(
    archive_path: &str,
    row: &ConversationThreadRow,
    markdown: &str,
    archive_crypto: &ArchiveCrypto,
) -> anyhow::Result<ThreadBundlePayload> {
    // 这一段复用完整打包函数，只传主 Markdown。
    // Reuse the full package builder with only the main Markdown.
    create_thread_package_with_related_files(archive_path, row, markdown, &[], archive_crypto)
}

/// 这一段创建带思考附件的单会话 gzip JSON 包。
/// Create a gzipped JSON package for one thread with reasoning attachments.
pub fn create_thread_package_with_related_files(
    archive_path: &str,
    row: &ConversationThreadRow,
    markdown: &str,
    related_files: &[RelatedMarkdownFile],
    archive_crypto: &ArchiveCrypto,
) -> anyhow::Result<ThreadBundlePayload> {
    create_thread_package_with_related_files_and_counts(
        archive_path,
        row,
        markdown,
        related_files,
        0,
        archive_crypto,
    )
}

/// 这一段创建带思考附件和消息数量的单会话 gzip JSON 包。
/// Create a gzipped JSON package with reasoning attachments and message count.
pub fn create_thread_package_with_related_files_and_counts(
    archive_path: &str,
    row: &ConversationThreadRow,
    markdown: &str,
    related_files: &[RelatedMarkdownFile],
    message_count: usize,
    archive_crypto: &ArchiveCrypto,
) -> anyhow::Result<ThreadBundlePayload> {
    // 这一段构造包内文件清单，保持远端单包和本地多文件预览的旧协议。
    // Build the in-package file list, preserving the legacy single-remote-bundle and local multi-file preview contract.
    let main_markdown_bytes = markdown.len();
    let main_markdown_sha256 = sha256_hex(markdown.as_bytes());
    let mut package_files = vec![json!({
        "contentBase64": base64::engine::general_purpose::STANDARD.encode(markdown.as_bytes()),
        "fileRole": "thread",
        "linkName": "index.md",
        "markdownBytes": main_markdown_bytes,
        "markdownSha256": main_markdown_sha256,
    })];
    let mut related_metadata = Vec::new();
    let thread_directory = archive_path
        .strip_suffix("/index.md")
        .unwrap_or(archive_path)
        .to_string();
    for related in related_files.iter().take(500) {
        let Some(link_name) = normalize_related_link_name(&related.link_name) else {
            bail!("invalid conversation archive related link name");
        };
        let markdown_bytes = related.markdown.len();
        let markdown_sha256 = sha256_hex(related.markdown.as_bytes());
        let thinking_index = related.thinking_index.max(1);
        let remote_path = format!("{thread_directory}/thinking-{thinking_index:03}.md");
        package_files.push(json!({
            "contentBase64": base64::engine::general_purpose::STANDARD.encode(related.markdown.as_bytes()),
            "fileRole": "thinking",
            "linkName": link_name,
            "markdownBytes": markdown_bytes,
            "markdownSha256": markdown_sha256,
            "thinkingIndex": thinking_index,
        }));
        related_metadata.push(RelatedFileMetadata {
            file_role: "thinking".to_string(),
            link_name,
            markdown_sha256,
            path: remote_path,
            thinking_index,
            title: row.title.clone(),
        });
    }

    // 这一段压缩包体并生成稳定明文包级哈希。
    // Compress the package body and compute the stable plaintext package hash.
    let package = json!({
        "files": package_files,
        "packageFormatVersion": PACKAGE_FORMAT_VERSION,
        "packageKind": PACKAGE_KIND_THREAD_BUNDLE,
        "path": archive_path,
        "threadId": row.thread_id,
        "title": row.title,
    });
    let package_text = serde_json::to_vec(&package)?;
    if package_text.len() > MAX_PACKAGE_UNCOMPRESSED_BYTES {
        bail!("conversation archive package exceeds uncompressed size limit");
    }
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(&package_text)?;
    let compressed = encoder.finish()?;
    let package_sha256 = sha256_hex(&compressed);
    let encrypted = archive_crypto.encrypt_package(&compressed, archive_path, &package_sha256)?;
    let package_bytes = encrypted.ciphertext.len();
    if package_bytes > MAX_PACKAGE_BYTES {
        bail!("conversation archive package exceeds compressed size limit");
    }
    let package_file_count = 1 + related_metadata.len();
    let package_uncompressed_bytes = package_text.len();
    Ok(ThreadBundlePayload {
        markdown_bytes: main_markdown_bytes,
        markdown_sha256: main_markdown_sha256.clone(),
        metadata: ThreadBundleMetadata {
            archive_group_id: archive_group_id_from_path(archive_path),
            archive_group_name: row.archive_group_name.clone(),
            archive_group_type: row.archive_group_type.clone(),
            archived_at: row.archived_at.clone(),
            deleted_detected_at: row.deleted_detected_at.clone(),
            device_name: String::new(),
            file_role: "thread".to_string(),
            lifecycle_status: row.lifecycle_status.clone(),
            link_name: "index.md".to_string(),
            markdown_sha256: main_markdown_sha256,
            message_count,
            package_bytes,
            package_file_count,
            package_format_version: PACKAGE_FORMAT_VERSION,
            package_kind: PACKAGE_KIND_THREAD_BUNDLE.to_string(),
            package_sha256: package_sha256.clone(),
            package_uncompressed_bytes,
            profile_name: String::new(),
            related_files: related_metadata,
            source_created_at: row.created_at.clone(),
            source_updated_at: row.updated_at.clone(),
            thinking_count: related_files.len(),
            title: row.title.clone(),
            thread_id: row.thread_id.clone(),
            thread_source: if row.thread_source.trim().is_empty() {
                "user".to_string()
            } else {
                row.thread_source.clone()
            },
        },
        encrypted_package_sha256: encrypted.encrypted_sha256,
        package_base64: base64::engine::general_purpose::STANDARD.encode(&encrypted.ciphertext),
        package_bytes,
        package_encryption: encrypted.encryption,
        package_file_count,
        package_format_version: PACKAGE_FORMAT_VERSION,
        package_kind: PACKAGE_KIND_THREAD_BUNDLE.to_string(),
        package_sha256,
        package_uncompressed_bytes,
        path: archive_path.to_string(),
    })
}

/// 这一段从远端路径解析归档分组 ID。
/// Parse archive group id from the remote path.
fn archive_group_id_from_path(archive_path: &str) -> String {
    // 这一段匹配 v2 grouped path，失败时回落普通对话分组。
    // Match the v2 grouped path and fall back to the default conversation group.
    let parts = archive_path.split('/').collect::<Vec<_>>();
    if parts.len() >= 6 && (parts[4] == "projects" || parts[4] == "conversations") {
        return parts[5].to_string();
    }
    "conversation_default".to_string()
}

/// 这一段从远端响应里解包会话包。
/// Unpack a thread package from a remote response.
pub fn unpack_thread_package_response(
    response: &Value,
    archive_crypto: &ArchiveCrypto,
) -> anyhow::Result<UnpackedThreadPackage> {
    // 这一段兼容 data.packageBase64 和 data.data.packageBase64 两种包装。
    // Support both data.packageBase64 and data.data.packageBase64 response shapes.
    let data = response
        .get("data")
        .and_then(|value| {
            if value.get("packageBase64").is_some() {
                Some(value)
            } else {
                value.get("data")
            }
        })
        .unwrap_or(response);
    let package_base64 = data
        .get("packageBase64")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let expected_sha = data
        .get("packageSha256")
        .and_then(Value::as_str)
        .or_else(|| {
            data.get("file")
                .and_then(|file| file.get("packageSha256"))
                .and_then(Value::as_str)
        })
        .unwrap_or_default();
    let archive_path = data
        .get("path")
        .and_then(Value::as_str)
        .or_else(|| {
            data.get("file")
                .and_then(|file| file.get("path"))
                .and_then(Value::as_str)
        })
        .unwrap_or_default();
    let encryption = data
        .get("packageEncryption")
        .cloned()
        .or_else(|| {
            data.get("file")
                .and_then(|file| file.get("packageEncryption"))
                .cloned()
        })
        .ok_or_else(|| anyhow::anyhow!("conversation archive package encryption metadata missing"))
        .and_then(|value| {
            serde_json::from_value::<PackageEncryption>(value)
                .map_err(|error| anyhow::anyhow!(error))
        })?;
    let encrypted = base64::engine::general_purpose::STANDARD.decode(package_base64)?;
    let encrypted_sha = data
        .get("encryptedPackageSha256")
        .and_then(Value::as_str)
        .or_else(|| {
            data.get("file")
                .and_then(|file| file.get("encryptedPackageSha256"))
                .and_then(Value::as_str)
        })
        .unwrap_or_default();
    if !encrypted_sha.is_empty() && sha256_hex(&encrypted) != encrypted_sha {
        bail!("conversation archive encrypted package sha256 mismatch");
    }
    let compressed =
        archive_crypto.decrypt_package(&encrypted, &encryption, archive_path, expected_sha)?;
    if !expected_sha.is_empty() && sha256_hex(&compressed) != expected_sha {
        bail!("conversation archive package sha256 mismatch");
    }
    let mut decoder = GzDecoder::new(compressed.as_slice());
    let mut text = String::new();
    decoder
        .by_ref()
        .take(MAX_PACKAGE_UNCOMPRESSED_BYTES as u64)
        .read_to_string(&mut text)?;
    let package: Value = serde_json::from_str(&text)?;
    let title = data
        .get("file")
        .and_then(|file| file.get("title"))
        .and_then(Value::as_str)
        .or_else(|| package.get("title").and_then(Value::as_str))
        .or_else(|| data.get("title").and_then(Value::as_str))
        .unwrap_or("conversation")
        .to_string();
    let files = package
        .get("files")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow::anyhow!("conversation archive package missing files"))?;
    let file = files
        .iter()
        .find(|file| {
            file.get("linkName").and_then(Value::as_str) == Some("index.md")
                || file.get("path").and_then(Value::as_str) == Some("index.md")
        })
        .ok_or_else(|| anyhow::anyhow!("conversation archive package missing index.md"))?;
    let markdown = decode_package_markdown_file(file)?;
    let mut related_files = Vec::new();
    for file in files {
        let role = file
            .get("fileRole")
            .or_else(|| file.get("threadSource"))
            .and_then(Value::as_str)
            .unwrap_or_default();
        if role != "thinking" {
            continue;
        }
        let link_name = file
            .get("linkName")
            .and_then(Value::as_str)
            .and_then(normalize_related_link_name);
        let Some(link_name) = link_name else {
            continue;
        };
        related_files.push(UnpackedRelatedFile {
            link_name,
            markdown: decode_package_markdown_file(file)?,
        });
    }
    Ok(UnpackedThreadPackage {
        markdown,
        related_files,
        title,
    })
}

/// 这一段从包内文件解码 Markdown 并验证哈希。
/// Decode a Markdown file from a package and verify its hash.
fn decode_package_markdown_file(file: &Value) -> anyhow::Result<String> {
    // 这一段校验文件内容、字节数和 SHA-256。
    // Validate file content, byte count, and SHA-256.
    let content = file
        .get("contentBase64")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let bytes = base64::engine::general_purpose::STANDARD.decode(content)?;
    let markdown_bytes = file
        .get("markdownBytes")
        .and_then(Value::as_u64)
        .unwrap_or(bytes.len() as u64) as usize;
    if markdown_bytes != bytes.len() {
        bail!("conversation archive markdown size mismatch");
    }
    let markdown_sha256 = file
        .get("markdownSha256")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !markdown_sha256.is_empty() && sha256_hex(&bytes) != markdown_sha256 {
        bail!("conversation archive markdown sha256 mismatch");
    }
    Ok(String::from_utf8(bytes)?)
}

/// 这一段规范化思考附件本地链接名。
/// Normalize a local reasoning attachment link name.
fn normalize_related_link_name(value: &str) -> Option<String> {
    // 这一段只允许单文件名 Markdown，避免解包写出预览目录。
    // Allow only a single Markdown filename so unpacking cannot escape the preview directory.
    let name = value.trim();
    if name.len() > 180
        || !name.starts_with("thinking-")
        || !name.ends_with(".md")
        || name.contains('/')
        || name.contains('\\')
        || name.contains("..")
        || name.chars().any(char::is_control)
    {
        return None;
    }
    Some(name.to_string())
}

/// 这一段计算 sha256 hex。
/// Compute sha256 hex.
fn sha256_hex(bytes: &[u8]) -> String {
    // 这一段用于包完整性校验。
    // Used for package integrity checks.
    format!("{:x}", Sha256::digest(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 这一段构造归档包测试加密上下文。
    /// Build a package-test encryption context.
    fn test_crypto() -> ArchiveCrypto {
        ArchiveCrypto::derive("test-sync-key-1234567890").unwrap()
    }

    /// 这一段构造归档包测试行。
    /// Build a package test row.
    fn test_row() -> ConversationThreadRow {
        ConversationThreadRow {
            archive_group_id: "conversation_default".to_string(),
            archive_group_name: "对话".to_string(),
            archive_group_type: "conversation".to_string(),
            archived_at: String::new(),
            created_at: "2026-06-14T00:00:00.000Z".to_string(),
            created_at_ms: 0,
            cwd: String::new(),
            deleted_detected_at: String::new(),
            lifecycle_status: "active".to_string(),
            rollout_path: "rollout.jsonl".to_string(),
            skip_reason: String::new(),
            thread_id: "thread_123".to_string(),
            thread_source: "user".to_string(),
            title: "测试会话".to_string(),
            updated_at: "2026-06-14T00:01:00.000Z".to_string(),
            updated_at_ms: 1_765_670_460_000,
        }
    }

    /// 这一段确认 thread-bundle 上传体保留旧 Node 需要的包级元数据。
    /// Confirm thread-bundle payloads keep the package metadata required by the legacy Node contract.
    #[test]
    fn thread_package_payload_matches_legacy_bundle_contract() {
        let crypto = test_crypto();
        let payload = create_thread_package(
            "devices/device_local/profiles/profile_default/conversations/conversation_default/threads/2026/06/thread_123/index.md",
            &test_row(),
            "# 测试会话\n\n### User\n\n你好",
            &crypto,
        )
        .unwrap();

        assert_eq!(payload.package_kind, "thread-bundle");
        assert_eq!(payload.package_format_version, 1);
        assert!(payload.package_bytes > 0);
        assert!(payload.package_uncompressed_bytes > 0);
        assert_eq!(payload.package_file_count, 1);
        assert_eq!(payload.encrypted_package_sha256.len(), 64);
        assert_eq!(payload.markdown_sha256.len(), 64);
        assert_eq!(payload.metadata.title, "测试会话");
        assert_eq!(payload.metadata.file_role, "thread");
        assert_eq!(payload.metadata.package_kind, "thread-bundle");
        assert_eq!(payload.metadata.markdown_sha256, payload.markdown_sha256);
        let serialized = serde_json::to_value(&payload).unwrap();
        assert!(serialized.get("metadata").is_some());
        assert!(serialized.get("packageEncryption").is_some());
        assert!(serialized.get("title").is_none());
        assert!(serialized.get("lifecycleStatus").is_none());
    }

    /// 这一段确认随机加密不会改变增量判断使用的明文包 hash。
    /// Confirm random encryption does not change the plaintext package hash used for deltas.
    #[test]
    fn thread_package_keeps_stable_plain_package_hash() {
        let crypto = test_crypto();
        let first = create_thread_package(
            "devices/device_local/profiles/profile_default/conversations/conversation_default/threads/2026/06/thread_123/index.md",
            &test_row(),
            "# 测试会话\n\n### User\n\n你好",
            &crypto,
        )
        .unwrap();
        let second = create_thread_package(
            "devices/device_local/profiles/profile_default/conversations/conversation_default/threads/2026/06/thread_123/index.md",
            &test_row(),
            "# 测试会话\n\n### User\n\n你好",
            &crypto,
        )
        .unwrap();

        assert_eq!(first.package_sha256, second.package_sha256);
        assert_ne!(first.package_base64, second.package_base64);
        assert_ne!(
            first.package_encryption.nonce_base64,
            second.package_encryption.nonce_base64
        );
    }

    /// 这一段确认思考附件进入同一个 thread-bundle，并能按 linkName 解回预览数据。
    /// Confirm reasoning attachments stay in the same thread-bundle and unpack by linkName for previews.
    #[test]
    fn thread_package_round_trips_related_thinking_files() {
        let crypto = test_crypto();
        let payload = create_thread_package_with_related_files(
            "devices/device_local/profiles/profile_default/conversations/conversation_default/threads/2026/06/thread_123/index.md",
            &test_row(),
            "# 测试会话\n\n[已处理](<thinking-001-abcdef123456.md>)",
            &[RelatedMarkdownFile {
                link_name: "thinking-001-abcdef123456.md".to_string(),
                markdown: "# 已处理\n\n工具执行摘要".to_string(),
                thinking_index: 1,
            }],
            &crypto,
        )
        .unwrap();
        let response = json!({
            "ok": true,
            "data": {
                "encryptedPackageSha256": payload.encrypted_package_sha256,
                "packageBase64": payload.package_base64,
                "packageEncryption": payload.package_encryption,
                "packageSha256": payload.package_sha256,
                "path": payload.path,
            }
        });
        let unpacked = unpack_thread_package_response(&response, &crypto).unwrap();

        assert!(unpacked.markdown.contains("thinking-001-abcdef123456.md"));
        assert_eq!(unpacked.related_files.len(), 1);
        assert_eq!(
            unpacked.related_files[0].link_name,
            "thinking-001-abcdef123456.md"
        );
        assert!(unpacked.related_files[0].markdown.contains("工具执行摘要"));
    }

    /// 这一段确认 getBundle 的 file.packageSha256 响应也能解密。
    /// Confirm getBundle responses with file.packageSha256 can still decrypt.
    #[test]
    fn thread_package_uses_file_package_sha_for_get_bundle_response() {
        let crypto = test_crypto();
        let payload = create_thread_package(
            "devices/device_local/profiles/profile_default/conversations/conversation_default/threads/2026/06/thread_123/index.md",
            &test_row(),
            "# 测试会话\n\n### User\n\n你好",
            &crypto,
        )
        .unwrap();
        let response = json!({
            "ok": true,
            "data": {
                "encryptedPackageSha256": payload.encrypted_package_sha256,
                "file": {
                    "packageSha256": payload.package_sha256,
                    "path": payload.path,
                    "title": "测试会话"
                },
                "packageBase64": payload.package_base64,
                "packageEncryption": payload.package_encryption,
                "path": payload.path,
            }
        });
        let unpacked = unpack_thread_package_response(&response, &crypto).unwrap();

        assert!(unpacked.markdown.contains("你好"));
        assert_eq!(unpacked.title, "测试会话");
    }
}
