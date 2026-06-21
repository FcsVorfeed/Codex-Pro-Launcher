use crate::args::LauncherOptions;
use crate::codex_app::{LaunchTarget, codex_launch_args};
use crate::injection_manifest::build_injection_module_paths;
use crate::local_config::{has_embedded_release_config, load_local_config};
use crate::paths::logs_dir;
use crate::ports::DebugPortSelection;
use anyhow::Context;
use serde_json::{Value, json};
use std::path::PathBuf;
use tokio::io::AsyncWriteExt;

/// 这一段返回 Rust launcher 日志路径。
/// Return the Rust launcher log path.
pub fn launcher_log_path() -> anyhow::Result<PathBuf> {
    // 这一段集中创建日志目录。
    // Create the log directory centrally.
    let dir = logs_dir();
    std::fs::create_dir_all(&dir).context("failed to create Codex-Pro log directory")?;
    Ok(dir.join("portable-launcher.log"))
}

/// 这一段追加一行诊断日志。
/// Append one diagnostic log line.
pub async fn append_log_line(path: &PathBuf, line: &str) -> anyhow::Result<()> {
    // 这一段只写入调用方提供的脱敏消息。
    // Write only caller-provided sanitized messages.
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let mut file = tokio::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .await?;
    file.write_all(format!("{line}\n").as_bytes()).await?;
    Ok(())
}

/// 这一段生成 dry-run JSON 报告。
/// Build the dry-run JSON report.
pub fn dry_run_report(
    target: &LaunchTarget,
    options: &LauncherOptions,
    debug_port_selection: &DebugPortSelection,
) -> Value {
    // 这一段只输出配置是否存在，不输出任何真实服务地址。
    // Report only whether config fields exist, never the real service URLs.
    let source_root = if options.dev_runtime && !options.source_root.trim().is_empty() {
        Some(PathBuf::from(options.source_root.trim()))
    } else {
        None
    };
    let local_config = load_local_config(source_root.as_deref());
    // 这一段字段名对齐 Node doctor 的输出，方便迁移对照。
    // Align field names with the Node doctor output for comparison.
    json!({
        "executable": target.executable,
        "args": codex_launch_args(options.debug_port),
        "appUserModelId": target.app_user_model_id,
        "debugPort": options.debug_port,
        "debugPortSelectionReason": debug_port_selection.reason,
        "disabledSystems": options.disabled_systems,
        "devRuntime": options.dev_runtime,
        "injectionModules": build_injection_module_paths(&options.disabled_systems),
        "localConfig": {
            "embeddedReleaseConfig": has_embedded_release_config(),
            "sync": {
                "cloudSyncEndpoint": !local_config.sync.cloud_sync_endpoint.trim().is_empty(),
                "petSyncEndpoint": !local_config.sync.pet_sync_endpoint.trim().is_empty(),
                "conversationArchiveEndpoint": !local_config.sync.conversation_archive_endpoint.trim().is_empty(),
                "keyAcquisitionUrl": !local_config.sync.key_acquisition_url.trim().is_empty(),
            },
            "license": {
                "apiBase": !local_config.license.api_base.trim().is_empty(),
                "apiKey": !local_config.license.api_key.trim().is_empty(),
                "productSlug": !local_config.license.product_slug.trim().is_empty(),
            },
        },
        "nativeBridge": options.native_bridge,
        "nativeBridgeMode": if options.native_bridge {
            if options.dev_runtime { "rust-dev-background-worker" } else { "rust-background-worker" }
        } else {
            "disabled"
        },
        "requestedDebugPort": debug_port_selection.requested_port,
        "sourceRoot": if options.dev_runtime { json!(options.source_root) } else { Value::Null },
    })
}
