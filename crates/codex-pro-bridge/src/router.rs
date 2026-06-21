use crate::handlers::{
    cloud_sync, conversation_archive, diff_hover_preview, mouse_gestures, pet_sync,
    today_token_usage,
};
use crate::protocol::{NATIVE_BRIDGE_MAX_PAYLOAD_LENGTH, NATIVE_BRIDGE_RESPONSE_EVENT_NAME};
use codex_pro_core::cdp::CdpClient;
use codex_pro_core::native_bridge::NativeBridgeConfig;
use serde_json::{Value, json};
use tokio::sync::mpsc;

/// 这一段描述已解析 native bridge 请求。
/// Describes a parsed native bridge request.
#[derive(Clone, Debug, PartialEq)]
pub enum BridgeRequest {
    /// 这一段是原生快捷键请求。
    /// Native shortcut request.
    Shortcut(mouse_gestures::ShortcutRequest),
    /// 这一段是外部 Diff 请求。
    /// External diff request.
    ExternalDiff(diff_hover_preview::ExternalDiffRequest),
    /// 这一段是 Git 摘要请求。
    /// Git summary request.
    GitDiffSummary(diff_hover_preview::GitDiffSummaryRequest),
    /// 这一段是云端设置同步请求。
    /// Cloud settings sync request.
    CloudSync(cloud_sync::CloudSyncRequest),
    /// 这一段是宠物同步请求。
    /// Pet sync request.
    PetSync(pet_sync::PetSyncRequest),
    /// 这一段是会话归档请求。
    /// Conversation archive request.
    ConversationArchive(conversation_archive::ConversationArchiveRequest),
    /// 这一段是 Today token 本机聚合请求。
    /// Local Today token aggregation request.
    TodayTokenUsage(today_token_usage::TodayTokenUsageRequest),
}

/// 这一段描述业务任务要交回 CDP 主循环处理的事件。
/// Describes an event that business tasks hand back to the CDP main loop.
#[derive(Clone, Debug, PartialEq)]
pub enum BridgeWorkerEvent {
    /// 这一段是需要在页面执行的快捷键请求。
    /// Shortcut request to run on the page.
    Shortcut(mouse_gestures::ShortcutRequest),
    /// 这一段是需要派发给页面的响应事件。
    /// Response event to dispatch to the page.
    Response {
        /// 这一段是页面请求 id。
        /// Page request id.
        request_id: String,
        /// 这一段是页面响应类型。
        /// Page response type.
        response_type: &'static str,
        /// 这一段是 handler 响应体。
        /// Handler response body.
        response: Value,
    },
}

/// 这一段定义业务任务回传事件的发送端。
/// Sender used by business tasks to return events.
pub type BridgeWorkerEventSender = mpsc::UnboundedSender<BridgeWorkerEvent>;

/// 这一段解析页面传来的 bridge payload。
/// Parse a bridge payload from the page.
pub fn parse_native_bridge_request(
    binding_name: &str,
    payload: &str,
    native_bridge: &NativeBridgeConfig,
) -> Option<BridgeRequest> {
    // 这一段先验证 binding 名和 payload 大小。
    // Validate binding name and payload size first.
    if binding_name != native_bridge.binding_name
        || payload.len() > NATIVE_BRIDGE_MAX_PAYLOAD_LENGTH
    {
        return None;
    }
    let value: Value = serde_json::from_str(payload).ok()?;
    if value.get("bridgeId").and_then(Value::as_str) != Some(native_bridge.bridge_id.as_str()) {
        return None;
    }
    match value.get("type").and_then(Value::as_str)? {
        "shortcut" => mouse_gestures::parse_shortcut_request(&value).map(BridgeRequest::Shortcut),
        "external-diff" => {
            diff_hover_preview::parse_external_diff_request(&value).map(BridgeRequest::ExternalDiff)
        }
        "git-diff-summary" => diff_hover_preview::parse_git_diff_summary_request(&value)
            .map(BridgeRequest::GitDiffSummary),
        "cloud-sync" => cloud_sync::parse_cloud_sync_request(&value).map(BridgeRequest::CloudSync),
        "pet-sync" => pet_sync::parse_pet_sync_request(&value).map(BridgeRequest::PetSync),
        "conversation-archive" => conversation_archive::parse_conversation_archive_request(&value)
            .map(BridgeRequest::ConversationArchive),
        "today-token-usage" => today_token_usage::parse_today_token_usage_request(&value)
            .map(BridgeRequest::TodayTokenUsage),
        _ => None,
    }
}

/// 这一段分发 native bridge 请求。
/// Dispatch a native bridge request.
pub fn dispatch_native_bridge_request(events: BridgeWorkerEventSender, request: BridgeRequest) {
    // 这一段只启动业务任务或投递轻量事件，不阻塞 CDP 读取循环。
    // Start business tasks or enqueue lightweight events without blocking the CDP read loop.
    match request {
        BridgeRequest::Shortcut(request) => {
            let _ = events.send(BridgeWorkerEvent::Shortcut(request));
        }
        BridgeRequest::ExternalDiff(request) => {
            tokio::spawn(async move {
                let _ = diff_hover_preview::open_external_diff(request).await;
            });
        }
        BridgeRequest::GitDiffSummary(request) => {
            tokio::spawn(async move {
                let request_id = request.request_id.clone();
                let response = diff_hover_preview::read_git_diff_summary(&request)
                    .await
                    .unwrap_or(Value::Null);
                send_response(events, request_id, "git-diff-summary", response);
            });
        }
        BridgeRequest::CloudSync(request) => {
            tokio::spawn(async move {
                let request_id = request.request_id.clone();
                let response = cloud_sync::run_cloud_sync_request(&request)
                    .await
                    .unwrap_or_else(|error| json!({ "ok": false, "status": 0, "data": null, "error": error.to_string() }));
                send_response(events, request_id, "cloud-sync", response);
            });
        }
        BridgeRequest::PetSync(request) => {
            tokio::spawn(async move {
                let request_id = request.request_id.clone();
                let response = pet_sync::run_pet_sync_request(&request)
                    .await
                    .unwrap_or_else(|error| json!({ "ok": false, "status": 0, "data": null, "error": error.to_string() }));
                send_response(events, request_id, "pet-sync", response);
            });
        }
        BridgeRequest::ConversationArchive(request) => {
            dispatch_conversation_archive_request(events, request);
        }
        BridgeRequest::TodayTokenUsage(request) => {
            tokio::spawn(async move {
                let request_id = request.request_id.clone();
                let response = today_token_usage::run_today_token_usage_request(&request)
                    .await
                    .unwrap_or_else(|error| {
                        json!({ "ok": false, "status": 0, "data": null, "error": error.to_string() })
                    });
                send_response(events, request_id, "today-token-usage", response);
            });
        }
    }
}

/// 这一段处理需要访问 CDP client 的 worker 事件。
/// Handle worker events that need access to the CDP client.
pub async fn handle_bridge_worker_event(
    client: &mut CdpClient,
    native_bridge: &NativeBridgeConfig,
    event: BridgeWorkerEvent,
) {
    // 这一段把所有 CDP 写操作集中在 worker 主循环，避免多任务并发写 websocket。
    // Keep all CDP writes in the worker main loop to avoid concurrent websocket writes.
    match event {
        BridgeWorkerEvent::Shortcut(request) => {
            let _ = mouse_gestures::dispatch_native_shortcut(client, &request).await;
        }
        BridgeWorkerEvent::Response {
            request_id,
            response_type,
            response,
        } => {
            let _ =
                send_response_value(client, native_bridge, &request_id, response_type, response)
                    .await;
        }
    }
}

/// 这一段分发会话归档请求并转发进度事件。
/// Dispatch a conversation archive request and forward progress events.
fn dispatch_conversation_archive_request(
    events: BridgeWorkerEventSender,
    request: conversation_archive::ConversationArchiveRequest,
) {
    // 这一段用通道让长任务可以在最终响应前持续通知页面。
    // Use a channel so the long-running task can notify the page before the final response.
    let request_id = request.request_id.clone();
    let (progress_tx, mut progress_rx) = mpsc::unbounded_channel();
    tokio::spawn(async move {
        let task_request = request.clone();
        let events_for_progress = events.clone();
        let progress_request_id = request_id.clone();
        let progress_forwarder = tokio::spawn(async move {
            while let Some(progress) = progress_rx.recv().await {
                send_response(
                    events_for_progress.clone(),
                    progress_request_id.clone(),
                    "conversation-archive-progress",
                    conversation_archive::progress::progress_response(progress),
                );
            }
        });
        let response = conversation_archive::run_conversation_archive_request(
            &task_request,
            Some(progress_tx),
        )
        .await
        .unwrap_or_else(
            |error| json!({ "ok": false, "status": 0, "data": null, "error": error.to_string() }),
        );
        let _ = progress_forwarder.await;
        send_response(events, request_id, "conversation-archive", response);
    });
}

/// 这一段发送 handler 响应事件。
/// Send a handler response event.
fn send_response(
    events: BridgeWorkerEventSender,
    request_id: String,
    response_type: &'static str,
    response: Value,
) {
    // 这一段把页面回包交给 worker 主循环串行发送。
    // Hand page responses to the worker main loop for serial sending.
    let _ = events.send(BridgeWorkerEvent::Response {
        request_id,
        response_type,
        response,
    });
}

/// 这一段把响应写回页面 CustomEvent。
/// Write a response back through a page CustomEvent.
async fn send_response_value(
    client: &mut CdpClient,
    native_bridge: &NativeBridgeConfig,
    request_id: &str,
    response_type: &str,
    response: Value,
) -> anyhow::Result<()> {
    // 这一段用 Runtime.evaluate 派发事件，不暴露任意代码给页面输入。
    // Dispatch a Runtime.evaluate event without exposing arbitrary code from page input.
    let detail = json!({
        "requestId": request_id,
        "response": response,
        "type": response_type,
    });
    let expression = build_response_expression(native_bridge, &detail)?;
    client
        .send(
            "Runtime.evaluate",
            json!({
                "expression": expression,
                "awaitPromise": false,
                "allowUnsafeEvalBlockedByCSP": true,
            }),
        )
        .await
        .map(|_| ())
}

/// 这一段构造页面回包事件表达式。
/// Build the page response-event expression.
fn build_response_expression(
    native_bridge: &NativeBridgeConfig,
    detail: &Value,
) -> anyhow::Result<String> {
    Ok(format!(
        r#"(() => {{
  const bridgeId = {};
  const eventName = {};
  const detail = {};
  if (window.__codexProNativeBridgeConfig?.bridgeId !== bridgeId) return false;
  window.dispatchEvent(new CustomEvent(eventName, {{ detail }}));
  return true;
}})()"#,
        serde_json::to_string(&native_bridge.bridge_id)?,
        serde_json::to_string(NATIVE_BRIDGE_RESPONSE_EVENT_NAME)?,
        serde_json::to_string(detail)?,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn response_expression_dispatches_event_directly() {
        // 这一段确认回包表达式仍对齐旧 Node 版的同步 CustomEvent 派发形态。
        // Confirm the response expression keeps the legacy Node-style synchronous CustomEvent dispatch shape.
        let native_bridge = NativeBridgeConfig {
            binding_name: "__codexProNativeBridge_test".to_string(),
            bridge_id: "bridge_test".to_string(),
            protocol_version: crate::protocol::NATIVE_BRIDGE_PROTOCOL_VERSION,
        };
        let detail = json!({
            "requestId": "req_test",
            "response": { "ok": true },
            "type": "conversation-archive",
        });

        let expression = build_response_expression(&native_bridge, &detail).unwrap();

        assert!(expression.contains("window.dispatchEvent"));
        assert!(!expression.contains("window.setTimeout"));
        assert!(expression.contains("bridge_test"));
        assert!(expression.contains("req_test"));
    }

    #[test]
    fn bridge_worker_event_response_dispatches_event() {
        // 这一段确认 worker 响应事件保留页面回包需要的请求元数据。
        // Confirm response worker events keep the request metadata needed by page responses.
        let native_bridge = NativeBridgeConfig {
            binding_name: "__codexProNativeBridge_test".to_string(),
            bridge_id: "bridge_test".to_string(),
            protocol_version: crate::protocol::NATIVE_BRIDGE_PROTOCOL_VERSION,
        };
        let event = BridgeWorkerEvent::Response {
            request_id: "req_test".to_string(),
            response_type: "conversation-archive-progress",
            response: json!({ "ok": true }),
        };
        let BridgeWorkerEvent::Response {
            request_id,
            response_type,
            response,
        } = event
        else {
            panic!("expected response event");
        };

        let expression = build_response_expression(
            &native_bridge,
            &json!({ "requestId": request_id, "response": response, "type": response_type }),
        )
        .unwrap();

        assert!(expression.contains("conversation-archive-progress"));
        assert!(expression.contains("bridge_test"));
        assert!(expression.contains("req_test"));
    }
}
