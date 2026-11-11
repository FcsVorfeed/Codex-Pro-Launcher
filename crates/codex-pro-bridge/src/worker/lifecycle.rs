use anyhow::{Context, bail, ensure};
use serde_json::Value;
use std::future::Future;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::process::Child;
use tokio::sync::watch;
use tokio::time::{Instant, sleep, sleep_until, timeout_at};

/// 这一段区分页面暂未就绪与明确被新 bridge 替代。
/// Distinguish temporary page unreadiness from explicit bridge replacement.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum HeartbeatError {
    /// 这一段表示新文档还没有本次 bridge 配置。
    /// The new document does not yet have bridge configuration.
    Missing,
    /// 这一段表示页面明确属于另一轮 bridge。
    /// The page explicitly belongs to a different bridge.
    Superseded,
}

impl std::fmt::Display for HeartbeatError {
    /// 这一段输出固定阶段信息，不包含页面正文或用户配置。
    /// Emit fixed stage information without page content or user configuration.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{}",
            match self {
                Self::Missing => "页面桥接配置未就绪 / page bridge configuration missing",
                Self::Superseded => "桥接已被替换 / bridge superseded",
            }
        )
    }
}
impl std::error::Error for HeartbeatError {}

/// 这一段严格检查心跳返回，页面异常不能伪装成正常替换退出。
/// Validate heartbeat responses; page exceptions must never masquerade as replacement.
pub(super) fn check_heartbeat_response(response: &Value) -> anyhow::Result<()> {
    ensure!(
        response.pointer("/result/exceptionDetails").is_none(),
        "心跳脚本执行异常 / heartbeat script exception"
    );
    match response
        .pointer("/result/result/value")
        .and_then(Value::as_str)
    {
        Some("ready") => Ok(()),
        Some("missing") => Err(HeartbeatError::Missing.into()),
        Some("superseded") => Err(HeartbeatError::Superseded.into()),
        _ => bail!("心跳返回无效 / invalid heartbeat response"),
    }
}

/// 这一段生成父子进程共享的绝对启动期限，不因进程创建耗时重置预算。
/// Generate an absolute startup deadline shared across parent and child process creation.
pub(super) fn startup_deadline_ms(timeout_ms: u64) -> u64 {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    now.saturating_add(timeout_ms.max(1000))
}

/// 这一段在各进程中把共享墙钟期限转换为单调时钟期限。
/// Convert the shared wall-clock deadline into a local monotonic deadline.
pub(super) fn local_deadline(deadline_ms: u64) -> Instant {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    Instant::now() + Duration::from_millis(deadline_ms.saturating_sub(now))
}

/// 这一段以成功心跳为依据限制全部失联原因，持续报错不能刷新退出期限。
/// Bound all disconnection causes by successful heartbeats, never by repeated errors.
pub(super) async fn watch_heartbeats(
    mut heartbeat: watch::Receiver<Option<Instant>>,
    startup_deadline: Instant,
    disconnected_limit: Duration,
) -> anyhow::Result<()> {
    loop {
        // 这一段首次心跳前使用启动期限，之后只由成功心跳延长存活时间。
        // Use the startup deadline until the first heartbeat; only successful heartbeats extend liveness.
        let last = *heartbeat.borrow_and_update();
        let deadline = last
            .map(|at| at + disconnected_limit)
            .unwrap_or(startup_deadline);
        tokio::select! {
            biased;
            changed = heartbeat.changed() => { changed.context("heartbeat monitor closed")?; }
            _ = sleep_until(deadline) => {
                bail!("{}", if last.is_some() {
                    "桥接持续失联，已退出 / bridge disconnected deadline reached"
                } else {
                    "桥接启动超时 / bridge startup deadline reached"
                });
            }
        }
    }
}

/// 这一段持有本次子进程直到握手完成，提前退出或超时只回收这个句柄。
/// Own the spawned child until handshake completion; reclaim only this handle on failure.
pub(super) async fn await_owned_worker(
    child: &mut Child,
    deadline: Instant,
    ready: impl Future<Output = anyhow::Result<()>>,
) -> anyhow::Result<()> {
    // 这一段同时监听心跳和退出码，不让已退出的 worker 继续耗尽启动预算。
    // Observe both heartbeat and exit status instead of waiting out the budget for an exited child.
    let result = timeout_at(deadline, async {
        tokio::pin!(ready);
        loop {
            if let Some(status) = child.try_wait().context("query bridge worker exit")? {
                bail!("桥接进程提前退出 / bridge worker exited before ready: {status}");
            }
            tokio::select! {
                result = &mut ready => return result,
                _ = sleep(Duration::from_millis(100)) => {}
            }
        }
    })
    .await
    .context("桥接启动超时 / bridge startup deadline reached")
    .and_then(|result| result);

    // 这一段失败时等待终止确认，防止下一次启动继承本次残留；不用全局进程名杀进程。
    // Confirm termination after failure so the next launch inherits no child; never kill by process name.
    if result.is_err() && child.try_wait()?.is_none() {
        child
            .kill()
            .await
            .context("回收桥接进程失败 / failed to reclaim bridge worker")?;
    }
    result
}

/// 这一段只把生命周期阶段写入启动器日志，不记录脚本或设置。
/// Write lifecycle stages to the launcher log without scripts or settings.
pub(super) async fn log_event(message: &str) {
    eprintln!("[Codex-Pro] bridge lifecycle: {message}");
    #[cfg(not(test))]
    if let Ok(path) = codex_pro_core::diagnostics::launcher_log_path() {
        let _ = tokio::time::timeout(
            Duration::from_millis(250),
            codex_pro_core::diagnostics::append_log_line(
                &path,
                &format!("RustBridgeLifecycle: {message}"),
            ),
        )
        .await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tokio::process::Command;

    /// 这一段验证配置缺失、明确替换、脚本异常和无效返回各自保持不同语义。
    /// Keep missing configuration, explicit replacement, exceptions and malformed responses distinct.
    #[test]
    fn heartbeat_classification_does_not_turn_exceptions_into_retirement() {
        for (value, expected) in [
            ("missing", HeartbeatError::Missing),
            ("superseded", HeartbeatError::Superseded),
        ] {
            let error = check_heartbeat_response(&json!({"result":{"result":{"value":value}}}))
                .unwrap_err();
            assert_eq!(error.downcast_ref::<HeartbeatError>(), Some(&expected));
        }
        assert!(check_heartbeat_response(&json!({"result":{"result":{"value":"ready"}}})).is_ok());
        for response in [
            json!({"result":{"exceptionDetails":{},"result":{"value":"ready"}}}),
            json!({}),
        ] {
            assert!(
                check_heartbeat_response(&response)
                    .unwrap_err()
                    .downcast_ref::<HeartbeatError>()
                    .is_none()
            );
        }
    }

    /// 这一段验证只有真实成功心跳延长运行期限，连续失败或后台进程存在都不能续命。
    /// Only successful heartbeats extend liveness; repeated failures or background processes cannot.
    #[tokio::test]
    async fn watchdog_requires_first_heartbeat_and_bounds_later_disconnects() {
        let (tx, rx) = watch::channel(None);
        let monitor = tokio::spawn(watch_heartbeats(
            rx,
            Instant::now() + Duration::from_millis(30),
            Duration::from_millis(80),
        ));
        tx.send_replace(Some(Instant::now()));
        sleep(Duration::from_millis(40)).await;
        assert!(!monitor.is_finished());
        tx.send_replace(Some(Instant::now()));
        sleep(Duration::from_millis(40)).await;
        assert!(!monitor.is_finished());
        let error = monitor.await.unwrap().unwrap_err();
        assert!(error.to_string().contains("disconnected deadline"));
        let (_tx, rx) = watch::channel(None);
        let error = watch_heartbeats(rx, Instant::now(), Duration::from_secs(120))
            .await
            .unwrap_err();
        assert!(error.to_string().contains("startup deadline"));
    }

    /// 这一段只启动测试专属的隐藏子进程，不访问或关闭用户客户端。
    /// Spawn only a hidden test-owned child without accessing or closing the user client.
    fn test_child(exit_immediately: bool) -> Child {
        #[cfg(windows)]
        let mut command = {
            let mut command = Command::new("powershell.exe");
            command.args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                if exit_immediately {
                    "exit 7"
                } else {
                    "Start-Sleep -Seconds 30"
                },
            ]);
            command.creation_flags(codex_pro_core::process::CREATE_NO_WINDOW);
            command
        };
        #[cfg(not(windows))]
        let mut command = {
            let mut command = Command::new("sh");
            command.args([
                "-c",
                if exit_immediately {
                    "exit 7"
                } else {
                    "exec sleep 30"
                },
            ]);
            command
        };
        command.kill_on_drop(true).spawn().unwrap()
    }

    /// 这一段用真实进程验证超时后回收且不残留。
    /// Use a real child process to verify timeout cleanup leaves no live process.
    #[tokio::test]
    async fn startup_timeout_reaps_the_owned_child() {
        let mut child = test_child(false);
        let error = await_owned_worker(
            &mut child,
            Instant::now() + Duration::from_millis(50),
            std::future::pending(),
        )
        .await
        .unwrap_err();
        assert!(error.to_string().contains("startup deadline"));
        assert!(child.try_wait().unwrap().is_some());
    }

    /// 这一段验证提前退出立即返回，正常就绪则保留 worker 供后台继续使用。
    /// Return early exits promptly while leaving successfully started workers alive.
    #[tokio::test]
    async fn startup_observes_exit_and_keeps_a_ready_child() {
        let mut exited = test_child(true);
        let error = await_owned_worker(
            &mut exited,
            Instant::now() + Duration::from_secs(5),
            std::future::pending(),
        )
        .await
        .unwrap_err();
        assert!(error.to_string().contains("exited before ready"));
        let mut ready = test_child(false);
        await_owned_worker(&mut ready, Instant::now() + Duration::from_secs(2), async {
            sleep(Duration::from_millis(100)).await;
            Ok(())
        })
        .await
        .unwrap();
        assert!(ready.try_wait().unwrap().is_none());
        ready.kill().await.unwrap();
    }
}
