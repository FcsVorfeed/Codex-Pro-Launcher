use crate::handlers::cloud_sync::normalize_request_id;
use codex_pro_core::paths::codex_pro_data_root_dir;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, SystemTime};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;
use uuid::Uuid;

/// 这一段定义路径长度上限。
/// Maximum path length accepted by the diff bridge.
const EXTERNAL_DIFF_MAX_PATH_LENGTH: usize = 1000;
/// 这一段定义相对路径长度上限。
/// Maximum relative path length accepted by the diff bridge.
const EXTERNAL_DIFF_MAX_RELATIVE_PATH_LENGTH: usize = 500;
/// 这一段定义旧版本文件最大读取字节数。
/// Maximum old-version file bytes read for external diff.
const EXTERNAL_DIFF_MAX_FILE_BYTES: usize = 25 * 1024 * 1024;
/// 这一段定义外部 Diff 临时目录最长保留时间。
/// Maximum age for external diff temporary run directories.
const EXTERNAL_DIFF_TEMP_MAX_AGE: Duration = Duration::from_secs(24 * 60 * 60);
/// 这一段定义 git 命令超时。
/// Git command timeout.
const GIT_COMMAND_TIMEOUT_MS: u64 = 8_000;
/// 这一段定义 Git 输出上限。
/// Maximum Git output bytes.
const GIT_MAX_OUTPUT_BYTES: usize = 2 * 1024 * 1024;
/// 这一段定义摘要最大文件数。
/// Maximum summary files.
const GIT_DIFF_SUMMARY_MAX_FILES: usize = 500;
/// 这一段定义单次摘要最多返回的 hunk 导航块。
/// Maximum hunk navigation ranges returned by one summary.
const GIT_DIFF_SUMMARY_MAX_NAVIGATION_RANGES: usize = 200;

/// 这一段描述外部 Diff 请求。
/// Describes an external diff request.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct ExternalDiffRequest {
    /// 这一段是工作区根目录。
    /// Workspace root.
    pub cwd: PathBuf,
    /// 这一段是工作区相对文件路径。
    /// Workspace-relative file path.
    pub path: String,
    /// 这一段是上一个文件路径。
    /// Previous file path.
    #[serde(rename = "previousPath")]
    pub previous_path: String,
    /// 这一段是变更类型。
    /// Change kind.
    #[serde(rename = "changeKind")]
    pub change_kind: String,
    /// 这一段是外部 Diff 工具路径。
    /// External diff tool path.
    #[serde(rename = "toolPath")]
    pub tool_path: PathBuf,
}

/// 这一段描述 Git 摘要请求。
/// Describes a Git diff summary request.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct GitDiffSummaryRequest {
    /// 这一段是 request id。
    /// Request id.
    #[serde(rename = "requestId")]
    pub request_id: String,
    /// 这一段是工作区根目录。
    /// Workspace root.
    pub cwd: PathBuf,
}

/// 这一段描述 Git hunk 导航范围。
/// Describes a Git hunk navigation range.
#[derive(Clone, Debug, PartialEq, Eq)]
struct GitHunkRange {
    /// 这一段是新文件侧起始行。
    /// Start line on the new-file side.
    line: u64,
    /// 这一段是新文件侧结束行。
    /// End line on the new-file side.
    end_line: u64,
}

/// 这一段描述 Git numstat 结果。
/// Describes Git numstat results.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct GitFileStats {
    /// 这一段是新增行数。
    /// Added line count.
    additions: u64,
    /// 这一段是删除行数。
    /// Deleted line count.
    deletions: u64,
}

/// 这一段跟踪一个 Git hunk 的新文件侧位置。
/// Tracks one Git hunk on the new-file side.
#[derive(Clone, Debug, PartialEq, Eq)]
struct GitHunkTracker {
    /// 这一段是删除-only hunk 的兜底锚点。
    /// Fallback anchor for deletion-only hunks.
    anchor_line: u64,
    /// 这一段是 hunk 已知结束行。
    /// Known hunk end line.
    end_line: u64,
    /// 这一段记录 hunk 是否包含增删变更。
    /// Whether the hunk contains additions or deletions.
    has_change: bool,
    /// 这一段是首个可跳转行。
    /// First jumpable line.
    line: u64,
    /// 这一段是当前新文件侧行号游标。
    /// Current new-file line cursor.
    new_line: u64,
    /// 这一段是 hunk 头部声明的新文件行数。
    /// New-file line count declared by the hunk header.
    new_line_count: u64,
}

/// 这一段记录当前正在解析的 Git 文件。
/// Tracks the Git file currently being parsed.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct GitHunkFile {
    /// 这一段是当前路径。
    /// Current path.
    path: String,
    /// 这一段是旧路径。
    /// Previous path.
    previous_path: String,
    /// 这一段是该文件的导航范围。
    /// Navigation ranges for this file.
    navigation_ranges: Vec<GitHunkRange>,
}

/// 这一段描述外部 Diff 两侧文件。
/// Describes the two files passed to the external diff tool.
#[derive(Clone, Debug, PartialEq, Eq)]
struct ExternalDiffFilePair {
    /// 这一段是左侧旧版本文件。
    /// Left old-version file.
    left_path: PathBuf,
    /// 这一段是右侧当前版本文件。
    /// Right current-version file.
    right_path: PathBuf,
}

/// 这一段解析外部 Diff 请求。
/// Parse an external diff request.
pub fn parse_external_diff_request(value: &Value) -> Option<ExternalDiffRequest> {
    // 这一段只接受绝对 cwd、绝对工具路径和不越界相对文件路径。
    // Accept only absolute cwd/tool paths and non-escaping relative file paths.
    let cwd = normalize_absolute_path(value.get("cwd")?.as_str()?)?;
    let tool_path = normalize_absolute_path(value.get("toolPath")?.as_str()?)?;
    let path = normalize_relative_path(value.get("path")?.as_str()?)?;
    let previous_path = value
        .get("previousPath")
        .and_then(Value::as_str)
        .and_then(normalize_optional_relative_path)
        .unwrap_or_default();
    let change_kind = value
        .get("changeKind")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .chars()
        .take(40)
        .collect::<String>();
    Some(ExternalDiffRequest {
        cwd,
        path,
        previous_path,
        change_kind,
        tool_path,
    })
}

/// 这一段解析 Git 摘要请求。
/// Parse a Git diff summary request.
pub fn parse_git_diff_summary_request(value: &Value) -> Option<GitDiffSummaryRequest> {
    // 这一段只接受 request id 和绝对 cwd。
    // Accept only request id and absolute cwd.
    Some(GitDiffSummaryRequest {
        request_id: normalize_request_id(value.get("requestId")?.as_str()?)?,
        cwd: normalize_absolute_path(value.get("cwd")?.as_str()?)?,
    })
}

/// 这一段打开外部 Diff 工具。
/// Open the external diff tool.
pub async fn open_external_diff(request: ExternalDiffRequest) -> anyhow::Result<()> {
    // 这一段校验工具路径、工作区路径和当前文件解析结果。
    // Validate the tool path, workspace path, and resolved current file.
    let current_path = assert_external_diff_inputs(&request).await?;
    let pair = build_external_diff_file_pair(&request, &current_path).await?;

    // 这一段固定用 [旧版本, 当前版本] 参数启动外部工具，不允许页面注入参数模板。
    // Launch with fixed [old, current] arguments so the page cannot inject argument templates.
    let mut command = Command::new(&request.tool_path);
    command
        .arg(&pair.left_path)
        .arg(&pair.right_path)
        .current_dir(&request.cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let child = command.spawn()?;
    let process_id = child.id().unwrap_or_default();
    let tool_path = request.tool_path.clone();
    drop(child);
    tokio::spawn(async move {
        focus_external_diff_window(process_id, tool_path).await;
    });
    Ok(())
}

/// 这一段读取 Git 变更摘要。
/// Read the Git diff summary.
pub async fn read_git_diff_summary(request: &GitDiffSummaryRequest) -> anyhow::Result<Value> {
    // 这一段先确认 cwd 是目录；Git 不是仓库时后续命令会失败闭合为空摘要。
    // Confirm cwd is a directory; non-repository Git commands later fail closed to an empty summary.
    let cwd_stats = tokio::fs::metadata(&request.cwd).await?;
    if !cwd_stats.is_dir() {
        anyhow::bail!("Git diff summary cwd is not a directory");
    }

    // 这一段按旧 Node 行为优先 upstream，没有 upstream 时回退 HEAD。
    // Match the Node behavior by preferring upstream and falling back to HEAD.
    let base_revision = resolve_git_diff_summary_base(&request.cwd).await;
    let numstat_args = git_args(&[
        "diff",
        "--no-ext-diff",
        "--find-renames",
        "--numstat",
        &base_revision,
        "--",
    ]);
    let name_status_args = git_args(&[
        "diff",
        "--no-ext-diff",
        "--find-renames",
        "--name-status",
        &base_revision,
        "--",
    ]);
    let patch_args = git_args(&[
        "diff",
        "--no-ext-diff",
        "--find-renames",
        "--unified=0",
        &base_revision,
        "--",
    ]);
    let untracked_args = git_args(&["ls-files", "--others", "--exclude-standard"]);
    let (numstat_output, name_status_output, patch_output, untracked_output) = tokio::join!(
        run_git_text(&request.cwd, &numstat_args, GIT_MAX_OUTPUT_BYTES),
        run_git_text(&request.cwd, &name_status_args, GIT_MAX_OUTPUT_BYTES),
        run_git_text(&request.cwd, &patch_args, GIT_MAX_OUTPUT_BYTES),
        run_git_text(&request.cwd, &untracked_args, GIT_MAX_OUTPUT_BYTES),
    );

    // 这一段组合 numstat、name-status、hunk 和未跟踪文件，返回页面实际消费的字段。
    // Combine numstat, name-status, hunks, and untracked files into the page-consumed shape.
    let stats_by_path = parse_git_diff_numstat(&numstat_output);
    let navigation_ranges_by_path = parse_git_diff_hunks(&patch_output);
    let tracked_files = parse_git_diff_name_status(
        &name_status_output,
        &stats_by_path,
        &base_revision,
        &navigation_ranges_by_path,
    );
    let files = tracked_files
        .iter()
        .cloned()
        .chain(parse_git_untracked_files(
            &untracked_output,
            &tracked_files,
            &base_revision,
        ))
        .collect::<Vec<_>>();
    Ok(json!({
        "baseRevision": base_revision,
        "cwd": request.cwd,
        "files": files,
        "type": "success",
    }))
}

/// 这一段在 worker 正常退出时清理外部 Diff 临时根。
/// Clear the external diff temporary root when the worker exits normally.
pub async fn clear_external_diff_temp_root_on_worker_exit() {
    // 这一段忽略被外部工具占用的文件，避免清理失败影响 worker 生命周期。
    // Ignore files held by external tools so cleanup cannot break the worker lifecycle.
    let _ = tokio::fs::remove_dir_all(external_diff_temp_root_dir()).await;
}

/// 这一段校验外部 Diff 输入并解析当前工作区文件路径。
/// Validate external diff inputs and resolve the current workspace file path.
async fn assert_external_diff_inputs(request: &ExternalDiffRequest) -> anyhow::Result<PathBuf> {
    // 这一段校验工具是普通文件、cwd 是目录。
    // Validate the tool as a regular file and cwd as a directory.
    let tool_stats = tokio::fs::metadata(&request.tool_path).await?;
    let cwd_stats = tokio::fs::metadata(&request.cwd).await?;
    if !tool_stats.is_file() {
        anyhow::bail!("External diff tool is not a file");
    }
    if !cwd_stats.is_dir() {
        anyhow::bail!("External diff cwd is not a directory");
    }

    // 这一段只做路径边界解析，不要求当前文件一定存在，删除文件会改用空右侧文件。
    // Resolve path boundaries only; deleted files later use an empty right-side file.
    resolve_workspace_file_path(&request.cwd, &request.path)
        .ok_or_else(|| anyhow::anyhow!("External diff file escaped workspace"))
}

/// 这一段为外部 Diff 准备左右两侧文件。
/// Build the two files passed to the external diff tool.
async fn build_external_diff_file_pair(
    request: &ExternalDiffRequest,
    current_path: &Path,
) -> anyhow::Result<ExternalDiffFilePair> {
    build_external_diff_file_pair_in_root(request, current_path, &external_diff_temp_root_dir())
        .await
}

/// 这一段在指定临时根里准备外部 Diff 文件对。
/// Build external diff files under the supplied temporary root.
async fn build_external_diff_file_pair_in_root(
    request: &ExternalDiffRequest,
    current_path: &Path,
    temp_root: &Path,
) -> anyhow::Result<ExternalDiffFilePair> {
    // 这一段创建单次临时目录，并按新增/删除/重命名决定旧版本来源。
    // Create one run directory and choose the old-version source by add/delete/rename semantics.
    let temp_dir = create_external_diff_temp_dir(temp_root).await?;
    let (is_added, is_deleted) = external_diff_kind_flags(&request.change_kind);
    let old_relative_path = if request.previous_path.is_empty() {
        request.path.as_str()
    } else {
        request.previous_path.as_str()
    };
    let old_content = if is_added {
        None
    } else {
        run_git_show(&request.cwd, old_relative_path).await
    };
    let left_path =
        write_external_diff_temp_file(&temp_dir, "HEAD", old_relative_path, old_content).await?;

    // 这一段处理删除文件或当前文件不存在时的空右侧占位。
    // Use an empty right-side placeholder for deleted or missing current files.
    if is_deleted || !is_existing_file(current_path).await {
        let right_path =
            write_external_diff_temp_file(&temp_dir, "WORKTREE", &request.path, None).await?;
        return Ok(ExternalDiffFilePair {
            left_path,
            right_path,
        });
    }
    Ok(ExternalDiffFilePair {
        left_path,
        right_path: current_path.to_path_buf(),
    })
}

/// 这一段返回外部 Diff 临时根目录。
/// Return the external diff temporary root directory.
fn external_diff_temp_root_dir() -> PathBuf {
    codex_pro_data_root_dir().join("external-diff")
}

/// 这一段创建单次外部 Diff 临时目录。
/// Create a single-run external diff temporary directory.
async fn create_external_diff_temp_dir(root: &Path) -> anyhow::Result<PathBuf> {
    // 这一段先清理旧 run 目录，再创建 UUID 命名的新目录。
    // Prune old run directories first, then create a UUID-named run directory.
    tokio::fs::create_dir_all(&root).await?;
    prune_external_diff_temp_root(root).await;
    for _ in 0..16 {
        let dir = root.join(format!("run-{}", Uuid::new_v4()));
        match tokio::fs::create_dir(&dir).await {
            Ok(()) => return Ok(dir),
            Err(error) if error.kind() == ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.into()),
        }
    }
    anyhow::bail!("Unable to create an external diff temporary directory")
}

/// 这一段清理过期的外部 Diff 临时 run 目录。
/// Prune expired external diff temporary run directories.
async fn prune_external_diff_temp_root(root: &Path) {
    // 这一段清理失败时直接跳过，不能影响本次外部 Diff 打开。
    // Skip cleanup failures so the current external diff launch is unaffected.
    let Ok(mut entries) = tokio::fs::read_dir(root).await else {
        return;
    };
    while let Ok(Some(entry)) = entries.next_entry().await {
        let file_name = entry.file_name().to_string_lossy().to_string();
        if !file_name.starts_with("run-") {
            continue;
        }
        let Ok(metadata) = entry.metadata().await else {
            continue;
        };
        if !metadata.is_dir() || !is_external_diff_temp_entry_expired(&metadata) {
            continue;
        }
        let _ = tokio::fs::remove_dir_all(entry.path()).await;
    }
}

/// 这一段判断临时目录是否过期。
/// Return whether a temporary run directory is expired.
fn is_external_diff_temp_entry_expired(metadata: &std::fs::Metadata) -> bool {
    // 这一段使用修改时间判断，异常时间戳按不过期处理。
    // Use modified time; unusual timestamps are treated as not expired.
    metadata
        .modified()
        .ok()
        .and_then(|modified| SystemTime::now().duration_since(modified).ok())
        .is_some_and(|age| age > EXTERNAL_DIFF_TEMP_MAX_AGE)
}

/// 这一段写入外部 Diff 临时文件。
/// Write one external diff temporary file.
async fn write_external_diff_temp_file(
    temp_dir: &Path,
    prefix: &str,
    relative_path: &str,
    content: Option<Vec<u8>>,
) -> anyhow::Result<PathBuf> {
    // 这一段保留原文件名和扩展名，方便外部工具识别语法。
    // Preserve the original file name and extension so external tools can detect syntax.
    let file_path = temp_dir.join(external_diff_temp_file_name(prefix, relative_path));
    let mut file = tokio::fs::File::create(&file_path).await?;
    file.write_all(content.as_deref().unwrap_or_default())
        .await?;
    Ok(file_path)
}

/// 这一段生成外部 Diff 临时文件名。
/// Build an external diff temporary file name.
fn external_diff_temp_file_name(prefix: &str, relative_path: &str) -> String {
    // 这一段只清理 Windows 不允许的字符，不把正常非 ASCII 文件名改掉。
    // Remove only Windows-invalid characters without rewriting normal non-ASCII file names.
    let raw_name = relative_path
        .rsplit('/')
        .next()
        .filter(|name| !name.is_empty())
        .unwrap_or("file");
    let safe_name = raw_name
        .chars()
        .map(|ch| {
            if matches!(ch, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') || ch.is_control()
            {
                '_'
            } else {
                ch
            }
        })
        .take(120)
        .collect::<String>();
    format!("{prefix}-{}", empty_to_default(&safe_name, "file"))
}

/// 这一段把空字符串替换为默认值。
/// Replace an empty string with a default value.
fn empty_to_default<'a>(value: &'a str, default_value: &'a str) -> &'a str {
    if value.is_empty() {
        default_value
    } else {
        value
    }
}

/// 这一段判断普通文件是否存在。
/// Return whether a regular file exists.
async fn is_existing_file(path: &Path) -> bool {
    // 这一段把 stat 失败统一当作不存在。
    // Treat stat failures as missing files.
    tokio::fs::metadata(path)
        .await
        .map(|metadata| metadata.is_file())
        .unwrap_or(false)
}

/// 这一段解析工作区内文件路径。
/// Resolve a workspace-contained file path.
fn resolve_workspace_file_path(cwd: &Path, relative_path: &str) -> Option<PathBuf> {
    // 这一段复用相对路径校验结果，按路径段 join，避免绝对路径或上跳语义进入。
    // Reuse relative-path validation and join by segments so absolutes or parent traversal cannot enter.
    let normalized = normalize_relative_path(relative_path)?;
    let mut target = cwd.to_path_buf();
    for segment in normalized.split('/') {
        target.push(segment);
    }
    if target == cwd { None } else { Some(target) }
}

/// 这一段识别新增和删除变更。
/// Detect added and deleted change kinds.
fn external_diff_kind_flags(change_kind: &str) -> (bool, bool) {
    // 这一段兼容页面可能传来的英文和中文短标签。
    // Accept short English and Chinese labels from the page.
    let kind = change_kind.to_ascii_lowercase();
    let is_added = kind.contains("add") || kind.contains("create") || change_kind.contains("新增");
    let is_deleted =
        kind.contains("delete") || kind.contains("remove") || change_kind.contains("删除");
    (is_added, is_deleted)
}

/// 这一段读取 HEAD 中的旧版本文件。
/// Read the old-version file from HEAD.
async fn run_git_show(cwd: &Path, relative_path: &str) -> Option<Vec<u8>> {
    // 这一段使用参数数组调用 git show，不让 shell 解释路径。
    // Use an argument array for git show so no shell interprets paths.
    let spec = format!("HEAD:{relative_path}");
    run_git_bytes(
        cwd,
        &["show".to_string(), spec],
        EXTERNAL_DIFF_MAX_FILE_BYTES,
    )
    .await
}

/// 这一段解析 Git 摘要基准。
/// Resolve the Git diff summary base revision.
async fn resolve_git_diff_summary_base(cwd: &Path) -> String {
    // 这一段对齐旧 Node：upstream 存在则用 upstream，否则使用 HEAD。
    // Match the Node behavior: use upstream when it exists, otherwise HEAD.
    let upstream = run_git_text(
        cwd,
        &git_args(&["rev-parse", "--verify", "--quiet", "@{upstream}"]),
        GIT_MAX_OUTPUT_BYTES,
    )
    .await;
    if upstream.trim().is_empty() {
        "HEAD".to_string()
    } else {
        "@{upstream}".to_string()
    }
}

/// 这一段把静态 Git 参数转成 owned 参数。
/// Convert static Git arguments into owned arguments.
fn git_args(args: &[&str]) -> Vec<String> {
    args.iter().map(|arg| (*arg).to_string()).collect()
}

/// 这一段运行 Git 并返回文本。
/// Run Git and return text output.
async fn run_git_text(cwd: &Path, args: &[String], max_bytes: usize) -> String {
    // 这一段失败时返回空字符串，保持旧 Node handler 的失败闭合行为。
    // Return an empty string on failure to preserve the Node handler's fail-closed behavior.
    run_git_bytes(cwd, args, max_bytes)
        .await
        .map(|bytes| String::from_utf8_lossy(&bytes).to_string())
        .unwrap_or_default()
}

/// 这一段运行 Git 并返回受限字节。
/// Run Git and return bounded bytes.
async fn run_git_bytes(cwd: &Path, args: &[String], max_bytes: usize) -> Option<Vec<u8>> {
    // 这一段配置隐藏 Git 子进程和 bounded stdout，不经过 shell。
    // Configure a hidden Git subprocess with bounded stdout and no shell.
    let mut command = Command::new("git");
    command
        .arg("-C")
        .arg(cwd)
        .args(args)
        .kill_on_drop(true)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        command.creation_flags(codex_pro_core::process::CREATE_NO_WINDOW);
    }

    // 这一段边读边限制 stdout，避免大 diff 一次性进入内存。
    // Read stdout incrementally with a hard cap so large diffs cannot fill memory.
    let mut child = command.spawn().ok()?;
    let mut stdout = child.stdout.take()?;
    let run = async move {
        let mut output = Vec::new();
        let mut buffer = [0_u8; 8192];
        loop {
            let read = stdout.read(&mut buffer).await.ok()?;
            if read == 0 {
                break;
            }
            output.extend_from_slice(&buffer[..read]);
            if output.len() > max_bytes {
                let _ = child.kill().await;
                let _ = child.wait().await;
                return None;
            }
        }
        let status = child.wait().await.ok()?;
        if status.success() { Some(output) } else { None }
    };
    tokio::time::timeout(Duration::from_millis(GIT_COMMAND_TIMEOUT_MS), run)
        .await
        .ok()
        .flatten()
}

/// 这一段把 Git numstat 数字规整成非负整数。
/// Normalize Git numstat values into non-negative integers.
fn normalize_git_diff_number(value: &str) -> u64 {
    // 这一段把二进制文件的 "-" 或异常值计为 0。
    // Treat binary "-" values or invalid values as zero.
    value.parse::<u64>().unwrap_or_default()
}

/// 这一段解析 git diff --numstat 输出。
/// Parse git diff --numstat output.
fn parse_git_diff_numstat(output: &str) -> HashMap<String, GitFileStats> {
    // 这一段只保留安全相对路径和增删行数。
    // Keep only safe relative paths and line counts.
    let mut stats_by_path = HashMap::new();
    for line in output.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let parts = line.split('\t').collect::<Vec<_>>();
        if parts.len() < 3 {
            continue;
        }
        let relative_path = normalize_relative_path(&parts[2..].join("\t"));
        let Some(relative_path) = relative_path else {
            continue;
        };
        stats_by_path.insert(
            relative_path,
            GitFileStats {
                additions: normalize_git_diff_number(parts[0]),
                deletions: normalize_git_diff_number(parts[1]),
            },
        );
    }
    stats_by_path
}

/// 这一段把 Git 状态码转成页面使用的变更类型。
/// Convert a Git status code into the page-facing change kind.
fn git_diff_change_kind(status: &str) -> &'static str {
    // 这一段只看首字符，对齐旧 Node 版的 R/C/A/D/M 归类。
    // Inspect only the first character to match the Node R/C/A/D/M grouping.
    match status.chars().next().map(|ch| ch.to_ascii_uppercase()) {
        Some('A') => "added",
        Some('D') => "deleted",
        Some('R') => "renamed",
        Some('C') => "copied",
        _ => "modified",
    }
}

/// 这一段解析 git diff --name-status 输出。
/// Parse git diff --name-status output.
fn parse_git_diff_name_status(
    output: &str,
    stats_by_path: &HashMap<String, GitFileStats>,
    revision: &str,
    navigation_ranges_by_path: &HashMap<String, Vec<Value>>,
) -> Vec<Value> {
    // 这一段以 name-status 作为文件顺序和变更类型来源。
    // Use name-status as the source of file order and change kinds.
    let mut files = Vec::new();
    let mut seen_paths = HashSet::new();
    for line in output.lines() {
        if line.trim().is_empty() || files.len() >= GIT_DIFF_SUMMARY_MAX_FILES {
            continue;
        }
        let parts = line.split('\t').collect::<Vec<_>>();
        let status = parts.first().copied().unwrap_or_default();
        let is_rename_or_copy = status.starts_with('R') || status.starts_with('C');
        let previous_path = if is_rename_or_copy {
            parts
                .get(1)
                .and_then(|value| normalize_relative_path(value))
        } else {
            Some(String::new())
        };
        let current_path = if is_rename_or_copy {
            parts
                .get(2)
                .and_then(|value| normalize_relative_path(value))
        } else {
            parts
                .get(1)
                .and_then(|value| normalize_relative_path(value))
        };
        let (Some(previous_path), Some(current_path)) = (previous_path, current_path) else {
            continue;
        };
        if current_path.is_empty() || !seen_paths.insert(current_path.clone()) {
            continue;
        }
        let stats = stats_by_path
            .get(&current_path)
            .copied()
            .unwrap_or_default();
        files.push(json!({
            "additions": stats.additions,
            "changeKind": git_diff_change_kind(status),
            "deletions": stats.deletions,
            "navigationRanges": navigation_ranges_by_path.get(&current_path).cloned().unwrap_or_default(),
            "path": current_path,
            "previousPath": previous_path,
            "revision": revision,
        }));
    }
    files
}

/// 这一段解析未跟踪文件。
/// Parse untracked Git files.
fn parse_git_untracked_files(output: &str, existing_files: &[Value], revision: &str) -> Vec<Value> {
    // 这一段把未跟踪文件追加到摘要，避免只显示已跟踪文件。
    // Append untracked files so the summary is not limited to tracked files.
    let mut files = Vec::new();
    let mut seen_paths = existing_files
        .iter()
        .filter_map(|file| file.get("path").and_then(Value::as_str).map(str::to_string))
        .collect::<HashSet<_>>();
    for line in output.lines() {
        let Some(relative_path) = normalize_relative_path(line) else {
            continue;
        };
        if !seen_paths.insert(relative_path.clone())
            || existing_files.len() + files.len() >= GIT_DIFF_SUMMARY_MAX_FILES
        {
            continue;
        }
        files.push(json!({
            "additions": 0,
            "changeKind": "added",
            "deletions": 0,
            "path": relative_path,
            "previousPath": "",
            "revision": revision,
        }));
    }
    files
}

/// 这一段解析 unified diff hunk 导航范围。
/// Parse unified diff hunk navigation ranges.
pub fn parse_git_diff_hunks(diff_text: &str) -> HashMap<String, Vec<Value>> {
    // 这一段只记录路径和新文件行号，不保留源码内容。
    // Record only paths and new-file line numbers, never source content.
    let mut output = HashMap::new();
    let mut current_file: Option<GitHunkFile> = None;
    let mut current_hunk: Option<GitHunkTracker> = None;
    for line in diff_text.lines() {
        if line.starts_with("diff --git ") {
            push_git_hunk_range(current_file.as_mut(), current_hunk.take());
            finalize_git_hunk_file(&mut output, current_file.take());
            current_file = Some(GitHunkFile::default());
            continue;
        }
        let Some(file) = current_file.as_mut() else {
            continue;
        };
        if let Some(rest) = line.strip_prefix("rename from ") {
            file.previous_path = normalize_relative_path(rest).unwrap_or_default();
            continue;
        }
        if let Some(rest) = line.strip_prefix("rename to ") {
            file.path = normalize_relative_path(rest).unwrap_or_default();
            continue;
        }
        if let Some(rest) = line.strip_prefix("--- ") {
            file.previous_path = parse_git_unified_diff_path(rest);
            continue;
        }
        if let Some(rest) = line.strip_prefix("+++ ") {
            file.path = parse_git_unified_diff_path(rest);
            continue;
        }
        if let Some((line_number, count)) = parse_hunk_header(line) {
            push_git_hunk_range(Some(file), current_hunk.take());
            current_hunk = Some(create_git_hunk_tracker(line_number, count));
            continue;
        }
        let Some(hunk) = current_hunk.as_mut() else {
            continue;
        };
        if line.starts_with('+') && !line.starts_with("+++") {
            hunk.has_change = true;
            if hunk.line == 0 {
                hunk.line = hunk.new_line;
            }
            hunk.end_line = hunk.new_line;
            hunk.new_line += 1;
            continue;
        }
        if line.starts_with('-') && !line.starts_with("---") {
            hunk.has_change = true;
            if hunk.line == 0 && hunk.new_line_count == 0 {
                hunk.line = hunk.anchor_line;
            }
            continue;
        }
        if line.starts_with(' ') {
            hunk.new_line += 1;
        }
    }
    push_git_hunk_range(current_file.as_mut(), current_hunk);
    finalize_git_hunk_file(&mut output, current_file);
    output
}

/// 这一段从 Git patch 文件头提取相对路径。
/// Extract a relative path from a Git patch header.
fn parse_git_unified_diff_path(value: &str) -> String {
    // 这一段兼容普通 a/b 前缀和 Git 带引号路径，/dev/null 表示新增或删除侧为空。
    // Handle normal a/b prefixes and quoted Git paths; /dev/null means one side is empty.
    let token = value.trim().split('\t').next().unwrap_or_default().trim();
    if token.is_empty() || token == "/dev/null" {
        return String::new();
    }
    let token = token.strip_prefix('"').unwrap_or(token);
    let token = token
        .strip_prefix("a/")
        .or_else(|| token.strip_prefix("b/"))
        .unwrap_or(token);
    let token = token.strip_suffix('"').unwrap_or(token);
    normalize_relative_path(token).unwrap_or_default()
}

/// 这一段解析 hunk 头部的新文件范围。
/// Parse the new-file range from a hunk header.
fn parse_hunk_header(line: &str) -> Option<(u64, u64)> {
    // 这一段只读取 `+line,count` 片段，不解析源码正文。
    // Read only the `+line,count` fragment and ignore source body text.
    if !line.starts_with("@@") {
        return None;
    }
    let plus = line.split_whitespace().find(|part| part.starts_with('+'))?;
    let raw = plus.trim_start_matches('+');
    let mut parts = raw.split(',');
    let line_number = parts.next()?.parse::<u64>().ok()?;
    let count = parts
        .next()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(1);
    Some((line_number, count))
}

/// 这一段创建 hunk 跟踪器。
/// Create a hunk tracker.
fn create_git_hunk_tracker(line: u64, count: u64) -> GitHunkTracker {
    // 这一段保留删除-only hunk 的锚点，和旧 Node 版行为一致。
    // Preserve the deletion-only hunk anchor to match the Node behavior.
    GitHunkTracker {
        anchor_line: line.max(1),
        end_line: 0,
        has_change: false,
        line: 0,
        new_line: line,
        new_line_count: count,
    }
}

/// 这一段把当前 hunk 写入文件范围。
/// Push the current hunk into the file ranges.
fn push_git_hunk_range(file: Option<&mut GitHunkFile>, hunk: Option<GitHunkTracker>) {
    // 这一段只返回有效变更 hunk，删除-only hunk 使用锚点行。
    // Return only changed hunks; deletion-only hunks use the anchor line.
    let (Some(file), Some(hunk)) = (file, hunk) else {
        return;
    };
    if !hunk.has_change {
        return;
    }
    let line = if hunk.line == 0 {
        hunk.anchor_line
    } else {
        hunk.line
    };
    let end_line = if hunk.end_line == 0 {
        line
    } else {
        hunk.end_line.max(line)
    };
    file.navigation_ranges.push(GitHunkRange { line, end_line });
}

/// 这一段收束当前文件的 hunk 范围。
/// Finalize hunk ranges for the current file.
fn finalize_git_hunk_file(output: &mut HashMap<String, Vec<Value>>, file: Option<GitHunkFile>) {
    // 这一段只保存安全路径和有效范围，并限制返回数量。
    // Store only safe paths and valid ranges with a hard count limit.
    let Some(file) = file else {
        return;
    };
    let file_path = if file.path.is_empty() {
        file.previous_path
    } else {
        file.path
    };
    if file_path.is_empty() || file.navigation_ranges.is_empty() {
        return;
    }
    let ranges = file
        .navigation_ranges
        .into_iter()
        .filter(|range| range.line > 0)
        .take(GIT_DIFF_SUMMARY_MAX_NAVIGATION_RANGES)
        .map(|range| json!({ "line": range.line, "endLine": range.end_line.max(range.line) }))
        .collect::<Vec<_>>();
    if !ranges.is_empty() {
        output.insert(file_path, ranges);
    }
}

/// 这一段归一化绝对路径。
/// Normalize an absolute path.
fn normalize_absolute_path(value: &str) -> Option<PathBuf> {
    // 这一段拒绝控制字符和相对路径，同时兼容设置里带引号的 exe 路径。
    // Reject control characters and relative paths while accepting quoted exe paths from settings.
    let raw = value.trim();
    let raw = raw
        .strip_prefix('"')
        .and_then(|value| value.strip_suffix('"'))
        .unwrap_or(raw);
    if raw.is_empty() || raw.len() > EXTERNAL_DIFF_MAX_PATH_LENGTH || raw.contains('\0') {
        return None;
    }
    let path = PathBuf::from(raw);
    if path.is_absolute() { Some(path) } else { None }
}

/// 这一段归一化可选相对路径。
/// Normalize an optional relative path.
fn normalize_optional_relative_path(value: &str) -> Option<String> {
    // 这一段允许空 previousPath。
    // Allow an empty previousPath.
    if value.trim().is_empty() {
        return Some(String::new());
    }
    normalize_relative_path(value)
}

/// 这一段归一化工作区相对路径。
/// Normalize a workspace-relative path.
fn normalize_relative_path(value: &str) -> Option<String> {
    // 这一段拒绝绝对路径、Windows 盘符、上跳和控制字符。
    // Reject absolute paths, Windows drive prefixes, parent traversal, and control characters.
    let raw = value.trim();
    if raw.is_empty() || raw.len() > EXTERNAL_DIFF_MAX_RELATIVE_PATH_LENGTH || raw.contains('\0') {
        return None;
    }
    let mut unified = raw.replace('\\', "/");
    if let Some(stripped) = unified.strip_prefix("./") {
        unified = stripped.to_string();
    }
    if unified.starts_with('/') || has_windows_drive_prefix(&unified) {
        return None;
    }
    let segments = unified
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>();
    if segments.is_empty()
        || segments
            .iter()
            .any(|segment| *segment == "." || *segment == "..")
    {
        return None;
    }
    Some(segments.join("/"))
}

/// 这一段判断是否是 Windows 盘符路径。
/// Return whether a path starts with a Windows drive prefix.
fn has_windows_drive_prefix(value: &str) -> bool {
    // 这一段即使在非 Windows 测试环境也拒绝 C:/secret 这类输入。
    // Reject inputs like C:/secret even when tests run on non-Windows systems.
    let bytes = value.as_bytes();
    bytes.len() >= 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic()
}

/// 这一段在 Windows 上尝试把外部 Diff 窗口置前。
/// Try to foreground the external diff window on Windows.
#[cfg(windows)]
async fn focus_external_diff_window(process_id: u32, tool_path: PathBuf) {
    // 这一段复用当前 launcher exe 的隐藏 helper 模式，避免 worker 自己争抢前台权限。
    // Reuse the current launcher exe's hidden helper mode so the worker does not foreground windows directly.
    if process_id == 0 && tool_path.as_os_str().is_empty() {
        return;
    }
    let Ok(helper_path) = std::env::current_exe() else {
        return;
    };
    let mut command = Command::new(helper_path);
    command
        .arg("--focus-external-diff")
        .arg(process_id.to_string())
        .arg(tool_path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    command.creation_flags(codex_pro_core::process::CREATE_NO_WINDOW);
    if let Ok(mut child) = command.spawn() {
        let _ = child.wait().await;
    }
}

/// 这一段在非 Windows 平台保留空实现。
/// Keep a no-op focus implementation on non-Windows platforms.
#[cfg(not(windows))]
async fn focus_external_diff_window(_process_id: u32, _tool_path: PathBuf) {}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command as StdCommand;

    #[test]
    fn parser_rejects_workspace_escape() {
        assert!(
            parse_external_diff_request(&json!({
                "cwd": "C:/work",
                "path": "../secret.txt",
                "toolPath": "C:/tool.exe",
                "changeKind": "modified"
            }))
            .is_none()
        );
    }

    #[test]
    fn parser_normalizes_safe_relative_paths() {
        let request = parse_external_diff_request(&json!({
            "cwd": "C:/work",
            "path": ".\\src//app.js",
            "previousPath": "./old//app.js",
            "toolPath": "\"C:/tool.exe\"",
            "changeKind": "modified"
        }))
        .expect("valid request should parse");
        assert_eq!(request.path, "src/app.js");
        assert_eq!(request.previous_path, "old/app.js");
        assert_eq!(request.tool_path, PathBuf::from("C:/tool.exe"));
    }

    #[test]
    fn hunk_parser_keeps_new_ranges_only() {
        let ranges = parse_git_diff_hunks(
            "diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1,0 +10,2 @@\n+x\n+y\n",
        );
        assert_eq!(ranges["a.js"][0]["line"], 10);
        assert_eq!(ranges["a.js"][0]["endLine"], 11);
    }

    #[test]
    fn hunk_parser_keeps_delete_only_and_renamed_ranges() {
        let ranges = parse_git_diff_hunks(
            "diff --git a/src/delete-only.js b/src/delete-only.js\n--- a/src/delete-only.js\n+++ b/src/delete-only.js\n@@ -4,1 +4,0 @@\n-const removed = true;\ndiff --git a/src/old.js b/src/new.js\nrename from src/old.js\nrename to src/new.js\n--- a/src/old.js\n+++ b/src/new.js\n@@ -2,0 +3,1 @@\n+export const renamed = true;\n",
        );
        assert_eq!(ranges["src/delete-only.js"][0]["line"], 4);
        assert_eq!(ranges["src/delete-only.js"][0]["endLine"], 4);
        assert_eq!(ranges["src/new.js"][0]["line"], 3);
        assert_eq!(ranges["src/new.js"][0]["endLine"], 3);
    }

    #[tokio::test]
    async fn git_summary_matches_node_shape_for_worktree_changes() {
        let root = create_test_git_repo("summary-shape");
        std::fs::write(root.join("modified.txt"), "old\nsame\n").unwrap();
        std::fs::write(root.join("renamed-old.txt"), "rename\n").unwrap();
        git(&root, &["add", "."]);
        git(&root, &["commit", "-m", "initial"]);

        std::fs::write(root.join("modified.txt"), "new\nsame\nextra\n").unwrap();
        git(&root, &["mv", "renamed-old.txt", "renamed-new.txt"]);
        git(&root, &["add", "-A"]);
        std::fs::write(root.join("untracked.txt"), "local\n").unwrap();

        let response = read_git_diff_summary(&GitDiffSummaryRequest {
            request_id: "req_git".to_string(),
            cwd: root.clone(),
        })
        .await
        .expect("summary should read");
        assert_eq!(response["type"], "success");
        assert_eq!(response["baseRevision"], "HEAD");
        assert_eq!(response["cwd"], root.to_string_lossy().to_string());
        let files = response["files"]
            .as_array()
            .expect("files should be an array");

        let modified = files
            .iter()
            .find(|file| file["path"] == "modified.txt")
            .expect("modified file should be present");
        assert_eq!(modified["changeKind"], "modified");
        assert_eq!(modified["additions"], 2);
        assert_eq!(modified["deletions"], 1);
        assert!(!modified["navigationRanges"].as_array().unwrap().is_empty());

        let renamed = files
            .iter()
            .find(|file| file["path"] == "renamed-new.txt")
            .expect("renamed file should be present");
        assert_eq!(renamed["changeKind"], "renamed");
        assert_eq!(renamed["previousPath"], "renamed-old.txt");

        let untracked = files
            .iter()
            .find(|file| file["path"] == "untracked.txt")
            .expect("untracked file should be present");
        assert_eq!(untracked["changeKind"], "added");
        assert_eq!(untracked["additions"], 0);

        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn external_diff_pairs_handle_added_deleted_and_renamed_files() {
        let root = create_test_git_repo("external-pairs");
        std::fs::write(root.join("old.txt"), "old\n").unwrap();
        std::fs::write(root.join("renamed-old.txt"), "rename old\n").unwrap();
        git(&root, &["add", "."]);
        git(&root, &["commit", "-m", "initial"]);

        let temp_root = root.join(".external-diff-test");
        std::fs::write(root.join("added.txt"), "added\n").unwrap();
        let added_request = external_diff_request(&root, "added.txt", "", "added");
        let added_current = resolve_workspace_file_path(&root, "added.txt").unwrap();
        let added_pair =
            build_external_diff_file_pair_in_root(&added_request, &added_current, &temp_root)
                .await
                .expect("added pair should build");
        assert_eq!(std::fs::read(&added_pair.left_path).unwrap(), b"");
        assert_eq!(added_pair.right_path, root.join("added.txt"));
        cleanup_pair(&added_pair);

        std::fs::remove_file(root.join("old.txt")).unwrap();
        let deleted_request = external_diff_request(&root, "old.txt", "", "deleted");
        let deleted_current = resolve_workspace_file_path(&root, "old.txt").unwrap();
        let deleted_pair =
            build_external_diff_file_pair_in_root(&deleted_request, &deleted_current, &temp_root)
                .await
                .expect("deleted pair should build");
        assert_eq!(std::fs::read(&deleted_pair.left_path).unwrap(), b"old\n");
        assert_eq!(std::fs::read(&deleted_pair.right_path).unwrap(), b"");
        cleanup_pair(&deleted_pair);

        std::fs::rename(root.join("renamed-old.txt"), root.join("renamed-new.txt")).unwrap();
        std::fs::write(root.join("renamed-new.txt"), "rename new\n").unwrap();
        let renamed_request =
            external_diff_request(&root, "renamed-new.txt", "renamed-old.txt", "renamed");
        let renamed_current = resolve_workspace_file_path(&root, "renamed-new.txt").unwrap();
        let renamed_pair =
            build_external_diff_file_pair_in_root(&renamed_request, &renamed_current, &temp_root)
                .await
                .expect("renamed pair should build");
        assert_eq!(
            std::fs::read(&renamed_pair.left_path).unwrap(),
            b"rename old\n"
        );
        assert_eq!(renamed_pair.right_path, root.join("renamed-new.txt"));
        cleanup_pair(&renamed_pair);

        let _ = std::fs::remove_dir_all(root);
    }

    fn external_diff_request(
        root: &Path,
        path: &str,
        previous_path: &str,
        change_kind: &str,
    ) -> ExternalDiffRequest {
        ExternalDiffRequest {
            cwd: root.to_path_buf(),
            path: path.to_string(),
            previous_path: previous_path.to_string(),
            change_kind: change_kind.to_string(),
            tool_path: std::env::current_exe().unwrap(),
        }
    }

    fn cleanup_pair(pair: &ExternalDiffFilePair) {
        if let Some(parent) = pair.left_path.parent() {
            let _ = std::fs::remove_dir_all(parent);
        }
    }

    fn create_test_git_repo(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "codex-pro-diff-hover-{name}-{}-{}",
            std::process::id(),
            Uuid::new_v4()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        git(&root, &["init"]);
        git(
            &root,
            &["config", "user.email", "codex-pro@example.invalid"],
        );
        git(&root, &["config", "user.name", "Codex Pro Test"]);
        git(&root, &["config", "core.autocrlf", "false"]);
        root
    }

    fn git(root: &Path, args: &[&str]) {
        let status = StdCommand::new("git")
            .arg("-C")
            .arg(root)
            .args(args)
            .status()
            .expect("git command should start");
        assert!(status.success(), "git {:?} should succeed", args);
    }
}
