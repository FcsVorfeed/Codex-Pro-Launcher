use std::net::TcpListener;

/// 这一段定义 Codex-Pro launcher 的单实例守护端口。
/// Defines the single-instance guard port for the Codex-Pro launcher.
pub const LAUNCHER_GUARD_PORT: u16 = 57324;

/// 这一段描述最终 CDP 调试端口的选择结果。
/// Describes the final CDP debug port selection.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DebugPortSelection {
    /// 这一段是用户或默认配置请求的端口。
    /// Port requested by the user or default configuration.
    pub requested_port: u16,
    /// 这一段是本轮实际使用的端口。
    /// Port used by this launcher run.
    pub effective_port: u16,
    /// 这一段是选择该端口的人类可读原因。
    /// Human-readable reason for choosing the effective port.
    pub reason: &'static str,
}

/// 这一段持有本地端口监听器，生命周期内阻止第二个 launcher 同时运行。
/// Holds a loopback listener so a second launcher cannot run concurrently.
#[derive(Debug)]
pub struct LoopbackPortGuard {
    /// 这一段必须保留监听器所有权，否则端口会被立即释放。
    /// Keep ownership of the listener so the port is not released immediately.
    _listener: TcpListener,
}

/// 这一段尝试获取默认 launcher 单实例 guard。
/// Try to acquire the default launcher single-instance guard.
pub fn try_acquire_launcher_guard() -> std::io::Result<Option<LoopbackPortGuard>> {
    // 这一段使用独立端口，避免和 Codex CDP 端口及 Codex++ guard 端口冲突。
    // Use a dedicated port so it does not conflict with Codex CDP or Codex++ guard ports.
    try_acquire_loopback_guard(LAUNCHER_GUARD_PORT)
}

/// 这一段尝试获取指定 loopback 端口 guard。
/// Try to acquire a guard on a specific loopback port.
pub fn try_acquire_loopback_guard(port: u16) -> std::io::Result<Option<LoopbackPortGuard>> {
    // 这一段把端口占用视为已有实例，其他错误继续上抛用于诊断。
    // Treat address-in-use as an existing instance and surface other errors for diagnostics.
    match TcpListener::bind(("127.0.0.1", port)) {
        Ok(listener) => Ok(Some(LoopbackPortGuard {
            _listener: listener,
        })),
        Err(error) if error.kind() == std::io::ErrorKind::AddrInUse => Ok(None),
        Err(error) => Err(error),
    }
}

/// 这一段选择本轮 Codex CDP 调试端口。
/// Select the Codex CDP debug port for this launcher run.
pub async fn select_debug_port(requested_port: u16) -> anyhow::Result<DebugPortSelection> {
    // 这一段先用绑定探测识别空闲端口，再只在占用时访问 CDP，避免无谓网络等待。
    // Probe binding first and query CDP only when occupied to avoid unnecessary network waits.
    let requested_port_bindable = requested_port != 0 && can_bind_loopback_port(requested_port);
    let requested_port_has_codex = requested_port != 0
        && !requested_port_bindable
        && crate::cdp::has_injectable_target(requested_port).await;
    Ok(select_debug_port_from_probe(
        requested_port,
        requested_port_bindable,
        requested_port_has_codex,
        find_available_loopback_port,
    )?)
}

/// 这一段按已知探测结果选择端口，便于单元测试覆盖分支。
/// Select a port from known probe results so unit tests can cover branches.
fn select_debug_port_from_probe(
    requested_port: u16,
    requested_port_bindable: bool,
    requested_port_has_codex: bool,
    find_available: impl FnOnce() -> std::io::Result<u16>,
) -> std::io::Result<DebugPortSelection> {
    // 这一段显式 0 表示请求动态端口。
    // Treat explicit zero as a request for a dynamic port.
    if requested_port == 0 {
        return fallback_debug_port_selection(requested_port, "requested-dynamic", find_available);
    }

    // 这一段保持默认端口优先，只有冲突时才换端口。
    // Keep the requested port first and switch only on conflict.
    if requested_port_bindable {
        return Ok(DebugPortSelection {
            requested_port,
            effective_port: requested_port,
            reason: "requested-free",
        });
    }

    // 这一段如果占用方已经是可注入 Codex，就复用该 CDP 端口。
    // Reuse the port when the occupant is already an injectable Codex CDP endpoint.
    if requested_port_has_codex {
        return Ok(DebugPortSelection {
            requested_port,
            effective_port: requested_port,
            reason: "existing-codex-cdp",
        });
    }

    fallback_debug_port_selection(
        requested_port,
        "requested-conflict-fallback",
        find_available,
    )
}

/// 这一段构造动态兜底端口选择结果。
/// Build a dynamic fallback port selection.
fn fallback_debug_port_selection(
    requested_port: u16,
    reason: &'static str,
    find_available: impl FnOnce() -> std::io::Result<u16>,
) -> std::io::Result<DebugPortSelection> {
    // 这一段通过系统分配空闲 loopback 端口，避免和其它本机服务争抢 9229。
    // Ask the OS for a free loopback port so 9229 conflicts do not block launch.
    let effective_port = find_available()?;
    if effective_port == 0 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::AddrNotAvailable,
            "failed to allocate a loopback debug port",
        ));
    }
    Ok(DebugPortSelection {
        requested_port,
        effective_port,
        reason,
    })
}

/// 这一段判断 loopback 端口当前是否可绑定。
/// Return whether a loopback port can be bound right now.
pub fn can_bind_loopback_port(port: u16) -> bool {
    // 这一段先绑定 IPv4；如果 IPv6 loopback 可用，再额外确认同端口 IPv6 未被占用。
    // Bind IPv4 first; when IPv6 loopback is available, also confirm the same IPv6 port is free.
    let Ok(ipv4_listener) = TcpListener::bind(("127.0.0.1", port)) else {
        return false;
    };
    if !ipv6_loopback_is_available() {
        return true;
    }
    let _ipv4_listener = ipv4_listener;
    TcpListener::bind(("::1", port)).is_ok()
}

/// 这一段请求系统分配一个当前空闲的 loopback 端口。
/// Ask the OS for a currently free loopback port.
pub fn find_available_loopback_port() -> std::io::Result<u16> {
    // 这一段在 IPv6 loopback 可用时分配双栈都空闲的端口；否则降级为 IPv4-only。
    // Allocate a port free on both stacks when IPv6 loopback is available; otherwise fall back to IPv4-only.
    let require_ipv6 = ipv6_loopback_is_available();
    let mut last_error = None;
    for _ in 0..64 {
        match find_available_loopback_port_once(require_ipv6) {
            Ok(port) => return Ok(port),
            Err(error) => last_error = Some(error),
        }
    }
    Err(last_error.unwrap_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::AddrNotAvailable,
            "failed to allocate a loopback debug port",
        )
    }))
}

/// 这一段尝试分配一次 loopback 端口。
/// Try once to allocate a loopback port.
fn find_available_loopback_port_once(require_ipv6: bool) -> std::io::Result<u16> {
    // 这一段先让系统给 IPv4 分配端口，再按需验证同端口 IPv6 也空闲。
    // Ask IPv4 for an OS-assigned port, then optionally verify the same port is free on IPv6 too.
    let ipv4_listener = TcpListener::bind(("127.0.0.1", 0))?;
    let port = ipv4_listener.local_addr()?.port();
    if require_ipv6 {
        let _ipv6_listener = TcpListener::bind(("::1", port))?;
    }
    Ok(port)
}

/// 这一段判断当前机器是否能使用 IPv6 loopback。
/// Return whether IPv6 loopback is available on this machine.
fn ipv6_loopback_is_available() -> bool {
    // 这一段只检测系统能力，不检测业务端口占用；具体端口仍由调用方单独绑定验证。
    // Check system capability only; callers still verify occupancy on the specific port.
    TcpListener::bind(("::1", 0)).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loopback_guard_blocks_second_guard_on_same_port() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);

        let _guard = try_acquire_loopback_guard(port).unwrap().unwrap();
        let second = try_acquire_loopback_guard(port).unwrap();

        assert!(second.is_none());
    }

    #[test]
    fn can_bind_loopback_port_rejects_ipv4_occupied_port() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();

        assert!(!can_bind_loopback_port(port));
    }

    #[test]
    fn loopback_port_once_supports_ipv4_only_fallback_mode() {
        let port = find_available_loopback_port_once(false).unwrap();
        let _listener = TcpListener::bind(("127.0.0.1", port)).unwrap();

        assert_ne!(port, 0);
    }

    #[test]
    fn debug_port_selection_keeps_free_requested_port() {
        let selection = select_debug_port_from_probe(9229, true, false, || Ok(50000)).unwrap();

        assert_eq!(selection.requested_port, 9229);
        assert_eq!(selection.effective_port, 9229);
        assert_eq!(selection.reason, "requested-free");
    }

    #[test]
    fn debug_port_selection_reuses_existing_codex_cdp_port() {
        let selection = select_debug_port_from_probe(9229, false, true, || Ok(50000)).unwrap();

        assert_eq!(selection.requested_port, 9229);
        assert_eq!(selection.effective_port, 9229);
        assert_eq!(selection.reason, "existing-codex-cdp");
    }

    #[test]
    fn debug_port_selection_falls_back_when_requested_port_is_busy() {
        let selection = select_debug_port_from_probe(9229, false, false, || Ok(50000)).unwrap();

        assert_eq!(selection.requested_port, 9229);
        assert_eq!(selection.effective_port, 50000);
        assert_eq!(selection.reason, "requested-conflict-fallback");
    }

    #[test]
    fn debug_port_selection_allows_explicit_dynamic_port() {
        let selection = select_debug_port_from_probe(0, false, false, || Ok(50000)).unwrap();

        assert_eq!(selection.requested_port, 0);
        assert_eq!(selection.effective_port, 50000);
        assert_eq!(selection.reason, "requested-dynamic");
    }
}
