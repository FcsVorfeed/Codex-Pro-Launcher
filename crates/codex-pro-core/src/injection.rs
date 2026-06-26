use crate::cdp::{
    CdpClient, CdpTarget, is_auxiliary_codex_page_target, list_targets, wait_for_target,
};
use crate::native_bridge::NativeBridgeConfig;
use anyhow::Context;
use serde::Deserialize;
use serde_json::json;
use std::path::{Path, PathBuf};

/// 这一段描述注入结果。
/// Describes an injection result.
#[derive(Clone, Debug)]
pub struct InjectionResult {
    /// 这一段是注入的 CDP target。
    /// Injected CDP target.
    pub target: CdpTarget,
}

impl InjectionResult {
    /// 这一段返回用于日志的人类可读 target 名称。
    /// Return a human-readable target label for logs.
    pub fn target_title_or_url(&self) -> String {
        // 这一段优先标题，再使用 URL，最后回退 target id。
        // Prefer title, then URL, then target id.
        if !self.target.title.trim().is_empty() {
            self.target.title.clone()
        } else if !self.target.url.trim().is_empty() {
            self.target.url.clone()
        } else {
            self.target.id.clone()
        }
    }
}

/// 这一段描述现有页面运行态探测结果。
/// Describes the existing page runtime probe result.
#[derive(Clone, Debug)]
pub struct ExistingRuntimeProbe {
    /// 这一段是被探测的 CDP target。
    /// CDP target that was probed.
    pub target: CdpTarget,
    /// 这一段表示现有运行态是否可直接复用。
    /// Whether the existing runtime can be reused directly.
    pub usable: bool,
    /// 这一段记录不能复用时的人类可读原因。
    /// Human-readable reason when the runtime cannot be reused.
    pub reason: String,
}

impl ExistingRuntimeProbe {
    /// 这一段返回用于日志的人类可读 target 名称。
    /// Return a human-readable target label for logs.
    pub fn target_title_or_url(&self) -> String {
        // 这一段复用注入结果的 target 展示规则，保证日志格式一致。
        // Reuse the injection-result target display rule so log formatting stays consistent.
        if !self.target.title.trim().is_empty() {
            self.target.title.clone()
        } else if !self.target.url.trim().is_empty() {
            self.target.url.clone()
        } else {
            self.target.id.clone()
        }
    }
}

/// 这一段承接页面侧返回的运行态快照。
/// Carries the runtime snapshot returned from the page.
#[derive(Clone, Debug, Default, Deserialize)]
struct ExistingRuntimeSnapshot {
    /// 这一段表示页面里是否存在 Codex-Pro runtime。
    /// Whether the page has a Codex-Pro runtime.
    #[serde(rename = "hasRuntime")]
    has_runtime: bool,
    /// 这一段表示 native bridge 是否仍有新鲜心跳。
    /// Whether the native bridge still has a fresh heartbeat.
    #[serde(rename = "bridgeAvailable")]
    bridge_available: bool,
    /// 这一段是页面当前 native bridge 协议版本。
    /// Current page native bridge protocol version.
    #[serde(rename = "protocolVersion")]
    protocol_version: Option<u32>,
    /// 这一段表示页面里是否还残留已退役的字体替换运行态。
    /// Whether the page still carries the retired font override runtime.
    #[serde(rename = "retiredFontOverrideRuntime")]
    retired_font_override_runtime: bool,
}

/// 这一段拼接完整注入脚本。
/// Build the full injection script.
pub fn read_injection_script(
    disabled_systems: &[String],
    native_bridge: Option<&NativeBridgeConfig>,
    source_root: Option<&Path>,
) -> anyhow::Result<String> {
    // 这一段先生成运行时配置模块，确保后续核心模块能读取 hard-disable 和 bridge 配置。
    // Generate the runtime config module before loading core modules.
    let local_config = crate::local_config::load_local_config(source_root);
    let frontend_local_config = serde_json::json!({
        "sync": &local_config.sync,
        "appearance": &local_config.appearance,
        "conversationArchive": &local_config.conversation_archive,
    });
    let config_source = if let Some(native_bridge) = native_bridge {
        format!(
            "window.__codexProHardDisabledSystems = {};\nwindow.__codexProLocalConfig = {};\nwindow.__codexProNativeBridgeConfig = {};\nwindow.__codexProNativeBridgeStatus = {{ bridgeId: {}, updatedAt: 0 }};",
            serde_json::to_string(disabled_systems)?,
            serde_json::to_string(&frontend_local_config)?,
            serde_json::to_string(native_bridge)?,
            serde_json::to_string(&native_bridge.bridge_id)?,
        )
    } else {
        format!(
            "window.__codexProHardDisabledSystems = {};\nwindow.__codexProLocalConfig = {};\nwindow.__codexProNativeBridgeConfig = window.__codexProNativeBridgeConfig || null;",
            serde_json::to_string(disabled_systems)?,
            serde_json::to_string(&frontend_local_config)?,
        )
    };

    // 这一段按 Rust manifest 的固定顺序拼接嵌入源码。
    // Join embedded sources in the fixed Rust manifest order.
    let mut parts = vec![format!(
        "\n// Codex-Pro module: codex-pro-runtime-config\n{config_source}"
    )];
    for path in crate::injection_manifest::build_injection_module_paths(disabled_systems) {
        let source = read_injection_module_source(path, source_root)?;
        parts.push(format!("\n// Codex-Pro module: {path}\n{source}"));
    }
    Ok(parts.join("\n"))
}

/// 这一段拼接宠物浮窗最小注入脚本。
/// Build the minimal pet-overlay injection script.
pub fn read_pet_event_sound_overlay_script(
    disabled_systems: &[String],
    source_root: Option<&Path>,
) -> anyhow::Result<Option<String>> {
    // 这一段读取浮窗所需模块；硬屏蔽时不返回脚本。
    // Read only overlay-required modules; return no script when the system is hard-disabled.
    let module_paths =
        crate::injection_manifest::build_pet_event_sound_overlay_module_paths(disabled_systems);
    if module_paths.is_empty() {
        return Ok(None);
    }
    let local_config = crate::local_config::load_local_config(source_root);
    let frontend_local_config = serde_json::json!({
        "sync": &local_config.sync,
        "appearance": &local_config.appearance,
        "conversationArchive": &local_config.conversation_archive,
    });
    let config_source = format!(
        "window.__codexProHardDisabledSystems = {};\nwindow.__codexProLocalConfig = {};\nwindow.__codexProNativeBridgeConfig = window.__codexProNativeBridgeConfig || null;",
        serde_json::to_string(disabled_systems)?,
        serde_json::to_string(&frontend_local_config)?,
    );
    let mut parts = vec![format!(
        "\n// Codex-Pro module: codex-pro-pet-overlay-runtime-config\n{config_source}"
    )];
    for path in module_paths {
        let source = read_injection_module_source(path, source_root)?;
        parts.push(format!("\n// Codex-Pro module: {path}\n{source}"));
    }
    Ok(Some(parts.join("\n")))
}

/// 这一段探测页面里是否已有可复用的 Codex-Pro runtime。
/// Probe whether the page already has a reusable Codex-Pro runtime.
pub async fn probe_existing_runtime(
    debug_port: u16,
    expected_native_bridge_protocol: Option<u32>,
) -> anyhow::Result<ExistingRuntimeProbe> {
    // 这一段只等待很短时间；调用方已经完成窗口复用和 CDP 快速探测。
    // Wait only briefly; the caller already foregrounded the window and performed a CDP quick probe.
    let target = wait_for_target(debug_port, 1_000).await?;
    let websocket_url = target
        .web_socket_debugger_url
        .as_deref()
        .ok_or_else(|| anyhow::anyhow!("selected CDP target has no websocket URL"))?;

    // 这一段读取页面运行态和 bridge 状态，不触发任何 DOM 变更。
    // Read page runtime and bridge state without mutating the DOM.
    let mut client = CdpClient::connect(websocket_url).await?;
    let response = client
        .send(
            "Runtime.evaluate",
            json!({
                "expression": existing_runtime_probe_expression(),
                "returnByValue": true,
                "awaitPromise": false,
                "allowUnsafeEvalBlockedByCSP": true,
            }),
        )
        .await;
    client.close().await;

    let snapshot = response
        .and_then(existing_runtime_snapshot_from_response)
        .unwrap_or_default();
    let reason = existing_runtime_unusable_reason(&snapshot, expected_native_bridge_protocol);
    Ok(ExistingRuntimeProbe {
        target,
        usable: reason.is_none(),
        reason: reason.unwrap_or_else(|| "runtime usable".to_string()),
    })
}

/// 这一段生成页面运行态探测表达式。
/// Build the page runtime probe expression.
fn existing_runtime_probe_expression() -> &'static str {
    r#"
(() => {
  const runtime = window.__codexProRuntime;
  const config = window.__codexProNativeBridgeConfig;
  let bridgeAvailable = false;
  try {
    bridgeAvailable = Boolean(runtime?.nativeBridge?.isAvailable?.());
  } catch {}
  return {
    hasRuntime: Boolean(runtime && typeof runtime.start === "function" && Array.isArray(runtime.systems)),
    bridgeAvailable,
    protocolVersion: Number.isFinite(config?.protocolVersion) ? config.protocolVersion : null,
    retiredFontOverrideRuntime: Boolean(
      (runtime?.systems || []).some((system) => system?.name === "font-override") ||
      runtime?.controllers?.["font-override"] ||
      document.getElementById("codex-pro-font-override-style")
    )
  };
})()
"#
}

/// 这一段从 CDP Runtime.evaluate 响应里提取运行态快照。
/// Extract the runtime snapshot from a CDP Runtime.evaluate response.
fn existing_runtime_snapshot_from_response(
    response: serde_json::Value,
) -> anyhow::Result<ExistingRuntimeSnapshot> {
    // 这一段只接受 returnByValue 的 value 结果，避免误把 objectId 当成可用状态。
    // Accept only the returnByValue value result so an objectId is not treated as usable state.
    let value = response
        .get("result")
        .and_then(|result| result.get("result"))
        .and_then(|result| result.get("value"))
        .cloned()
        .unwrap_or_default();
    serde_json::from_value(value).context("failed to parse existing Codex-Pro runtime snapshot")
}

/// 这一段判断现有运行态为什么不能复用。
/// Determine why the existing runtime cannot be reused.
fn existing_runtime_unusable_reason(
    snapshot: &ExistingRuntimeSnapshot,
    expected_native_bridge_protocol: Option<u32>,
) -> Option<String> {
    // 这一段先确认页面基础 runtime 存在，否则必须重新注入。
    // Confirm the base page runtime exists first; otherwise reinjection is required.
    if !snapshot.has_runtime {
        return Some("runtime missing".to_string());
    }

    // 这一段发现已退役的字体替换运行态时强制重新注入，让 legacy-cleanup 有机会清理旧 CSS。
    // Force reinjection when the retired font override runtime is present so legacy-cleanup can remove stale CSS.
    if snapshot.retired_font_override_runtime {
        return Some("retired font-override runtime present".to_string());
    }

    // 这一段在启用 native bridge 时要求协议版本完全一致。
    // When native bridge is enabled, require an exact protocol version match.
    if let Some(expected) = expected_native_bridge_protocol {
        if snapshot.protocol_version != Some(expected) {
            return Some(format!(
                "native bridge protocol mismatch current={:?} expected={expected}",
                snapshot.protocol_version
            ));
        }
        if !snapshot.bridge_available {
            return Some("native bridge unavailable".to_string());
        }
    }

    None
}

/// 这一段读取单个注入模块源码。
/// Read one injection module source.
fn read_injection_module_source(path: &str, source_root: Option<&Path>) -> anyhow::Result<String> {
    // 这一段仅在开发模式下从磁盘读取源码，发布模式继续使用嵌入资产。
    // Read source from disk only in development mode; release mode keeps embedded assets.
    if let Some(source_root) = source_root {
        return read_injection_module_source_from_disk(source_root, path);
    }
    crate::assets::module_source(path)
        .map(str::to_string)
        .with_context(|| format!("missing embedded injection module: {path}"))
}

/// 这一段从仓库根读取注入模块源码。
/// Read an injection module source from the repository root.
fn read_injection_module_source_from_disk(
    source_root: &Path,
    path: &str,
) -> anyhow::Result<String> {
    // 这一段按 manifest 固定路径逐段拼接，避免平台分隔符影响 Windows dev 模式。
    // Join fixed manifest paths segment by segment so Windows dev mode is not affected by separators.
    let mut module_path = PathBuf::from(source_root);
    for segment in path.split('/') {
        module_path.push(segment);
    }
    std::fs::read_to_string(&module_path).with_context(|| {
        format!(
            "failed to read injection module from disk: {}",
            module_path.display()
        )
    })
}

/// 这一段注入 Codex-Pro 脚本到主 Codex 页面。
/// Inject Codex-Pro scripts into the main Codex page.
pub async fn inject(
    debug_port: u16,
    timeout_ms: u64,
    disabled_systems: &[String],
    native_bridge: Option<&NativeBridgeConfig>,
    source_root: Option<&Path>,
) -> anyhow::Result<InjectionResult> {
    // 这一段等待主页面并生成脚本。
    // Wait for the main page and build the script.
    let target = wait_for_target(debug_port, timeout_ms).await?;
    let websocket_url = target
        .web_socket_debugger_url
        .as_deref()
        .ok_or_else(|| anyhow::anyhow!("selected CDP target has no websocket URL"))?;
    let script = read_injection_script(disabled_systems, native_bridge, source_root)?;

    // 这一段注册 binding 并执行立即注入。
    // Register the binding and execute immediate injection.
    let mut client = CdpClient::connect(websocket_url).await?;
    let result = async {
        client.send("Runtime.enable", json!({})).await?;

        // 这一段在普通注入前尝试应用官方 split-items 热路径补丁；失败只记录，不阻断其它功能。
        // Try the official split-items hotpath patch before normal injection; failures are logged without blocking other systems.
        if !disabled_systems
            .iter()
            .any(|system| system.as_str() == "split-items-hotpath-patch")
        {
            match crate::split_items_hotpath_patch::apply_split_items_hotpath_patch(&mut client)
                .await
            {
                Ok(status) => eprintln!("[Codex-Pro] split-items hotpath patch: {status}"),
                Err(error) => {
                    eprintln!("[Codex-Pro] split-items hotpath patch skipped: {error}")
                }
            }
        }
        if let Some(native_bridge) = native_bridge {
            let add_binding = client
                .send(
                    "Runtime.addBinding",
                    json!({ "name": native_bridge.binding_name }),
                )
                .await;
            if let Err(error) = add_binding
                && !error.to_string().contains("already exists")
            {
                return Err(error);
            }
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
        cleanup_auxiliary_codex_targets(debug_port, &target.id).await?;
        inject_pet_event_sound_overlay_targets(
            debug_port,
            &target.id,
            disabled_systems,
            source_root,
        )
        .await?;
        Ok::<(), anyhow::Error>(())
    }
    .await;
    client.close().await;
    result?;
    Ok(InjectionResult { target })
}

/// 这一段清理历史误注入到宠物悬浮窗的 DOM。
/// Clean DOM historically injected into the avatar overlay.
async fn cleanup_auxiliary_codex_targets(
    debug_port: u16,
    selected_target_id: &str,
) -> anyhow::Result<()> {
    // 这一段读取所有 target，失败时不阻断主注入。
    // Read all targets; failures should not block the main injection.
    let targets = match list_targets(debug_port).await {
        Ok(targets) => targets,
        Err(_) => return Ok(()),
    };
    for target in targets
        .iter()
        .filter(|target| target.id != selected_target_id && is_auxiliary_codex_page_target(target))
    {
        let Some(websocket_url) = target.web_socket_debugger_url.as_deref() else {
            continue;
        };
        let Ok(mut client) = CdpClient::connect(websocket_url).await else {
            continue;
        };
        let _ = client.send("Runtime.enable", json!({})).await;
        let cleanup_script = r#"
(() => {
  const runtime = window.__codexProRuntime;
  if (runtime?.controllers) {
    for (const controller of Object.values(runtime.controllers)) {
      try { controller?.abort?.(); } catch {}
    }
  }
  const ids = [
    "codex-pro-mvp-root",
    "codex-pro-mvp-style",
    "codex-pro-settings-root",
    "codex-pro-settings-style",
    "codex-pro-background-wallpaper-root",
    "codex-pro-background-wallpaper-style",
    "codex-pro-chat-width-resizer-handle",
    "codex-pro-chat-width-resizer-style",
    "codex-pro-chat-line-hover",
    "codex-pro-chat-line-hover-style",
    "codex-pro-font-override-style",
    "codex-pro-mouse-gesture-root",
    "codex-pro-mouse-gesture-style",
    "codex-pro-diff-hover-preview",
    "codex-pro-diff-hover-preview-style",
    "codex-pro-conversation-archive-sidebar-root",
    "codex-pro-conversation-archive-sidebar-panel",
    "codex-pro-conversation-archive-sidebar-style",
    "codex-pro-context-usage-inline-style",
    "codex-pro-native-thread-drag-to-chat-ghost",
    "codex-pro-native-thread-drag-to-chat-style"
  ];
  for (const id of ids) document.getElementById(id)?.remove();
  for (const node of document.querySelectorAll("[data-codex-pro-context-usage-inline]")) node.remove();
  window.__codexProRuntime = undefined;
})();
"#;
        let _ = client
            .send(
                "Runtime.evaluate",
                json!({
                    "expression": cleanup_script,
                    "awaitPromise": false,
                    "allowUnsafeEvalBlockedByCSP": true,
                }),
            )
            .await;
        client.close().await;
    }
    Ok(())
}

/// 这一段把宠物状态音效的最小运行态注入到辅助宠物窗口。
/// Inject the minimal pet-state sound runtime into auxiliary pet windows.
async fn inject_pet_event_sound_overlay_targets(
    debug_port: u16,
    selected_target_id: &str,
    disabled_systems: &[String],
    source_root: Option<&Path>,
) -> anyhow::Result<()> {
    // 这一段先构造脚本；系统被硬屏蔽时直接跳过辅助窗口注入。
    // Build the script first; skip auxiliary injection when the system is hard-disabled.
    let Some(script) = read_pet_event_sound_overlay_script(disabled_systems, source_root)? else {
        return Ok(());
    };
    let targets = match list_targets(debug_port).await {
        Ok(targets) => targets,
        Err(_) => return Ok(()),
    };
    for target in targets
        .iter()
        .filter(|target| target.id != selected_target_id && is_auxiliary_codex_page_target(target))
    {
        let Some(websocket_url) = target.web_socket_debugger_url.as_deref() else {
            continue;
        };
        let Ok(mut client) = CdpClient::connect(websocket_url).await else {
            continue;
        };
        let _ = client.send("Runtime.enable", json!({})).await;
        let _ = client
            .send(
                "Page.addScriptToEvaluateOnNewDocument",
                json!({ "source": script }),
            )
            .await;
        let _ = client
            .send(
                "Runtime.evaluate",
                json!({
                    "expression": script,
                    "awaitPromise": false,
                    "allowUnsafeEvalBlockedByCSP": true,
                }),
            )
            .await;
        client.close().await;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn injection_script_contains_all_expected_runtime_markers() {
        let script = read_injection_script(&[], None, None).unwrap();
        assert!(script.contains("Codex-Pro module: src/inject/core/runtime.js"));
        assert!(script.contains("Codex-Pro module: src/inject/index.js"));
        assert!(script.contains("window.__codexProNativeBridgeConfig"));
    }

    #[test]
    fn pet_overlay_script_contains_minimal_runtime_markers() {
        let script = read_pet_event_sound_overlay_script(&[], None)
            .unwrap()
            .unwrap();
        assert!(script.contains("Codex-Pro module: src/inject/systems/pet-event-sounds/index.js"));
        assert!(!script.contains("Codex-Pro module: src/inject/systems/settings-menu/view.js"));
        assert!(
            read_pet_event_sound_overlay_script(&["pet-event-sounds".to_string()], None)
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn existing_runtime_rejects_retired_font_override_runtime() {
        let snapshot = ExistingRuntimeSnapshot {
            has_runtime: true,
            bridge_available: true,
            protocol_version: Some(68),
            retired_font_override_runtime: true,
        };
        assert_eq!(
            existing_runtime_unusable_reason(&snapshot, Some(68)),
            Some("retired font-override runtime present".to_string())
        );
    }
}
