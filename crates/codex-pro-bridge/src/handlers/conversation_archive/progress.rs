use serde_json::{Value, json};
use std::time::{Duration, Instant};
use tokio::sync::mpsc;

/// 这一段定义进度事件发送器。
/// Progress event sender.
pub type ProgressSender = mpsc::UnboundedSender<Value>;

/// 这一段定义进度事件节流间隔。
/// Progress event throttle interval.
const PROGRESS_INTERVAL: Duration = Duration::from_millis(500);

/// 这一段描述会话归档进度报告器。
/// Describes a conversation archive progress reporter.
#[derive(Clone, Debug)]
pub struct ProgressReporter {
    /// 这一段是可选发送器。
    /// Optional progress sender.
    sender: Option<ProgressSender>,
    /// 这一段是最近一次发送时间。
    /// Last sent timestamp.
    last_sent_at: Option<Instant>,
}

impl ProgressReporter {
    /// 这一段创建进度报告器。
    /// Create a progress reporter.
    pub fn new(sender: Option<ProgressSender>) -> Self {
        // 这一段没有页面进度回调时保持无副作用。
        // Keep no side effects when the page has no progress callback.
        Self {
            sender,
            last_sent_at: None,
        }
    }

    /// 这一段发送节流进度。
    /// Send throttled progress.
    pub fn report(&mut self, mut progress: Value) {
        // 这一段默认节流，避免高频 CDP 事件拖慢同步。
        // Throttle by default so high-frequency CDP events do not slow sync.
        self.report_inner(&mut progress, false);
    }

    /// 这一段发送强制进度。
    /// Send forced progress.
    pub fn report_force(&mut self, mut progress: Value) {
        // 这一段用于阶段切换和失败/完成事件。
        // Used for stage transitions and failed/done events.
        self.report_inner(&mut progress, true);
    }

    /// 这一段执行发送。
    /// Send one progress payload.
    fn report_inner(&mut self, progress: &mut Value, force: bool) {
        // 这一段检查发送器和节流窗口。
        // Check sender availability and throttling window.
        let Some(sender) = &self.sender else {
            return;
        };
        let now = Instant::now();
        if !force
            && self
                .last_sent_at
                .is_some_and(|last| now.duration_since(last) < PROGRESS_INTERVAL)
        {
            return;
        }
        self.last_sent_at = Some(now);
        if let Some(object) = progress.as_object_mut() {
            object.insert("progressAt".to_string(), json!(crate::state::now_text()));
        }
        let _ = sender.send(progress.clone());
    }
}

/// 这一段构造页面侧 progress response。
/// Build the page-side progress response.
pub fn progress_response(progress: Value) -> Value {
    // 这一段保持和最终 response 一致的包装形状。
    // Keep the same wrapper shape as final responses.
    json!({
        "ok": true,
        "status": 200,
        "data": progress,
        "error": "",
    })
}
