use super::codex_state::ConversationThreadRow;
use super::identity::ArchiveIdentity;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

/// 这一段定义普通对话分组 ID。
/// Default conversation group id.
pub const DEFAULT_CONVERSATION_GROUP_ID: &str = "conversation_default";
/// 这一段定义普通对话分组名称。
/// Default conversation group name.
pub const DEFAULT_CONVERSATION_GROUP_NAME: &str = "对话";
/// 这一段定义项目分组类型。
/// Project group type.
pub const GROUP_TYPE_PROJECT: &str = "project";
/// 这一段定义普通对话分组类型。
/// Conversation group type.
pub const GROUP_TYPE_CONVERSATION: &str = "conversation";

/// 这一段描述官方项目索引。
/// Describes official project indexes.
#[derive(Clone, Debug, Default)]
struct OfficialProjects {
    /// 这一段按官方 project id 索引项目。
    /// Projects indexed by official project id.
    by_project_id: HashMap<String, OfficialProject>,
    /// 这一段按本机路径索引项目。
    /// Projects indexed by local path.
    by_path_key: HashMap<String, OfficialProject>,
    /// 这一段保存所有项目，用于父子路径匹配。
    /// All projects for parent-path matching.
    list: Vec<OfficialProject>,
}

/// 这一段描述官方项目。
/// Describes one official project.
#[derive(Clone, Debug, Default)]
struct OfficialProject {
    /// 这一段是本机匹配用身份。
    /// Local matching identity.
    identity: String,
    /// 这一段是项目类型。
    /// Project kind.
    project_kind: String,
    /// 这一段是远端 host id。
    /// Remote host id.
    host_id: String,
    /// 这一段是官方 project id。
    /// Official project id.
    project_id: String,
    /// 这一段是项目显示名。
    /// Project display name.
    project_name: String,
    /// 这一段是本机路径 key。
    /// Local path key.
    path_key: String,
}

/// 这一段描述官方状态。
/// Describes official project state.
#[derive(Clone, Debug, Default)]
struct OfficialState {
    /// 这一段是官方项目索引。
    /// Official project indexes.
    projects: OfficialProjects,
    /// 这一段是官方明确无项目线程。
    /// Official projectless thread IDs.
    projectless_thread_ids: HashSet<String>,
    /// 这一段是官方线程项目绑定。
    /// Official thread-project assignments.
    thread_project_assignments: serde_json::Map<String, Value>,
    /// 这一段是官方线程工作区提示。
    /// Official thread workspace-root hints.
    thread_workspace_root_hints: serde_json::Map<String, Value>,
}

/// 这一段描述分组结果。
/// Describes grouped thread rows.
#[derive(Clone, Debug, Default)]
pub struct GroupedThreads {
    /// 这一段是可同步线程。
    /// Syncable rows.
    pub rows: Vec<ConversationThreadRow>,
    /// 这一段是已移除项目线程数量。
    /// Removed-project thread count.
    pub removed_project_thread_count: usize,
}

/// 这一段按 Codex 官方项目状态给线程分组。
/// Group threads by Codex official project state.
pub async fn apply_thread_groups(
    rows: Vec<ConversationThreadRow>,
    identity: &ArchiveIdentity,
) -> anyhow::Result<GroupedThreads> {
    // 这一段读取官方持久化项目状态，避免从 UI 文案或 cwd 猜项目。
    // Read official persisted project state instead of guessing projects from UI text or cwd.
    let state = read_official_state().await?;
    let mut grouped = GroupedThreads::default();
    for mut row in rows {
        let resolved = resolve_thread_project(&state, &row);
        if resolved.thread_id.is_empty() {
            continue;
        }
        if is_removed_project_thread(&state, &resolved) {
            grouped.removed_project_thread_count += 1;
            continue;
        }
        if let Some(project) = resolved.project {
            row.archive_group_type = GROUP_TYPE_PROJECT.to_string();
            row.archive_group_id = project_group_id(&project.identity, identity);
            row.archive_group_name =
                normalize_group_name(&project.project_name, GROUP_TYPE_PROJECT);
        } else {
            apply_default_conversation_group(&mut row);
        }
        grouped.rows.push(row);
    }
    Ok(grouped)
}

/// 这一段给线程写入默认普通对话分组。
/// Apply the default conversation group to a row.
pub fn apply_default_conversation_group(row: &mut ConversationThreadRow) {
    // 这一段不把 cwd 伪装成项目，避免上传本机路径派生出的错误分组。
    // Do not treat cwd as a project, avoiding path-derived wrong groups.
    row.archive_group_id = DEFAULT_CONVERSATION_GROUP_ID.to_string();
    row.archive_group_name = DEFAULT_CONVERSATION_GROUP_NAME.to_string();
    row.archive_group_type = GROUP_TYPE_CONVERSATION.to_string();
}

/// 这一段读取 Codex 官方全局状态。
/// Read Codex official global state.
async fn read_official_state() -> anyhow::Result<OfficialState> {
    // 这一段只读取本机 Codex 状态文件，不访问网络或 UI。
    // Read only the local Codex state file, not network or UI state.
    let path = codex_pro_core::paths::codex_home_dir().join(".codex-global-state.json");
    let bytes = tokio::fs::read(&path).await.map_err(|_| {
        anyhow::anyhow!(
            "未找到 Codex 官方项目状态，已停止会话归档同步以避免错误分类 / Codex official project state was not found; archive sync stopped to avoid wrong grouping"
        )
    })?;
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| {
        anyhow::anyhow!(
            "Codex 官方项目状态暂时不可读，已停止会话归档同步，请稍后重试 / Codex official project state is temporarily unreadable; archive sync stopped, please retry later"
        )
    })?;
    let object = value.as_object().ok_or_else(|| {
        anyhow::anyhow!(
            "Codex 官方项目状态格式异常，已停止会话归档同步以避免错误分类 / Codex official project state has an invalid shape; archive sync stopped to avoid wrong grouping"
        )
    })?;
    Ok(OfficialState {
        projects: build_official_projects(object),
        projectless_thread_ids: string_array(object.get("projectless-thread-ids"))
            .into_iter()
            .collect(),
        thread_project_assignments: object_map(object.get("thread-project-assignments")),
        thread_workspace_root_hints: object_map(object.get("thread-workspace-root-hints")),
    })
}

/// 这一段构造官方项目索引。
/// Build official project indexes.
fn build_official_projects(object: &serde_json::Map<String, Value>) -> OfficialProjects {
    // 这一段只使用官方保存的项目根和显式项目定义。
    // Use only official saved roots and explicit project definitions.
    let mut projects = OfficialProjects::default();
    add_workspace_root_projects(&mut projects, object.get("electron-saved-workspace-roots"));
    for project_path in string_array(object.get("project-order")) {
        if normalize_path_key(&project_path).is_empty() {
            continue;
        }
        add_project(
            &mut projects,
            ProjectCandidate {
                path: project_path.clone(),
                project_id: project_path.clone(),
                project_kind: "local".to_string(),
                project_name: project_name_from_path(&project_path),
                ..ProjectCandidate::default()
            },
        );
    }
    for (project_id, value) in object_map(object.get("local-projects")) {
        let record = object_map(Some(&value));
        add_project(
            &mut projects,
            ProjectCandidate {
                path: string_field(&record, &["path", "root", "cwd"]),
                project_id: string_field(&record, &["id"]).if_empty(project_id),
                project_kind: "local".to_string(),
                project_name: string_field(&record, &["name", "label"]),
                ..ProjectCandidate::default()
            },
        );
    }
    for (project_id, roots) in object_map(object.get("project-writable-roots")) {
        let root_values = if let Some(array) = roots.as_array() {
            array
                .iter()
                .filter_map(Value::as_str)
                .map(ToString::to_string)
                .collect::<Vec<_>>()
        } else {
            roots
                .as_str()
                .map(|value| vec![value.to_string()])
                .unwrap_or_default()
        };
        for root in root_values {
            add_project(
                &mut projects,
                ProjectCandidate {
                    path: root.clone(),
                    project_id: project_id.clone(),
                    project_kind: "local".to_string(),
                    project_name: project_name_from_path(&root).if_empty(project_id.clone()),
                    ..ProjectCandidate::default()
                },
            );
        }
    }
    for value in object_map(object.get("remote-projects")).into_values() {
        let record = object_map(Some(&value));
        add_project(
            &mut projects,
            ProjectCandidate {
                host_id: string_field(&record, &["hostId"]),
                path: string_field(&record, &["remotePath", "path"]),
                project_id: string_field(&record, &["id", "projectId"]),
                project_kind: "remote".to_string(),
                project_name: string_field(&record, &["label", "name"]),
            },
        );
    }
    projects
}

/// 这一段添加保存工作区项目。
/// Add saved workspace-root projects.
fn add_workspace_root_projects(projects: &mut OfficialProjects, value: Option<&Value>) {
    // 这一段兼容数组形态和 roots/labels 对象形态。
    // Support both array and roots/labels object shapes.
    if let Some(array) = value.and_then(Value::as_array) {
        for root in array.iter().filter_map(Value::as_str) {
            add_project(
                projects,
                ProjectCandidate {
                    path: root.to_string(),
                    project_id: root.to_string(),
                    project_kind: "local".to_string(),
                    project_name: project_name_from_path(root),
                    ..ProjectCandidate::default()
                },
            );
        }
        return;
    }
    let Some(object) = value.and_then(Value::as_object) else {
        return;
    };
    let labels = object_map(object.get("labels"));
    for root in string_array(object.get("roots")) {
        let path_key = normalize_path_key(&root);
        let label = labels
            .get(&root)
            .or_else(|| labels.get(&path_key))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        add_project(
            projects,
            ProjectCandidate {
                path: root.clone(),
                project_id: root.clone(),
                project_kind: "local".to_string(),
                project_name: label.if_empty(project_name_from_path(&root)),
                ..ProjectCandidate::default()
            },
        );
    }
}

/// 这一段描述待加入项目。
/// Describes a project candidate.
#[derive(Clone, Debug, Default)]
struct ProjectCandidate {
    /// 这一段是 host id。
    /// Host id.
    host_id: String,
    /// 这一段是路径。
    /// Path.
    path: String,
    /// 这一段是 project id。
    /// Project id.
    project_id: String,
    /// 这一段是项目类型。
    /// Project kind.
    project_kind: String,
    /// 这一段是显示名。
    /// Display name.
    project_name: String,
}

/// 这一段加入一个项目。
/// Add one project.
fn add_project(projects: &mut OfficialProjects, candidate: ProjectCandidate) {
    // 这一段建立 projectId 和路径两个索引；无身份信息则跳过。
    // Build both projectId and path indexes; skip candidates with no identity.
    let path_key = normalize_path_key(&candidate.path);
    let identity_value = first_non_empty(&[&candidate.project_id, &path_key, &candidate.path]);
    if identity_value.is_empty() {
        return;
    }
    let project_kind = candidate.project_kind.if_empty("local".to_string());
    let project_name = normalize_group_name(
        &candidate
            .project_name
            .if_empty(project_name_from_path(&candidate.path))
            .if_empty(candidate.project_id.clone()),
        GROUP_TYPE_PROJECT,
    );
    let project = OfficialProject {
        identity: format!(
            "official:{}:{}:{}",
            project_kind, candidate.host_id, identity_value
        ),
        host_id: candidate.host_id,
        project_id: candidate.project_id.if_empty(path_key.clone()),
        project_kind,
        project_name,
        path_key: path_key.clone(),
    };
    if !project.project_id.is_empty() {
        projects.by_project_id.insert(
            project_key(&project.project_kind, &project.host_id, &project.project_id),
            project.clone(),
        );
    }
    if !path_key.is_empty() {
        projects.by_path_key.insert(path_key, project.clone());
    }
    projects.list.push(project);
}

/// 这一段解析线程项目。
/// Resolve a thread project.
fn resolve_thread_project(
    state: &OfficialState,
    row: &ConversationThreadRow,
) -> ResolvedThreadProject {
    // 这一段优先官方显式 assignment，其次 hint 和 cwd 路径匹配。
    // Prefer official assignment, then hint and cwd path matching.
    let thread_id = row.thread_id.trim().to_string();
    if thread_id.is_empty() {
        return ResolvedThreadProject::default();
    }
    let assignment_project = state
        .thread_project_assignments
        .get(&thread_id)
        .and_then(|value| project_from_assignment(state, value));
    let hint_path_key = state
        .thread_workspace_root_hints
        .get(&thread_id)
        .and_then(Value::as_str)
        .map(normalize_path_key)
        .unwrap_or_default();
    let cwd_path_key = normalize_path_key(&row.cwd);
    let project = assignment_project
        .or_else(|| project_by_path_key(state, &hint_path_key))
        .or_else(|| project_by_path_key(state, &cwd_path_key));
    ResolvedThreadProject {
        hint_path_key,
        project,
        thread_id,
    }
}

/// 这一段描述线程项目解析结果。
/// Describes resolved thread project state.
#[derive(Clone, Debug, Default)]
struct ResolvedThreadProject {
    /// 这一段是 hint 路径 key。
    /// Hint path key.
    hint_path_key: String,
    /// 这一段是匹配项目。
    /// Matched project.
    project: Option<OfficialProject>,
    /// 这一段是线程 id。
    /// Thread id.
    thread_id: String,
}

/// 这一段从官方 assignment 解析项目。
/// Resolve a project from an official assignment.
fn project_from_assignment(state: &OfficialState, value: &Value) -> Option<OfficialProject> {
    // 这一段允许 assignment 自身生成稳定身份，兼容项目 registry 缺失。
    // Allow the assignment itself to provide stable identity when the registry is missing.
    let record = value.as_object()?;
    let project_kind = record
        .get("projectKind")
        .and_then(Value::as_str)
        .unwrap_or("local")
        .to_string();
    let host_id = record
        .get("hostId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let project_id = first_non_empty_value(record, &["projectId", "id"]);
    let path_value = first_non_empty_value(record, &["path", "cwd", "remotePath"]);
    let by_project_id = if project_id.is_empty() {
        None
    } else {
        state
            .projects
            .by_project_id
            .get(&project_key(&project_kind, &host_id, &project_id))
            .cloned()
    };
    if by_project_id.is_some() {
        return by_project_id;
    }
    let path_key = normalize_path_key(&path_value);
    if let Some(project) = project_by_path_key(state, &path_key) {
        return Some(project);
    }
    if project_id.is_empty() && path_key.is_empty() {
        return None;
    }
    Some(OfficialProject {
        identity: format!(
            "official-assignment:{}:{}:{}",
            project_kind,
            host_id,
            project_id.clone().if_empty(path_key.clone())
        ),
        host_id,
        project_id,
        project_kind,
        project_name: normalize_group_name(
            &first_non_empty_value(record, &["label", "name"])
                .if_empty(project_name_from_path(&path_value))
                .if_empty(path_value),
            GROUP_TYPE_PROJECT,
        ),
        path_key,
    })
}

/// 这一段按路径 key 找项目。
/// Find a project by path key.
fn project_by_path_key(state: &OfficialState, path_key: &str) -> Option<OfficialProject> {
    // 这一段先精确匹配，再匹配项目根父路径。
    // Match exactly first, then by project-root parent path.
    let normalized = normalize_path_key(path_key);
    if normalized.is_empty() {
        return None;
    }
    if let Some(project) = state.projects.by_path_key.get(&normalized) {
        return Some(project.clone());
    }
    state.projects.list.iter().find_map(|project| {
        let project_path = normalize_path_key(&project.path_key);
        if !project_path.is_empty()
            && (normalized.starts_with(&format!("{project_path}/"))
                || normalized.starts_with(&format!("{project_path}\\")))
        {
            Some(project.clone())
        } else {
            None
        }
    })
}

/// 这一段判断是否是已移除项目线程。
/// Return whether a row belongs to a removed project.
fn is_removed_project_thread(state: &OfficialState, resolved: &ResolvedThreadProject) -> bool {
    // 这一段只把官方 workspace hint 视为旧项目负向证据；SQLite cwd 仅用于正向匹配项目。
    // Treat only official workspace hints as removed-project evidence; SQLite cwd is only a positive project match signal.
    !resolved.thread_id.is_empty()
        && !state.projectless_thread_ids.contains(&resolved.thread_id)
        && resolved.project.is_none()
        && !resolved.hint_path_key.is_empty()
}

/// 这一段生成项目分组 ID。
/// Build a project group id.
fn project_group_id(project_identity: &str, identity: &ArchiveIdentity) -> String {
    // 这一段使用本机私有盐做不可逆 hash，不上传真实路径。
    // Use a local private salt as an irreversible hash, never uploading real paths.
    let value = project_identity.trim();
    if value.is_empty() {
        return "project_unknown".to_string();
    }
    let hash_input = format!("{}\n{}", identity.project_salt, value);
    let digest = format!("{:x}", Sha256::digest(hash_input.as_bytes()));
    format!("project_{}", digest.chars().take(16).collect::<String>())
}

/// 这一段构造 project map key。
/// Build a project map key.
fn project_key(kind: &str, host_id: &str, project_id: &str) -> String {
    // 这一段保持和旧 Node `${kind}:${host}:${id}` 一致。
    // Match the legacy Node `${kind}:${host}:${id}` key.
    format!("{kind}:{host_id}:{project_id}")
}

/// 这一段规范化本机路径 key。
/// Normalize a local path key.
fn normalize_path_key(value: &str) -> String {
    // 这一段只用于本机匹配，不会上传。
    // This is used only for local matching and is never uploaded.
    let raw = value.trim();
    if raw.is_empty() {
        return String::new();
    }
    let without_prefix = raw
        .strip_prefix(r"\\?\UNC\")
        .map(|rest| format!(r"\\{rest}"))
        .unwrap_or_else(|| raw.strip_prefix(r"\\?\").unwrap_or(raw).to_string());
    let path = PathBuf::from(&without_prefix);
    let mut text = if path.is_absolute() {
        path.to_string_lossy().to_string()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(path)
            .to_string_lossy()
            .to_string()
    };
    while text.ends_with('/') || text.ends_with('\\') {
        text.pop();
    }
    if cfg!(windows) {
        text.to_ascii_lowercase()
    } else {
        text
    }
}

/// 这一段从路径取项目名。
/// Derive a project name from a path.
fn project_name_from_path(value: &str) -> String {
    // 这一段只取最后一级目录名，避免上传完整路径。
    // Use only the last path segment so full paths are not uploaded.
    let normalized = value.replace('\\', "/");
    normalized
        .split('/')
        .rfind(|part| !part.trim().is_empty())
        .unwrap_or_default()
        .trim()
        .trim_end_matches(':')
        .chars()
        .take(120)
        .collect()
}

/// 这一段规范化分组显示名。
/// Normalize a group display name.
fn normalize_group_name(value: &str, group_type: &str) -> String {
    // 这一段只保留短显示文本，项目名再取最后一级。
    // Keep a short display text, using only the last path segment for projects.
    let fallback = if group_type == GROUP_TYPE_PROJECT {
        "项目"
    } else {
        DEFAULT_CONVERSATION_GROUP_NAME
    };
    let text = value.replace('\\', "/");
    let segment = text
        .split('/')
        .rfind(|part| !part.trim().is_empty())
        .unwrap_or(&text);
    let name = segment
        .trim()
        .trim_end_matches(':')
        .chars()
        .filter(|ch| !ch.is_control())
        .take(120)
        .collect::<String>();
    if name.trim().is_empty() {
        fallback.to_string()
    } else {
        name.trim().to_string()
    }
}

/// 这一段读取字符串数组。
/// Read a string array.
fn string_array(value: Option<&Value>) -> Vec<String> {
    // 这一段忽略异常项，保持扫描稳定。
    // Ignore invalid items so scanning stays stable.
    value
        .and_then(Value::as_array)
        .map(|array| {
            array
                .iter()
                .filter_map(Value::as_str)
                .filter(|text| !text.trim().is_empty())
                .map(ToString::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// 这一段读取对象 map。
/// Read an object map.
fn object_map(value: Option<&Value>) -> serde_json::Map<String, Value> {
    // 这一段只接受普通对象。
    // Accept only plain objects.
    value
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
}

/// 这一段读取第一个字符串字段。
/// Read the first string field.
fn string_field(map: &serde_json::Map<String, Value>, keys: &[&str]) -> String {
    // 这一段用于兼容官方状态里的多个字段名。
    // Support several field names in official state records.
    first_non_empty_value(map, keys)
}

/// 这一段读取第一个非空字段值。
/// Read the first non-empty field value.
fn first_non_empty_value(map: &serde_json::Map<String, Value>, keys: &[&str]) -> String {
    // 这一段只接受字符串值，避免对象或数组进入路径和名称。
    // Accept only string values so objects or arrays do not enter paths or names.
    keys.iter()
        .find_map(|key| {
            map.get(*key)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToString::to_string)
        })
        .unwrap_or_default()
}

/// 这一段返回第一个非空字符串。
/// Return the first non-empty string.
fn first_non_empty(values: &[&str]) -> String {
    // 这一段减少多字段 fallback 的重复代码。
    // Reduce repeated multi-field fallback code.
    values
        .iter()
        .map(|value| value.trim())
        .find(|value| !value.is_empty())
        .unwrap_or_default()
        .to_string()
}

/// 这一段提供空字符串 fallback。
/// Provide a fallback for empty strings.
trait EmptyFallback {
    /// 这一段在当前字符串为空时返回 fallback。
    /// Return fallback when the current string is empty.
    fn if_empty(self, fallback: String) -> String;
}

impl EmptyFallback for String {
    /// 这一段在当前字符串为空时返回 fallback。
    /// Return fallback when the current string is empty.
    fn if_empty(self, fallback: String) -> String {
        // 这一段保留已有非空文本。
        // Preserve existing non-empty text.
        if self.trim().is_empty() {
            fallback
        } else {
            self
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 这一段确认项目 ID 使用盐 hash 而不是原始路径。
    /// Confirm project IDs use salted hashes instead of raw paths.
    #[test]
    fn project_group_id_uses_salted_hash() {
        let identity = ArchiveIdentity {
            device_id: "device_a".to_string(),
            profile_id: "profile_a".to_string(),
            project_salt: "salt_secret".to_string(),
        };
        let group_id = project_group_id("official:local::X:/Example/Codex-Pro", &identity);

        assert!(group_id.starts_with("project_"));
        assert!(!group_id.contains("AIProject"));
    }

    /// 这一段确认项目名只取路径最后一级。
    /// Confirm project names use only the last path segment.
    #[test]
    fn project_name_uses_last_path_segment() {
        assert_eq!(project_name_from_path("X:/Example/Codex-Pro"), "Codex-Pro");
    }

    /// 这一段确认官方无项目线程会回落到普通对话分组。
    /// Confirm official projectless threads fall back to the default conversation group.
    #[test]
    fn projectless_thread_uses_default_conversation_group() {
        let mut state = OfficialState::default();
        state
            .projectless_thread_ids
            .insert("thread_projectless".to_string());
        let row = ConversationThreadRow {
            archive_group_id: String::new(),
            archive_group_name: String::new(),
            archive_group_type: String::new(),
            archived_at: String::new(),
            created_at: String::new(),
            created_at_ms: 0,
            cwd: "X:/Removed/OldProject".to_string(),
            deleted_detected_at: String::new(),
            lifecycle_status: "active".to_string(),
            rollout_path: "rollout.jsonl".to_string(),
            skip_reason: String::new(),
            thread_id: "thread_projectless".to_string(),
            thread_source: "user".to_string(),
            title: "普通对话".to_string(),
            updated_at: String::new(),
            updated_at_ms: 0,
        };
        let resolved = resolve_thread_project(&state, &row);
        let mut grouped_row = row.clone();

        assert!(!is_removed_project_thread(&state, &resolved));
        apply_default_conversation_group(&mut grouped_row);
        assert_eq!(grouped_row.archive_group_type, GROUP_TYPE_CONVERSATION);
        assert_eq!(grouped_row.archive_group_id, DEFAULT_CONVERSATION_GROUP_ID);
    }

    /// 这一段确认仅有 SQLite cwd 不会被当成移除项目。
    /// Confirm SQLite cwd alone is not treated as a removed project.
    #[test]
    fn cwd_only_thread_falls_back_to_conversation_group() {
        let state = OfficialState::default();
        let row = ConversationThreadRow {
            archive_group_id: String::new(),
            archive_group_name: String::new(),
            archive_group_type: String::new(),
            archived_at: String::new(),
            created_at: String::new(),
            created_at_ms: 0,
            cwd: "X:/Removed/OldProject".to_string(),
            deleted_detected_at: String::new(),
            lifecycle_status: "active".to_string(),
            rollout_path: "rollout.jsonl".to_string(),
            skip_reason: String::new(),
            thread_id: "thread_cwd_only".to_string(),
            thread_source: "user".to_string(),
            title: "普通对话".to_string(),
            updated_at: String::new(),
            updated_at_ms: 0,
        };
        let resolved = resolve_thread_project(&state, &row);

        assert!(resolved.hint_path_key.is_empty());
        assert!(!is_removed_project_thread(&state, &resolved));
    }

    /// 这一段确认官方 hint 指向旧项目时仍会被隐藏。
    /// Confirm stale official hints are still hidden as removed projects.
    #[test]
    fn stale_official_hint_thread_is_removed_project() {
        let mut state = OfficialState::default();
        state.thread_workspace_root_hints.insert(
            "thread_with_stale_hint".to_string(),
            Value::String("X:/Removed/OldProject".to_string()),
        );
        let row = ConversationThreadRow {
            archive_group_id: String::new(),
            archive_group_name: String::new(),
            archive_group_type: String::new(),
            archived_at: String::new(),
            created_at: String::new(),
            created_at_ms: 0,
            cwd: String::new(),
            deleted_detected_at: String::new(),
            lifecycle_status: "active".to_string(),
            rollout_path: "rollout.jsonl".to_string(),
            skip_reason: String::new(),
            thread_id: "thread_with_stale_hint".to_string(),
            thread_source: "user".to_string(),
            title: "旧项目对话".to_string(),
            updated_at: String::new(),
            updated_at_ms: 0,
        };
        let resolved = resolve_thread_project(&state, &row);

        assert!(!resolved.hint_path_key.is_empty());
        assert!(is_removed_project_thread(&state, &resolved));
    }
}
