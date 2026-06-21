use anyhow::{Context, bail};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{HashMap, VecDeque};
use std::time::Duration;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;

/// 这一段定义 CDP HTTP 查询超时。
/// CDP HTTP query timeout.
const CDP_HTTP_TIMEOUT: Duration = Duration::from_secs(3);
/// 这一段定义 CDP WebSocket 命令超时。
/// CDP WebSocket command timeout.
const CDP_COMMAND_TIMEOUT: Duration = Duration::from_secs(8);

/// 这一段描述 Chromium DevTools Protocol 页面目标。
/// Describes a Chromium DevTools Protocol page target.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct CdpTarget {
    /// 这一段是 target id。
    /// Target id.
    pub id: String,
    /// 这一段是 target 类型。
    /// Target type.
    #[serde(rename = "type")]
    pub target_type: String,
    /// 这一段是页面标题。
    /// Page title.
    #[serde(default)]
    pub title: String,
    /// 这一段是页面 URL。
    /// Page URL.
    #[serde(default)]
    pub url: String,
    /// 这一段是可连接 WebSocket 调试地址。
    /// WebSocket debugger URL.
    #[serde(default, rename = "webSocketDebuggerUrl")]
    pub web_socket_debugger_url: Option<String>,
}

/// 这一段判断目标是否是可调试 page。
/// Return whether a target is a debuggable page.
pub fn is_page_target(target: &CdpTarget) -> bool {
    // 这一段只接受带 WebSocket 地址的 page。
    // Accept only page targets with WebSocket URLs.
    target.target_type == "page"
        && target
            .web_socket_debugger_url
            .as_deref()
            .is_some_and(|value| !value.is_empty())
}

/// 这一段判断目标是否是 Codex 宠物悬浮窗。
/// Return whether the target is the Codex avatar overlay.
pub fn is_auxiliary_codex_page_target(target: &CdpTarget) -> bool {
    // 这一段按 initialRoute=/avatar-overlay 排除辅助窗口。
    // Exclude auxiliary windows by initialRoute=/avatar-overlay.
    if !is_page_target(target) {
        return false;
    }
    url::Url::parse(&target.url)
        .ok()
        .and_then(|url| {
            url.query_pairs()
                .find(|(key, _)| key == "initialRoute")
                .map(|(_, value)| value.to_string())
        })
        .is_some_and(|value| value == "/avatar-overlay")
}

/// 这一段判断目标是否是 Codex 主窗口。
/// Return whether the target is the Codex main window.
pub fn is_main_codex_page_target(target: &CdpTarget) -> bool {
    // 这一段优先匹配 app://-/index.html 且没有 initialRoute 的主窗口。
    // Prefer app://-/index.html without initialRoute.
    if !is_page_target(target) || is_auxiliary_codex_page_target(target) {
        return false;
    }
    let Ok(url) = url::Url::parse(&target.url) else {
        return false;
    };
    let has_initial_route = url.query_pairs().any(|(key, _)| key == "initialRoute");
    url.scheme() == "app"
        && url.host_str() == Some("-")
        && url.path() == "/index.html"
        && !has_initial_route
}

/// 这一段从目标列表里选择可注入主页面。
/// Pick the injectable main page target from a target list.
pub fn pick_page_target(targets: &[CdpTarget]) -> Option<CdpTarget> {
    // 这一段先找真实主窗口，再用非辅助 Codex 页面作为兼容兜底。
    // Prefer the real main window, then fall back to a non-auxiliary Codex page.
    targets
        .iter()
        .find(|target| is_main_codex_page_target(target))
        .cloned()
        .or_else(|| {
            targets
                .iter()
                .filter(|target| is_page_target(target) && !is_auxiliary_codex_page_target(target))
                .find(|target| {
                    format!("{} {}", target.title, target.url)
                        .to_ascii_lowercase()
                        .contains("codex")
                })
                .cloned()
        })
}

/// 这一段读取 CDP target 列表。
/// Read CDP targets from the loopback debugging endpoint.
pub async fn list_targets(debug_port: u16) -> anyhow::Result<Vec<CdpTarget>> {
    // 这一段禁用代理并限制超时，避免本地 CDP 请求被系统代理影响。
    // Disable proxies and bound timeout so local CDP calls are not routed externally.
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(CDP_HTTP_TIMEOUT)
        .build()
        .context("failed to build CDP HTTP client")?;
    let urls = [
        format!("http://127.0.0.1:{debug_port}/json"),
        format!("http://[::1]:{debug_port}/json"),
    ];
    let mut errors = Vec::new();
    for url in urls {
        match client.get(&url).send().await {
            Ok(response) => match response.error_for_status() {
                Ok(ok) => {
                    return ok
                        .json::<Vec<CdpTarget>>()
                        .await
                        .context("failed to parse CDP target list");
                }
                Err(error) => errors.push(format!("{url}: {error}")),
            },
            Err(error) => errors.push(format!("{url}: {error}")),
        }
    }
    bail!("failed to query CDP targets: {}", errors.join("; "))
}

/// 这一段快速判断当前端口是否已有可注入的 Codex 主页面。
/// Quickly determine whether the port already exposes an injectable Codex page.
pub async fn has_injectable_target(debug_port: u16) -> bool {
    // 这一段只做一次轻量探测，用于 launcher 决策，不替代后续正式注入等待。
    // Probe once for launcher decisions; this does not replace the later injection wait.
    list_targets(debug_port)
        .await
        .ok()
        .and_then(|targets| pick_page_target(&targets))
        .is_some()
}

/// 这一段等待可注入 CDP 页面出现。
/// Wait for an injectable CDP page target.
pub async fn wait_for_target(debug_port: u16, timeout_ms: u64) -> anyhow::Result<CdpTarget> {
    // 这一段短轮询，兼容 Codex 冷启动。
    // Poll briefly to handle Codex cold startup.
    let started = std::time::Instant::now();
    let timeout = Duration::from_millis(timeout_ms.max(1000));
    let mut last_error = "unknown error".to_string();
    while started.elapsed() <= timeout {
        match list_targets(debug_port).await {
            Ok(targets) => {
                if let Some(target) = pick_page_target(&targets) {
                    return Ok(target);
                }
                last_error = "No page target found".to_string();
            }
            Err(error) => last_error = error.to_string(),
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    bail!("Timed out waiting for CDP target: {last_error}")
}

/// 这一段封装 CDP WebSocket 会话。
/// Wraps a CDP WebSocket session.
pub struct CdpClient {
    /// 这一段是 WebSocket 流。
    /// WebSocket stream.
    socket: tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    /// 这一段是递增消息 id。
    /// Incrementing message id.
    next_id: u64,
    /// 这一段缓存非当前请求的响应。
    /// Responses received while waiting for another id.
    pending_responses: HashMap<u64, Value>,
    /// 这一段缓存等待命令响应时读到的 CDP 事件，避免吞掉 Runtime.bindingCalled。
    /// Events received while waiting for a command response, preventing Runtime.bindingCalled from being swallowed.
    pending_events: VecDeque<Value>,
}

impl CdpClient {
    /// 这一段连接 CDP WebSocket。
    /// Connect to a CDP WebSocket.
    pub async fn connect(websocket_url: &str) -> anyhow::Result<Self> {
        // 这一段建立 websocket 并初始化请求状态。
        // Open the websocket and initialize request state.
        let (socket, _) =
            tokio::time::timeout(Duration::from_secs(5), connect_async(websocket_url))
                .await
                .context("timed out connecting CDP websocket")?
                .context("failed to connect CDP websocket")?;
        Ok(Self {
            socket,
            next_id: 1,
            pending_responses: HashMap::new(),
            pending_events: VecDeque::new(),
        })
    }

    /// 这一段发送 CDP 命令并等待对应响应。
    /// Send a CDP command and wait for its matching response.
    pub async fn send(&mut self, method: &str, params: Value) -> anyhow::Result<Value> {
        // 这一段为请求分配 id 并写入 websocket。
        // Allocate an id and write the request to the websocket.
        let id = self.next_id;
        self.next_id += 1;
        self.socket
            .send(Message::Text(
                json!({ "id": id, "method": method, "params": params })
                    .to_string()
                    .into(),
            ))
            .await
            .with_context(|| format!("failed to send CDP command {method}"))?;
        tokio::time::timeout(
            CDP_COMMAND_TIMEOUT,
            self.wait_for_id(id, method.to_string()),
        )
        .await
        .with_context(|| format!("timed out waiting for CDP command {method}"))?
    }

    /// 这一段读取下一条 websocket 消息。
    /// Read the next websocket message.
    pub async fn next_message(&mut self) -> anyhow::Result<Option<Value>> {
        // 这一段优先吐出 send() 等命令响应时暂存的事件，恢复旧 Node CDP client 不丢事件的行为。
        // Prefer events cached while send() waited for command responses, matching the legacy Node CDP client's non-dropping behavior.
        if let Some(message) = self.pending_events.pop_front() {
            return Ok(Some(message));
        }
        self.read_socket_message().await
    }

    /// 这一段直接读取底层 websocket，不消费暂存事件。
    /// Read the underlying websocket directly without consuming cached events.
    async fn read_socket_message(&mut self) -> anyhow::Result<Option<Value>> {
        // 这一段只解析文本消息；其它消息按空对象处理。
        // Parse text messages; treat non-text messages as empty objects.
        let Some(message) = self.socket.next().await else {
            return Ok(None);
        };
        let message = message.context("failed to read CDP websocket message")?;
        let Message::Text(text) = message else {
            return Ok(Some(json!({})));
        };
        serde_json::from_str(&text)
            .context("failed to parse CDP websocket message")
            .map(Some)
    }

    /// 这一段关闭 websocket。
    /// Close the websocket.
    pub async fn close(&mut self) {
        // 这一段忽略关闭失败，避免掩盖调用方原始错误。
        // Ignore close failures so original caller errors are not hidden.
        let _ = self.socket.close(None).await;
    }

    /// 这一段等待指定 id 的命令响应。
    /// Wait for the response matching a command id.
    async fn wait_for_id(&mut self, id: u64, method: String) -> anyhow::Result<Value> {
        // 这一段先检查之前乱序缓存的响应。
        // Check responses cached from earlier out-of-order messages first.
        if let Some(response) = self.pending_responses.remove(&id) {
            return command_result(response, &method);
        }

        // 这一段读取消息直到拿到对应 id。
        // Read messages until the matching id is found.
        loop {
            let Some(message) = self.read_socket_message().await? else {
                bail!("CDP websocket closed before response for {method}");
            };
            if let Some(response_id) = message.get("id").and_then(Value::as_u64) {
                if response_id == id {
                    return command_result(message, &method);
                }
                self.pending_responses.insert(response_id, message);
            } else {
                self.pending_events.push_back(message);
            }
        }
    }
}

/// 这一段把 CDP error 字段转换成 anyhow 错误。
/// Convert CDP error responses into anyhow errors.
fn command_result(response: Value, method: &str) -> anyhow::Result<Value> {
    // 这一段保留原始 CDP error JSON，方便诊断官方接口变化。
    // Preserve the original CDP error JSON for diagnostics.
    if let Some(error) = response.get("error") {
        bail!("CDP command {method} failed: {error}");
    }
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pick_page_target_prefers_main_window_over_avatar_overlay() {
        let targets = vec![
            CdpTarget {
                id: "pet".to_string(),
                target_type: "page".to_string(),
                title: "Codex".to_string(),
                url: "app://-/index.html?initialRoute=%2Favatar-overlay".to_string(),
                web_socket_debugger_url: Some("ws://pet".to_string()),
            },
            CdpTarget {
                id: "main".to_string(),
                target_type: "page".to_string(),
                title: "Codex".to_string(),
                url: "app://-/index.html".to_string(),
                web_socket_debugger_url: Some("ws://main".to_string()),
            },
        ];
        assert_eq!(pick_page_target(&targets).unwrap().id, "main");
    }

    #[tokio::test]
    async fn send_caches_events_seen_while_waiting_for_response() {
        // 这一段模拟旧 Node CDP client 的行为：等待 Runtime.evaluate 回包时收到的 binding 事件不能被吞掉。
        // Simulate the legacy Node CDP client behavior: binding events received while waiting for Runtime.evaluate must not be swallowed.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
            let request_message = socket.next().await.unwrap().unwrap();
            let Message::Text(request_text) = request_message else {
                panic!("expected text CDP command");
            };
            let request: Value = serde_json::from_str(&request_text).unwrap();
            let request_id = request.get("id").and_then(Value::as_u64).unwrap();

            // 这一段故意先发送无 id 的 CDP 事件，再发送命令响应，复现 Rust bridge 之前会丢事件的顺序。
            // Send the id-less CDP event before the command response to reproduce the order the Rust bridge previously dropped.
            socket
                .send(Message::Text(
                    json!({
                        "method": "Runtime.bindingCalled",
                        "params": {
                            "name": "__codexProNativeBridge_test",
                            "payload": "{}",
                        },
                    })
                    .to_string()
                    .into(),
                ))
                .await
                .unwrap();
            socket
                .send(Message::Text(
                    json!({
                        "id": request_id,
                        "result": { "ok": true },
                    })
                    .to_string()
                    .into(),
                ))
                .await
                .unwrap();
        });

        let mut client = CdpClient::connect(&format!("ws://{address}"))
            .await
            .unwrap();
        let response = client.send("Runtime.evaluate", json!({})).await.unwrap();
        let cached_event = client.next_message().await.unwrap().unwrap();

        assert_eq!(response["result"]["ok"], true);
        assert_eq!(
            cached_event.get("method").and_then(Value::as_str),
            Some("Runtime.bindingCalled"),
        );
        server.await.unwrap();
    }
}
