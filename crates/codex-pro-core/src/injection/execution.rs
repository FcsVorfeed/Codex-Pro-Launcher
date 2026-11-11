use super::startup;
use crate::cdp::{CdpClient, CdpTarget, is_connection_loss};
use crate::native_bridge::NativeBridgeConfig;
use anyhow::{Context, bail, ensure};
use serde_json::json;
use std::time::Duration;
use tokio::time::{Instant, sleep, timeout, timeout_at};

/// 这一段把注册、实际执行和断线恢复放在同一截止时间内。
/// Bound registration, execution and disconnect recovery by one deadline.
pub(super) async fn execute(
    debug_port: u16,
    timeout_ms: u64,
    disabled_systems: &[String],
    native_bridge: Option<&NativeBridgeConfig>,
    template: &str,
    attempt_id: &str,
    mut recovering: bool,
) -> anyhow::Result<(CdpTarget, CdpClient)> {
    // 这一段固定截止时间，重连不刷新预算；只保存首次断线避免日志无界增长。
    // Fix the deadline across retries and retain only the first disconnect.
    let deadline = Instant::now() + Duration::from_millis(timeout_ms.max(1000));
    let mut first_disconnect = None;
    loop {
        let script = template.replace(
            "/* CODEX_PRO_RECOVERY */",
            if recovering { "true" } else { "false" },
        );
        let remaining = deadline
            .saturating_duration_since(Instant::now())
            .as_millis() as u64;
        let (target, mut client) = timeout_at(
            deadline,
            startup::prepare_connection(
                debug_port,
                remaining,
                disabled_systems,
                native_bridge,
                &script,
            ),
        )
        .await
        .context("injection deadline during connection preparation")??;

        // 这一段通过文档标记原子复用完成结果或正在执行的 Promise，仅新文档执行源码。
        // Atomically reuse completed results or an in-flight promise; only a new document runs source.
        let result = timeout_at(deadline, async {
            let response = client
                .send(
                    "Runtime.evaluate",
                    json!({
                        "expression": script, "awaitPromise": true, "returnByValue": true,
                        "allowUnsafeEvalBlockedByCSP": true,
                    }),
                )
                .await
                .context("injection stage Runtime.evaluate")?;
            ensure!(
                response.pointer("/result/exceptionDetails").is_none(),
                "injection stage Runtime.evaluate: injected script reported an exception"
            );
            ensure!(
                response
                    .pointer("/result/result/value/id")
                    .and_then(|v| v.as_str())
                    == Some(attempt_id)
                    && response
                        .pointer("/result/result/value/complete")
                        .and_then(|v| v.as_bool())
                        == Some(true),
                "injection stage Runtime.evaluate: document did not confirm completion"
            );
            Ok::<(), anyhow::Error>(())
        })
        .await;
        match result {
            Ok(Ok(())) => {
                startup::log_event("completed stage=Runtime.evaluate").await;
                return Ok((target, client));
            }
            Ok(Err(error)) if is_connection_loss(&error) => {
                first_disconnect.get_or_insert_with(|| format!("{error:#}"));
                startup::log_event("disconnected stage=Runtime.evaluate; resume guarded attempt")
                    .await;
                recovering = true;
            }
            Ok(Err(error)) => {
                let _ = timeout(Duration::from_millis(250), client.close()).await;
                return Err(error);
            }
            Err(_) => {
                let _ = timeout(Duration::from_millis(250), client.close()).await;
                bail!(
                    "injection deadline at Runtime.evaluate; first disconnect: {}",
                    first_disconnect.as_deref().unwrap_or("none")
                );
            }
        }
        // 这一段丢弃失效连接并限制恢复频率，不重试脚本异常或协议错误。
        // Drop the failed session and bound retry frequency; never retry script or protocol errors.
        let _ = timeout(Duration::from_millis(250), client.close()).await;
        if timeout_at(deadline, sleep(Duration::from_millis(250)))
            .await
            .is_err()
        {
            bail!(
                "injection deadline after Runtime.evaluate disconnect: {}",
                first_disconnect.unwrap()
            );
        }
    }
}
