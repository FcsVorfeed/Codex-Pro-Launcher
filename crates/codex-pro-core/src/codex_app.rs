use crate::paths::{DEFAULT_APP_USER_MODEL_ID, DEFAULT_DEBUG_PORT};
use anyhow::{Context, bail};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tokio::process::Command;

/// 这一段定义 Windows packaged activation 后等待 CDP 就绪的时间。
/// Time to wait for CDP readiness after Windows packaged activation.
const PACKAGED_CDP_READY_TIMEOUT_MS: u64 = 5_000;

/// 这一段描述已解析的 Codex 启动目标。
/// Describes the resolved Codex launch target.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct LaunchTarget {
    /// 这一段是 Codex.exe 路径，MSIX 权限不可见时允许为空。
    /// Codex.exe path, allowed to be empty when MSIX permissions hide it.
    pub executable: String,
    /// 这一段是 MSIX AppUserModelId。
    /// MSIX AppUserModelId.
    #[serde(rename = "appUserModelId")]
    pub app_user_model_id: String,
}

/// 这一段描述启动结果。
/// Describes a launch result.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct LaunchResult {
    /// 这一段是启动方式。
    /// Launch method.
    pub method: String,
    /// 这一段是进程 id。
    /// Process id.
    pub pid: Option<u32>,
    /// 这一段表示启动函数返回前已经确认 CDP 主页面存在。
    /// Whether the main CDP page was confirmed before returning from launch.
    #[serde(rename = "cdpReady")]
    pub cdp_ready: bool,
}

/// 这一段把输入路径归一化到 Codex.exe。
/// Normalize a user input path into Codex.exe.
pub fn normalize_codex_path(value: &str) -> String {
    // 这一段支持 exe、app 目录和包根目录三种输入。
    // Support an exe, app directory, or package root.
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let path = PathBuf::from(trimmed);
    let path_text = path.to_string_lossy();
    if path_text.to_ascii_lowercase().ends_with("codex.exe") {
        return path_text.to_string();
    }
    if path_text.to_ascii_lowercase().ends_with("\\app")
        || path_text.to_ascii_lowercase().ends_with("/app")
    {
        return path.join("Codex.exe").to_string_lossy().to_string();
    }
    path.join("app")
        .join("Codex.exe")
        .to_string_lossy()
        .to_string()
}

/// 这一段从 Codex.exe 路径推导 AppUserModelId。
/// Derive AppUserModelId from a Codex.exe path.
pub fn app_user_model_id_from_executable(executable: &str) -> String {
    // 这一段查找 OpenAI.Codex_* 包目录名，并按 MSIX 规则拼接。
    // Find the OpenAI.Codex_* package segment and assemble the MSIX id.
    let package = executable
        .split(['\\', '/'])
        .find(|part| {
            let lower = part.to_ascii_lowercase();
            lower.starts_with("openai.codex_") || lower.starts_with("openai.codexbeta_")
        })
        .unwrap_or_default();
    if !package.contains("__") {
        return String::new();
    }
    let identity = package.split('_').next().unwrap_or_default();
    let publisher = package.split("__").last().unwrap_or_default();
    if identity.is_empty() || publisher.is_empty() {
        String::new()
    } else {
        format!("{identity}_{publisher}!App")
    }
}

/// 这一段解析 Codex 启动目标。
/// Resolve the Codex launch target.
pub fn resolve_launch_target(
    app_path: &str,
    app_user_model_id: &str,
) -> anyhow::Result<LaunchTarget> {
    // 这一段优先使用显式路径，并从路径推导 AUMID。
    // Prefer an explicit path and derive AUMID from it.
    let explicit = normalize_codex_path(app_path);
    let executable = if explicit.is_empty() {
        resolve_default_codex_executable()
    } else {
        explicit
    };
    let derived = app_user_model_id_from_executable(&executable);
    let app_user_model_id = if !derived.is_empty() {
        derived
    } else if !app_user_model_id.trim().is_empty() {
        app_user_model_id.trim().to_string()
    } else {
        DEFAULT_APP_USER_MODEL_ID.to_string()
    };

    // 这一段没有显式路径时回落到稳定 AUMID，不扫描 WindowsApps 以避免权限阻塞。
    // Fall back to a stable AUMID when no explicit path is supplied.
    if executable.is_empty() && app_user_model_id.is_empty() {
        bail!("Codex launch target not found");
    }
    Ok(LaunchTarget {
        executable,
        app_user_model_id,
    })
}

/// 这一段解析默认 Codex.exe 路径。
/// Resolve the default Codex.exe path.
fn resolve_default_codex_executable() -> String {
    // 这一段优先复用正在运行的 Codex 进程路径，适合 WindowsApps 目录不可枚举的环境。
    // Prefer the running Codex process path, which works even when WindowsApps cannot be enumerated.
    if let Some(path) = crate::process::find_running_codex_executable() {
        return path.to_string_lossy().to_string();
    }

    // 这一段退回到安装目录扫描，支持无 Codex 进程时直接启动。
    // Fall back to install-directory scanning so cold starts can spawn the executable directly.
    find_latest_installed_codex_executable()
        .map(|path| path.to_string_lossy().to_string())
        .unwrap_or_default()
}

/// 这一段查找最新安装的 Codex.exe。
/// Find the latest installed Codex.exe.
fn find_latest_installed_codex_executable() -> Option<PathBuf> {
    // 这一段目前只需要 Windows MSIX 包路径，其他平台保留空实现。
    // Currently only Windows MSIX package paths are needed; other platforms keep an empty implementation.
    #[cfg(windows)]
    {
        find_latest_windowsapps_codex_executable()
    }
    #[cfg(not(windows))]
    {
        None
    }
}

/// 这一段在 WindowsApps 根目录里查找最新 Codex 包。
/// Search WindowsApps roots for the latest Codex package.
#[cfg(windows)]
fn find_latest_windowsapps_codex_executable() -> Option<PathBuf> {
    // 这一段对每个可枚举根目录收集候选，权限不足时跳过该根。
    // Collect candidates from each enumerable root and skip roots without permission.
    let mut candidates = Vec::<(Vec<u32>, PathBuf)>::new();
    for root in windows_app_package_roots() {
        let Ok(entries) = std::fs::read_dir(&root) else {
            continue;
        };
        for entry in entries.filter_map(Result::ok) {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
                continue;
            };
            let Some(version) = codex_package_version_parts(name) else {
                continue;
            };
            let app_dir = path.join("app");
            let executable = if app_dir.is_dir() {
                app_dir.join("Codex.exe")
            } else {
                path.join("Codex.exe")
            };
            if executable.is_file() {
                candidates.push((version, executable));
            }
        }
    }
    candidates.sort_by(|left, right| left.0.cmp(&right.0));
    candidates.pop().map(|(_, path)| path)
}

/// 这一段返回常见 WindowsApps 根目录。
/// Return common WindowsApps root directories.
#[cfg(windows)]
fn windows_app_package_roots() -> Vec<PathBuf> {
    // 这一段兼容 ProgramFiles/ProgramW6432 差异，并去重固定路径。
    // Handle ProgramFiles/ProgramW6432 differences and deduplicate the fixed path.
    let mut roots = Vec::new();
    if let Some(program_files) = std::env::var_os("ProgramFiles") {
        roots.push(PathBuf::from(program_files).join("WindowsApps"));
    }
    if let Some(program_files) = std::env::var_os("ProgramW6432") {
        roots.push(PathBuf::from(program_files).join("WindowsApps"));
    }
    roots.push(PathBuf::from(r"C:\Program Files\WindowsApps"));
    roots.sort();
    roots.dedup();
    roots
}

/// 这一段从 Codex MSIX 包名提取版本号。
/// Extract version parts from a Codex MSIX package name.
#[cfg(windows)]
fn codex_package_version_parts(name: &str) -> Option<Vec<u32>> {
    // 这一段同时接受正式版和 Beta 包名。
    // Accept both stable and beta package names.
    let lower = name.to_ascii_lowercase();
    let prefix_len = if lower.starts_with("openai.codex_") {
        "openai.codex_".len()
    } else if lower.starts_with("openai.codexbeta_") {
        "openai.codexbeta_".len()
    } else {
        return None;
    };
    let version = name.get(prefix_len..)?.split('_').next()?;
    let parts = version
        .split('.')
        .map(|part| part.parse::<u32>().ok())
        .collect::<Option<Vec<_>>>()?;
    (!parts.is_empty()).then_some(parts)
}

/// 这一段生成 Codex CDP 启动参数。
/// Build Codex CDP launch arguments.
pub fn codex_launch_args(debug_port: u16) -> Vec<String> {
    // 这一段和 Node 版保持完全一致。
    // Keep arguments aligned with the Node launcher.
    vec![
        format!("--remote-debugging-port={debug_port}"),
        format!("--remote-allow-origins=http://127.0.0.1:{debug_port}"),
    ]
}

/// 这一段启动官方 Codex。
/// Launch official Codex.
pub async fn launch_codex(target: &LaunchTarget, debug_port: u16) -> anyhow::Result<LaunchResult> {
    // 这一段优先通过 MSIX 激活，兼容 WindowsApps 路径不可见场景。
    // Prefer MSIX activation to handle inaccessible WindowsApps paths.
    let fallback_executable = if target.executable.trim().is_empty() {
        String::new()
    } else {
        target.executable.clone()
    };
    let mut packaged_activation_error = None::<String>;
    if cfg!(windows) && !target.app_user_model_id.is_empty() {
        let arguments = command_line_arguments(&codex_launch_args(debug_port));
        match crate::windows_shell::activate_packaged_app(&target.app_user_model_id, &arguments)
            .await
        {
            Ok(pid) => {
                if crate::cdp::wait_for_target(debug_port, PACKAGED_CDP_READY_TIMEOUT_MS)
                    .await
                    .is_ok()
                {
                    return Ok(LaunchResult {
                        method: "packaged-activation".to_string(),
                        pid: Some(pid),
                        cdp_ready: true,
                    });
                }

                // 这一段不再终止刚激活的官方 Codex；CDP 可能只是启动较慢，交给后续注入等待完整超时。
                // Do not terminate the activated Codex; CDP may simply be slow, so let injection use its full timeout.
                return Ok(LaunchResult {
                    method: "packaged-activation-pending-cdp".to_string(),
                    pid: Some(pid),
                    cdp_ready: false,
                });
            }
            Err(error) if fallback_executable.is_empty() => {
                return Err(error).context("MSIX packaged activation failed");
            }
            Err(error) => packaged_activation_error = Some(error.to_string()),
        }
    }

    // 这一段直接启动可见 exe，作为显式路径和非 Windows 兜底。
    // Directly spawn the executable as explicit-path and non-Windows fallback.
    if fallback_executable.is_empty() {
        bail!("Codex executable path is empty and packaged activation failed");
    }
    if should_refuse_direct_windowsapps_launch(&fallback_executable) {
        let activation_detail = packaged_activation_error
            .map(|error| format!(" MSIX activation error: {error}"))
            .unwrap_or_default();
        bail!(
            "Refusing direct WindowsApps Codex.exe launch; use MSIX activation instead.{activation_detail}"
        );
    }
    let mut command = Command::new(&fallback_executable);
    command.args(codex_launch_args(debug_port));
    command.stdout(std::process::Stdio::null());
    command.stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        command.creation_flags(crate::process::CREATE_NO_WINDOW);
    }
    let child = command
        .spawn()
        .with_context(|| format!("failed to launch {fallback_executable}"))?;
    Ok(LaunchResult {
        method: "spawn".to_string(),
        pid: child.id(),
        cdp_ready: false,
    })
}

/// 这一段判断是否应该拒绝直接启动 WindowsApps 内的官方 Codex。
/// Decide whether direct launching the official Codex inside WindowsApps should be refused.
fn should_refuse_direct_windowsapps_launch(executable: &str) -> bool {
    // 这一段避免对 MSIX 包内 exe 走 direct spawn 或 UAC；冷启动必须使用 AUMID/MSIX 激活。
    // Avoid direct spawn or UAC for MSIX package executables; cold start must use AUMID/MSIX activation.
    cfg!(windows) && crate::process::is_windowsapps_codex_executable(Path::new(executable))
}

/// 这一段按 Windows 命令行规则拼接参数。
/// Join arguments using Windows command-line escaping rules.
pub fn command_line_arguments(args: &[String]) -> String {
    // 这一段逐个参数转义，避免空格和引号被 Shell 误拆。
    // Escape each argument so spaces and quotes are not split by Shell.
    args.iter()
        .map(|arg| quote_windows_argument(arg))
        .collect::<Vec<_>>()
        .join(" ")
}

/// 这一段转义单个 Windows 参数。
/// Escape one Windows command-line argument.
pub fn quote_windows_argument(arg: &str) -> String {
    // 这一段无特殊字符时直接返回，减少日志和测试噪声。
    // Return simple arguments unchanged.
    if !arg.is_empty() && !arg.bytes().any(|byte| matches!(byte, b' ' | b'\t' | b'"')) {
        return arg.to_string();
    }
    let mut output = String::from("\"");
    let mut backslashes = 0;
    for ch in arg.chars() {
        match ch {
            '\\' => backslashes += 1,
            '"' => {
                output.push_str(&"\\".repeat(backslashes * 2 + 1));
                output.push('"');
                backslashes = 0;
            }
            _ => {
                output.push_str(&"\\".repeat(backslashes));
                output.push(ch);
                backslashes = 0;
            }
        }
    }
    output.push_str(&"\\".repeat(backslashes * 2));
    output.push('"');
    output
}

/// 这一段返回默认调试端口，供测试和报告使用。
/// Return the default debug port for tests and reports.
pub fn default_debug_port() -> u16 {
    DEFAULT_DEBUG_PORT
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_user_model_id_is_derived_from_msix_path() {
        let id = app_user_model_id_from_executable(
            r"C:\Program Files\WindowsApps\OpenAI.Codex_1.2.3.0_x64__2p2nqsd0c76g0\app\Codex.exe",
        );
        assert_eq!(id, "OpenAI.Codex_2p2nqsd0c76g0!App");
    }

    #[test]
    fn app_user_model_id_is_derived_from_beta_msix_path() {
        let id = app_user_model_id_from_executable(
            r"C:\Program Files\WindowsApps\OpenAI.CodexBeta_1.2.3.0_x64__2p2nqsd0c76g0\app\Codex.exe",
        );
        assert_eq!(id, "OpenAI.CodexBeta_2p2nqsd0c76g0!App");
    }

    #[test]
    fn quote_windows_argument_handles_spaces_and_quotes() {
        assert_eq!(quote_windows_argument("abc"), "abc");
        assert_eq!(quote_windows_argument("a b"), "\"a b\"");
        assert!(quote_windows_argument("a\"b").contains("\\\""));
    }

    #[test]
    fn direct_windowsapps_launch_is_refused_on_windows() {
        let executable =
            r"C:\Program Files\WindowsApps\OpenAI.Codex_1.2.3.0_x64__2p2nqsd0c76g0\app\Codex.exe";
        #[cfg(windows)]
        assert!(should_refuse_direct_windowsapps_launch(executable));
        #[cfg(not(windows))]
        assert!(!should_refuse_direct_windowsapps_launch(executable));
    }

    #[test]
    fn direct_non_windowsapps_launch_is_allowed() {
        assert!(!should_refuse_direct_windowsapps_launch(
            r"C:\Tools\Codex\app\Codex.exe"
        ));
    }
}
