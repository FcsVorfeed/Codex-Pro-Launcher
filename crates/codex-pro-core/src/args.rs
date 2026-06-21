use crate::paths::{DEFAULT_APP_USER_MODEL_ID, DEFAULT_DEBUG_PORT, DEFAULT_TIMEOUT_MS};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// 这一段保存外部 Diff 前台激活辅助模式参数。
/// Stores external-diff foreground helper arguments.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExternalDiffFocusOptions {
    /// 这一段是刚启动的外部 Diff 进程 id。
    /// External diff process id returned by the launch call.
    pub process_id: u32,
    /// 这一段是设置里配置的外部 Diff 工具路径。
    /// External diff tool path configured by settings.
    pub tool_path: String,
}

/// 这一段保存 Rust launcher 标准化命令行参数。
/// Stores normalized Rust launcher CLI options.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct LauncherOptions {
    /// 这一段是显式 Codex 安装路径。
    /// Explicit Codex install path.
    #[serde(rename = "appPath")]
    pub app_path: String,
    /// 这一段是 Windows MSIX AppUserModelId。
    /// Windows MSIX AppUserModelId.
    #[serde(rename = "appUserModelId")]
    pub app_user_model_id: String,
    /// 这一段决定是否只附加已有 Codex。
    /// Whether to attach to an existing Codex instance only.
    #[serde(rename = "attachOnly")]
    pub attach_only: bool,
    /// 这一段是 CDP 调试端口。
    /// CDP debugging port.
    #[serde(rename = "debugPort")]
    pub debug_port: u16,
    /// 这一段是硬屏蔽系统列表。
    /// Hard-disabled injected systems.
    #[serde(rename = "disabledSystems")]
    pub disabled_systems: Vec<String>,
    /// 这一段决定是否启用开发运行期。
    /// Whether the development runtime is enabled.
    #[serde(rename = "devRuntime")]
    pub dev_runtime: bool,
    /// 这一段决定是否只输出诊断。
    /// Whether to print diagnostics only.
    #[serde(rename = "dryRun")]
    pub dry_run: bool,
    /// 这一段是外部 Diff 前台激活辅助模式。
    /// External-diff foreground helper mode.
    #[serde(skip)]
    pub external_diff_focus: Option<ExternalDiffFocusOptions>,
    /// 这一段决定是否启用 native bridge。
    /// Whether the native bridge is enabled.
    #[serde(rename = "nativeBridge")]
    pub native_bridge: bool,
    /// 这一段是 worker 内部参数。
    /// Internal worker payload.
    #[serde(skip)]
    pub native_bridge_worker_payload: Option<String>,
    /// 这一段是构建后自检开关。
    /// Post-build self-test switch.
    #[serde(skip)]
    pub rust_self_test: bool,
    /// 这一段是开发模式读取注入源码的仓库根。
    /// Repository root used by development-mode injection source reads.
    #[serde(rename = "sourceRoot")]
    pub source_root: String,
    /// 这一段是等待页面超时。
    /// Timeout for waiting on the page.
    #[serde(rename = "timeoutMs")]
    pub timeout_ms: u64,
}

/// 这一段把硬屏蔽系统字符串拆成稳定小写列表。
/// Split hard-disabled system names into stable lowercase entries.
pub fn split_system_names(value: &str) -> Vec<String> {
    // 这一段兼容逗号、空白和分号，和 Node 版保持一致。
    // Accept comma, whitespace, and semicolon separators like the Node implementation.
    value
        .split(|ch: char| ch == ',' || ch == ';' || ch.is_whitespace())
        .map(|name| name.trim().to_ascii_lowercase())
        .filter(|name| !name.is_empty())
        .fold(Vec::<String>::new(), |mut acc, name| {
            if !acc.contains(&name) {
                acc.push(name);
            }
            acc
        })
}

/// 这一段解析 launcher 命令行参数。
/// Parse launcher command line arguments.
pub fn parse_args<I, S>(args: I) -> LauncherOptions
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    // 这一段建立环境变量默认值。
    // Build defaults from environment variables.
    let env_disabled = std::env::var("CODEX_PRO_DISABLED_SYSTEMS").unwrap_or_default();
    let env_bridge = std::env::var("CODEX_PRO_NATIVE_BRIDGE").unwrap_or_default();
    let env_dev_runtime = std::env::var("CODEX_PRO_DEV_RUNTIME").unwrap_or_default();
    let env_source_root = std::env::var("CODEX_PRO_SOURCE_ROOT").unwrap_or_default();
    let mut options = LauncherOptions {
        app_path: std::env::var("CODEX_APP_PATH").unwrap_or_default(),
        app_user_model_id: std::env::var("CODEX_APP_USER_MODEL_ID")
            .unwrap_or_else(|_| DEFAULT_APP_USER_MODEL_ID.to_string()),
        attach_only: false,
        debug_port: DEFAULT_DEBUG_PORT,
        disabled_systems: split_system_names(&env_disabled),
        dev_runtime: matches!(
            env_dev_runtime.trim().to_ascii_lowercase().as_str(),
            "1" | "true" | "yes" | "on"
        ),
        dry_run: false,
        external_diff_focus: None,
        native_bridge: env_bridge.trim() != "0",
        native_bridge_worker_payload: None,
        rust_self_test: false,
        source_root: env_source_root,
        timeout_ms: DEFAULT_TIMEOUT_MS,
    };

    // 这一段逐项解析参数，不识别的参数保持忽略以兼容旧调用。
    // Parse arguments one by one and ignore unknown values for compatibility.
    let values = args
        .into_iter()
        .map(|arg| arg.as_ref().to_string())
        .collect::<Vec<_>>();
    let explicit_dev_runtime = matches!(
        env_dev_runtime.trim().to_ascii_lowercase().as_str(),
        "1" | "true" | "yes" | "on"
    );
    let mut index = 0;
    while index < values.len() {
        let arg = values[index].as_str();
        match arg {
            "--app-path" => {
                index += 1;
                options.app_path = values.get(index).cloned().unwrap_or_default();
            }
            "--app-user-model-id" => {
                index += 1;
                options.app_user_model_id = values.get(index).cloned().unwrap_or_default();
            }
            "--debug-port" => {
                index += 1;
                options.debug_port = values
                    .get(index)
                    .and_then(|value| value.parse().ok())
                    .unwrap_or(DEFAULT_DEBUG_PORT);
            }
            "--timeout-ms" => {
                index += 1;
                options.timeout_ms = values
                    .get(index)
                    .and_then(|value| value.parse().ok())
                    .unwrap_or(DEFAULT_TIMEOUT_MS);
            }
            "--disable-system" => {
                index += 1;
                let next = values.get(index).cloned().unwrap_or_default();
                options.disabled_systems =
                    split_system_names(&[options.disabled_systems.join(","), next].join(","));
            }
            "--attach-only" => options.attach_only = true,
            "--dev-runtime" => options.dev_runtime = true,
            "--dry-run" => options.dry_run = true,
            "--focus-external-diff" => {
                index += 1;
                let process_id = values
                    .get(index)
                    .and_then(|value| value.parse::<u32>().ok())
                    .unwrap_or_default();
                index += 1;
                let tool_path = values.get(index).cloned().unwrap_or_default();
                if process_id > 0 || !tool_path.trim().is_empty() {
                    options.external_diff_focus = Some(ExternalDiffFocusOptions {
                        process_id,
                        tool_path,
                    });
                }
            }
            "--native-bridge" => options.native_bridge = true,
            "--no-native-bridge" => options.native_bridge = false,
            "--native-bridge-worker" => {
                index += 1;
                options.native_bridge_worker_payload = values.get(index).cloned();
            }
            "--rust-self-test" => options.rust_self_test = true,
            "--source-root" => {
                index += 1;
                options.source_root = values.get(index).cloned().unwrap_or_default();
            }
            _ => {}
        }
        index += 1;
    }

    // 这一段让仓库内双击 Rust launcher 时自动进入开发模式，保留发布目录的内嵌资产行为。
    // Enable development mode automatically for repository launchers while preserving embedded assets in release output.
    if !options.dev_runtime
        && !explicit_dev_runtime
        && values.is_empty()
        && let Some(source_root) = discover_implicit_development_source_root()
    {
        options.dev_runtime = true;
        options.source_root = source_root;
    }

    // 这一段给 npm dev 脚本之外的手动 dev 调用一个稳定源码根。
    // Give manual dev invocations a stable source root outside the npm dev script.
    if options.dev_runtime && options.source_root.trim().is_empty() {
        options.source_root = std::env::current_dir()
            .map(|path| path.to_string_lossy().to_string())
            .unwrap_or_else(|_| ".".to_string());
    }

    // 这一段保持 attach-only 默认不新建 bridge，除非显式 --native-bridge。
    // Keep attach-only from creating a bridge unless explicitly requested.
    if options.attach_only
        && env_bridge.is_empty()
        && !values.iter().any(|value| value == "--native-bridge")
    {
        options.native_bridge = false;
    }

    options
}

/// 这一段发现无参数双击时可使用的仓库源码根。
/// Discover the repository source root for no-argument double-click launches.
fn discover_implicit_development_source_root() -> Option<String> {
    // 这一段只在无法读取 current_exe 时才允许 cwd 兜底。
    // Allow cwd fallback only when current_exe cannot be read.
    let current_exe = std::env::current_exe().ok();
    let current_dir = if current_exe.is_none() {
        std::env::current_dir().ok()
    } else {
        None
    };
    discover_implicit_development_source_root_from_paths(
        current_exe.as_deref(),
        current_dir.as_deref(),
    )
    .map(|root| root.to_string_lossy().to_string())
}

/// 这一段按给定路径发现隐式 DEV 根，便于测试发布产物排除规则。
/// Discover the implicit DEV root from supplied paths so release exclusions can be tested.
fn discover_implicit_development_source_root_from_paths(
    current_exe: Option<&Path>,
    current_dir: Option<&Path>,
) -> Option<PathBuf> {
    // 这一段优先从当前 exe 路径回溯，匹配 private 开发 launcher 和 private target 调试产物。
    // Prefer walking from the current exe so private dev launchers and private target debug artifacts work.
    if let Some(exe_path) = current_exe {
        if let Some(exe_dir) = exe_path.parent()
            && let Some(root) = find_development_source_root(exe_dir)
            && is_development_launcher_location(exe_path, &root)
        {
            return Some(root);
        }
        return None;
    }

    // 这一段只在 current_exe 不可用时兜底当前目录，避免 private/build 发布产物被 cwd 误切 DEV。
    // Fall back to cwd only when current_exe is unavailable so private/build releases are not forced into DEV by cwd.
    current_dir.and_then(find_development_source_root)
}

/// 这一段向上查找 Codex-Pro 仓库根。
/// Walk upward to find the Codex-Pro repository root.
fn find_development_source_root(start: &Path) -> Option<PathBuf> {
    // 这一段同时检查 Rust 工作区和注入源码目录，避免误把普通父目录当作开发根。
    // Check both the Rust workspace and injection source tree so ordinary parent folders are not mistaken for a dev root.
    let mut current = Some(start);
    while let Some(dir) = current {
        if is_development_source_root(dir) {
            return Some(dir.to_path_buf());
        }
        current = dir.parent();
    }
    None
}

/// 这一段判断目录是否是当前项目源码根。
/// Return whether a directory is the current project source root.
fn is_development_source_root(path: &Path) -> bool {
    // 这一段要求 package、Cargo 工作区和注入源码同时存在，减少跨项目误判。
    // Require package, Cargo workspace, and injection sources together to reduce false positives.
    path.join("package.json").is_file()
        && path.join("Cargo.toml").is_file()
        && path.join("src").join("inject").is_dir()
        && path
            .join("apps")
            .join("codex-pro-launcher")
            .join("src")
            .join("main.rs")
            .is_file()
}

/// 这一段判断当前 exe 是否属于开发启动位置。
/// Return whether the current exe is located where development launches are expected.
fn is_development_launcher_location(exe_path: &Path, source_root: &Path) -> bool {
    // 这一段 private/bin exe 和 private/target 调试产物都视为开发入口，private/build 发布产物不自动切 DEV。
    // Treat the private/bin exe and private/target artifacts as dev launchers, but do not auto-enable dev for private/build releases.
    let Ok(relative) = exe_path.strip_prefix(source_root) else {
        return false;
    };
    let components = relative
        .components()
        .map(|component| component.as_os_str().to_string_lossy().to_ascii_lowercase())
        .collect::<Vec<_>>();
    if components.as_slice() == ["private", "bin", "codex-pro-launcher.exe"] {
        return true;
    }
    if components
        .first()
        .is_some_and(|component| component == "target")
    {
        return true;
    }
    components
        .first()
        .is_some_and(|component| component == "private")
        && components
            .get(1)
            .is_some_and(|component| component == "target")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_system_names_dedupes_and_lowercases() {
        let names = split_system_names("Usage-Panel, usage-panel;diff-hover-preview");
        assert_eq!(names, vec!["usage-panel", "diff-hover-preview"]);
    }

    #[test]
    fn parse_args_keeps_node_compatible_options() {
        let options = parse_args([
            "--attach-only",
            "--native-bridge",
            "--disable-system",
            "usage-panel,file-tree-filter",
            "--debug-port",
            "9333",
        ]);
        assert!(options.attach_only);
        assert!(options.native_bridge);
        assert_eq!(options.debug_port, 9333);
        assert_eq!(
            options.disabled_systems,
            vec!["usage-panel", "file-tree-filter"]
        );
    }

    #[test]
    fn parse_args_accepts_dev_runtime_source_root() {
        let options = parse_args(["--dev-runtime", "--source-root", "X:/Example/Codex-Pro"]);
        assert!(options.dev_runtime);
        assert_eq!(options.source_root, "X:/Example/Codex-Pro");
    }

    #[test]
    fn parse_args_accepts_external_diff_focus_helper() {
        let options = parse_args([
            "--focus-external-diff",
            "1234",
            "C:/Program Files/Beyond Compare 4/BCompare.exe",
        ]);
        let focus = options
            .external_diff_focus
            .expect("focus helper arguments should be parsed");
        assert_eq!(focus.process_id, 1234);
        assert_eq!(
            focus.tool_path,
            "C:/Program Files/Beyond Compare 4/BCompare.exe"
        );
    }

    #[test]
    fn development_launcher_location_excludes_release_build_output() {
        let root = PathBuf::from(r"X:\Example\Codex-Pro");
        assert!(is_development_launcher_location(
            &root
                .join("private")
                .join("bin")
                .join("Codex-Pro-Launcher.exe"),
            &root
        ));
        assert!(is_development_launcher_location(
            &root
                .join("target")
                .join("codex-pro-dev")
                .join("debug")
                .join("Codex-Pro-Launcher.exe"),
            &root
        ));
        assert!(is_development_launcher_location(
            &root
                .join("private")
                .join("target")
                .join("codex-pro-dev")
                .join("debug")
                .join("Codex-Pro-Launcher.exe"),
            &root
        ));
        assert!(!is_development_launcher_location(
            &root
                .join("private")
                .join("build")
                .join("rust")
                .join("Codex-Pro-Launcher.exe"),
            &root
        ));
    }

    #[test]
    fn implicit_dev_discovery_does_not_use_cwd_when_release_exe_is_known() {
        let root = create_test_source_root("implicit-dev-release-exe");
        let release_exe = root
            .join("private")
            .join("build")
            .join("rust")
            .join("Codex-Pro-Launcher.exe");
        let discovered =
            discover_implicit_development_source_root_from_paths(Some(&release_exe), Some(&root));
        assert_eq!(discovered, None);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn implicit_dev_discovery_uses_cwd_only_without_current_exe() {
        let root = create_test_source_root("implicit-dev-cwd-fallback");
        let discovered = discover_implicit_development_source_root_from_paths(None, Some(&root));
        assert_eq!(discovered, Some(root.clone()));
        let _ = std::fs::remove_dir_all(root);
    }

    fn create_test_source_root(name: &str) -> PathBuf {
        let root =
            std::env::temp_dir().join(format!("codex-pro-args-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("src").join("inject")).unwrap();
        std::fs::create_dir_all(root.join("apps").join("codex-pro-launcher").join("src")).unwrap();
        std::fs::create_dir_all(root.join("private").join("build").join("rust")).unwrap();
        std::fs::write(root.join("package.json"), "{}").unwrap();
        std::fs::write(root.join("Cargo.toml"), "[workspace]\n").unwrap();
        std::fs::write(
            root.join("apps")
                .join("codex-pro-launcher")
                .join("src")
                .join("main.rs"),
            "fn main() {}\n",
        )
        .unwrap();
        root
    }
}
