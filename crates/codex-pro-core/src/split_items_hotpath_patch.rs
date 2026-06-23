use crate::cdp::CdpClient;
use anyhow::{Context, bail};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64_STANDARD};
use serde_json::{Value, json};
use std::time::{Duration, Instant};

/// 这一段标记页面已经加载过优化后的 split-items chunk。
/// Marker showing the page has loaded the optimized split-items chunk.
const PATCH_MARKER: &str = "__codexProSplitItemsHotpathPatch";

/// 这一段识别官方 split-items chunk 的资源名。
/// Resource name used to identify the official split-items chunk.
const SPLIT_ITEMS_CHUNK_NAME: &str = "/assets/split-items-into-render-groups-";

/// 这一段是当前 Codex 26.616.9593.0 的未优化热路径。
/// Unoptimized hot path from the current Codex 26.616.9593.0 bundle.
const CURRENT_HOTPATH_SOURCE: &str = r#"var De=new WeakMap;function L({apps:e,functionName:t,serverName:n,toolName:r}){let i=R(n),a=R(r),o=t.split(`__`).map(R).filter(e=>e.length>0);for(let t of e){let e=Oe(t);if(e.some(e=>ke(e,i))||e.some(e=>Ae(a,e))||o.some(t=>e.some(e=>Ae(t,e))))return t}return null}function Oe(e){let t=De.get(e);if(t)return t;let n=[R(e.name),R(e.id),R(e.id.replace(/^connector[_-]/i,``)),...(e.pluginDisplayNames??[]).map(R)],r=n.filter((e,t)=>e.length===0?!1:n.findIndex(t=>ke(t,e))===t);return De.set(e,r),r}function R(e){return e.trim().toLowerCase().split(/[^a-z0-9]+/g).filter(e=>e.length>0)}function ke(e,t){return e.length===t.length?e.every((e,n)=>e===t[n]):!1}function Ae(e,t){return t.length===0||e.length<t.length?!1:t.every((t,n)=>t===e[n])}"#;

/// 这一段用缓存和索引替换官方全量扫描热路径。
/// Replacement that swaps the official full scan for cached indexed lookups.
const OPTIMIZED_HOTPATH_SOURCE: &str = r#"var __codexProSplitItemsNormalizeCache=new Map,__codexProSplitItemsAppAliasWeakCache=new WeakMap,__codexProSplitItemsAppAliasStableCache=new Map,__codexProSplitItemsFunctionNameCache=new Map,__codexProSplitItemsAppsIndexWeakCache=new WeakMap,__codexProSplitItemsAppsIndexStableCache=new Map;try{globalThis.__codexProSplitItemsHotpathPatch={active:!0,version:1,mode:`alias-index`,loadedAt:Date.now()}}catch{}function L({apps:e,functionName:t,serverName:n,toolName:r}){let i=__codexProSplitItemsAppsIndex(e),a=__codexProSplitItemsBestCandidate(i,R(n),R(r),__codexProSplitItemsFunctionParts(t));return a==null?null:e[a.index]??null}function Oe(e){let t=__codexProSplitItemsAppKey(e),n=__codexProSplitItemsAppAliasWeakCache.get(e);if(n?.key===t)return n.aliases;let r=__codexProSplitItemsAppAliasStableCache.get(t);if(r!==void 0)return __codexProSplitItemsAppAliasWeakCache.set(e,{key:t,aliases:r}),r;r=[R(e.name),R(e.id),R(e.id.replace(/^connector[_-]/i,``)),...(e.pluginDisplayNames??[]).map(R)].filter((e,t,n)=>e.length===0?!1:n.findIndex(t=>ke(t,e))===t),__codexProSplitItemsAppAliasStableCache.size>1024&&__codexProSplitItemsAppAliasStableCache.clear(),__codexProSplitItemsAppAliasStableCache.set(t,r),__codexProSplitItemsAppAliasWeakCache.set(e,{key:t,aliases:r});return r}function R(e){e=e??``;let t=__codexProSplitItemsNormalizeCache.get(e);if(t!==void 0)return t;t=e.trim().toLowerCase().split(/[^a-z0-9]+/g).filter(e=>e.length>0),__codexProSplitItemsNormalizeCache.size>4096&&__codexProSplitItemsNormalizeCache.clear(),__codexProSplitItemsNormalizeCache.set(e,t);return t}function __codexProSplitItemsFunctionParts(e){e=e??``;let t=__codexProSplitItemsFunctionNameCache.get(e);if(t!==void 0)return t;t=e.split(`__`).map(R).filter(e=>e.length>0),__codexProSplitItemsFunctionNameCache.size>4096&&__codexProSplitItemsFunctionNameCache.clear(),__codexProSplitItemsFunctionNameCache.set(e,t);return t}function __codexProSplitItemsAppKey(e){return`${e.id??``}\x02${e.name??``}\x02${(e.pluginDisplayNames??[]).join(`\x03`)}`}function __codexProSplitItemsAliasKey(e){return e.join(`\x01`)}function __codexProSplitItemsAppsKey(e){return e.map(__codexProSplitItemsAppKey).join(`\x04`)}function __codexProSplitItemsSetFirst(e,t,n){let i=__codexProSplitItemsAliasKey(t);if(i.length===0)return;let a=e.get(i);(a===void 0||n<a.index)&&e.set(i,{index:n})}function __codexProSplitItemsAppsIndex(e){let t=__codexProSplitItemsAppsKey(e),n=__codexProSplitItemsAppsIndexWeakCache.get(e);if(n?.key===t)return n.index;let r=__codexProSplitItemsAppsIndexStableCache.get(t);if(r!==void 0)return __codexProSplitItemsAppsIndexWeakCache.set(e,{key:t,index:r}),r;r=new Map;for(let t=0;t<e.length;t++){let n=e[t];for(let e of Oe(n))__codexProSplitItemsSetFirst(r,e,t)}return __codexProSplitItemsAppsIndexStableCache.size>128&&__codexProSplitItemsAppsIndexStableCache.clear(),__codexProSplitItemsAppsIndexStableCache.set(t,r),__codexProSplitItemsAppsIndexWeakCache.set(e,{key:t,index:r}),r}function __codexProSplitItemsLookupExact(e,t){return e.get(__codexProSplitItemsAliasKey(t))}function __codexProSplitItemsLookupPrefixes(e,t){let n=null;for(let r=1;r<=t.length;r++){let i=e.get(__codexProSplitItemsAliasKey(t.slice(0,r)));i&&(n==null||i.index<n.index)&&(n=i)}return n}function __codexProSplitItemsPickEarlier(e,t){return e==null?t:t==null?e:e.index<=t.index?e:t}function __codexProSplitItemsBestCandidate(e,t,n,r){let i=__codexProSplitItemsPickEarlier(__codexProSplitItemsLookupExact(e,t),__codexProSplitItemsLookupPrefixes(e,n));for(let t of r)i=__codexProSplitItemsPickEarlier(i,__codexProSplitItemsLookupPrefixes(e,t));return i}function ke(e,t){return e.length===t.length?e.every((e,n)=>e===t[n]):!1}function Ae(e,t){return t.length===0||e.length<t.length?!1:t.every((t,n)=>t===e[n])}"#;

/// 这一段尝试对官方 split-items chunk 应用运行时补丁。
/// Try to apply the runtime patch to the official split-items chunk.
pub async fn apply_split_items_hotpath_patch(client: &mut CdpClient) -> anyhow::Result<String> {
    // 这一段优先尊重用户设置；即使当前页已加载补丁，关闭后也不再报告为主动应用。
    // Respect the user setting first; even if the page already loaded the patch, off no longer reports an active apply.
    if !split_items_hotpath_patch_enabled(client)
        .await
        .unwrap_or(true)
    {
        return Ok("disabled by settings".to_string());
    }

    // 这一段先检查当前页面是否已经加载过补丁，避免每次注入都 reload。
    // Check whether the current page already loaded the patch so reinjection does not reload every time.
    if runtime_patch_marker_active(client).await.unwrap_or(false) {
        return Ok("already active".to_string());
    }

    // 这一段通过 CDP 脚本解析事件定位真实 hash chunk URL。
    // Locate the real hashed chunk URL through CDP scriptParsed events.
    let Some(split_items_url) = find_split_items_script_url(client).await? else {
        return Ok("unsupported: split-items chunk not found".to_string());
    };

    // 这一段只读获取当前 chunk 源码；不可识别时直接跳过，不 reload 页面。
    // Fetch the current chunk source read-only; skip without reload when it is not recognized.
    let source = fetch_script_source(client, &split_items_url).await?;
    let Some(patched_source) = patch_split_items_source(&source) else {
        return Ok(format!(
            "unsupported: hotpath signature not found in {split_items_url}"
        ));
    };
    if !force_split_items_reload() {
        let reload_guard = page_allows_patch_reload(client).await?;
        if !reload_guard.allowed {
            return Ok(format!("deferred: {}", reload_guard.reason));
        }
    }

    // 这一段只在确认可补丁后拦截一次 reload 的目标 chunk 请求。
    // Intercept one reload request for the target chunk only after the source is confirmed patchable.
    reload_with_patched_split_items(client, &split_items_url, &patched_source).await?;
    if wait_for_patch_marker(client, Duration::from_secs(5)).await {
        return Ok(format!("active: {split_items_url}"));
    }
    Ok(format!("reloaded but marker missing: {split_items_url}"))
}

/// 这一段描述当前页面是否适合为补丁执行 reload。
/// Describes whether the current page is safe for a patch reload.
#[derive(Debug, serde::Deserialize)]
struct PatchReloadGuard {
    /// 这一段表示是否允许本轮自动 reload。
    /// Whether this run may trigger an automatic reload.
    allowed: bool,
    /// 这一段记录允许或拒绝的原因。
    /// Reason for allowing or denying the reload.
    reason: String,
}

/// 这一段读取人工强制 reload 开关。
/// Read the manual force-reload switch.
fn force_split_items_reload() -> bool {
    // 这一段只接受显式 true 值，避免无意环境变量触发页面 reload。
    // Accept only explicit true values so accidental environment variables do not reload the page.
    matches!(
        std::env::var("CODEX_PRO_FORCE_SPLIT_ITEMS_HOTPATH_RELOAD")
            .unwrap_or_default()
            .to_ascii_lowercase()
            .as_str(),
        "1" | "true" | "yes"
    )
}

/// 这一段读取页面设置中的热补丁开关。
/// Read the hotpatch switch from the page settings.
async fn split_items_hotpath_patch_enabled(client: &mut CdpClient) -> anyhow::Result<bool> {
    // 这一段只把显式 false 视为关闭；无设置、旧设置或读取失败都保持默认开启。
    // Treat only explicit false as disabled; missing, legacy, or unreadable settings keep the default on.
    let response = client
        .send(
            "Runtime.evaluate",
            json!({
                "expression": r#"
(() => {
  try {
    const raw = globalThis.localStorage?.getItem("codex-pro:settings");
    const settings = raw ? JSON.parse(raw) : {};
    return !(settings && typeof settings === "object" && settings.enableSplitItemsHotpathPatch === false);
  } catch {
    return true;
  }
})()
"#,
                "returnByValue": true,
                "awaitPromise": false,
                "allowUnsafeEvalBlockedByCSP": true,
            }),
        )
        .await?;
    Ok(response_value(&response).as_bool().unwrap_or(true))
}

/// 这一段检查当前页面是否适合自动 reload。
/// Check whether the current page is safe for an automatic reload.
async fn page_allows_patch_reload(client: &mut CdpClient) -> anyhow::Result<PatchReloadGuard> {
    // 这一段只在没有既有 Codex-Pro runtime 且没有 composer 草稿时允许 reload。
    // Allow reload only before an existing Codex-Pro runtime is present and when the composer has no draft.
    let response = client
        .send(
            "Runtime.evaluate",
            json!({
                "expression": r#"
(() => {
  const runtime = window.__codexProRuntime;
  if (runtime && typeof runtime.start === "function") {
    return { allowed: false, reason: "existing Codex-Pro runtime present" };
  }
  const composerRoots = [...document.querySelectorAll('[data-codex-composer="true"]')];
  if (!composerRoots.length) return { allowed: false, reason: "composer root not found" };
  const composerFields = composerRoots.flatMap((root) => [
    ...(root.matches?.('textarea, [contenteditable="true"]') ? [root] : []),
    ...root.querySelectorAll('textarea, [contenteditable="true"]')
  ]);
  if (!composerFields.length) return { allowed: false, reason: "composer editor not found" };
  const hasDraft = composerFields.some((field) => String(field.value ?? field.textContent ?? "").trim().length > 0);
  if (hasDraft) return { allowed: false, reason: "composer draft present" };
  return { allowed: true, reason: "initial page without Codex-Pro runtime" };
})()
"#,
                "returnByValue": true,
                "awaitPromise": false,
                "allowUnsafeEvalBlockedByCSP": true,
            }),
        )
        .await?;
    serde_json::from_value(response_value(&response))
        .context("failed to parse split-items patch reload guard")
}

/// 这一段把已知官方热路径替换成优化实现。
/// Replace the known official hot path with the optimized implementation.
pub fn patch_split_items_source(source: &str) -> Option<String> {
    // 这一段保证已补丁的源码不会被重复替换。
    // Avoid replacing a source that already carries this patch marker.
    if source.contains(PATCH_MARKER) {
        return Some(source.to_string());
    }
    if !source.contains(CURRENT_HOTPATH_SOURCE) {
        return None;
    }
    Some(source.replace(CURRENT_HOTPATH_SOURCE, OPTIMIZED_HOTPATH_SOURCE))
}

/// 这一段读取页面里的补丁状态。
/// Read the patch state from the page.
async fn runtime_patch_marker_active(client: &mut CdpClient) -> anyhow::Result<bool> {
    // 这一段只读全局 marker，不触碰 DOM 或 React 状态。
    // Read only a global marker without touching DOM or React state.
    let response = client
        .send(
            "Runtime.evaluate",
            json!({
                "expression": format!(
                    "Boolean(globalThis.{PATCH_MARKER} && globalThis.{PATCH_MARKER}.active === true)"
                ),
                "returnByValue": true,
                "awaitPromise": false,
                "allowUnsafeEvalBlockedByCSP": true,
            }),
        )
        .await?;
    Ok(response_value(&response).as_bool().unwrap_or(false))
}

/// 这一段等待页面重新加载并执行补丁 marker。
/// Wait for the page to reload and execute the patch marker.
async fn wait_for_patch_marker(client: &mut CdpClient, timeout: Duration) -> bool {
    // 这一段用短轮询处理 reload 期间执行上下文短暂不可用的窗口。
    // Poll briefly because the execution context can be unavailable during reload.
    let started = Instant::now();
    while started.elapsed() <= timeout {
        if runtime_patch_marker_active(client).await.unwrap_or(false) {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    false
}

/// 这一段从 CDP scriptParsed 事件中定位 split-items chunk。
/// Locate the split-items chunk from CDP scriptParsed events.
async fn find_split_items_script_url(client: &mut CdpClient) -> anyhow::Result<Option<String>> {
    // 这一段启用 Debugger 只为读取已加载脚本 URL，随后立即关闭以降低运行时开销。
    // Enable Debugger only to read loaded script URLs, then disable it to reduce runtime overhead.
    client.send("Debugger.enable", json!({})).await?;
    let result = collect_split_items_script_url(client, Duration::from_millis(700)).await;
    let _ = client.send("Debugger.disable", json!({})).await;
    result
}

/// 这一段收集 Debugger 已知脚本事件。
/// Collect known script events from Debugger.
async fn collect_split_items_script_url(
    client: &mut CdpClient,
    timeout: Duration,
) -> anyhow::Result<Option<String>> {
    // 这一段只消费短时间内的事件；没找到时按不支持处理，不阻塞注入。
    // Consume events for a bounded window only; missing events mean unsupported, not an injection blocker.
    let started = Instant::now();
    let mut found = None;
    while started.elapsed() < timeout {
        let remaining = timeout.saturating_sub(started.elapsed());
        let message = match tokio::time::timeout(remaining, client.next_message()).await {
            Ok(result) => result?,
            Err(_) => break,
        };
        let Some(message) = message else {
            break;
        };
        if message.get("method").and_then(Value::as_str) != Some("Debugger.scriptParsed") {
            continue;
        }
        let url = message
            .get("params")
            .and_then(|params| params.get("url"))
            .and_then(Value::as_str)
            .unwrap_or_default();
        if url.contains(SPLIT_ITEMS_CHUNK_NAME) && url.ends_with(".js") {
            found = Some(url.to_string());
            break;
        }
    }
    Ok(found)
}

/// 这一段让页面同源读取目标脚本文本。
/// Let the page read the target script source from the same origin.
async fn fetch_script_source(client: &mut CdpClient, script_url: &str) -> anyhow::Result<String> {
    // 这一段使用页面自己的 fetch 读取 app:// 资源，避免直接碰官方安装目录。
    // Use the page's own fetch for app:// assets so the official install directory is untouched.
    let expression = format!(
        "(async()=>await fetch({}).then((response)=>response.text()))()",
        serde_json::to_string(script_url)?
    );
    let response = client
        .send(
            "Runtime.evaluate",
            json!({
                "expression": expression,
                "returnByValue": true,
                "awaitPromise": true,
                "allowUnsafeEvalBlockedByCSP": true,
            }),
        )
        .await?;
    response_value(&response)
        .as_str()
        .map(str::to_string)
        .filter(|source| !source.is_empty())
        .context("split-items script source is empty")
}

/// 这一段 reload 页面并只替换目标 chunk 的响应体。
/// Reload the page and replace only the target chunk response body.
async fn reload_with_patched_split_items(
    client: &mut CdpClient,
    split_items_url: &str,
    patched_source: &str,
) -> anyhow::Result<()> {
    // 这一段启用精确 URL 拦截；启用失败时不会 reload 页面。
    // Enable exact URL interception; if this fails, the page is not reloaded.
    client
        .send(
            "Fetch.enable",
            json!({
                "patterns": [{
                    "urlPattern": split_items_url,
                    "requestStage": "Request",
                }],
            }),
        )
        .await?;

    // 这一段 reload 当前页面，让浏览器重新请求目标 chunk。
    // Reload the current page so the browser requests the target chunk again.
    let reload_result = client
        .send("Page.reload", json!({ "ignoreCache": true }))
        .await;
    let patch_result = match reload_result {
        Ok(_) => {
            fulfill_split_items_request(
                client,
                split_items_url,
                patched_source,
                Duration::from_secs(6),
            )
            .await
        }
        Err(error) => Err(error),
    };
    let disable_result = client.send("Fetch.disable", json!({})).await;

    // 这一段优先报告真实补丁错误；关闭拦截失败只在补丁成功时冒泡。
    // Prefer the real patch error; surface Fetch.disable failure only when the patch itself succeeded.
    patch_result?;
    disable_result?;
    Ok(())
}

/// 这一段处理 Fetch.requestPaused 并返回优化后的 chunk。
/// Handle Fetch.requestPaused and return the optimized chunk.
async fn fulfill_split_items_request(
    client: &mut CdpClient,
    split_items_url: &str,
    patched_source: &str,
    timeout: Duration,
) -> anyhow::Result<()> {
    // 这一段只等待一个目标请求，避免长时间持有 Fetch 拦截。
    // Wait for one target request only so Fetch interception is held briefly.
    let started = Instant::now();
    while started.elapsed() < timeout {
        let remaining = timeout.saturating_sub(started.elapsed());
        let message = match tokio::time::timeout(remaining, client.next_message()).await {
            Ok(result) => result?,
            Err(_) => break,
        };
        let Some(message) = message else {
            break;
        };
        if message.get("method").and_then(Value::as_str) != Some("Fetch.requestPaused") {
            continue;
        }
        let params = message.get("params").cloned().unwrap_or_default();
        let request_id = params
            .get("requestId")
            .and_then(Value::as_str)
            .context("Fetch.requestPaused missing requestId")?;
        let request_url = params
            .get("request")
            .and_then(|request| request.get("url"))
            .and_then(Value::as_str)
            .unwrap_or_default();
        if request_url != split_items_url {
            let _ = client
                .send("Fetch.continueRequest", json!({ "requestId": request_id }))
                .await;
            continue;
        }
        return fulfill_patched_source(client, request_id, patched_source).await;
    }
    bail!("timed out waiting for split-items chunk request")
}

/// 这一段把优化后的源码交给 Chromium。
/// Fulfill the paused request with the optimized source.
async fn fulfill_patched_source(
    client: &mut CdpClient,
    request_id: &str,
    patched_source: &str,
) -> anyhow::Result<()> {
    // 这一段按 CDP 要求使用 base64 body，避免编码损坏 minified JS。
    // Use the CDP-required base64 body so minified JS is not corrupted by encoding.
    let encoded_body = BASE64_STANDARD.encode(patched_source.as_bytes());
    client
        .send(
            "Fetch.fulfillRequest",
            json!({
                "requestId": request_id,
                "responseCode": 200,
                "responseHeaders": [
                    { "name": "Content-Type", "value": "application/javascript; charset=utf-8" },
                    { "name": "Cache-Control", "value": "no-store" },
                ],
                "body": encoded_body,
            }),
        )
        .await?;
    Ok(())
}

/// 这一段读取 Runtime.evaluate 的 returnByValue 结果。
/// Read the returnByValue payload from Runtime.evaluate.
fn response_value(response: &Value) -> Value {
    // 这一段按 CDP 标准 result.result.value 路径读取。
    // Read the standard CDP result.result.value path.
    response
        .get("result")
        .and_then(|result| result.get("result"))
        .and_then(|result| result.get("value"))
        .cloned()
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn patch_replaces_current_hotpath_and_adds_marker() {
        let source = format!("before {CURRENT_HOTPATH_SOURCE} after");
        let patched = patch_split_items_source(&source).unwrap();
        assert!(patched.contains(PATCH_MARKER));
        assert!(patched.contains("__codexProSplitItemsAppsIndex"));
        assert!(patched.contains("return a==null?null:e[a.index]??null"));
        assert!(!patched.contains("app:r"));
        assert!(!patched.contains(CURRENT_HOTPATH_SOURCE));
        assert!(patched.starts_with("before "));
        assert!(patched.ends_with(" after"));
    }

    #[test]
    fn patch_rejects_unknown_source() {
        assert!(patch_split_items_source("function unrelated(){}").is_none());
    }

    #[test]
    fn patch_is_idempotent_for_marked_source() {
        let source = format!("globalThis.{PATCH_MARKER}={{active:!0}};");
        assert_eq!(patch_split_items_source(&source).unwrap(), source);
    }
}
