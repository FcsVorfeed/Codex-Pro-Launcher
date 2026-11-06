use super::*;
use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::{JoinHandle, JoinSet};
use tokio_tungstenite::tungstenite::Message;

/// 这一段定义真实 TCP/WebSocket 测试服务的故障模式。
/// Describe fault modes for the real TCP/WebSocket test server.
#[derive(Clone, Copy)]
enum Fault {
    /// 这一段在指定命令第一次执行时正常关闭连接。
    /// Close the connection on the first execution of the selected command.
    CloseOnce(&'static str),
    /// 这一段模拟没有关闭握手的连接重置。
    /// Simulate a reset without a closing handshake.
    ResetOnce,
    /// 这一段让所有连接都断开，用于验证总时限。
    /// Disconnect every session to verify the shared deadline.
    AlwaysClose,
    /// 这一段返回业务协议错误，用于确认不会重试。
    /// Return an application protocol error to verify it is not retried.
    CommandError,
    /// 这一段模拟同名 binding 已存在的既有可接受响应。
    /// Simulate the existing acceptable response for a duplicate binding.
    BindingExists,
    /// 这一段不回应命令，验证总时限能取消挂起请求。
    /// Leave a command unanswered to verify cancellation at the shared deadline.
    Stall,
}

/// 这一段保存有限的测试观测数据，不启动真实客户端。
/// Hold bounded test observations without starting a real client.
struct MockCdp {
    /// 这一段是操作系统分配的测试端口。
    /// OS-assigned test port.
    port: u16,
    /// 这一段统计 target 被重新发现的次数。
    /// Count target rediscovery requests.
    discoveries: Arc<AtomicUsize>,
    /// 这一段记录每条连接实际收到的命令。
    /// Record commands actually received by each connection.
    commands: Arc<Mutex<Vec<(usize, String)>>>,
    /// 这一段持有服务任务，离开测试作用域即取消。
    /// Own the server task so leaving the test scope cancels it.
    task: JoinHandle<()>,
}

impl Drop for MockCdp {
    /// 这一段取消监听任务及其 JoinSet 子任务，避免测试泄漏 socket。
    /// Cancel the listener and its JoinSet children to avoid leaking test sockets.
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl MockCdp {
    /// 这一段在同一个端口模拟 CDP HTTP 发现和 WebSocket 命令处理。
    /// Simulate CDP HTTP discovery and WebSocket commands on one port.
    async fn start(fault: Fault) -> Self {
        // 这一段使用临时端口及独立状态，允许多个测试同时运行。
        // Use an ephemeral port and isolated state so tests can run concurrently.
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let discoveries = Arc::new(AtomicUsize::new(0));
        let commands = Arc::new(Mutex::new(Vec::new()));
        let observed_discoveries = discoveries.clone();
        let observed_commands = commands.clone();
        let task = tokio::spawn(async move {
            let mut sessions = JoinSet::new();
            loop {
                tokio::select! {
                    connection = listener.accept() => {
                        let (stream, _) = connection.unwrap();
                        sessions.spawn(serve_connection(stream, port, fault,
                            observed_discoveries.clone(), observed_commands.clone()));
                    }
                    Some(result) = sessions.join_next(), if !sessions.is_empty() => { result.unwrap(); }
                }
            }
        });
        Self {
            port,
            discoveries,
            commands,
            task,
        }
    }
}

/// 这一段让每次 HTTP 发现返回不同 target，确保重连必须使用新地址。
/// Return a different target on each discovery so reconnection must use the new address.
async fn serve_connection(
    mut stream: TcpStream,
    port: u16,
    fault: Fault,
    discoveries: Arc<AtomicUsize>,
    commands: Arc<Mutex<Vec<(usize, String)>>>,
) {
    // 这一段先只窥视请求行，让 WebSocket 握手函数仍能读取完整请求。
    // Peek at the request line so the WebSocket handshake still receives the full request.
    let mut prefix = [0; 512];
    let length = loop {
        let length = stream.peek(&mut prefix).await.unwrap();
        assert!(length > 0 && length < prefix.len());
        if prefix[..length].windows(2).any(|pair| pair == b"\r\n") {
            break length;
        }
        sleep(Duration::from_millis(1)).await;
    };
    let request = String::from_utf8_lossy(&prefix[..length]);
    if request.starts_with("GET /json ") {
        let generation = discoveries.fetch_add(1, Ordering::SeqCst) + 1;
        let body = json!([{
            "id": format!("main-{generation}"), "type": "page", "url": "app://-/index.html",
            "webSocketDebuggerUrl": format!("ws://127.0.0.1:{port}/devtools/page/{generation}")
        }])
        .to_string();
        let mut request_bytes = [0; 4096];
        stream.read(&mut request_bytes).await.unwrap();
        stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
        return;
    }
    let generation: usize = request
        .split_whitespace()
        .nth(1)
        .unwrap()
        .rsplit('/')
        .next()
        .unwrap()
        .parse()
        .unwrap();
    let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();

    // 这一段按真实 CDP 消息编号响应，并在指定阶段注入连接级或业务级故障。
    // Respond using actual CDP message IDs and inject transport or application faults by stage.
    while let Some(Ok(Message::Text(text))) = socket.next().await {
        let message: Value = serde_json::from_str(&text).unwrap();
        let method = message["method"].as_str().unwrap();
        commands
            .lock()
            .unwrap()
            .push((generation, method.to_string()));
        if matches!(fault, Fault::ResetOnce) && generation == 1 {
            return;
        }
        if matches!(fault, Fault::AlwaysClose)
            || matches!(fault, Fault::CloseOnce(stage) if generation == 1 && method == stage)
        {
            socket.close(None).await.unwrap();
            return;
        }
        if matches!(fault, Fault::Stall) {
            std::future::pending::<()>().await;
        }
        let response = if matches!(fault, Fault::BindingExists) && method == "Runtime.addBinding" {
            json!({"id": message["id"], "error": {"code": -32000, "message": "binding already exists"}})
        } else if matches!(fault, Fault::CommandError) {
            json!({"id": message["id"], "error": {"code": -32601, "message": "unsupported test command"}})
        } else if method == "Runtime.evaluate" {
            let marker = message["params"]["expression"]
                .as_str()
                .unwrap()
                .contains("__codexProSplitItemsHotpathPatch");
            json!({"id": message["id"], "result": {"result": {"type": "boolean", "value": !marker}}})
        } else {
            json!({"id": message["id"], "result": {}})
        };
        if socket
            .send(Message::Text(response.to_string().into()))
            .await
            .is_err()
        {
            return;
        }
    }
}

/// 这一段用公开占位配置验证 binding 阶段，不读取真实运行配置。
/// Use a public placeholder binding configuration without reading real runtime config.
fn binding() -> NativeBridgeConfig {
    NativeBridgeConfig {
        binding_name: "__testBinding".into(),
        bridge_id: "test".into(),
        protocol_version: 1,
    }
}

/// 这一段验证初始化、可选补丁和 binding 断线都会重新发现主窗口。
/// Verify disconnects during initialization, optional patching and binding rediscover the window.
#[tokio::test]
async fn reconnects_before_injection_and_preserves_first_patch_disconnect() {
    for stage in ["Runtime.enable", "Runtime.evaluate", "Runtime.addBinding"] {
        let server = MockCdp::start(Fault::CloseOnce(stage)).await;
        let disabled = if stage == "Runtime.evaluate" {
            vec![]
        } else {
            vec!["split-items-hotpath-patch".into()]
        };
        let (target, mut client) =
            prepare_connection(server.port, 5000, &disabled, Some(&binding()))
                .await
                .unwrap();
        assert_eq!(target.id, "main-2");
        assert_eq!(server.discoveries.load(Ordering::SeqCst), 2);
        let commands = server.commands.lock().unwrap().clone();
        assert_eq!(
            commands
                .iter()
                .filter(|(generation, _)| *generation == 1)
                .last()
                .unwrap()
                .1,
            stage
        );
        assert_eq!(commands.last().unwrap(), &(2, "Runtime.addBinding".into()));
        assert!(
            !commands
                .iter()
                .any(|(_, method)| method == "Page.addScriptToEvaluateOnNewDocument")
        );
        client.close().await;
    }
}

/// 这一段验证无握手连接重置也能恢复，但业务协议错误不能重试。
/// Verify recovery from a reset without a handshake, but never retry application errors.
#[tokio::test]
async fn resets_reconnect_but_command_errors_return_immediately() {
    let disabled = vec!["split-items-hotpath-patch".into()];
    let server = MockCdp::start(Fault::ResetOnce).await;
    let (target, mut client) = prepare_connection(server.port, 3000, &disabled, None)
        .await
        .unwrap();
    assert_eq!(target.id, "main-2");
    client.close().await;
    let server = MockCdp::start(Fault::CommandError).await;
    let error = prepare_connection(server.port, 3000, &disabled, None)
        .await
        .err()
        .unwrap();
    assert!(!is_connection_loss(&error));
    assert!(format!("{error:#}").contains("unsupported test command"));
    assert_eq!(server.discoveries.load(Ordering::SeqCst), 1);
}

/// 这一段验证错误增强不破坏后台桥和启动器对已存在 binding 的处理。
/// Ensure error enrichment preserves duplicate-binding handling for the bridge and launcher.
#[tokio::test]
async fn existing_binding_remains_accepted_without_reconnection() {
    let server = MockCdp::start(Fault::BindingExists).await;
    let (_, mut client) = prepare_connection(
        server.port,
        3000,
        &["split-items-hotpath-patch".into()],
        Some(&binding()),
    )
    .await
    .unwrap();
    let error = client
        .send("Runtime.addBinding", json!({"name":"__testBinding"}))
        .await
        .unwrap_err();
    assert!(error.to_string().contains("already exists"));
    assert!(client.ensure_connected().is_ok());
    assert_eq!(server.discoveries.load(Ordering::SeqCst), 1);
    client.close().await;
}

/// 这一段验证可选补丁捕获错误后仍保留第一次断线的命令和原因。
/// Preserve the first command and reason even if optional patch code catches the error.
#[tokio::test]
async fn disconnected_client_keeps_first_command_instead_of_later_binding() {
    let server = MockCdp::start(Fault::CloseOnce("Runtime.evaluate")).await;
    let target = wait_for_target(server.port, 3000).await.unwrap();
    let mut client = CdpClient::connect(target.web_socket_debugger_url.as_deref().unwrap())
        .await
        .unwrap();
    let _ = client
        .send("Runtime.evaluate", json!({"expression":"true"}))
        .await;
    let error = client
        .send("Runtime.addBinding", json!({"name":"__testBinding"}))
        .await
        .unwrap_err();
    assert!(is_connection_loss(&error));
    assert!(error.to_string().contains("Runtime.evaluate"));
    assert!(error.to_string().contains("close frame"));
    assert!(!error.to_string().contains("Runtime.addBinding"));
    assert_eq!(server.commands.lock().unwrap().len(), 1);
    client.close().await;
}

/// 这一段验证真正注册注入脚本后发生的断线不会重放注入。
/// Verify a disconnect after script registration never replays injection.
#[tokio::test]
async fn script_registration_disconnect_is_not_retried() {
    let server = MockCdp::start(Fault::CloseOnce("Page.addScriptToEvaluateOnNewDocument")).await;
    let error = crate::injection::inject(
        server.port,
        3000,
        &["split-items-hotpath-patch".into()],
        None,
        None,
    )
    .await
    .err()
    .unwrap();
    assert!(format!("{error:#}").contains("Page.addScriptToEvaluateOnNewDocument"));
    assert_eq!(server.discoveries.load(Ordering::SeqCst), 1);
    assert!(
        !server
            .commands
            .lock()
            .unwrap()
            .iter()
            .any(|(_, method)| method == "Runtime.evaluate")
    );
}

/// 这一段验证连续断线和挂起命令均受一个总时限约束，并保留首个失败阶段。
/// Bound repeated disconnects and stalled commands by one deadline, preserving the first stage.
#[tokio::test]
async fn deadline_bounds_retries_and_hung_commands() {
    for fault in [Fault::AlwaysClose, Fault::Stall] {
        let server = MockCdp::start(fault).await;
        let start = Instant::now();
        let error = prepare_connection(
            server.port,
            1000,
            &["split-items-hotpath-patch".into()],
            None,
        )
        .await
        .err()
        .unwrap();
        let message = format!("{error:#}");
        assert!(message.contains("deadline"), "{message}");
        assert!(message.contains("Runtime.enable"), "{message}");
        assert!(start.elapsed() < Duration::from_millis(1800));
        if matches!(fault, Fault::AlwaysClose) {
            assert!(server.discoveries.load(Ordering::SeqCst) >= 2);
            assert!(message.contains("close frame"));
            assert!(!message.contains("Runtime.addBinding"));
        } else {
            assert_eq!(server.discoveries.load(Ordering::SeqCst), 1);
        }
    }
}
