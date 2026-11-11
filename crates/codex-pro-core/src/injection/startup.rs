use crate::cdp::{CdpClient, CdpTarget, is_connection_loss, wait_for_target};
use crate::native_bridge::NativeBridgeConfig;
use anyhow::{Context, bail};
use serde_json::json;
use std::time::Duration;
use tokio::time::{Instant, sleep, timeout, timeout_at};

/// 这一段限制启动重连频率，避免页面切换期间忙循环。
/// Bound startup reconnection frequency to avoid spinning during page replacement.
const RECONNECT_DELAY: Duration = Duration::from_millis(250);

/// 这一段在同一个总时限内重新发现页面，恢复注册完成前的连接丢失。
/// Rediscover the page within one deadline, recovering connection loss until script registration completes.
pub(super) async fn prepare_connection(
    debug_port: u16,
    timeout_ms: u64,
    disabled_systems: &[String],
    native_bridge: Option<&NativeBridgeConfig>,
    script: &str,
) -> anyhow::Result<(CdpTarget, CdpClient)> {
    // 这一段让发现、连接、binding 和脚本注册共用截止时间，不为每次重试重新计时。
    // Share one deadline across discovery, connection, binding and registration instead of resetting it.
    let deadline = Instant::now() + Duration::from_millis(timeout_ms.max(1000));
    let mut first_failure = None;
    let mut attempt = 0;
    loop {
        attempt += 1;
        let mut stage = "target-discovery";
        let result = timeout_at(
            deadline,
            prepare_attempt(
                debug_port,
                timeout_ms,
                disabled_systems,
                native_bridge,
                script,
                &mut stage,
            ),
        )
        .await;

        // 这一段按类型区分断线与真实命令失败，后者立即返回，不被重试掩盖。
        // Distinguish disconnects from real command failures, which return without retries.
        match result {
            Ok(Ok(connection)) => {
                log_event(&format!("prepared attempt={attempt}")).await;
                return Ok(connection);
            }
            Ok(Err(error)) => {
                let error = error.context(format!("injection startup stage {stage}"));
                if !is_connection_loss(&error) {
                    log_event(&format!("failed attempt={attempt} stage={stage}")).await;
                    return Err(error);
                }
                log_event(&format!(
                    "disconnected attempt={attempt} stage={stage}: {error:#}"
                ))
                .await;
                first_failure.get_or_insert_with(|| format!("{error:#}"));
            }
            Err(_) => {
                log_event(&format!("deadline attempt={attempt} stage={stage}")).await;
                bail!(
                    "injection startup deadline reached at {stage}; first disconnect: {}",
                    first_failure.as_deref().unwrap_or("none")
                );
            }
        }

        // 这一段只等待剩余预算内的间隔，下一轮一定重新获取 target 和 websocket。
        // Wait only within the remaining budget and obtain a fresh target and socket next time.
        if timeout_at(deadline, sleep(RECONNECT_DELAY)).await.is_err() {
            bail!(
                "injection startup deadline reached; first disconnect: {}",
                first_failure.unwrap()
            );
        }
    }
}

/// 这一段准备一次连接并注册脚本；失败或取消时释放会话，不主动调用功能脚本。
/// Prepare a connection and register scripts, releasing failed sessions without manually evaluating features.
async fn prepare_attempt(
    debug_port: u16,
    timeout_ms: u64,
    disabled_systems: &[String],
    native_bridge: Option<&NativeBridgeConfig>,
    script: &str,
    stage: &mut &'static str,
) -> anyhow::Result<(CdpTarget, CdpClient)> {
    // 这一段每次都重新发现主窗口，避免复用启动时已经销毁的 target。
    // Rediscover the main window on every attempt instead of reusing a destroyed startup target.
    let target = wait_for_target(debug_port, timeout_ms).await?;
    let websocket_url = target
        .web_socket_debugger_url
        .as_deref()
        .context("selected CDP target has no websocket URL")?;
    *stage = "websocket-connect";
    let mut client = CdpClient::connect(websocket_url).await?;
    let result = async {
        *stage = "Runtime.enable";
        client.send("Runtime.enable", json!({})).await?;

        // 这一段保留可选补丁原有跳过行为，但传输断线不能带入后续 binding。
        // Preserve optional patch skipping, but never carry a disconnected socket into binding.
        if !disabled_systems
            .iter()
            .any(|system| system == "split-items-hotpath-patch")
        {
            *stage = "split-items-hotpath-patch";
            let patch_result =
                crate::split_items_hotpath_patch::apply_split_items_hotpath_patch(&mut client)
                    .await;
            client.ensure_connected()?;
            match patch_result {
                Ok(status) => eprintln!("[Codex-Pro] split-items hotpath patch: {status}"),
                Err(error) => eprintln!("[Codex-Pro] split-items hotpath patch skipped: {error:#}"),
            }
        }
        if let Some(native_bridge) = native_bridge {
            *stage = "Runtime.addBinding";
            let binding = client
                .send(
                    "Runtime.addBinding",
                    json!({ "name": native_bridge.binding_name }),
                )
                .await;
            if let Err(error) = binding
                && !error.to_string().contains("already exists")
            {
                return Err(error);
            }
        }
        // 这一段把新文档脚本注册纳入启动恢复；默认不立即执行，同一注入标记阻止导航竞态重复启动。
        // Include new-document registration in startup recovery; deferred execution shares a guard against navigation races.
        *stage = "Page.addScriptToEvaluateOnNewDocument";
        client
            .send(
                "Page.addScriptToEvaluateOnNewDocument",
                json!({ "source": script }),
            )
            .await?;
        Ok::<(), anyhow::Error>(())
    }
    .await;

    // 这一段失败后尽量发送关闭帧，受限等待后丢弃连接，避免旧会话残留。
    // Attempt a bounded close on failure, then drop the session so stale sockets cannot linger.
    if let Err(error) = result {
        let _ = timeout(RECONNECT_DELAY, client.close()).await;
        return Err(error);
    }
    Ok((target, client))
}

/// 这一段把阶段日志写入双击启动器日志，测试不接触用户运行目录。
/// Persist stage diagnostics for double-click launches without touching user directories in tests.
pub(super) async fn log_event(message: &str) {
    // 这一段只记录阶段和连接错误，不记录脚本、设置或页面正文。
    // Record stages and connection failures, never scripts, settings or page content.
    eprintln!("[Codex-Pro] injection startup: {message}");
    #[cfg(not(test))]
    if let Ok(path) = crate::diagnostics::launcher_log_path() {
        let _ = timeout(
            RECONNECT_DELAY,
            crate::diagnostics::append_log_line(&path, &format!("RustInjectionStartup: {message}")),
        )
        .await;
    }
}

#[cfg(test)]
mod tests;
