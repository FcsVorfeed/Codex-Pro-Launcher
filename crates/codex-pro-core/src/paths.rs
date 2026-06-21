use std::path::PathBuf;

/// 这一段定义默认 CDP 调试端口。
/// Default CDP debugging port.
pub const DEFAULT_DEBUG_PORT: u16 = 9229;
/// 这一段定义默认等待 Codex 页面超时。
/// Default timeout for waiting on the Codex page.
pub const DEFAULT_TIMEOUT_MS: u64 = 30_000;
/// 这一段定义默认 Windows MSIX AppUserModelId。
/// Default Windows MSIX AppUserModelId.
pub const DEFAULT_APP_USER_MODEL_ID: &str = "OpenAI.Codex_2p2nqsd0c76g0!App";
/// 这一段定义 Codex-Pro 数据目录名。
/// Codex-Pro data directory name.
pub const CODEX_PRO_DATA_DIR_NAME: &str = ".Codex-Pro-Launcher";

/// 这一段解析 Codex 用户目录，优先 CODEX_HOME。
/// Resolve Codex home, preferring CODEX_HOME.
pub fn codex_home_dir() -> PathBuf {
    // 这一段优先使用显式环境变量，方便 portable/测试场景隔离数据。
    // Prefer the explicit environment variable for portable and test isolation.
    let override_home = std::env::var("CODEX_HOME").unwrap_or_default();
    if !override_home.trim().is_empty() {
        return PathBuf::from(override_home.trim());
    }

    // 这一段回退到当前用户目录下的 .codex。
    // Fall back to the current user's .codex directory.
    std::env::var_os("USERPROFILE")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(PathBuf::from))
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".codex")
}

/// 这一段返回 Codex-Pro 统一运行期数据根。
/// Return the unified Codex-Pro runtime data root.
pub fn codex_pro_data_root_dir() -> PathBuf {
    codex_home_dir().join(CODEX_PRO_DATA_DIR_NAME)
}

/// 这一段返回日志目录。
/// Return the diagnostics log directory.
pub fn logs_dir() -> PathBuf {
    codex_pro_data_root_dir().join("logs")
}
