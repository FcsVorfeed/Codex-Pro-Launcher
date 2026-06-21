use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};

/// 这一段定义本机私有配置路径环境变量。
/// Environment variable for the private local config path.
pub const CODEX_PRO_LOCAL_CONFIG_ENV: &str = "CODEX_PRO_LOCAL_CONFIG";
/// 这一段定义 release 构建时嵌入公开运行配置的环境变量。
/// Environment variable used to embed public runtime config during release builds.
pub const CODEX_PRO_RELEASE_CONFIG_JSON_ENV: &str = "CODEX_PRO_RELEASE_CONFIG_JSON";
/// 这一段定义仓库内 private 本机配置相对路径。
/// Repository-relative private local config path.
const LOCAL_CONFIG_RELATIVE_PATH: [&str; 3] = ["private", "config", "codex-pro.local.json"];
/// 这一段定义运行期数据目录里的本机私有配置文件名。
/// Private local config filename under the runtime data directory.
const LOCAL_CONFIG_FILE_NAME: &str = "codex-pro.local.json";

/// 这一段描述 Codex-Pro 本机私有配置。
/// Describes the Codex-Pro private local config.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct CodexProLocalConfig {
    /// 这一段是云端同步相关本机配置。
    /// Local cloud-sync config.
    pub sync: CodexProLocalSyncConfig,
    /// 这一段是授权服务相关本机配置。
    /// Local license-service config.
    pub license: CodexProLocalLicenseConfig,
    /// 这一段是默认外观资源本机配置。
    /// Local appearance-resource config.
    pub appearance: CodexProLocalAppearanceConfig,
    /// 这一段是会话归档本机配置。
    /// Local conversation-archive config.
    #[serde(rename = "conversationArchive")]
    pub conversation_archive: CodexProLocalConversationArchiveConfig,
}

/// 这一段描述云端同步本机配置。
/// Describes local cloud-sync config.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct CodexProLocalSyncConfig {
    /// 这一段是设置同步接口地址。
    /// Settings-sync endpoint.
    pub cloud_sync_endpoint: String,
    /// 这一段是宠物同步接口地址。
    /// Pet-sync endpoint.
    pub pet_sync_endpoint: String,
    /// 这一段是会话归档同步接口地址。
    /// Conversation-archive sync endpoint.
    pub conversation_archive_endpoint: String,
    /// 这一段是同步密钥获取页面地址。
    /// Sync-key acquisition page URL.
    pub key_acquisition_url: String,
}

/// 这一段描述授权服务本机配置。
/// Describes local license-service config.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct CodexProLocalLicenseConfig {
    /// 这一段是授权服务 API 根地址。
    /// License-service API base URL.
    pub api_base: String,
    /// 这一段是授权服务公开 API Key。
    /// License-service publishable API key.
    pub api_key: String,
    /// 这一段是授权服务产品标识。
    /// License-service product slug.
    pub product_slug: String,
}

/// 这一段描述默认外观资源本机配置。
/// Describes local appearance-resource config.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct CodexProLocalAppearanceConfig {
    /// 这一段是默认背景壁纸 URL 列表。
    /// Default background wallpaper URL list.
    pub default_background_wallpaper_images: Vec<String>,
}

/// 这一段描述会话归档本机配置。
/// Describes local conversation-archive config.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct CodexProLocalConversationArchiveConfig {
    /// 这一段是默认设备展示名称。
    /// Default device display name.
    pub default_device_name: String,
}

/// 这一段读取本机私有配置，缺失或解析失败时回退为空配置。
/// Read the private local config, falling back to an empty config when missing or invalid.
pub fn load_local_config(source_root: Option<&Path>) -> CodexProLocalConfig {
    // 这一段按优先级尝试候选路径；第一个可解析文件就是有效配置。
    // Try candidate paths in priority order; the first parseable file wins.
    for config_path in local_config_candidate_paths(source_root) {
        let Ok(contents) = std::fs::read_to_string(&config_path) else {
            continue;
        };
        if let Ok(config) = serde_json::from_str::<CodexProLocalConfig>(&contents) {
            return config;
        }
    }
    if let Some(config) = embedded_release_config() {
        return config;
    }
    CodexProLocalConfig::default()
}

/// 这一段判断当前二进制是否带有 release 公开运行配置。
/// Return whether the current binary carries embedded public release runtime config.
pub fn has_embedded_release_config() -> bool {
    embedded_release_config().is_some()
}

/// 这一段读取编译进 release exe 的公开运行配置。
/// Read the public runtime config embedded into the release executable.
fn embedded_release_config() -> Option<CodexProLocalConfig> {
    // 这一段只接受构建脚本传入的脱敏公开配置；解析失败时回退到其它候选路径。
    // Accept only sanitized public config from the build script; fall back to other candidates when invalid.
    let raw = option_env!("CODEX_PRO_RELEASE_CONFIG_JSON")?.trim();
    if raw.is_empty() {
        return None;
    }
    serde_json::from_str::<CodexProLocalConfig>(raw).ok()
}

/// 这一段返回本机私有配置候选路径。
/// Return private local config candidate paths.
pub fn local_config_candidate_paths(source_root: Option<&Path>) -> Vec<PathBuf> {
    // 这一段收集候选路径并去重，保证显式配置优先。
    // Collect candidate paths with de-duplication while keeping explicit config first.
    let mut paths = Vec::new();
    let mut seen = HashSet::new();
    push_env_config_path(&mut paths, &mut seen);
    if let Some(source_root) = source_root {
        push_repository_config_path(source_root, &mut paths, &mut seen);
    }
    push_current_dir_config_paths(&mut paths, &mut seen);
    push_current_exe_config_paths(&mut paths, &mut seen);
    push_runtime_data_config_path(&mut paths, &mut seen);
    paths
}

/// 这一段加入环境变量显式指定的配置路径。
/// Add the config path explicitly specified by environment variable.
fn push_env_config_path(paths: &mut Vec<PathBuf>, seen: &mut HashSet<PathBuf>) {
    // 这一段允许不同电脑把私有配置放在仓库外，避免公开仓库误带真实值。
    // Allow machines to keep private config outside the repo to avoid accidental publication.
    let value = std::env::var(CODEX_PRO_LOCAL_CONFIG_ENV).unwrap_or_default();
    let trimmed = value.trim();
    if !trimmed.is_empty() {
        push_unique_path(paths, seen, PathBuf::from(trimmed));
    }
}

/// 这一段加入源码根目录下的配置路径。
/// Add the config path under the source root.
fn push_repository_config_path(
    source_root: &Path,
    paths: &mut Vec<PathBuf>,
    seen: &mut HashSet<PathBuf>,
) {
    // 这一段服务开发注入场景，source_root 指向当前仓库，私有值统一放在 private。
    // Serve dev-injection scenarios where source_root points at this repository, with private values kept under private.
    push_unique_path(
        paths,
        seen,
        source_root
            .join(LOCAL_CONFIG_RELATIVE_PATH[0])
            .join(LOCAL_CONFIG_RELATIVE_PATH[1])
            .join(LOCAL_CONFIG_RELATIVE_PATH[2]),
    );
}

/// 这一段加入当前工作目录及其祖先目录下的配置路径。
/// Add config paths under the current working directory and its ancestors.
fn push_current_dir_config_paths(paths: &mut Vec<PathBuf>, seen: &mut HashSet<PathBuf>) {
    // 这一段兼容 cargo run、脚本和从仓库子目录启动的场景。
    // Cover cargo run, scripts, and launches from repository subdirectories.
    let Ok(current_dir) = std::env::current_dir() else {
        return;
    };
    for ancestor in current_dir.ancestors() {
        push_repository_config_path(ancestor, paths, seen);
    }
}

/// 这一段加入可执行文件旁边的配置路径。
/// Add config paths near the executable.
fn push_current_exe_config_paths(paths: &mut Vec<PathBuf>, seen: &mut HashSet<PathBuf>) {
    // 这一段兼容打包后把配置放在 exe 旁边或 exe/config 目录里的场景。
    // Cover packaged launches where config sits beside the exe or under exe/config.
    let Ok(exe_path) = std::env::current_exe() else {
        return;
    };
    let Some(exe_dir) = exe_path.parent() else {
        return;
    };
    push_unique_path(paths, seen, exe_dir.join(LOCAL_CONFIG_FILE_NAME));
    push_repository_config_path(exe_dir, paths, seen);
}

/// 这一段加入 Codex-Pro 运行期数据目录里的配置路径。
/// Add the config path under the Codex-Pro runtime data directory.
fn push_runtime_data_config_path(paths: &mut Vec<PathBuf>, seen: &mut HashSet<PathBuf>) {
    // 这一段支持把私有配置完全放到用户目录，不跟仓库一起移动。
    // Support keeping private config entirely in the user data directory, separate from the repository.
    push_unique_path(
        paths,
        seen,
        crate::paths::codex_pro_data_root_dir().join(LOCAL_CONFIG_FILE_NAME),
    );
}

/// 这一段按原始路径去重并保留顺序。
/// De-duplicate paths while preserving insertion order.
fn push_unique_path(paths: &mut Vec<PathBuf>, seen: &mut HashSet<PathBuf>, path: PathBuf) {
    // 这一段不做 canonicalize，避免不存在的候选路径触发额外 IO 错误。
    // Avoid canonicalize so missing candidate paths do not create extra IO errors.
    if seen.insert(path.clone()) {
        paths.push(path);
    }
}
