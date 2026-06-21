use super::package::UnpackedThreadPackage;
use super::request::ConversationArchiveRequest;
use serde_json::{Value, json};
use std::path::Path;

/// 这一段写入本地归档预览文件。
/// Write a local archive preview file.
pub async fn write_preview_file(
    request: &ConversationArchiveRequest,
    package: &UnpackedThreadPackage,
) -> anyhow::Result<Value> {
    // 这一段把预览文件限制在 Codex-Pro 数据根下。
    // Keep preview files under the Codex-Pro data root.
    write_preview_file_to_root(
        request,
        package,
        &codex_pro_core::paths::codex_pro_data_root_dir(),
    )
    .await
}

/// 这一段把归档预览写入指定数据根。
/// Write an archive preview into a specific data root.
pub async fn write_preview_file_to_root(
    request: &ConversationArchiveRequest,
    package: &UnpackedThreadPackage,
    data_root: &Path,
) -> anyhow::Result<Value> {
    // 这一段创建一会话一目录的预览根，避免不同会话文件互相覆盖。
    // Create one preview directory per thread so files from different threads do not overwrite each other.
    let dir_name = safe_file_name(&package.title);
    let preview_root = data_root
        .join("conversation-archive-preview")
        .join(format!("{dir_name}-{}", short_hash(&request.path)));
    tokio::fs::create_dir_all(&preview_root).await?;
    let file_name = format!("index-{}.md", short_hash(&package.markdown));
    let file_path = preview_root.join(file_name);

    // 这一段先写思考附件，再把主文件里的相对链接改写成同目录绝对链接。
    // Write reasoning attachments first, then rewrite main-file relative links into same-directory absolute links.
    let mut keep_file_names = vec![
        file_path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_string(),
    ];
    for related_file in &package.related_files {
        let Some(link_name) = normalize_related_link_name(&related_file.link_name) else {
            continue;
        };
        let related_path = preview_root.join(&link_name);
        ensure_child_path(&preview_root, &related_path)?;
        tokio::fs::write(&related_path, normalize_newlines(&related_file.markdown)).await?;
        keep_file_names.push(link_name);
    }
    let preview_markdown = rewrite_related_links(&package.markdown, &preview_root);
    tokio::fs::write(&file_path, preview_markdown).await?;
    cleanup_preview_directory(&preview_root, &keep_file_names).await?;
    Ok(json!({
        "ok": true,
        "status": 200,
        "data": {
            "path": file_path.to_string_lossy(),
            "filePath": file_path.to_string_lossy(),
            "localPath": file_path.to_string_lossy(),
            "markdown": "",
            "title": package.title,
        },
        "error": "",
    }))
}

/// 这一段确认子路径没有越过预览目录。
/// Confirm a child path does not escape the preview directory.
fn ensure_child_path(root: &Path, child: &Path) -> anyhow::Result<()> {
    // 这一段用绝对路径前缀检查阻止附件名穿越。
    // Use absolute-prefix checks to block traversal in attachment names.
    let root = std::path::absolute(root)?;
    let child = std::path::absolute(child)?;
    if !child.starts_with(root) {
        anyhow::bail!("conversation archive preview path escaped");
    }
    Ok(())
}

/// 这一段重写主 Markdown 里的思考附件链接。
/// Rewrite reasoning attachment links in the main Markdown.
fn rewrite_related_links(markdown: &str, directory: &Path) -> String {
    // 这一段用旧协议的 thinking-xxx-hash.md 模式做受控替换，不处理普通链接。
    // Replace only the legacy thinking-xxx-hash.md pattern and leave normal links untouched.
    let mut output = String::with_capacity(markdown.len());
    let mut rest = normalize_newlines(markdown);
    while let Some(index) = rest.find("](<thinking-") {
        let (before, after_start) = rest.split_at(index);
        output.push_str(before);
        let Some(end_index) = after_start.find(".md>)") else {
            output.push_str(after_start);
            return output;
        };
        let link_name = &after_start[3..end_index + 3];
        if let Some(safe_name) = normalize_related_link_name(link_name) {
            let absolute = directory
                .join(&safe_name)
                .to_string_lossy()
                .replace('\\', "/");
            output.push_str("](<");
            output.push_str(&absolute);
            output.push_str(">)");
        } else {
            output.push_str(&after_start[..end_index + 5]);
        }
        rest = after_start[end_index + 5..].to_string();
    }
    output.push_str(&rest);
    output
}

/// 这一段清理旧预览别名。
/// Clean stale preview aliases.
async fn cleanup_preview_directory(
    directory: &Path,
    keep_file_names: &[String],
) -> anyhow::Result<()> {
    // 这一段只删除本模块生成的 index/thinking Markdown 文件，避免误删其它文件。
    // Delete only generated index/thinking Markdown files so unrelated files are not touched.
    let keep: std::collections::HashSet<&str> =
        keep_file_names.iter().map(String::as_str).collect();
    let mut entries = tokio::fs::read_dir(directory).await?;
    while let Some(entry) = entries.next_entry().await? {
        let file_type = entry.file_type().await?;
        if !file_type.is_file() {
            continue;
        }
        let file_name = entry.file_name().to_string_lossy().to_string();
        if keep.contains(file_name.as_str()) {
            continue;
        }
        if is_generated_preview_file_name(&file_name) {
            let _ = tokio::fs::remove_file(entry.path()).await;
        }
    }
    Ok(())
}

/// 这一段判断是否为生成的预览文件名。
/// Return whether a file name is a generated preview file.
fn is_generated_preview_file_name(value: &str) -> bool {
    // 这一段只匹配 index-<12hex>.md 和 thinking-*.md。
    // Match only index-<12hex>.md and thinking-*.md.
    (value.starts_with("index-")
        && value.ends_with(".md")
        && value.len() == "index-".len() + 12 + ".md".len())
        || normalize_related_link_name(value).is_some()
}

/// 这一段规范化思考附件链接名。
/// Normalize a reasoning attachment link name.
fn normalize_related_link_name(value: &str) -> Option<String> {
    // 这一段只允许单文件名，避免写出预览目录。
    // Allow only a single filename so writes cannot escape the preview directory.
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

/// 这一段统一预览换行。
/// Normalize preview newlines.
fn normalize_newlines(value: &str) -> String {
    // 这一段对齐旧 Node 预览写入行为，落盘前收敛 CRLF。
    // Match the legacy Node preview writer by normalizing CRLF before writing.
    value.replace("\r\n", "\n").replace('\r', "\n")
}

/// 这一段生成安全文件名。
/// Build a safe filename.
fn safe_file_name(value: &str) -> String {
    // 这一段只保留常见可读字符，其它字符替换为下划线。
    // Keep common readable characters and replace others with underscores.
    let name = value
        .chars()
        .take(80)
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | ' ') {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>()
        .trim()
        .to_string();
    if name.is_empty() {
        "conversation".to_string()
    } else {
        name
    }
}

/// 这一段生成短 hash。
/// Build a short hash.
fn short_hash(value: &str) -> String {
    // 这一段避免引入额外状态文件。
    // Avoid adding extra state files.
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(value.as_bytes()))
        .chars()
        .take(12)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::handlers::conversation_archive::package::{
        UnpackedRelatedFile, UnpackedThreadPackage,
    };
    use std::fs;

    /// 这一段构造预览测试请求。
    /// Build a preview test request.
    fn test_request() -> ConversationArchiveRequest {
        ConversationArchiveRequest {
            action: "prepare-file".to_string(),
            device_id: "device_local".to_string(),
            device_name: "Desk".to_string(),
            endpoint: "https://example.com/archive-sync".to_string(),
            force: false,
            path: "devices/device_local/profiles/profile_default/conversations/conversation_default/threads/2026/06/thread_123/index.md".to_string(),
            profile_name: "Default profile".to_string(),
            request_id: "req_archive".to_string(),
            sync_key: "1234567890123456".to_string(),
            thread_id: String::new(),
        }
    }

    /// 这一段确认预览写入主文件、思考附件，并把主文件里的附件链接改成同目录绝对路径。
    /// Confirm preview writes the main file, reasoning attachment, and rewrites links to same-directory absolute paths.
    #[tokio::test]
    async fn preview_writes_related_files_and_rewrites_links() {
        let temp = tempfile::tempdir().unwrap();
        let package = UnpackedThreadPackage {
            markdown: "# 测试\n\n[已处理](<thinking-001-abcdef123456.md>)".to_string(),
            related_files: vec![UnpackedRelatedFile {
                link_name: "thinking-001-abcdef123456.md".to_string(),
                markdown: "# 已处理\n\n摘要".to_string(),
            }],
            title: "测试会话".to_string(),
        };
        let response = write_preview_file_to_root(&test_request(), &package, temp.path())
            .await
            .unwrap();
        let file_path = response["data"]["filePath"].as_str().unwrap();
        let local_path = response["data"]["localPath"].as_str().unwrap();
        let preview = fs::read_to_string(file_path).unwrap();
        let related_path = std::path::Path::new(file_path)
            .parent()
            .unwrap()
            .join("thinking-001-abcdef123456.md");

        assert_eq!(local_path, file_path);
        assert_eq!(response["data"]["markdown"], "");
        assert!(related_path.is_file());
        assert!(preview.contains("thinking-001-abcdef123456.md"));
        assert!(!preview.contains("](<thinking-001-abcdef123456.md>)"));
    }
}
