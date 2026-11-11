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
    /// 这一段保持同一 target 并丢弃首次注册响应，模拟请求已被接受而回包丢失。
    /// Keep the same target and lose the first registration response after accepting its source.
    RegistrationResponseLost,
    /// 这一段丢弃实际执行的回包，分别覆盖同文档和新文档恢复。
    /// Lose the evaluation response for same-document and replacement-document recovery.
    ExecutionResponseLost(bool),
    /// 这一段持续阻塞实际执行，检查执行阶段也使用总时限。
    /// Stall execution to verify the shared deadline also covers evaluation.
    ExecutionStall,
    /// 这一段模拟没有关闭握手的连接重置。
    /// Simulate a reset without a closing handshake.
    ResetOnce,
    /// 这一段让所有连接都断开，用于验证总时限。
    /// Disconnect every session to verify the shared deadline.
    AlwaysClose,
    /// 这一段返回业务协议错误，用于确认不会重试。
    /// Return an application protocol error to verify it is not retried.
    CommandError,
    /// 这一段在注册阶段返回协议错误，确保不会错误重试。
    /// Return a registration protocol error to ensure it is never retried.
    RegistrationError,
    /// 这一段让注册阶段一直挂起或断开，验证注册也受总时限约束。
    /// Stall or close every registration to verify registration shares the deadline.
    RegistrationUnavailable(bool),
    /// 这一段让脚本执行返回异常详情，不能误判为注入成功。
    /// Return script exception details, which must not be reported as injection success.
    ScriptException,
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
    /// 这一段记录服务端收到的注册与执行脚本，核对重连没有更换注入标记。
    /// Record accepted registration and evaluation scripts to verify recovery preserves the marker.
    scripts: Arc<Mutex<Vec<String>>>,
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
        let scripts = Arc::new(Mutex::new(Vec::new()));
        let observed_discoveries = discoveries.clone();
        let observed_commands = commands.clone();
        let observed_scripts = scripts.clone();
        let task = tokio::spawn(async move {
            let mut sessions = JoinSet::new();
            loop {
                tokio::select! {
                    connection = listener.accept() => {
                        let (stream, _) = connection.unwrap();
                        sessions.spawn(serve_connection(stream, port, fault,
                            observed_discoveries.clone(), observed_commands.clone(), observed_scripts.clone()));
                    }
                    Some(result) = sessions.join_next(), if !sessions.is_empty() => { result.unwrap(); }
                }
            }
        });
        Self {
            port,
            discoveries,
            commands,
            scripts,
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
    scripts: Arc<Mutex<Vec<String>>>,
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
        let generation = if matches!(
            fault,
            Fault::RegistrationResponseLost | Fault::ExecutionResponseLost(true)
        ) {
            1
        } else {
            generation
        };
        let body = json!([{
            "id": format!("main-{generation}"), "type": "page", "url": "app://-/index.html",
            "webSocketDebuggerUrl": format!("ws://127.0.0.1:{port}/devtools/page/{generation}")
        }])
        .to_string();
        let mut request_bytes = [0; 4096];
        // 这一段完整读取 HTTP 头，避免测试依赖 TCP 恰好一次收齐数据。
        // Read the complete HTTP header instead of assuming one TCP read contains everything.
        let mut read = 0;
        while !request_bytes[..read].ends_with(b"\r\n\r\n") {
            let count = stream.read(&mut request_bytes[read..]).await.unwrap();
            assert!(count > 0);
            read += count;
        }
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
        // 这一段先接受脚本，再按故障模式丢回包，覆盖“服务端已收到”的不确定结果。
        // Accept the source before losing the reply to model an uncertain server-side outcome.
        if method == "Page.addScriptToEvaluateOnNewDocument" || method == "Runtime.evaluate" {
            let key = if method == "Runtime.evaluate" {
                "expression"
            } else {
                "source"
            };
            scripts
                .lock()
                .unwrap()
                .push(message["params"][key].as_str().unwrap().to_string());
        }
        if matches!(fault, Fault::RegistrationResponseLost)
            && method == "Page.addScriptToEvaluateOnNewDocument"
            && scripts.lock().unwrap().len() == 1
        {
            return;
        }
        if matches!(fault, Fault::ExecutionResponseLost(_))
            && method == "Runtime.evaluate"
            && commands
                .lock()
                .unwrap()
                .iter()
                .filter(|(_, method)| method == "Runtime.evaluate")
                .count()
                == 1
        {
            return;
        }
        if matches!(fault, Fault::ResetOnce) && generation == 1 {
            return;
        }
        if matches!(fault, Fault::AlwaysClose)
            || matches!(fault, Fault::CloseOnce(stage) if generation == 1 && method == stage)
            || matches!(fault, Fault::RegistrationUnavailable(false) if method == "Page.addScriptToEvaluateOnNewDocument")
        {
            socket.close(None).await.unwrap();
            return;
        }
        if matches!(fault, Fault::Stall)
            || matches!(fault, Fault::ExecutionStall) && method == "Runtime.evaluate"
            || matches!(fault, Fault::RegistrationUnavailable(true) if method == "Page.addScriptToEvaluateOnNewDocument")
        {
            std::future::pending::<()>().await;
        }
        let response = if matches!(fault, Fault::BindingExists) && method == "Runtime.addBinding" {
            json!({"id": message["id"], "error": {"code": -32000, "message": "binding already exists"}})
        } else if matches!(fault, Fault::CommandError)
            || matches!(fault, Fault::RegistrationError)
                && method == "Page.addScriptToEvaluateOnNewDocument"
        {
            json!({"id": message["id"], "error": {"code": -32601, "message": "unsupported test command"}})
        } else if matches!(fault, Fault::ScriptException) && method == "Runtime.evaluate" {
            json!({"id": message["id"], "result": {"exceptionDetails": {"text": "Uncaught test error"}, "result": {"type": "object"}}})
        } else if method == "Runtime.evaluate" {
            let expression = message["params"]["expression"].as_str().unwrap();
            // 这一段回传生产脚本里的真实尝试标记；JS 副作用去重另由 VM 执行测试验证。
            // Echo the production attempt marker; VM execution tests independently verify side-effect deduplication.
            if let Some(id) = expression
                .split("const attemptId = ")
                .nth(1)
                .and_then(|tail| tail.split(';').next())
            {
                let id: Value = serde_json::from_str(id).unwrap();
                let response = json!({"id": message["id"], "result": {"result": {"type":"object", "value":{"id":id,"complete":true}}}});
                if socket
                    .send(Message::Text(response.to_string().into()))
                    .await
                    .is_err()
                {
                    return;
                }
                continue;
            }
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
            prepare_connection(server.port, 5000, &disabled, Some(&binding()), "void 0;")
                .await
                .unwrap();
        assert_eq!(target.id, "main-2");
        assert_eq!(server.discoveries.load(Ordering::SeqCst), 2);
        let commands = server.commands.lock().unwrap().clone();
        assert_eq!(
            commands
                .iter()
                .rfind(|(generation, _)| *generation == 1)
                .unwrap()
                .1,
            stage
        );
        assert_eq!(
            commands.last().unwrap(),
            &(2, "Page.addScriptToEvaluateOnNewDocument".into())
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
    let (target, mut client) = prepare_connection(server.port, 3000, &disabled, None, "void 0;")
        .await
        .unwrap();
    assert_eq!(target.id, "main-2");
    client.close().await;
    let server = MockCdp::start(Fault::CommandError).await;
    let error = prepare_connection(server.port, 3000, &disabled, None, "void 0;")
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
        "void 0;",
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

/// 这一段验证注册回包丢失后重新发现页面，功能脚本只在最终会话手动执行一次。
/// Recover a lost registration response by rediscovering the page and evaluating features once on the final session.
#[tokio::test]
async fn script_registration_disconnect_recovers_before_evaluation() {
    for fault in [
        Fault::CloseOnce("Page.addScriptToEvaluateOnNewDocument"),
        Fault::RegistrationResponseLost,
    ] {
        let server = MockCdp::start(fault).await;
        let result = crate::injection::inject(
            server.port,
            3000,
            &["split-items-hotpath-patch".into()],
            None,
            None,
        )
        .await
        .unwrap();
        let generation = if matches!(fault, Fault::RegistrationResponseLost) {
            1
        } else {
            2
        };
        assert_eq!(result.target.id, format!("main-{generation}"));
        let commands = server.commands.lock().unwrap();
        let evaluations: Vec<_> = commands
            .iter()
            .filter(|(_, method)| method == "Runtime.evaluate")
            .collect();
        assert_eq!(
            evaluations,
            vec![&(generation, "Runtime.evaluate".to_string())]
        );
        assert_eq!(
            commands
                .iter()
                .filter(|(_, method)| method == "Page.addScriptToEvaluateOnNewDocument")
                .count(),
            2
        );
        let scripts = server.scripts.lock().unwrap();
        assert_eq!(scripts.len(), 3);
        assert!(scripts.windows(2).all(|pair| pair[0] == pair[1]));
    }
}

/// 这一段验证脚本异常和注册协议错误不会盲目重放或报告成功。
/// Never replay or report success for script exceptions or registration protocol errors.
#[tokio::test]
async fn execution_failures_and_registration_errors_are_not_retried() {
    for (fault, expected) in [
        (
            Fault::ScriptException,
            "injected script reported an exception",
        ),
        (Fault::RegistrationError, "unsupported test command"),
    ] {
        let server = MockCdp::start(fault).await;
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
        assert!(format!("{error:#}").contains(expected));
        assert_eq!(server.discoveries.load(Ordering::SeqCst), 1);
        let commands = server.commands.lock().unwrap();
        assert_eq!(
            commands
                .iter()
                .filter(|(_, method)| method == "Page.addScriptToEvaluateOnNewDocument")
                .count(),
            1
        );
        assert_eq!(
            commands
                .iter()
                .filter(|(_, method)| method == "Runtime.evaluate")
                .count(),
            if matches!(fault, Fault::RegistrationError) {
                0
            } else {
                1
            }
        );
    }
}

/// 这一段覆盖实际执行回包丢失后同文档与新文档恢复，确保不会更换尝试标记。
/// Recover lost evaluation responses on the same or new document without changing attempt identity.
#[tokio::test]
async fn evaluation_response_loss_resumes_same_attempt_on_same_or_new_document() {
    for same_document in [true, false] {
        let server = MockCdp::start(Fault::ExecutionResponseLost(same_document)).await;
        let result = crate::injection::inject(
            server.port,
            3000,
            &["split-items-hotpath-patch".into()],
            None,
            None,
        )
        .await
        .unwrap();
        let scripts = server.scripts.lock().unwrap();
        assert_eq!(scripts.len(), 4);
        assert!(scripts[2].contains("const recovering = true;"));
        assert_eq!(
            scripts[0].replace("const recovering = false;", "const recovering = true;"),
            scripts[2]
        );
        assert_eq!(
            result.target.id,
            if same_document { "main-1" } else { "main-2" }
        );
    }
}

/// 这一段确认实际执行挂起不能突破启动总预算。
/// Ensure a stalled evaluation cannot exceed the startup budget.
#[tokio::test]
async fn execution_has_a_bounded_deadline() {
    let server = MockCdp::start(Fault::ExecutionStall).await;
    let started = Instant::now();
    let error = crate::injection::inject(
        server.port,
        1000,
        &["split-items-hotpath-patch".into()],
        None,
        None,
    )
    .await
    .unwrap_err();
    assert!(format!("{error:#}").contains("deadline at Runtime.evaluate"));
    assert!(started.elapsed() < Duration::from_millis(1800));
}

/// 这一段验证连续断线和挂起命令均受一个总时限约束，并保留首个失败阶段。
/// Bound repeated disconnects and stalled commands by one deadline, preserving the first stage.
#[tokio::test]
async fn deadline_bounds_retries_and_hung_commands() {
    for fault in [
        Fault::AlwaysClose,
        Fault::Stall,
        Fault::RegistrationUnavailable(false),
        Fault::RegistrationUnavailable(true),
    ] {
        let server = MockCdp::start(fault).await;
        let start = Instant::now();
        let error = prepare_connection(
            server.port,
            1000,
            &["split-items-hotpath-patch".into()],
            None,
            "void 0;",
        )
        .await
        .err()
        .unwrap();
        let message = format!("{error:#}");
        assert!(message.contains("deadline"), "{message}");
        let stage = if matches!(fault, Fault::RegistrationUnavailable(_)) {
            "Page.addScriptToEvaluateOnNewDocument"
        } else {
            "Runtime.enable"
        };
        assert!(message.contains(stage), "{message}");
        assert!(start.elapsed() < Duration::from_millis(1800));
        if matches!(
            fault,
            Fault::AlwaysClose | Fault::RegistrationUnavailable(false)
        ) {
            assert!(server.discoveries.load(Ordering::SeqCst) >= 2);
            assert!(message.contains("close frame"));
            assert!(!message.contains("Runtime.addBinding"));
        } else {
            assert_eq!(server.discoveries.load(Ordering::SeqCst), 1);
        }
    }
}
