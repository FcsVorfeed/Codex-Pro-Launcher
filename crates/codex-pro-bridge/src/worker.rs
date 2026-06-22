use crate::router::{
    dispatch_native_bridge_request, handle_bridge_worker_event, parse_native_bridge_request,
};
use crate::state::{
    NativeBridgeState, clear_native_bridge_state, heartbeat_is_fresh, now_text,
    read_native_bridge_state, write_native_bridge_state,
};
use anyhow::{Context, bail};
use base64::Engine;
use codex_pro_core::cdp::{
    CdpClient, CdpTarget, is_auxiliary_codex_page_target, list_targets, wait_for_target,
};
use codex_pro_core::native_bridge::NativeBridgeConfig;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::fs::OpenOptions;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tokio::process::Command;

/// 这一段定义 worker 心跳新鲜度。
/// Worker heartbeat freshness window.
const WORKER_HEARTBEAT_MAX_AGE_MS: u128 = 12_000;
/// 这一段定义心跳间隔。
/// Heartbeat interval.
const WORKER_HEARTBEAT_INTERVAL_MS: u64 = 2_000;
/// 这一段定义 worker 重连间隔。
/// Worker reconnect interval.
const WORKER_RECONNECT_DELAY_MS: u64 = 1_000;
/// 这一段定义宠物浮窗补注入扫描间隔。
/// Pet overlay reinjection scan interval.
const PET_EVENT_SOUND_OVERLAY_SCAN_INTERVAL_MS: u64 = 1_500;
/// 这一段定义找不到 Codex target 时的退出窗口。
/// Exit window when no Codex target is available.
const WORKER_TARGET_MISSING_EXIT_MS: u128 = 120_000;
/// 这一段定义确认官方 Codex 进程全部退出所需的连续空结果次数。
/// Consecutive empty process-list results required before treating Codex as exited.
const WORKER_CODEX_EXIT_EMPTY_STREAK_REQUIRED: u32 = 3;
/// 这一段定义官方 Codex 进程退出确认的轮询间隔。
/// Polling interval for confirming that official Codex processes exited.
const WORKER_CODEX_EXIT_POLL_MS: u64 = 2_000;

/// 这一段描述 worker 启动 payload。
/// Describes the worker startup payload.
#[derive(Clone, Debug, Deserialize, Serialize)]
struct NativeBridgeWorkerPayload {
    /// 这一段是 CDP 调试端口。
    /// CDP debug port.
    #[serde(rename = "debugPort")]
    debug_port: u16,
    /// 这一段是开发模式源码根。
    /// Development source root.
    #[serde(rename = "sourceRoot", default)]
    source_root: String,
    /// 这一段是启动超时。
    /// Startup timeout.
    #[serde(rename = "timeoutMs")]
    timeout_ms: u64,
    /// 这一段是硬禁用系统列表。
    /// Hard-disabled systems.
    #[serde(rename = "disabledSystems", default)]
    disabled_systems: Vec<String>,
    /// 这一段是 bridge 配置。
    /// Bridge config.
    #[serde(rename = "nativeBridge")]
    native_bridge: NativeBridgeConfig,
}

/// 这一段描述 worker 就绪状态。
/// Describes worker readiness.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NativeBridgeWorkerStatus {
    /// 这一段是 worker pid。
    /// Worker pid.
    pub pid: Option<u32>,
}

/// 这一段规整硬禁用系统列表。
/// Normalize hard-disabled system names.
fn normalize_disabled_systems(disabled_systems: &[String]) -> Vec<String> {
    // 这一段去空白、转小写、排序去重，避免同一配置因为顺序不同导致 worker 误复用或误重启。
    // Trim, lowercase, sort, and dedupe so equivalent configurations reuse or restart consistently.
    let mut normalized = disabled_systems
        .iter()
        .map(|system| system.trim().to_ascii_lowercase())
        .filter(|system| !system.is_empty())
        .collect::<Vec<_>>();
    normalized.sort();
    normalized.dedup();
    normalized
}

/// 这一段启动或复用 native bridge worker。
/// Start or reuse a native bridge worker.
pub async fn start_or_reuse_native_bridge_worker(
    debug_port: u16,
    timeout_ms: u64,
    native_bridge: NativeBridgeConfig,
    disabled_systems: &[String],
    dev_runtime: bool,
    source_root: Option<&Path>,
) -> anyhow::Result<NativeBridgeWorkerStatus> {
    // 这一段规整硬禁用系统，确保复用判断和 worker payload 使用同一份稳定配置。
    // Normalize hard-disabled systems so reuse checks and worker payloads share one stable configuration.
    let normalized_disabled_systems = normalize_disabled_systems(disabled_systems);

    // 这一段发布模式复用仍然新鲜的同协议 worker；开发模式必须重启，避免实时注入仍跑旧 Rust exe。
    // Reuse a still-fresh same-protocol worker only in release mode; dev mode must restart so live injection does not keep an old Rust exe.
    if let Some(state) = read_native_bridge_state(debug_port).await {
        if !dev_runtime
            && state.native_bridge == native_bridge
            && state.disabled_systems == normalized_disabled_systems
            && heartbeat_is_fresh(&state, WORKER_HEARTBEAT_MAX_AGE_MS)
            && codex_pro_core::process::is_process_alive(state.pid)
        {
            return Ok(NativeBridgeWorkerStatus {
                pid: Some(state.pid),
            });
        }
        clear_native_bridge_state(debug_port, &state.native_bridge.bridge_id).await;
    }

    // 这一段启动同一个 exe 的 worker 模式。
    // Start this same executable in worker mode.
    let payload = encode_worker_payload(&NativeBridgeWorkerPayload {
        debug_port,
        source_root: source_root
            .map(|path| path.to_string_lossy().to_string())
            .unwrap_or_default(),
        timeout_ms,
        disabled_systems: normalized_disabled_systems.clone(),
        native_bridge: native_bridge.clone(),
    })?;
    let pid = spawn_worker_process(&payload, &native_bridge, dev_runtime, source_root).await?;
    write_native_bridge_state(&NativeBridgeState {
        debug_port,
        native_bridge: native_bridge.clone(),
        disabled_systems: normalized_disabled_systems,
        pid,
        started_at: now_text(),
        worker_heartbeat_at: String::new(),
    })
    .await?;

    // 这一段等待 worker 写入首个心跳。
    // Wait for the worker's first heartbeat.
    let deadline =
        std::time::Instant::now() + Duration::from_millis(timeout_ms.clamp(1_000, 8_000));
    while std::time::Instant::now() <= deadline {
        if let Some(state) = read_native_bridge_state(debug_port).await
            && state.native_bridge.bridge_id == native_bridge.bridge_id
            && state.pid == pid
            && heartbeat_is_fresh(&state, WORKER_HEARTBEAT_MAX_AGE_MS)
        {
            return Ok(NativeBridgeWorkerStatus { pid: Some(pid) });
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    bail!("Native bridge worker did not report a fresh heartbeat after startup")
}

/// 这一段从 base64 payload 运行 worker。
/// Run a worker from a base64 payload.
pub async fn run_native_bridge_worker_from_payload(payload: &str) -> anyhow::Result<()> {
    // 这一段解析 payload 后进入 worker loop。
    // Parse payload and enter the worker loop.
    let payload = decode_worker_payload(payload)?;
    apply_worker_payload_source_root(&payload)?;
    let result = run_native_bridge_worker(payload).await;

    // 这一段复刻旧 Node worker cleanup：worker 正常结束前清理外部 Diff 临时目录。
    // Match the old Node worker cleanup by clearing external diff temp files before exit.
    crate::handlers::diff_hover_preview::clear_external_diff_temp_root_on_worker_exit().await;
    result
}

/// 这一段应用 payload 里的源码根，避免 worker 读取私有配置时依赖父进程状态。
/// Apply the source root from the payload so private config reads do not depend on parent process state.
fn apply_worker_payload_source_root(payload: &NativeBridgeWorkerPayload) -> anyhow::Result<()> {
    // 这一段只在开发注入携带源码根时生效；发布模式继续使用 exe 邻近或运行目录配置。
    // Act only for dev injection payloads; release mode still uses exe-near or runtime-data config.
    let source_root = payload.source_root.trim();
    if source_root.is_empty() {
        return Ok(());
    }
    let source_root = PathBuf::from(source_root);
    std::env::set_current_dir(&source_root)
        .with_context(|| format!("failed to enter source root {}", source_root.display()))?;
    Ok(())
}

/// 这一段运行 native bridge worker 主循环。
/// Run the native bridge worker loop.
async fn run_native_bridge_worker(payload: NativeBridgeWorkerPayload) -> anyhow::Result<()> {
    // 这一段 worker 只持有一个 CDP 连接，断线后短暂等待并重新寻找主窗口。
    // The worker owns one CDP connection and reconnects after disconnects.
    let mut missing_target_since: Option<std::time::Instant> = None;
    let mut missing_codex_process_streak = 0_u32;
    loop {
        // 这一段优先学习 Codex++ 的进程退出确认：官方 Codex 进程连续消失后才释放 worker。
        // Prefer the Codex++-style process-exit confirmation: release the worker only after Codex processes stay absent.
        if update_codex_process_missing_streak(
            &mut missing_codex_process_streak,
            codex_pro_core::process::codex_processes_are_absent(),
        ) {
            clear_native_bridge_state(payload.debug_port, &payload.native_bridge.bridge_id).await;
            return Ok(());
        }

        // 这一段在确认窗口内避免进入长 CDP 等待，让真实退出后的释放接近 4-6 秒。
        // During the confirmation window, avoid a long CDP wait so release after real exit stays close to 4-6 seconds.
        if missing_codex_process_streak > 0 {
            tokio::time::sleep(Duration::from_millis(WORKER_CODEX_EXIT_POLL_MS)).await;
            continue;
        }

        match run_native_bridge_session(&payload).await {
            Ok(()) => {
                missing_target_since = None;
            }
            Err(error) if is_stale_bridge_error(&error) => {
                clear_native_bridge_state(payload.debug_port, &payload.native_bridge.bridge_id)
                    .await;
                return Ok(());
            }
            Err(error) => {
                if is_missing_target_error(&error) {
                    let started = *missing_target_since.get_or_insert_with(std::time::Instant::now);
                    if started.elapsed().as_millis() >= WORKER_TARGET_MISSING_EXIT_MS {
                        clear_native_bridge_state(
                            payload.debug_port,
                            &payload.native_bridge.bridge_id,
                        )
                        .await;
                        return Err(error);
                    }
                } else {
                    missing_target_since = None;
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(WORKER_RECONNECT_DELAY_MS)).await;
    }
}

/// 这一段更新官方 Codex 进程缺失计数，并判断是否可以关闭 worker。
/// Update the official Codex missing-process streak and decide whether the worker can exit.
fn update_codex_process_missing_streak(
    missing_streak: &mut u32,
    codex_processes_absent: bool,
) -> bool {
    // 这一段只在系统进程表连续确认没有 Codex.exe 时递增，任何一次发现进程都会复位。
    // Increment only when the process table confirms no Codex.exe remains; any detected process resets the streak.
    if codex_processes_absent {
        *missing_streak = missing_streak.saturating_add(1);
    } else {
        *missing_streak = 0;
    }

    // 这一段沿用 Codex++ 风格的三次确认，避免进程枚举瞬时空结果导致误退出。
    // Use the Codex++-style three confirmations to avoid exiting on a transient empty process list.
    *missing_streak >= WORKER_CODEX_EXIT_EMPTY_STREAK_REQUIRED
}

/// 这一段运行单次 bridge CDP 会话。
/// Run one bridge CDP session.
async fn run_native_bridge_session(payload: &NativeBridgeWorkerPayload) -> anyhow::Result<()> {
    // 这一段连接主 Codex 页面。
    // Connect to the main Codex page.
    let target = wait_for_target(payload.debug_port, payload.timeout_ms).await?;
    let websocket_url = target
        .web_socket_debugger_url
        .as_deref()
        .ok_or_else(|| anyhow::anyhow!("selected CDP target has no websocket URL"))?;
    let mut client = CdpClient::connect(websocket_url).await?;
    client.send("Runtime.enable", json!({})).await?;
    let add_binding = client
        .send(
            "Runtime.addBinding",
            json!({ "name": payload.native_bridge.binding_name }),
        )
        .await;
    if let Err(error) = add_binding
        && !error.to_string().contains("already exists")
    {
        return Err(error);
    }
    update_worker_heartbeat(&mut client, payload).await?;

    // 这一段准备宠物浮窗补注入脚本；禁用系统时保持为空。
    // Prepare the pet-overlay reinjection script; keep it empty when the system is disabled.
    let overlay_script = codex_pro_core::injection::read_pet_event_sound_overlay_script(
        &payload.disabled_systems,
        worker_payload_source_root(payload),
    )?;
    if let Err(error) = scan_pet_event_sound_overlay_targets(
        payload.debug_port,
        &target.id,
        overlay_script.as_deref(),
    )
    .await
    {
        eprintln!("[Codex-Pro] pet event sound overlay watcher skipped: {error:#}");
    }

    // 这一段用 interval 定时刷新心跳、补注入晚创建宠物浮窗，同时监听 bindingCalled。
    // Refresh heartbeat, inject late-created pet overlays, and process bindingCalled events.
    let mut interval = tokio::time::interval(Duration::from_millis(WORKER_HEARTBEAT_INTERVAL_MS));
    let mut overlay_interval = tokio::time::interval(Duration::from_millis(
        PET_EVENT_SOUND_OVERLAY_SCAN_INTERVAL_MS,
    ));
    overlay_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let (bridge_event_tx, mut bridge_event_rx) = tokio::sync::mpsc::unbounded_channel();
    loop {
        tokio::select! {
            _ = interval.tick() => {
                update_worker_heartbeat(&mut client, payload).await?;
            }
            _ = overlay_interval.tick() => {
                if let Err(error) = scan_pet_event_sound_overlay_targets(
                    payload.debug_port,
                    &target.id,
                    overlay_script.as_deref(),
                ).await {
                    eprintln!("[Codex-Pro] pet event sound overlay watcher skipped: {error:#}");
                }
            }
            event = bridge_event_rx.recv() => {
                if let Some(event) = event {
                    handle_bridge_worker_event(&mut client, &payload.native_bridge, event).await;
                }
            }
            message = client.next_message() => {
                let Some(message) = message? else { break; };
                if message.get("method").and_then(|value| value.as_str()) == Some("Runtime.bindingCalled") {
                    let params = message.get("params").cloned().unwrap_or_else(|| json!({}));
                    let binding_name = params.get("name").and_then(|value| value.as_str()).unwrap_or_default();
                    let raw_payload = params.get("payload").and_then(|value| value.as_str()).unwrap_or_default();
                    if let Some(request) = parse_native_bridge_request(binding_name, raw_payload, &payload.native_bridge) {
                        dispatch_native_bridge_request(bridge_event_tx.clone(), request);
                    }
                }
            }
        }
    }
    Ok(())
}

/// 这一段刷新页面和状态文件心跳。
/// Refresh page and state-file heartbeat.
async fn update_worker_heartbeat(
    client: &mut CdpClient,
    payload: &NativeBridgeWorkerPayload,
) -> anyhow::Result<()> {
    // 这一段先写页面全局状态，再写本地状态文件。
    // Update page global state before writing the local state file.
    let expression = format!(
        r#"(() => {{
  const bridgeId = {};
  if (window.__codexProNativeBridgeConfig?.bridgeId !== bridgeId) return false;
  window.__codexProNativeBridgeStatus = {{ bridgeId, updatedAt: Date.now() }};
  return true;
}})()"#,
        serde_json::to_string(&payload.native_bridge.bridge_id)?,
    );
    let response = client
        .send(
            "Runtime.evaluate",
            json!({
                "expression": expression,
                "awaitPromise": false,
                "allowUnsafeEvalBlockedByCSP": true,
            }),
        )
        .await?;
    if !runtime_evaluate_bool(&response) {
        bail!("native bridge heartbeat rejected by page config");
    }
    write_native_bridge_state(&NativeBridgeState {
        debug_port: payload.debug_port,
        native_bridge: payload.native_bridge.clone(),
        disabled_systems: payload.disabled_systems.clone(),
        pid: std::process::id(),
        started_at: read_native_bridge_state(payload.debug_port)
            .await
            .map(|state| state.started_at)
            .unwrap_or_else(now_text),
        worker_heartbeat_at: now_text(),
    })
    .await
}

/// 这一段返回 worker payload 里的开发源码根。
/// Return the development source root from the worker payload.
fn worker_payload_source_root(payload: &NativeBridgeWorkerPayload) -> Option<&Path> {
    // 这一段只在 payload 携带源码根时让浮窗 watcher 读取磁盘源码；发布模式继续使用嵌入资产。
    // Read disk sources for the overlay watcher only when the payload carries a source root; release mode keeps embedded assets.
    let source_root = payload.source_root.trim();
    if source_root.is_empty() {
        return None;
    }
    Some(Path::new(source_root))
}

/// 这一段扫描宠物浮窗并补注入状态音效运行态。
/// Scan avatar overlays and inject the pet-state sound runtime.
async fn scan_pet_event_sound_overlay_targets(
    debug_port: u16,
    selected_target_id: &str,
    script: Option<&str>,
) -> anyhow::Result<()> {
    // 这一段在系统被硬禁用时直接跳过，避免无意义的 CDP 扫描。
    // Skip CDP scanning when the system is hard-disabled.
    let Some(script) = script.filter(|value| !value.trim().is_empty()) else {
        return Ok(());
    };

    // 这一段读取当前所有 target，只选择主窗口之外的宠物 overlay。
    // Read current targets and select only pet overlays outside the main window.
    let targets = list_targets(debug_port).await?;
    for target in targets
        .iter()
        .filter(|target| target.id != selected_target_id && is_auxiliary_codex_page_target(target))
    {
        // 这一段不按 target id 缓存“已注入”，因为宠物窗口关闭再打开时可能复用同一个 target id 但页面运行态已丢失。
        // Do not cache "injected" by target id because closing and reopening the pet window can reuse the same target id with a fresh page runtime.
        match inject_pet_event_sound_overlay_target(target, script).await {
            Ok(true) => {}
            Ok(false) => {}
            Err(error) => {
                eprintln!(
                    "[Codex-Pro] pet event sound overlay watcher failed {}: {error:#}",
                    target_label(target)
                );
            }
        }
    }
    Ok(())
}

/// 这一段返回 target 的诊断标签。
/// Return a diagnostic label for a target.
fn target_label(target: &CdpTarget) -> &str {
    // 这一段优先 URL，再回退 id，避免日志里出现空字符串。
    // Prefer the URL and fall back to the id so logs do not show an empty label.
    if target.url.trim().is_empty() {
        &target.id
    } else {
        &target.url
    }
}

/// 这一段向单个宠物浮窗注入最小音效运行态。
/// Inject the minimal sound runtime into one avatar overlay.
async fn inject_pet_event_sound_overlay_target(
    target: &CdpTarget,
    script: &str,
) -> anyhow::Result<bool> {
    // 这一段再次确认 target 可连接，避免无 WebSocket 的页面影响 watcher。
    // Confirm the target is connectable so pages without a WebSocket do not affect the watcher.
    if !is_auxiliary_codex_page_target(target) {
        return Ok(false);
    }
    let Some(websocket_url) = target.web_socket_debugger_url.as_deref() else {
        return Ok(false);
    };

    // 这一段执行已存在运行态检查和立即注入；关闭连接放在 result 之后，避免泄漏 CDP socket。
    // Check for an existing runtime and inject immediately; close the socket after the result to avoid leaking CDP connections.
    let mut client = CdpClient::connect(websocket_url).await?;
    let result = async {
        client.send("Runtime.enable", json!({})).await?;
        if has_pet_event_sound_overlay_runtime(&mut client).await? {
            return Ok(true);
        }
        client
            .send(
                "Page.addScriptToEvaluateOnNewDocument",
                json!({ "source": script }),
            )
            .await?;
        client
            .send(
                "Runtime.evaluate",
                json!({
                    "expression": script,
                    "awaitPromise": false,
                    "allowUnsafeEvalBlockedByCSP": true,
                }),
            )
            .await?;
        Ok(true)
    }
    .await;
    client.close().await;
    result
}

/// 这一段判断宠物浮窗是否已有状态音效运行态。
/// Return whether the avatar overlay already has the pet-state sound runtime.
async fn has_pet_event_sound_overlay_runtime(client: &mut CdpClient) -> anyhow::Result<bool> {
    // 这一段检查 runtime systems 和启动状态，避免重复执行同一 bundle。
    // Check runtime systems and started state so the same bundle is not executed repeatedly.
    let response = client
        .send(
            "Runtime.evaluate",
            json!({
                "expression": r#"
(() => Boolean(
  window.__codexProRuntime?.systems?.some((system) => system?.name === "pet-event-sounds") &&
  window.__codexProRuntime?.systemStates?.["pet-event-sounds"]?.started === true &&
  window.__codexProPetEventSoundsOverlayMode === "main-window-playback-v1"
))()
"#,
                "returnByValue": true,
                "awaitPromise": true,
                "allowUnsafeEvalBlockedByCSP": true,
            }),
        )
        .await?;
    Ok(runtime_evaluate_bool(&response))
}

/// 这一段判断错误是否表示当前 worker 已被新 bridge 取代。
/// Return whether the current worker has been superseded by a newer bridge.
fn is_stale_bridge_error(error: &anyhow::Error) -> bool {
    // 这一段只匹配本模块写出的受控错误文本。
    // Match only the controlled error emitted by this module.
    error
        .to_string()
        .contains("native bridge heartbeat rejected by page config")
}

/// 这一段判断错误是否表示暂时找不到 Codex 主窗口。
/// Return whether the error means the Codex main target is temporarily missing.
fn is_missing_target_error(error: &anyhow::Error) -> bool {
    // 这一段识别 CDP target 轮询超时，允许 worker 像旧版 Node 一样短暂等待。
    // Recognize CDP target polling timeouts so the worker can wait like the Node version.
    error
        .to_string()
        .contains("Timed out waiting for CDP target")
}

/// 这一段读取 Runtime.evaluate 的布尔返回值。
/// Read the boolean return value from Runtime.evaluate.
fn runtime_evaluate_bool(response: &Value) -> bool {
    // 这一段按 CDP 标准 result.result.value 路径解析。
    // Parse the CDP standard result.result.value path.
    response
        .get("result")
        .and_then(|result| result.get("result"))
        .and_then(|result| result.get("value"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

/// 这一段编码 worker payload。
/// Encode a worker payload.
fn encode_worker_payload(payload: &NativeBridgeWorkerPayload) -> anyhow::Result<String> {
    // 这一段用 base64url 避免命令行引号问题。
    // Use base64url to avoid command-line quoting issues.
    Ok(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(serde_json::to_vec(payload)?))
}

/// 这一段解码 worker payload。
/// Decode a worker payload.
fn decode_worker_payload(payload: &str) -> anyhow::Result<NativeBridgeWorkerPayload> {
    // 这一段解析失败时给出明确错误。
    // Return a clear error on malformed payloads.
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload)
        .context("invalid native bridge worker payload base64")?;
    serde_json::from_slice(&bytes).context("invalid native bridge worker payload json")
}

/// 这一段启动 worker 子进程。
/// Spawn the worker subprocess.
async fn spawn_worker_process(
    payload: &str,
    native_bridge: &NativeBridgeConfig,
    dev_runtime: bool,
    source_root: Option<&Path>,
) -> anyhow::Result<u32> {
    // 这一段解析 worker 可执行文件；发布模式继续使用当前单 exe，开发模式使用副本避免文件锁。
    // Resolve the worker executable; release uses the current single exe, dev uses a copy to avoid file locks.
    let worker_exe = resolve_worker_executable(native_bridge, dev_runtime, source_root).await?;
    let mut command = Command::new(worker_exe);
    command.arg("--native-bridge-worker").arg(payload);
    configure_worker_source_root(&mut command, source_root);
    configure_worker_stdio(&mut command, dev_runtime, native_bridge)?;
    #[cfg(windows)]
    {
        command.creation_flags(codex_pro_core::process::CREATE_NO_WINDOW);
    }
    let child = command
        .spawn()
        .context("failed to start native bridge worker")?;
    Ok(child.id().unwrap_or_default())
}

/// 这一段把源码根传给 worker，保证 private 配置查找不依赖父进程当前目录。
/// Pass the source root to the worker so private config discovery does not depend on the parent cwd.
fn configure_worker_source_root(command: &mut Command, source_root: Option<&Path>) {
    // 这一段只在已知源码根时设置；发布模式继续走 exe 邻近目录和运行期数据目录候选。
    // Set this only when the source root is known; release mode still uses exe-near and runtime-data candidates.
    let Some(source_root) = source_root else {
        return;
    };
    command.env("CODEX_PRO_SOURCE_ROOT", source_root);
    command.current_dir(source_root);
}

/// 这一段配置 worker 标准输出；开发模式写日志，发布模式保持静默。
/// Configure worker stdio; development mode writes logs while release remains quiet.
fn configure_worker_stdio(
    command: &mut Command,
    dev_runtime: bool,
    native_bridge: &NativeBridgeConfig,
) -> anyhow::Result<()> {
    // 这一段发布模式保持旧行为，不在用户目录产生额外 worker 日志。
    // Keep the previous release behavior without producing extra worker logs.
    if !dev_runtime {
        command.stdout(Stdio::null());
        command.stderr(Stdio::null());
        return Ok(());
    }

    // 这一段按 bridgeId 写入本轮开发 worker 日志，定位启动即退的问题。
    // Write per-bridge development worker logs to diagnose workers that exit during startup.
    let safe_bridge_id = sanitize_dev_runtime_name(&native_bridge.bridge_id);
    if safe_bridge_id.is_empty() {
        bail!("invalid native bridge id for dev worker logs");
    }
    let log_dir = codex_pro_core::paths::logs_dir();
    std::fs::create_dir_all(&log_dir)
        .context("failed to create native bridge worker log directory")?;
    let stdout_path = log_dir.join(format!("native-bridge-worker-{safe_bridge_id}.stdout.log"));
    let stderr_path = log_dir.join(format!("native-bridge-worker-{safe_bridge_id}.stderr.log"));
    let stdout = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&stdout_path)
        .with_context(|| {
            format!(
                "failed to open worker stdout log: {}",
                stdout_path.display()
            )
        })?;
    let stderr = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&stderr_path)
        .with_context(|| {
            format!(
                "failed to open worker stderr log: {}",
                stderr_path.display()
            )
        })?;
    command.stdout(Stdio::from(stdout));
    command.stderr(Stdio::from(stderr));
    Ok(())
}

/// 这一段解析 worker 要运行的 exe。
/// Resolve the executable used by the worker.
async fn resolve_worker_executable(
    native_bridge: &NativeBridgeConfig,
    dev_runtime: bool,
    source_root: Option<&Path>,
) -> anyhow::Result<PathBuf> {
    // 这一段默认使用当前 exe，保持 release 单文件不依赖额外 helper。
    // Default to the current exe so release single-file mode needs no extra helper.
    let current_exe = std::env::current_exe().context("failed to resolve current executable")?;
    if !dev_runtime {
        return Ok(current_exe);
    }
    let source_exe = resolve_dev_source_worker_executable(source_root, &current_exe);
    prepare_dev_worker_executable(&source_exe, native_bridge).await
}

/// 这一段选择开发模式 worker 的源 exe。
/// Select the source executable for a development-mode worker.
fn resolve_dev_source_worker_executable(source_root: Option<&Path>, current_exe: &Path) -> PathBuf {
    // 这一段优先复制源码根下最新 cargo dev 产物，避免旧 private/bin exe 或旧 dev-runtime exe 复制自己。
    // Prefer the latest cargo dev artifact under the source root so stale private/dev-runtime launchers do not copy themselves.
    if let Some(source_root) = source_root {
        let candidate = source_root
            .join("private")
            .join("target")
            .join("codex-pro-dev")
            .join("debug")
            .join("Codex-Pro-Launcher.exe");
        if candidate.is_file() {
            return candidate;
        }
    }
    current_exe.to_path_buf()
}

/// 这一段准备开发模式 worker exe 副本。
/// Prepare a development-mode worker executable copy.
async fn prepare_dev_worker_executable(
    current_exe: &Path,
    native_bridge: &NativeBridgeConfig,
) -> anyhow::Result<PathBuf> {
    // 这一段用 bridgeId 分隔每轮注入的 worker 副本，避免覆盖正在运行的旧 worker。
    // Separate each injection's worker copy by bridgeId so running old workers are not overwritten.
    let safe_bridge_id = sanitize_dev_runtime_name(&native_bridge.bridge_id);
    if safe_bridge_id.is_empty() {
        bail!("invalid native bridge id for dev runtime");
    }
    let runtime_root = codex_pro_core::paths::codex_pro_data_root_dir().join("dev-runtime");
    cleanup_dev_runtime_root(&runtime_root, &safe_bridge_id).await;
    let runtime_dir = runtime_root.join(&safe_bridge_id);
    tokio::fs::create_dir_all(&runtime_dir)
        .await
        .context("failed to create dev runtime directory")?;
    let file_name = current_exe
        .file_name()
        .ok_or_else(|| anyhow::anyhow!("current executable has no file name"))?;
    let worker_exe = runtime_dir.join(file_name);
    tokio::fs::copy(current_exe, &worker_exe)
        .await
        .with_context(|| {
            format!(
                "failed to copy dev worker executable to {}",
                worker_exe.display()
            )
        })?;
    Ok(worker_exe)
}

/// 这一段清理不再使用的开发 runtime 目录。
/// Clean development runtime directories that are no longer in use.
async fn cleanup_dev_runtime_root(runtime_root: &Path, keep_name: &str) {
    // 这一段尽力清理旧目录；仍被 Windows 锁定的 worker 副本会保留到下次再试。
    // Best-effort cleanup; worker copies still locked by Windows are retried on later runs.
    let Ok(mut entries) = tokio::fs::read_dir(runtime_root).await else {
        return;
    };
    while let Ok(Some(entry)) = entries.next_entry().await {
        let path = entry.path();
        if path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name == keep_name)
        {
            continue;
        }
        let _ = tokio::fs::remove_dir_all(path).await;
    }
}

/// 这一段把 bridgeId 转成安全目录名。
/// Convert a bridgeId into a safe directory name.
fn sanitize_dev_runtime_name(value: &str) -> String {
    // 这一段只保留 UUID 需要的 ASCII 字母数字和连字符，避免任意路径片段进入运行目录。
    // Keep only UUID-style ASCII alphanumerics and dashes so arbitrary path segments cannot enter the runtime dir.
    value
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || *ch == '-')
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 这一段创建唯一测试目录。
    /// Create a unique test directory.
    fn test_root(name: &str) -> PathBuf {
        // 这一段组合进程号和时间戳，避免并行测试目录冲突。
        // Combine process id and timestamp to avoid collisions in parallel tests.
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "codex-pro-worker-{name}-{}-{nonce}",
            std::process::id()
        ))
    }

    /// 这一段确认开发模式优先复制 cargo dev 产物。
    /// Confirm development mode prefers the cargo dev artifact.
    #[test]
    fn dev_source_worker_prefers_cargo_dev_artifact() {
        // 这一段准备一个带最新 private target exe 的源码根。
        // Prepare a source root that contains the latest private target executable.
        let root = test_root("prefer-target");
        let candidate = root
            .join("private")
            .join("target")
            .join("codex-pro-dev")
            .join("debug")
            .join("Codex-Pro-Launcher.exe");
        std::fs::create_dir_all(candidate.parent().unwrap()).unwrap();
        std::fs::write(&candidate, b"new").unwrap();
        let current = root.join("Codex-Pro-Launcher.exe");
        std::fs::write(&current, b"old").unwrap();

        // 这一段确认旧 current_exe 不会覆盖 private target 新产物。
        // Confirm the stale current_exe does not override the newer private target artifact.
        assert_eq!(
            resolve_dev_source_worker_executable(Some(&root), &current),
            candidate
        );
        let _ = std::fs::remove_dir_all(root);
    }

    /// 这一段确认缺少 private target 产物时才回退 current exe。
    /// Confirm missing private target artifacts fall back to the current exe.
    #[test]
    fn dev_source_worker_falls_back_to_current_exe() {
        // 这一段准备一个没有 private target exe 的源码根。
        // Prepare a source root without a private target executable.
        let root = test_root("fallback-current");
        std::fs::create_dir_all(&root).unwrap();
        let current = root.join("Codex-Pro-Launcher.exe");

        // 这一段保留发布/异常开发目录的可运行兜底。
        // Keep the runnable fallback for release-like or incomplete development directories.
        assert_eq!(
            resolve_dev_source_worker_executable(Some(&root), &current),
            current
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn codex_process_missing_streak_requires_three_empty_checks() {
        // 这一段确认前两次空进程表只进入确认窗口，不会立即退出 worker。
        // Confirm the first two empty process-list checks enter the confirmation window without exiting the worker.
        let mut streak = 0_u32;
        assert!(!update_codex_process_missing_streak(&mut streak, true));
        assert_eq!(streak, 1);
        assert!(!update_codex_process_missing_streak(&mut streak, true));
        assert_eq!(streak, 2);

        // 这一段确认第三次连续空结果才允许退出，和 Codex++ 的三次确认保持一致。
        // Confirm the third consecutive empty result allows exit, matching Codex++'s three confirmations.
        assert!(update_codex_process_missing_streak(&mut streak, true));
        assert_eq!(streak, 3);
    }

    #[test]
    fn codex_process_missing_streak_resets_when_process_returns() {
        // 这一段确认任何一次发现 Codex 进程都会复位，避免短暂枚举空结果导致功能断开。
        // Confirm any detected Codex process resets the streak so transient empty results do not disconnect features.
        let mut streak = 0_u32;
        assert!(!update_codex_process_missing_streak(&mut streak, true));
        assert!(!update_codex_process_missing_streak(&mut streak, true));
        assert!(!update_codex_process_missing_streak(&mut streak, false));
        assert_eq!(streak, 0);
        assert!(!update_codex_process_missing_streak(&mut streak, true));
        assert_eq!(streak, 1);
    }
}
