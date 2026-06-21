#![cfg_attr(windows, windows_subsystem = "windows")]

use anyhow::{Context, Result, bail};
use codex_pro_bridge::{
    NATIVE_BRIDGE_PROTOCOL_VERSION, create_native_bridge_config,
    run_native_bridge_worker_from_payload,
    state::{NativeBridgeState, heartbeat_is_fresh},
};
use codex_pro_core::args::{LauncherOptions, parse_args};
use codex_pro_core::codex_app::{launch_codex, resolve_launch_target};
use codex_pro_core::diagnostics::{append_log_line, launcher_log_path};
use codex_pro_core::injection::inject;
use codex_pro_core::native_bridge::NativeBridgeConfig;
use codex_pro_core::ports::{DebugPortSelection, select_debug_port, try_acquire_launcher_guard};
use std::path::PathBuf;

/// 这一段定义 native bridge 状态作为端口线索的有效窗口。
/// Defines the freshness window for native bridge state used as a port hint.
const NATIVE_BRIDGE_PORT_HINT_MAX_AGE_MS: u128 = 12_000;
/// 这一段定义已确认 CDP 可用后再次等待注入目标的短超时。
/// Defines the short injection wait after CDP availability was already confirmed.
const CONFIRMED_CDP_INJECTION_TIMEOUT_MS: u64 = 5_000;

/// 这一段描述已有 Codex 激活或启动后的下一步动作。
/// Describes the next action after activating or launching an existing Codex.
#[derive(Clone, Copy, Debug, Default)]
struct ActivationOutcome {
    /// 这一段表示普通 launcher 是否应该跳过本轮注入。
    /// Whether the normal launcher should skip injection for this run.
    skip_injection: bool,
    /// 这一段表示前置步骤已经确认 CDP 主页面存在。
    /// Whether a previous step already confirmed the main CDP page exists.
    cdp_ready: bool,
}

/// 这一段是 Rust 单文件启动器入口。
/// This is the Rust single-file launcher entrypoint.
#[tokio::main]
async fn main() -> Result<()> {
    // 这一段把 GUI 子系统下不可见的顶层错误写进 launcher 日志。
    // Write otherwise invisible top-level errors to the launcher log in GUI-subsystem mode.
    let raw_args = std::env::args().skip(1).collect::<Vec<_>>();
    if let Err(error) = run_launcher(raw_args.clone()).await {
        log_launcher_error(&error, should_show_launcher_error_dialog(&raw_args)).await;
        return Err(error);
    }
    Ok(())
}

/// 这一段运行 launcher 主流程。
/// Run the launcher main flow.
async fn run_launcher(raw_args: Vec<String>) -> Result<()> {
    let mut options = parse_args(raw_args);
    let source_root = development_source_root(&options);

    // 这一段处理外部 Diff 前台激活辅助模式，避免 helper 继续进入注入或 worker 流程。
    // Handle external-diff foreground helper mode before entering injection or worker flows.
    if let Some(focus) = options.external_diff_focus.as_ref() {
        codex_pro_core::windows_shell::focus_external_diff_window(
            focus.process_id,
            &focus.tool_path,
        )
        .await?;
        return Ok(());
    }

    // 这一段处理后台 bridge worker 模式，保持主启动路径和 worker 路径复用同一个 exe。
    // Handle bridge worker mode so the foreground launcher and worker reuse the same executable.
    if let Some(payload) = options.native_bridge_worker_payload.as_deref() {
        return run_native_bridge_worker_from_payload_on_dedicated_thread(payload.to_string());
    }

    // 这一段处理构建后自检，不启动 Codex，只验证嵌入注入清单可生成。
    // Handle post-build self-test without launching Codex.
    if options.rust_self_test {
        let script = codex_pro_core::injection::read_injection_script(
            &options.disabled_systems,
            None,
            source_root.as_deref(),
        )?;
        println!(
            "{}",
            serde_json::json!({
                "ok": true,
                "injectionScriptBytes": script.len(),
                "disabledSystems": options.disabled_systems,
            })
        );
        return Ok(());
    }

    // 这一段 dry-run 对齐当前 npm doctor：只解析路径、参数、注入模块和 native bridge 模式。
    // Align dry-run with the current npm doctor command.
    if options.dry_run {
        let target = resolve_launch_target(&options.app_path, &options.app_user_model_id)?;
        let debug_port_selection = select_debug_port(options.debug_port).await?;
        options.debug_port = debug_port_selection.effective_port;
        println!(
            "{}",
            serde_json::to_string_pretty(&codex_pro_core::diagnostics::dry_run_report(
                &target,
                &options,
                &debug_port_selection,
            ))?
        );
        return Ok(());
    }

    // 这一段避免连续双击时多个 launcher 同时启动和注入。
    // Prevent multiple launchers from starting and injecting concurrently on double-clicks.
    let _launcher_guard = if !options.attach_only {
        match try_acquire_launcher_guard()
            .context("获取 launcher 单实例 guard 失败 / failed to acquire launcher guard")?
        {
            Some(guard) => Some(guard),
            None => {
                activate_or_launch_existing_codex(&mut options, false).await?;
                return Ok(());
            }
        }
    } else {
        None
    };

    // 这一段非 attach-only 时先复用并置前已运行 Codex；运行态可复用时普通双击不再重复注入。
    // Reuse and foreground an existing Codex first; skip reinjection on normal double-clicks when the runtime is reusable.
    let mut activation = ActivationOutcome::default();
    if !options.attach_only {
        activation = activate_or_launch_existing_codex(&mut options, true).await?;
        if activation.skip_injection {
            append_log_line(
                &launcher_log_path()?,
                "RustLaunch: existing Codex-Pro runtime is reusable; skip normal launcher injection",
            )
            .await?;
            return Ok(());
        }
    }

    // 这一段 attach-only 不负责冷启动，只在默认端口不可用时跟随已有 bridge 端口再注入。
    // Attach-only does not cold-launch; when the default port is unavailable, follow the existing bridge port before injection.
    if options.attach_only {
        align_attach_only_debug_port(&mut options).await?;
    }

    // 这一段创建 bridge 配置并注入页面；bridge 关闭时仍允许页面基础 UI 正常运行。
    // Create the bridge config and inject the page scripts.
    let bridge_config: Option<NativeBridgeConfig> = if options.native_bridge {
        Some(create_native_bridge_config())
    } else {
        None
    };
    let injection_timeout_ms = if activation.cdp_ready {
        options.timeout_ms.min(CONFIRMED_CDP_INJECTION_TIMEOUT_MS)
    } else {
        options.timeout_ms
    };
    let injected = inject(
        options.debug_port,
        injection_timeout_ms,
        &options.disabled_systems,
        bridge_config.as_ref(),
        source_root.as_deref(),
    )
    .await?;
    println!(
        "Injected Codex-Pro modules into target: {}",
        injected.target_title_or_url()
    );

    // 这一段启动隐藏后台 bridge worker，让前台启动器可以退出。
    // Start the hidden bridge worker so the foreground launcher can exit.
    if let Some(config) = bridge_config {
        let worker = codex_pro_bridge::start_or_reuse_native_bridge_worker(
            options.debug_port,
            options.timeout_ms,
            config,
            options.dev_runtime,
            source_root.as_deref(),
        )
        .await?;
        println!("Native bridge ready pid={}", worker.pid.unwrap_or_default());
    }

    Ok(())
}

/// 这一段记录 CDP 调试端口选择结果。
/// Log the CDP debug port selection result.
async fn log_debug_port_selection(selection: &DebugPortSelection) -> anyhow::Result<()> {
    // 这一段只写入端口和原因，不包含用户路径或敏感数据。
    // Write only ports and reason, without user paths or sensitive data.
    append_log_line(
        &launcher_log_path()?,
        &format!(
            "RustLaunch: debug port requested={} effective={} reason={}",
            selection.requested_port, selection.effective_port, selection.reason
        ),
    )
    .await
}

/// 这一段判断当前错误是否应该显示给前台用户。
/// Decide whether this error should be shown to the foreground user.
fn should_show_launcher_error_dialog(raw_args: &[String]) -> bool {
    should_show_launcher_error_dialog_for_context(raw_args, is_scripted_launcher_invocation())
}

/// 这一段判断当前进程是否来自开发脚本或 cargo run。
/// Decide whether the current process came from development scripts or cargo run.
fn is_scripted_launcher_invocation() -> bool {
    // 这一段覆盖 npm 脚本和 cargo run，避免开发命令像真实双击一样弹窗。
    // Cover npm scripts and cargo run so developer commands do not behave like true double-click launches.
    std::env::var_os("npm_lifecycle_event").is_some() || std::env::var_os("CARGO").is_some()
}

/// 这一段按已知调用上下文判断是否显示错误弹窗，便于测试覆盖。
/// Decide whether to show an error dialog from a known invocation context for tests.
fn should_show_launcher_error_dialog_for_context(raw_args: &[String], scripted: bool) -> bool {
    // 这一段只给真实双击入口弹窗；脚本和 helper 参数调用只返回退出码并写日志。
    // Show dialogs only for true double-click launches; scripted and helper invocations return exit codes and logs.
    raw_args.is_empty() && !scripted
}

/// 这一段记录 launcher 顶层错误，避免 Windows GUI exe 失败时无诊断信息。
/// Record top-level launcher errors so Windows GUI exe failures still leave diagnostics.
async fn log_launcher_error(error: &anyhow::Error, show_dialog: bool) {
    // 这一段日志失败时不再继续抛错，避免覆盖原始退出码。
    // Ignore logging failures so the original exit status is preserved.
    if let Ok(path) = launcher_log_path() {
        let _ = append_log_line(&path, &format!("RustLauncherError: {error:#}")).await;
        if show_dialog {
            codex_pro_core::windows_shell::show_error_message_box(
                "Codex-Pro Launcher",
                &format!(
                    "启动 Codex-Pro 失败 / Failed to start Codex-Pro.\n\n日志 / Log:\n{}\n\n错误 / Error:\n{error:#}",
                    path.display()
                ),
            );
        }
    }
}

/// 这一段在较大栈的专用线程里运行 worker，避免 GUI 主线程栈过小导致启动即退。
/// Run the worker on a dedicated larger-stack thread so the GUI main thread stack cannot overflow at startup.
fn run_native_bridge_worker_from_payload_on_dedicated_thread(payload: String) -> Result<()> {
    // 这一段只影响 worker 模式；前台 launcher 仍沿用同一个 exe 和同一套参数解析。
    // Affect only worker mode; the foreground launcher still uses the same exe and argument parsing.
    let handle = std::thread::Builder::new()
        .name("codex-pro-native-bridge-worker".to_string())
        .stack_size(16 * 1024 * 1024)
        .spawn(move || -> Result<()> {
            // 这一段在线程内创建独立 Tokio runtime，避免嵌套使用外层 main runtime。
            // Create an isolated Tokio runtime inside the thread instead of nesting the outer main runtime.
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .context("failed to build native bridge worker runtime")?;
            runtime.block_on(run_native_bridge_worker_from_payload(&payload))
        })
        .context("failed to start native bridge worker thread")?;

    // 这一段把 worker 线程的错误传回进程退出码，保持注入脚本能识别失败。
    // Propagate worker-thread errors to the process exit code so the inject script can detect failures.
    match handle.join() {
        Ok(result) => result,
        Err(_) => bail!("native bridge worker thread panicked"),
    }
}

/// 这一段复用现有 Codex；如果 CDP 不可用则继续启动带调试端口的 Codex。
/// Reuse an existing Codex window; if CDP is unavailable, continue by launching Codex with the debug port.
async fn activate_or_launch_existing_codex(
    options: &mut LauncherOptions,
    allow_launch: bool,
) -> Result<ActivationOutcome> {
    // 这一段解析启动目标，优先拿到真实 Codex.exe 路径供 direct fallback 使用。
    // Resolve the launch target, preferring a real Codex.exe path for direct fallback.
    let target = resolve_launch_target(&options.app_path, &options.app_user_model_id)?;
    let log_path = launcher_log_path()?;

    // 这一段先尝试复用并置前已有 Codex 主窗口。
    // Try to reuse and foreground an existing Codex main window first.
    let reuse = codex_pro_core::windows_shell::try_reuse_running_codex(&target.app_user_model_id)
        .await
        .context("复用 Codex 窗口失败 / failed to reuse Codex window")?;
    for line in &reuse.diagnostics {
        append_log_line(&log_path, line).await?;
    }

    // 这一段第二个 launcher 进程只负责快速置前，不再等待 CDP 探测。
    // A secondary launcher only foregrounds quickly and does not wait for CDP probing.
    if reuse.handled {
        if !allow_launch {
            append_log_line(
                &log_path,
                &format!(
                    "RustLaunch: launcher guard busy; reused method={} focused={} skip cdp probe",
                    reuse.method, reuse.focused
                ),
            )
            .await?;
            return Ok(ActivationOutcome::default());
        }

        // 这一段先按请求端口保守探测，保持普通前台激活仍由 CDP/runtime 决定。
        // Probe the requested port first so normal foreground activation remains CDP/runtime-gated.
        let requested_debug_port = options.debug_port;
        if let Some(outcome) = probe_reused_runtime_port(
            options,
            &log_path,
            requested_debug_port,
            &format!("reused method={} focused={}", reuse.method, reuse.focused),
        )
        .await?
        {
            return Ok(outcome);
        }

        // 这一段只在请求端口没有 CDP target 时，把新鲜状态文件作为候选端口线索再探测。
        // Only when the requested port has no CDP target, use fresh state files as candidate port hints and probe again.
        if let Some(port_hint) = find_fresh_native_bridge_debug_port_hint().await?
            && port_hint != options.debug_port
            && let Some(outcome) = probe_reused_runtime_port(
                options,
                &log_path,
                port_hint,
                &format!(
                    "reused method={} focused={} portHint=state-file",
                    reuse.method, reuse.focused
                ),
            )
            .await?
        {
            return Ok(outcome);
        }
        append_log_line(
            &log_path,
            "RustLaunch: reused Codex has no CDP target; require full Codex exit before cold launch",
        )
        .await?;
        bail!(
            "检测到官方 Codex 已在运行，但没有可注入的 CDP 调试端口。请先完全退出官方 Codex，再双击 Codex-Pro-Launcher.exe。 / Official Codex is already running without an injectable CDP debugging port. Fully exit Codex first, then double-click Codex-Pro-Launcher.exe."
        );
    }

    // 这一段在第二个 launcher 实例中禁止启动新 Codex，避免单实例 guard 失去意义。
    // Prevent a secondary launcher instance from starting a new Codex so the guard remains meaningful.
    if !allow_launch {
        append_log_line(
            &log_path,
            "RustLaunch: launcher guard busy; skip cold launch from secondary instance",
        )
        .await?;
        return Ok(ActivationOutcome::default());
    }

    // 这一段只在确实需要启动 Codex 时选择最终调试端口，避免普通前台激活变慢。
    // Select the final debug port only when Codex must be launched so normal foreground activation stays fast.
    let debug_port_selection = select_debug_port(options.debug_port).await?;
    options.debug_port = debug_port_selection.effective_port;
    log_debug_port_selection(&debug_port_selection).await?;
    if debug_port_selection.reason == "existing-codex-cdp" {
        append_log_line(
            &log_path,
            "RustLaunch: selected existing Codex CDP; skip cold launch",
        )
        .await?;
        return Ok(ActivationOutcome {
            skip_injection: false,
            cdp_ready: true,
        });
    }

    // 这一段启动官方 Codex，并让 codex_app 负责 MSIX 激活和安全启动兜底。
    // Launch official Codex and let codex_app handle MSIX activation and safe launch fallbacks.
    let started = match launch_codex(&target, options.debug_port).await {
        Ok(started) => started,
        Err(error) => {
            append_log_line(&log_path, &format!("RustLaunchFailed: {error:#}")).await?;
            return Err(error).context("启动 Codex 失败 / failed to launch Codex");
        }
    };
    append_log_line(&log_path, &format!("RustLaunch: {started:?}")).await?;
    Ok(ActivationOutcome {
        skip_injection: false,
        cdp_ready: started.cdp_ready,
    })
}

/// 这一段为 attach-only 跟随已有 native bridge 端口。
/// Follow an existing native bridge port for attach-only injection.
async fn align_attach_only_debug_port(options: &mut LauncherOptions) -> Result<()> {
    // 这一段如果请求端口已有 Codex CDP，保持显式参数优先。
    // Keep the explicit port when it already exposes an injectable Codex CDP target.
    if codex_pro_core::cdp::has_injectable_target(options.debug_port).await {
        return Ok(());
    }

    // 这一段只把状态文件当端口线索，最终仍必须通过 CDP target 验证。
    // Treat state files only as port hints; the final decision still requires CDP target verification.
    let Some(port_hint) = find_fresh_native_bridge_debug_port_hint().await? else {
        return Ok(());
    };
    if port_hint == options.debug_port {
        return Ok(());
    }

    let cdp_ready = codex_pro_core::cdp::has_injectable_target(port_hint).await;
    append_log_line(
        &launcher_log_path()?,
        &format!(
            "RustLaunch: attach-only port hint requested={} hinted={} cdpReady={}",
            options.debug_port, port_hint, cdp_ready
        ),
    )
    .await?;
    if cdp_ready {
        options.debug_port = port_hint;
    }
    Ok(())
}

/// 这一段探测复用窗口上的指定 CDP 端口。
/// Probe a specific CDP port on a reused window.
async fn probe_reused_runtime_port(
    options: &mut LauncherOptions,
    log_path: &PathBuf,
    debug_port: u16,
    context: &str,
) -> Result<Option<ActivationOutcome>> {
    // 这一段只有 CDP 已可注入时才把该端口用于后续流程。
    // Use this port for subsequent work only when CDP is injectable.
    let cdp_ready = codex_pro_core::cdp::has_injectable_target(debug_port).await;
    append_log_line(
        log_path,
        &format!("{context} port={} cdpReady={}", debug_port, cdp_ready),
    )
    .await?;
    if !cdp_ready {
        return Ok(None);
    }
    options.debug_port = debug_port;

    // 这一段继续探测页面 runtime，避免仅凭端口或心跳跳过必要注入。
    // Continue probing the page runtime so neither the port nor heartbeat alone can skip required injection.
    let runtime = codex_pro_core::injection::probe_existing_runtime(
        debug_port,
        expected_native_bridge_protocol(options),
    )
    .await;
    match runtime {
        Ok(probe) => {
            append_log_line(
                log_path,
                &format!(
                    "RustLaunch: existing runtime usable={} reason={} target={}",
                    probe.usable,
                    probe.reason,
                    probe.target_title_or_url()
                ),
            )
            .await?;
            if probe.usable {
                return Ok(Some(ActivationOutcome {
                    skip_injection: true,
                    cdp_ready: true,
                }));
            }
        }
        Err(error) => {
            append_log_line(
                log_path,
                &format!("RustLaunch: existing runtime probe failed: {error:#}"),
            )
            .await?;
        }
    }
    Ok(Some(ActivationOutcome {
        skip_injection: false,
        cdp_ready: true,
    }))
}

/// 这一段扫描 native bridge 状态文件并返回最新鲜的调试端口线索。
/// Scan native bridge state files and return the freshest debug port hint.
async fn find_fresh_native_bridge_debug_port_hint() -> Result<Option<u16>> {
    // 这一段无法读取状态目录时按没有线索处理，避免影响前台激活。
    // Treat an unreadable state directory as no hint so foreground activation is not blocked.
    let data_root = codex_pro_core::paths::codex_pro_data_root_dir();
    let mut entries = match tokio::fs::read_dir(data_root).await {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error).context("failed to read native bridge state directory"),
    };
    let mut best: Option<(u16, u128)> = None;

    // 这一段逐个解析状态文件，只保留协议匹配且心跳新鲜的 Rust bridge。
    // Parse state files one by one and keep only fresh Rust bridge states with a matching protocol.
    while let Some(entry) = entries.next_entry().await? {
        let Some(file_name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        let Some(debug_port) = native_bridge_debug_port_from_file_name(&file_name) else {
            continue;
        };
        let Ok(text) = tokio::fs::read_to_string(entry.path()).await else {
            continue;
        };
        let Ok(state) = serde_json::from_str::<NativeBridgeState>(&text) else {
            continue;
        };
        if state.debug_port != debug_port
            || state.native_bridge.protocol_version != NATIVE_BRIDGE_PROTOCOL_VERSION
            || !heartbeat_is_fresh(&state, NATIVE_BRIDGE_PORT_HINT_MAX_AGE_MS)
        {
            continue;
        }
        let heartbeat = state
            .worker_heartbeat_at
            .parse::<u128>()
            .unwrap_or_default();
        if best
            .as_ref()
            .is_none_or(|(_, best_heartbeat)| heartbeat > *best_heartbeat)
        {
            best = Some((debug_port, heartbeat));
        }
    }
    Ok(best.map(|(debug_port, _)| debug_port))
}

/// 这一段从 native bridge 状态文件名解析调试端口。
/// Parse a debug port from a native bridge state file name.
fn native_bridge_debug_port_from_file_name(file_name: &str) -> Option<u16> {
    // 这一段只接受固定文件名前后缀，避免把其它文件误当状态。
    // Accept only the fixed file-name prefix and suffix so unrelated files are ignored.
    let port_text = file_name
        .strip_prefix("native-bridge-")?
        .strip_suffix(".json")?;
    port_text.parse::<u16>().ok().filter(|port| *port != 0)
}

/// 这一段返回当前页面需要匹配的 native bridge 协议版本。
/// Return the native bridge protocol version required by the current page.
fn expected_native_bridge_protocol(options: &LauncherOptions) -> Option<u32> {
    // 这一段仅在 native bridge 启用时要求页面协议匹配；禁用 bridge 时只验证基础 runtime。
    // Require page protocol matching only when native bridge is enabled; bridge-disabled runs validate only the base runtime.
    options
        .native_bridge
        .then_some(NATIVE_BRIDGE_PROTOCOL_VERSION)
}

/// 这一段解析开发模式下的源码根。
/// Resolve the source root used by development-mode injection.
fn development_source_root(options: &LauncherOptions) -> Option<PathBuf> {
    // 这一段只影响显式 dev runtime，发布和普通 Rust 注入继续使用嵌入资产。
    // Affect only explicit dev runtime; release and normal Rust injection keep embedded assets.
    if !options.dev_runtime {
        return None;
    }
    let source_root = options.source_root.trim();
    Some(if source_root.is_empty() {
        PathBuf::from(".")
    } else {
        PathBuf::from(source_root)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn foreground_launcher_errors_show_dialog() {
        assert!(should_show_launcher_error_dialog_for_context(&[], false));
    }

    #[test]
    fn scripted_worker_and_helper_errors_do_not_show_dialog() {
        assert!(!should_show_launcher_error_dialog_for_context(&[], true));
        assert!(!should_show_launcher_error_dialog_for_context(
            &[
                "--native-bridge".to_string(),
                "--debug-port".to_string(),
                "9229".to_string(),
            ],
            false
        ));
        assert!(!should_show_launcher_error_dialog_for_context(
            &["--native-bridge-worker".to_string(), "{}".to_string(),],
            false
        ));
        assert!(!should_show_launcher_error_dialog_for_context(
            &["--attach-only".to_string(), "--native-bridge".to_string(),],
            false
        ));
        assert!(!should_show_launcher_error_dialog_for_context(
            &["--focus-external-diff".to_string(), "123".to_string(),],
            false
        ));
        assert!(!should_show_launcher_error_dialog_for_context(
            &["--dry-run".to_string()],
            false
        ));
        assert!(!should_show_launcher_error_dialog_for_context(
            &["--rust-self-test".to_string()],
            false
        ));
    }
}
