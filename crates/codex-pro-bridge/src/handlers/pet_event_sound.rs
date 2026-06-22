use crate::handlers::cloud_sync::normalize_request_id;
use anyhow::bail;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use codex_pro_core::cdp::CdpClient;
use codex_pro_core::native_bridge::NativeBridgeConfig;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
#[cfg(windows)]
use std::path::{Component, Prefix};
use std::path::{Path, PathBuf};

/// 这一段定义宠物状态音效文件大小上限。
/// Maximum pet-state sound file size.
const PET_EVENT_SOUND_MAX_BYTES: u64 = 5 * 1024 * 1024;
/// 这一段定义宠物状态音效路径长度上限。
/// Maximum pet-state sound path length.
const PET_EVENT_SOUND_MAX_PATH_LENGTH: usize = 1000;
/// 这一段定义宠物状态 id 长度上限。
/// Maximum pet-state id length.
const PET_EVENT_SOUND_MAX_STATE_ID_LENGTH: usize = 40;

/// 这一段描述宠物状态音效读取请求。
/// Describes a pet-state sound read request.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct PetEventSoundRequest {
    /// 这一段是页面请求 id。
    /// Page request id.
    #[serde(rename = "requestId")]
    pub request_id: String,
    /// 这一段是官方宠物状态 id。
    /// Official pet-state id.
    #[serde(rename = "stateId")]
    pub state_id: String,
}

/// 这一段解析宠物状态音效读取请求。
/// Parse a pet-state sound read request.
pub fn parse_pet_event_sound_request(value: &Value) -> Option<PetEventSoundRequest> {
    // 这一段只接受短 request id 和官方状态 id，底层 bridge 不再接受页面路径。
    // Accept only a short request id and official state id; the low-level bridge no longer accepts page paths.
    let request_id = normalize_request_id(value.get("requestId")?.as_str()?)?;
    let state_id = normalize_state_id(value.get("stateId")?.as_str()?)?;
    Some(PetEventSoundRequest {
        request_id,
        state_id,
    })
}

/// 这一段读取本机宠物状态音效文件。
/// Read a local pet-state sound file.
pub async fn run_pet_event_sound_request(
    client: &mut CdpClient,
    native_bridge: &NativeBridgeConfig,
    request: &PetEventSoundRequest,
) -> anyhow::Result<Value> {
    // 这一段先在当前页面按状态 id 解析设置路径，把设置映射约束放到 native 边界内。
    // Resolve the settings path by state id in the current page first, enforcing the mapping inside the native boundary.
    let sound_path = resolve_sound_path(client, native_bridge, request).await?;
    if sound_path.is_empty() {
        return Ok(json!({
            "bytes": 0,
            "error": "unavailable",
            "ok": false,
        }));
    }

    // 这一段验证路径、扩展名和大小，避免页面借音效功能读取任意大文件或非音频内容。
    // Validate path, extension, and size so the page cannot use this feature to read arbitrary large or non-audio files.
    let file_path = validate_sound_path(&sound_path)?;
    let mime = mime_from_path(&file_path)?;
    let metadata = tokio::fs::metadata(&file_path).await?;
    if !metadata.is_file() {
        bail!("petEventSoundNotFile");
    }
    if metadata.len() > PET_EVENT_SOUND_MAX_BYTES {
        return Ok(json!({
            "bytes": metadata.len(),
            "error": "fileTooLarge",
            "ok": false,
        }));
    }

    // 这一段读取文件并编码为 base64，页面侧只解码到 WebAudio 缓存，不把路径写入回包。
    // Read the file and encode it as base64; the page decodes it into WebAudio cache without echoing the path.
    let bytes = tokio::fs::read(&file_path).await?;
    Ok(json!({
        "base64": STANDARD.encode(&bytes),
        "bytes": bytes.len(),
        "error": "",
        "mime": mime,
        "ok": true,
    }))
}

async fn resolve_sound_path(
    client: &mut CdpClient,
    native_bridge: &NativeBridgeConfig,
    request: &PetEventSoundRequest,
) -> anyhow::Result<String> {
    // 这一段通过受控 Runtime.evaluate 读取本插件本地设置，不接受页面请求里夹带路径。
    // Read this plugin's local settings through controlled Runtime.evaluate, without accepting paths in page requests.
    let expression = build_resolve_sound_path_expression(native_bridge, &request.state_id)?;
    let response = client
        .send(
            "Runtime.evaluate",
            json!({
                "expression": expression,
                "awaitPromise": false,
                "allowUnsafeEvalBlockedByCSP": true,
                "returnByValue": true,
            }),
        )
        .await?;
    Ok(normalize_sound_path_text(runtime_evaluate_string(&response).as_str()).unwrap_or_default())
}

fn build_resolve_sound_path_expression(
    native_bridge: &NativeBridgeConfig,
    state_id: &str,
) -> anyhow::Result<String> {
    // 这一段构造固定表达式，只把 bridgeId 和 stateId 作为 JSON 字符串注入。
    // Build a fixed expression, injecting only bridgeId and stateId as JSON strings.
    Ok(format!(
        r#"(() => {{
  const bridgeId = {};
  const stateId = {};
  if (window.__codexProNativeBridgeConfig?.bridgeId !== bridgeId) return "";
  const settingsApi = window.__codexProRuntime?.systemModules?.settingsMenu?.settings;
  const stateIds = Array.isArray(settingsApi?.petEventSoundStateIds) ? settingsApi.petEventSoundStateIds : [];
  if (!stateIds.includes(stateId)) return "";
  const settings = settingsApi?.getSettings?.() || {{}};
  if (settings.enablePetEventSounds !== true) return "";
  const paths = settings.petEventSoundPaths && typeof settings.petEventSoundPaths === "object" ? settings.petEventSoundPaths : {{}};
  const value = String(paths[stateId] || "").trim();
  if (!value || value.length > {} || /[\0\r\n]/u.test(value)) return "";
  return value;
}})()"#,
        serde_json::to_string(&native_bridge.bridge_id)?,
        serde_json::to_string(state_id)?,
        PET_EVENT_SOUND_MAX_PATH_LENGTH,
    ))
}

fn runtime_evaluate_string(response: &Value) -> String {
    // 这一段按 CDP 标准 result.result.value 路径读取字符串结果。
    // Read a string result from the standard CDP result.result.value path.
    response
        .get("result")
        .and_then(|result| result.get("result"))
        .and_then(|result| result.get("value"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn normalize_state_id(value: &str) -> Option<String> {
    // 这一段规整页面传入的状态 id，只允许官方状态 id 使用的短横线小写格式。
    // Normalize page-supplied state ids, allowing only the short lowercase-hyphen format used by official states.
    let state_id = value.trim();
    if state_id.is_empty()
        || state_id.len() > PET_EVENT_SOUND_MAX_STATE_ID_LENGTH
        || !state_id
            .chars()
            .all(|ch| ch.is_ascii_lowercase() || ch == '-')
    {
        return None;
    }
    Some(state_id.to_string())
}

fn normalize_sound_path_text(value: &str) -> Option<String> {
    // 这一段规整页面传入的路径文本，拒绝空值、控制字符和超长路径。
    // Normalize page-supplied path text, rejecting empty values, control characters, and oversized paths.
    let path = value.trim();
    if path.is_empty()
        || path.len() > PET_EVENT_SOUND_MAX_PATH_LENGTH
        || path.contains('\0')
        || path.contains('\r')
        || path.contains('\n')
    {
        return None;
    }
    Some(path.to_string())
}

fn validate_sound_path(value: &str) -> anyhow::Result<PathBuf> {
    // 这一段只接受本机绝对路径，避免页面用相对路径或 UNC 路径探测本机/网络文件。
    // Accept only local absolute paths so the page cannot probe local or network files through relative/UNC paths.
    let path = PathBuf::from(value);
    if !path.is_absolute() {
        bail!("petEventSoundPathNotAbsolute");
    }
    #[cfg(windows)]
    {
        match path.components().next() {
            Some(Component::Prefix(prefix)) => match prefix.kind() {
                Prefix::Disk(_) | Prefix::VerbatimDisk(_) => {}
                _ => bail!("petEventSoundPathNotLocal"),
            },
            _ => bail!("petEventSoundPathNotLocal"),
        }
    }
    #[cfg(not(windows))]
    {
        if value.starts_with("//") {
            bail!("petEventSoundPathNotLocal");
        }
    }
    Ok(path)
}

fn mime_from_path(path: &Path) -> anyhow::Result<&'static str> {
    // 这一段按扩展名限制音频格式，避免读取任意文本或二进制文件。
    // Restrict audio formats by extension so arbitrary text or binary files are not read.
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    match extension.as_str() {
        "aac" => Ok("audio/aac"),
        "flac" => Ok("audio/flac"),
        "m4a" => Ok("audio/mp4"),
        "mp3" => Ok("audio/mpeg"),
        "ogg" => Ok("audio/ogg"),
        "wav" => Ok("audio/wav"),
        _ => bail!("petEventSoundUnsupportedType"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parser_accepts_short_state_id_text() {
        let request = parse_pet_event_sound_request(&json!({
            "requestId": "req-1",
            "stateId": "running-left",
        }))
        .unwrap();

        assert_eq!(request.request_id, "req-1");
        assert_eq!(request.state_id, "running-left");
    }

    #[test]
    fn parser_rejects_raw_path_requests() {
        assert!(
            parse_pet_event_sound_request(&json!({
                "requestId": "req-1",
                "path": "C:/Sounds/a.mp3",
            }))
            .is_none()
        );
    }

    #[test]
    fn parser_rejects_unsafe_state_id_text() {
        assert!(
            parse_pet_event_sound_request(&json!({
                "requestId": "req-1",
                "stateId": "running\nC:/Sounds/a.mp3",
            }))
            .is_none()
        );
    }

    #[test]
    fn mime_rejects_unknown_extension() {
        assert!(mime_from_path(Path::new("C:/Sounds/a.txt")).is_err());
    }

    #[test]
    #[cfg(windows)]
    fn validate_rejects_unc_network_path() {
        assert!(validate_sound_path(r"\\server\share\sound.wav").is_err());
    }
}
