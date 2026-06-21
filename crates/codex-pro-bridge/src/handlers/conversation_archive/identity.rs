use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::Path;
use std::path::PathBuf;
use uuid::Uuid;

/// 这一段描述会话归档本机身份。
/// Describes the local conversation archive identity.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct ArchiveIdentity {
    /// 这一段是本机设备 ID。
    /// Local device ID.
    #[serde(rename = "deviceId")]
    pub device_id: String,
    /// 这一段是本机账号 ID。
    /// Local profile ID.
    #[serde(rename = "profileId")]
    pub profile_id: String,
    /// 这一段是项目分组盐。
    /// Project grouping salt.
    #[serde(rename = "projectSalt")]
    pub project_salt: String,
}

/// 这一段读取或创建归档本机身份。
/// Read or create the local archive identity.
pub async fn read_or_create_identity() -> anyhow::Result<ArchiveIdentity> {
    // 这一段把身份持久化到 Codex-Pro 数据根，只保存随机 ID，不保存账号或路径。
    // Persist identity under the Codex-Pro data root, storing only random IDs and no account or path data.
    let path = identity_path();
    for legacy_dir in legacy_state_dirs() {
        seed_state_file_from_legacy(&legacy_dir.join("identity.json"), &path).await;
    }
    let existing = read_identity_file(&path).await.unwrap_or_default();
    let identity = ArchiveIdentity {
        device_id: normalize_prefixed_id(&existing.device_id, "device_")
            .unwrap_or_else(|| create_prefixed_id("device_")),
        profile_id: normalize_prefixed_id(&existing.profile_id, "profile_")
            .unwrap_or_else(|| create_prefixed_id("profile_")),
        project_salt: normalize_prefixed_id(&existing.project_salt, "salt_")
            .unwrap_or_else(|| create_prefixed_id("salt_")),
    };
    if identity != existing {
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        tokio::fs::write(&path, serde_json::to_vec_pretty(&identity)?).await?;
    }
    Ok(identity)
}

/// 这一段读取身份文件。
/// Read an identity file.
async fn read_identity_file(path: &PathBuf) -> anyhow::Result<ArchiveIdentity> {
    // 这一段把不存在或损坏的身份交给调用方重建。
    // Let callers recreate identities when the file is missing or damaged.
    let bytes = tokio::fs::read(path).await?;
    Ok(serde_json::from_slice(&bytes)?)
}

/// 这一段返回身份文件路径。
/// Return the identity file path.
fn identity_path() -> PathBuf {
    // 这一段对齐旧 Node 的 conversation-archive 状态目录。
    // Match the legacy Node conversation-archive state directory.
    codex_pro_core::paths::codex_pro_data_root_dir()
        .join("conversation-archive")
        .join("identity.json")
}

/// 这一段返回旧项目根归档状态目录候选。
/// Return legacy project-root archive state directory candidates.
pub(crate) fn legacy_state_dirs() -> Vec<PathBuf> {
    // 这一段兼容旧 Node rootDir/.codex-pro/conversation-archive 状态，不把运行期状态写回旧目录。
    // Support the old Node rootDir/.codex-pro/conversation-archive state without writing runtime state back there.
    let mut roots = Vec::new();
    let source_root = std::env::var("CODEX_PRO_SOURCE_ROOT").unwrap_or_default();
    if !source_root.trim().is_empty() {
        roots.push(PathBuf::from(source_root.trim()));
    }
    if let Ok(current_dir) = std::env::current_dir() {
        roots.push(current_dir);
    }
    let mut seen = HashSet::<String>::new();
    roots
        .into_iter()
        .filter_map(|root| std::path::absolute(root).ok())
        .filter(|root| seen.insert(root.to_string_lossy().to_ascii_lowercase()))
        .map(|root| root.join(".codex-pro").join("conversation-archive"))
        .collect()
}

/// 这一段从旧状态文件复制到新数据根。
/// Copy one legacy state file into the new data root.
pub(crate) async fn seed_state_file_from_legacy(legacy_path: &Path, target_path: &Path) {
    // 这一段只在目标缺失且旧文件是普通文件时复制，失败不影响新状态创建。
    // Copy only when the target is missing and the legacy source is a regular file; failures do not block fresh state creation.
    if same_path(legacy_path, target_path) || is_regular_file(target_path).await {
        return;
    }
    if !is_regular_file(legacy_path).await {
        return;
    }
    let Some(parent) = target_path.parent() else {
        return;
    };
    if tokio::fs::create_dir_all(parent).await.is_err() {
        return;
    }
    let _ = tokio::fs::copy(legacy_path, target_path).await;
}

/// 这一段判断路径是否指向同一规范化文本。
/// Return whether two paths normalize to the same text.
fn same_path(left: &Path, right: &Path) -> bool {
    // 这一段用绝对路径文本比较，避免把目标复制到自己。
    // Compare absolute path text so a target is never copied onto itself.
    let left = std::path::absolute(left)
        .unwrap_or_else(|_| left.to_path_buf())
        .to_string_lossy()
        .to_ascii_lowercase();
    let right = std::path::absolute(right)
        .unwrap_or_else(|_| right.to_path_buf())
        .to_string_lossy()
        .to_ascii_lowercase();
    left == right
}

/// 这一段判断路径是否是普通文件。
/// Return whether a path is a regular file.
async fn is_regular_file(path: &Path) -> bool {
    // 这一段只读取 metadata，不创建或修改旧目录。
    // Read only metadata and never create or modify legacy directories.
    tokio::fs::metadata(path)
        .await
        .map(|metadata| metadata.is_file())
        .unwrap_or(false)
}

/// 这一段创建带前缀的随机 ID。
/// Create a random prefixed ID.
fn create_prefixed_id(prefix: &str) -> String {
    // 这一段使用 UUID 避免上传本机用户名、机器名或路径。
    // Use UUIDs so user names, machine names, or paths are never uploaded as IDs.
    format!("{prefix}{}", Uuid::new_v4().simple())
}

/// 这一段规范化带前缀 ID。
/// Normalize a prefixed ID.
fn normalize_prefixed_id(value: &str, prefix: &str) -> Option<String> {
    // 这一段只接受短安全单段 ID。
    // Accept only short safe single-segment IDs.
    let trimmed = value.trim();
    if trimmed.starts_with(prefix)
        && trimmed.len() <= 96
        && trimmed
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-' | '.'))
    {
        Some(trimmed.to_string())
    } else {
        None
    }
}

impl Default for ArchiveIdentity {
    /// 这一段返回空身份，供损坏文件兜底。
    /// Return an empty identity for damaged-file fallback.
    fn default() -> Self {
        Self {
            device_id: String::new(),
            profile_id: String::new(),
            project_salt: String::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 这一段确认旧状态只在新根缺失时复制。
    /// Confirm legacy state is copied only when the new-root file is missing.
    #[tokio::test]
    async fn legacy_state_seed_copies_without_overwriting() {
        let temp = tempfile::tempdir().unwrap();
        let legacy_path = temp.path().join("legacy").join("identity.json");
        let target_path = temp.path().join("new").join("identity.json");
        tokio::fs::create_dir_all(legacy_path.parent().unwrap())
            .await
            .unwrap();
        tokio::fs::write(&legacy_path, br#"{"deviceId":"device_old"}"#)
            .await
            .unwrap();

        seed_state_file_from_legacy(&legacy_path, &target_path).await;
        assert_eq!(
            tokio::fs::read_to_string(&target_path).await.unwrap(),
            r#"{"deviceId":"device_old"}"#
        );

        tokio::fs::write(&legacy_path, br#"{"deviceId":"device_newer"}"#)
            .await
            .unwrap();
        seed_state_file_from_legacy(&legacy_path, &target_path).await;
        assert_eq!(
            tokio::fs::read_to_string(&target_path).await.unwrap(),
            r#"{"deviceId":"device_old"}"#
        );
    }
}
