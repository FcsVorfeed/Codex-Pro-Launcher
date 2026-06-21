use reqwest::header::{ACCEPT, AUTHORIZATION, CONTENT_TYPE};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use uuid::Uuid;

/// 这一段定义授权服务 JSON 媒体类型。
/// License-service JSON media type.
const LICENSE_JSON_CONTENT_TYPE: &str = "application/json";
/// 这一段定义同步授权请求超时。
/// Sync-license request timeout.
const SYNC_LICENSE_REQUEST_TIMEOUT_MS: u64 = 15_000;
/// 这一段定义同步授权指纹版本。
/// Sync-license fingerprint version.
const SYNC_LICENSE_FINGERPRINT_VERSION: &str = "codex-pro-sync-license-fingerprint-v1";
/// 这一段定义成功授权的 worker 内缓存有效期。
/// In-worker cache lifetime for successful license checks.
const SYNC_LICENSE_SUCCESS_CACHE_TTL: Duration = Duration::from_secs(10 * 60);
/// 这一段定义成功授权缓存上限。
/// Maximum successful-license cache entries.
const SYNC_LICENSE_SUCCESS_CACHE_MAX_ENTRIES: usize = 16;

/// 这一段描述授权验证结果。
/// Describes a license validation response.
#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
struct LicenseValidationResponse {
    /// 这一段说明当前设备授权是否有效。
    /// Whether the current device authorization is valid.
    valid: Option<bool>,
    /// 这一段是机器可读失败码。
    /// Machine-readable failure code.
    code: Option<String>,
    /// 这一段是授权服务返回的说明。
    /// Human-readable detail from the license service.
    message: Option<String>,
    /// 这一段是授权码数据。
    /// License data.
    license: Option<LicenseData>,
    /// 这一段是当前设备激活数据。
    /// Current device activation data.
    #[allow(dead_code)]
    activation: Option<LicenseActivation>,
    /// 这一段是标准错误响应。
    /// Standard error response.
    error: Option<LicenseResponseError>,
    /// 这一段是授权服务错误列表。
    /// License-service errors.
    errors: Option<Vec<LicenseServiceError>>,
}

/// 这一段描述授权码数据。
/// Describes license data.
#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
struct LicenseData {
    /// 这一段是授权码状态。
    /// License status.
    status: Option<String>,
    /// 这一段是到期时间。
    /// Expiry timestamp.
    #[allow(dead_code)]
    #[serde(rename = "expires_at")]
    expires_at: Option<String>,
    /// 这一段是最大设备数。
    /// Maximum machine count.
    #[allow(dead_code)]
    #[serde(rename = "seat_limit")]
    seat_limit: Option<u64>,
}

/// 这一段描述设备激活数据。
/// Describes activation data.
#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
struct LicenseActivation {
    /// 这一段是激活 ID。
    /// Activation id.
    #[allow(dead_code)]
    id: Option<String>,
    /// 这一段是设备指纹。
    /// Device fingerprint.
    #[allow(dead_code)]
    fingerprint: Option<String>,
}

/// 这一段描述标准授权错误。
/// Describes a standard license error.
#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
struct LicenseResponseError {
    /// 这一段是错误码。
    /// Error code.
    code: Option<String>,
    /// 这一段是错误说明。
    /// Error message.
    message: Option<String>,
}

/// 这一段描述授权服务错误。
/// Describes a license-service error.
#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
struct LicenseServiceError {
    /// 这一段是错误标题。
    /// Error title.
    title: Option<String>,
    /// 这一段是错误详情。
    /// Error detail.
    detail: Option<String>,
    /// 这一段是错误码。
    /// Error code.
    code: Option<String>,
}

/// 这一段描述 worker 内成功授权缓存项。
/// Describes one in-worker successful-license cache entry.
#[derive(Clone, Debug)]
struct SyncLicenseCacheEntry {
    /// 这一段是本次授权成功的单调时间。
    /// Monotonic time when authorization succeeded.
    authorized_at: Instant,
    /// 这一段是授权码到期时间，只保存授权服务返回的时间戳，不保存原始密钥。
    /// License expiry timestamp; store only the service timestamp, never the raw key.
    expires_at: Option<String>,
}

/// 这一段描述同步授权成功后的安全展示信息。
/// Describes safe display metadata after sync authorization succeeds.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SyncLicenseAuthorization {
    /// 这一段是授权码到期时间，供页面展示。
    /// License expiry timestamp for page display.
    pub expires_at: Option<String>,
}

/// 这一段描述授权服务运行配置。
/// Describes license-service runtime config.
#[derive(Clone, Debug, PartialEq, Eq)]
struct LicenseSeatConfig {
    /// 这一段是授权服务 API 根地址。
    /// License-service API base URL.
    api_base: String,
    /// 这一段是授权服务公开 API Key。
    /// License-service publishable API key.
    api_key: String,
    /// 这一段是产品标识。
    /// Product slug.
    product_slug: String,
}

/// 这一段描述同步授权错误。
/// Describes a sync-license error.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SyncLicenseError {
    /// 这一段是前端 i18n key。
    /// Frontend i18n key.
    pub message_key: &'static str,
    /// 这一段是脱敏错误说明。
    /// Sanitized error message.
    message: String,
    /// 这一段是上游状态码。
    /// Upstream status code.
    status: u16,
}

impl SyncLicenseError {
    /// 这一段构造授权错误。
    /// Build a license error.
    fn new(message_key: &'static str, message: impl Into<String>, status: u16) -> Self {
        Self {
            message_key,
            message: message.into(),
            status,
        }
    }

    /// 这一段转换为页面侧统一响应。
    /// Convert into the normalized page response.
    pub fn into_response(self) -> Value {
        json!({
            "ok": false,
            "status": self.status,
            "data": {
                "messageKey": self.message_key,
                "messageDetail": self.message,
                "licenseInvalid": true,
            },
            "error": "Sync key authorization failed",
        })
    }
}

/// 这一段创建授权校验 HTTP client。
/// Create a license-check HTTP client.
fn create_license_http_client() -> Result<reqwest::Client, SyncLicenseError> {
    reqwest::Client::builder()
        .timeout(Duration::from_millis(SYNC_LICENSE_REQUEST_TIMEOUT_MS))
        .no_proxy()
        .build()
        .map_err(|error| {
            SyncLicenseError::new(
                "sync.error.licenseValidationFailed",
                format!("License client setup failed: {error}"),
                0,
            )
        })
}

/// 这一段读取授权服务运行配置。
/// Read the license-service runtime config.
fn license_config() -> Result<LicenseSeatConfig, SyncLicenseError> {
    // 这一段从本机私有配置读取授权供应商参数，避免把真实值写进公开源码。
    // Read provider parameters from private local config so real values are not committed to public source.
    let source_root = license_source_root();
    let license_config =
        codex_pro_core::local_config::load_local_config(source_root.as_deref()).license;
    let api_base = license_config
        .api_base
        .trim()
        .trim_end_matches('/')
        .to_string();
    let api_key = license_config.api_key.trim().to_string();
    let product_slug = license_config.product_slug.trim().to_string();
    if api_base.is_empty() || api_key.is_empty() || product_slug.is_empty() {
        return Err(SyncLicenseError::new(
            "sync.error.licenseValidationFailed",
            "License service is not configured",
            0,
        ));
    }
    if !is_license_https_url(&api_base)
        || !is_license_publishable_key(&api_key)
        || !is_license_path_segment_safe(&product_slug)
    {
        return Err(SyncLicenseError::new(
            "sync.error.licenseValidationFailed",
            "License service configuration is invalid",
            0,
        ));
    }
    Ok(LicenseSeatConfig {
        api_base,
        api_key,
        product_slug,
    })
}

/// 这一段读取 worker 显式源码根，避免开发 runtime 副本依赖当前工作目录。
/// Read the explicit worker source root so dev-runtime copies do not depend on cwd.
fn license_source_root() -> Option<PathBuf> {
    // 这一段和 worker 启动环境对齐；发布包没有源码根时仍走 exe 邻近和运行目录配置。
    // Match the worker launch environment; release builds without a source root still use exe-near and runtime config.
    let value = std::env::var("CODEX_PRO_SOURCE_ROOT").unwrap_or_default();
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(PathBuf::from(trimmed))
    }
}

/// 这一段判断授权 API 根地址是否安全。
/// Decide whether the license API base URL is safe.
fn is_license_https_url(value: &str) -> bool {
    url::Url::parse(value)
        .ok()
        .is_some_and(|url| url.scheme() == "https" && url.host_str().is_some())
}

/// 这一段判断授权 API Key 是否是公开 Key 形状。
/// Decide whether the license API key has a publishable-key shape.
fn is_license_publishable_key(value: &str) -> bool {
    value.starts_with("pk_")
        && value.len() <= 220
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-'))
}

/// 这一段判断授权路径片段是否安全。
/// Decide whether a license path segment is safe.
fn is_license_path_segment_safe(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 120
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-'))
}

/// 这一段生成 LicenseSeat 授权接口 URL。
/// Build a LicenseSeat license API URL.
fn license_action_url(config: &LicenseSeatConfig, sync_key: &str, action: &str) -> String {
    // 这一段把产品和授权码都作为 URL 路径片段编码，避免特殊字符破坏请求路径。
    // Encode both product and license key as path segments so special characters cannot break the request path.
    format!(
        "{}/products/{}/licenses/{}/{}",
        config.api_base,
        encode_license_path_segment(&config.product_slug),
        encode_license_path_segment(sync_key.trim()),
        action
    )
}

/// 这一段编码 URL 路径片段。
/// Encode one URL path segment.
fn encode_license_path_segment(value: &str) -> String {
    let mut output = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            output.push(byte as char);
        } else {
            output.push_str(&format!("%{byte:02X}"));
        }
    }
    output
}

/// 这一段确认同步密钥是当前设备可用的授权码。
/// Ensure the sync key is a license authorized for this device.
pub async fn ensure_sync_license(
    sync_key: &str,
) -> Result<SyncLicenseAuthorization, SyncLicenseError> {
    let client = create_license_http_client()?;
    ensure_sync_license_with_client(&client, sync_key, false).await
}

/// 这一段用调用方已有 HTTP client 确认同步密钥授权。
/// Ensure sync-key authorization with a caller-provided HTTP client.
pub async fn ensure_sync_license_with_client(
    client: &reqwest::Client,
    sync_key: &str,
    force_validation: bool,
) -> Result<SyncLicenseAuthorization, SyncLicenseError> {
    // 这一段先生成稳定设备指纹；只上传 hash，不上传原始机器信息。
    // Build a stable device fingerprint first; only the hash is uploaded, never raw machine data.
    let fingerprint = build_machine_fingerprint().await;
    let cache_key = sync_license_success_cache_key(sync_key, &fingerprint);
    if force_validation {
        remove_sync_license_success_cache(&cache_key);
    }
    if let Some(entry) = (!force_validation)
        .then(|| read_sync_license_success_cache(&cache_key))
        .flatten()
    {
        return Ok(SyncLicenseAuthorization {
            expires_at: entry.expires_at,
        });
    }

    let first_validation = validate_license(client, sync_key, &fingerprint).await?;
    if first_validation.valid == Some(true) {
        let authorization = sync_license_authorization_from_response(&first_validation);
        write_sync_license_success_cache(cache_key, authorization.clone());
        return Ok(authorization);
    }

    // 这一段处理授权码存在但本机尚未绑定的首次激活路径。
    // Handle the first-activation path where the license exists but this device is not bound yet.
    if first_validation.license.is_none() {
        return Err(SyncLicenseError::new(
            "sync.error.licenseInvalid",
            license_response_message(&first_validation, "License key is invalid"),
            404,
        ));
    }
    if let Some(message_key) = unusable_license_status_message_key(&first_validation) {
        return Err(SyncLicenseError::new(
            message_key,
            license_response_message(&first_validation, "License key is not active"),
            403,
        ));
    }

    if let Err(error) = activate_machine(client, sync_key, &fingerprint).await {
        // 这一段兼容同设备重复激活或服务端幂等返回差异：再次验证成功即可视为可用。
        // Tolerate same-device activation or idempotency differences: a successful re-validation means the device is authorized.
        let retry_validation = validate_license(client, sync_key, &fingerprint).await?;
        if retry_validation.valid == Some(true) {
            let authorization = sync_license_authorization_from_response(&retry_validation);
            write_sync_license_success_cache(cache_key, authorization.clone());
            return Ok(authorization);
        }
        return Err(error);
    }

    // 这一段以绑定后的二次验证作为最终同步授权依据。
    // Use a second validation after activation as the final sync authorization decision.
    let second_validation = validate_license(client, sync_key, &fingerprint).await?;
    if second_validation.valid == Some(true) {
        let authorization = sync_license_authorization_from_response(&second_validation);
        write_sync_license_success_cache(cache_key, authorization.clone());
        Ok(authorization)
    } else {
        Err(SyncLicenseError::new(
            "sync.error.licenseActivationFailed",
            license_response_message(&second_validation, "Machine activation did not validate"),
            403,
        ))
    }
}

/// 这一段从授权响应中提取页面可展示的安全授权信息。
/// Extract safe page-display authorization metadata from a license response.
fn sync_license_authorization_from_response(
    payload: &LicenseValidationResponse,
) -> SyncLicenseAuthorization {
    SyncLicenseAuthorization {
        expires_at: license_response_expiry(payload),
    }
}

/// 这一段读取授权响应里的到期时间。
/// Read the expiry timestamp from a license response.
fn license_response_expiry(payload: &LicenseValidationResponse) -> Option<String> {
    payload
        .license
        .as_ref()
        .and_then(|license| license.expires_at.as_deref())
        .and_then(normalize_license_expiry)
}

/// 这一段只允许短 ISO 风格时间戳进入页面合同。
/// Allow only short ISO-like timestamps into the page contract.
fn normalize_license_expiry(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.len() > 80 {
        return None;
    }
    let is_timestamp_like = trimmed
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | ':' | '.' | '+' | '_'));
    if is_timestamp_like {
        Some(trimmed.to_string())
    } else {
        None
    }
}

/// 这一段返回 worker 内授权成功缓存。
/// Return the in-worker successful-license cache.
fn sync_license_success_cache() -> &'static Mutex<HashMap<String, SyncLicenseCacheEntry>> {
    // 这一段只在 worker 进程内缓存授权状态，不落盘、不跨进程共享。
    // Cache authorization state only inside the worker process; never persist or share it across processes.
    static CACHE: OnceLock<Mutex<HashMap<String, SyncLicenseCacheEntry>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 这一段构造不含明文同步密钥的授权缓存键。
/// Build a license-cache key without the plaintext sync key.
fn sync_license_success_cache_key(sync_key: &str, fingerprint: &str) -> String {
    // 这一段把同步密钥 hash、设备指纹和缓存协议版本合并后再 hash，避免明文密钥进入内存 map key。
    // Hash the sync-key hash, device fingerprint, and cache protocol together so plaintext keys never enter map keys.
    let sync_key_hash = sha256_hex(sync_key.trim().as_bytes());
    sha256_hex(
        format!("codex-pro-sync-license-cache-v1\0{sync_key_hash}\0{fingerprint}").as_bytes(),
    )
}

/// 这一段读取仍在有效期内的授权成功缓存。
/// Read a still-fresh successful-license cache entry.
fn read_sync_license_success_cache(cache_key: &str) -> Option<SyncLicenseCacheEntry> {
    // 这一段命中过期项时同步移除，避免缓存长期增长。
    // Remove stale entries on read so the cache does not grow with expired state.
    let mut cache = sync_license_success_cache()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let entry = cache.get(cache_key)?.clone();
    if entry.authorized_at.elapsed() <= SYNC_LICENSE_SUCCESS_CACHE_TTL {
        return Some(entry);
    }
    cache.remove(cache_key);
    None
}

/// 这一段写入授权成功缓存。
/// Write a successful-license cache entry.
fn write_sync_license_success_cache(cache_key: String, authorization: SyncLicenseAuthorization) {
    // 这一段限制缓存规模；超过上限时清空，避免多密钥场景无界积累。
    // Bound cache size; clear when full so many-key scenarios cannot accumulate indefinitely.
    let mut cache = sync_license_success_cache()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if !cache.contains_key(&cache_key) && cache.len() >= SYNC_LICENSE_SUCCESS_CACHE_MAX_ENTRIES {
        cache.clear();
    }
    cache.insert(
        cache_key,
        SyncLicenseCacheEntry {
            authorized_at: Instant::now(),
            expires_at: authorization.expires_at,
        },
    );
}

/// 这一段移除指定授权成功缓存。
/// Remove one successful-license cache entry.
fn remove_sync_license_success_cache(cache_key: &str) {
    // 这一段用于强制重验，避免撤销或过期后普通同步继续命中过期成功状态。
    // Use this for forced revalidation so revoked or expired keys cannot keep using stale success state.
    let mut cache = sync_license_success_cache()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    cache.remove(cache_key);
}

/// 这一段调用授权验证接口。
/// Call the license validation endpoint.
async fn validate_license(
    client: &reqwest::Client,
    sync_key: &str,
    fingerprint: &str,
) -> Result<LicenseValidationResponse, SyncLicenseError> {
    let config = license_config()?;
    let response = client
        .post(license_action_url(&config, sync_key, "validate"))
        .header(CONTENT_TYPE, LICENSE_JSON_CONTENT_TYPE)
        .header(ACCEPT, LICENSE_JSON_CONTENT_TYPE)
        .header(AUTHORIZATION, format!("Bearer {}", config.api_key))
        .json(&json!({
            "fingerprint": fingerprint,
        }))
        .send()
        .await
        .map_err(|_| {
            SyncLicenseError::new(
                "sync.error.licenseValidationFailed",
                "License validation request failed",
                0,
            )
        })?;
    let (status, payload) = read_license_response(response).await;
    if !(200..300).contains(&status) {
        let message_key = if status == 404 {
            "sync.error.licenseInvalid"
        } else {
            "sync.error.licenseValidationFailed"
        };
        return Err(SyncLicenseError::new(
            message_key,
            license_response_message(&payload, "License validation failed"),
            status,
        ));
    }
    Ok(payload)
}

/// 这一段调用当前设备激活接口。
/// Call the current-device activation endpoint.
async fn activate_machine(
    client: &reqwest::Client,
    sync_key: &str,
    fingerprint: &str,
) -> Result<(), SyncLicenseError> {
    let config = license_config()?;
    let response = client
        .post(license_action_url(&config, sync_key, "activate"))
        .header(CONTENT_TYPE, LICENSE_JSON_CONTENT_TYPE)
        .header(ACCEPT, LICENSE_JSON_CONTENT_TYPE)
        .header(AUTHORIZATION, format!("Bearer {}", config.api_key))
        .json(&json!({
            "fingerprint": fingerprint,
            "device_name": license_machine_name(fingerprint),
            "metadata": {
                "app": "codex-pro",
                "platform": license_machine_platform(),
            },
        }))
        .send()
        .await
        .map_err(|_| {
            SyncLicenseError::new(
                "sync.error.licenseActivationFailed",
                "License activation request failed",
                0,
            )
        })?;
    let (status, payload) = read_license_response(response).await;
    if (200..300).contains(&status) {
        return Ok(());
    }
    let message = license_response_message(&payload, "Machine activation failed");
    let message_key = if is_device_limit_error(&payload, &message) {
        "sync.error.licenseDeviceLimit"
    } else {
        "sync.error.licenseActivationFailed"
    };
    Err(SyncLicenseError::new(message_key, message, status))
}

/// 这一段读取授权服务 JSON 响应。
/// Read a license-service JSON response.
async fn read_license_response(response: reqwest::Response) -> (u16, LicenseValidationResponse) {
    let status = response.status().as_u16();
    let text = response.text().await.unwrap_or_default();
    let payload = serde_json::from_str::<LicenseValidationResponse>(&text).unwrap_or_default();
    (status, payload)
}

/// 这一段读取授权响应里最有用的错误说明。
/// Read the most useful license-service response message.
fn license_response_message(payload: &LicenseValidationResponse, fallback: &str) -> String {
    let standard_error_message = payload
        .error
        .as_ref()
        .and_then(|error| error.message.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let validation_message = payload
        .message
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let error_message = payload
        .errors
        .as_ref()
        .and_then(|errors| errors.first())
        .and_then(|error| {
            error
                .detail
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .or_else(|| {
                    error
                        .title
                        .as_deref()
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                })
        });
    standard_error_message
        .or(validation_message)
        .or(error_message)
        .unwrap_or(fallback)
        .chars()
        .take(500)
        .collect()
}

/// 这一段根据授权码状态返回本地化错误 key。
/// Return a localized error key for unusable license statuses.
fn unusable_license_status_message_key(
    payload: &LicenseValidationResponse,
) -> Option<&'static str> {
    let status = payload
        .license
        .as_ref()
        .and_then(|license| license.status.as_deref())
        .or(payload.code.as_deref())
        .or(payload
            .error
            .as_ref()
            .and_then(|error| error.code.as_deref()))?
        .trim()
        .to_ascii_lowercase();
    if status.contains("expired") {
        Some("sync.error.licenseExpired")
    } else if status.contains("suspended") {
        Some("sync.error.licenseSuspended")
    } else if status.contains("revoked") {
        Some("sync.error.licenseRevoked")
    } else {
        None
    }
}

/// 这一段判断激活失败是否更像设备上限。
/// Decide whether an activation failure looks like a device-limit error.
fn is_device_limit_error(payload: &LicenseValidationResponse, message: &str) -> bool {
    let code = license_response_code(payload);
    let text = format!("{code} {message}").to_ascii_lowercase();
    text.contains("seat_limit_exceeded")
        || text.contains("device_limit_exceeded")
        || text.contains("machine_limit_exceeded")
        || (text.contains("machine")
            && (text.contains("limit")
                || text.contains("maximum")
                || text.contains("max")
                || text.contains("too many")))
        || (text.contains("device")
            && (text.contains("limit")
                || text.contains("maximum")
                || text.contains("max")
                || text.contains("too many")))
        || (text.contains("seat")
            && (text.contains("limit")
                || text.contains("maximum")
                || text.contains("max")
                || text.contains("too many")))
}

/// 这一段读取授权响应里的机器可读错误码。
/// Read the machine-readable error code from a license response.
fn license_response_code(payload: &LicenseValidationResponse) -> String {
    payload
        .error
        .as_ref()
        .and_then(|error| error.code.as_deref())
        .or(payload.code.as_deref())
        .or_else(|| {
            payload
                .errors
                .as_ref()
                .and_then(|errors| errors.first())
                .and_then(|error| error.code.as_deref())
        })
        .unwrap_or_default()
        .to_ascii_lowercase()
}

/// 这一段构造不含主机名的设备显示名。
/// Build a device display name that does not include the host name.
fn license_machine_name(fingerprint: &str) -> String {
    // 这一段只使用已经上传的设备指纹短前缀，避免把真实电脑名、公司名或用户名发给授权服务。
    // Use only a short prefix of the already-uploaded fingerprint so real host, company, or user names are not sent to the license service.
    let suffix: String = fingerprint
        .chars()
        .filter(|ch| ch.is_ascii_hexdigit())
        .take(8)
        .collect();
    if suffix.len() == 8 {
        format!("Codex-Pro device {suffix}")
    } else {
        "Codex-Pro device".to_string()
    }
}

/// 这一段返回授权设备平台名。
/// Return the license machine platform name.
fn license_machine_platform() -> &'static str {
    if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macOS"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        std::env::consts::OS
    }
}

/// 这一段生成当前设备稳定指纹。
/// Build the current device's stable fingerprint.
async fn build_machine_fingerprint() -> String {
    // 这一段组合系统机器 GUID、硬件环境和本插件安装 ID，再整体 hash。
    // Combine machine GUID, hardware environment, and this plugin's install id, then hash the whole input.
    let mut parts = vec![SYNC_LICENSE_FINGERPRINT_VERSION.to_string()];
    if let Some(machine_guid) = read_windows_machine_guid() {
        parts.push(format!("machine-guid={machine_guid}"));
    }
    for key in [
        "COMPUTERNAME",
        "PROCESSOR_IDENTIFIER",
        "PROCESSOR_ARCHITECTURE",
        "PROCESSOR_LEVEL",
        "PROCESSOR_REVISION",
        "NUMBER_OF_PROCESSORS",
    ] {
        if let Ok(value) = std::env::var(key) {
            let value = value.trim();
            if !value.is_empty() {
                parts.push(format!("{key}={value}"));
            }
        }
    }
    parts.push(format!(
        "install-id={}",
        read_or_create_license_install_id().await
    ));
    sha256_hex(parts.join("\0").as_bytes())
}

/// 这一段读取或创建本插件本地安装 ID。
/// Read or create this plugin's local install id.
async fn read_or_create_license_install_id() -> String {
    let path = codex_pro_core::paths::codex_pro_data_root_dir().join("license-device-id.txt");
    if let Ok(text) = tokio::fs::read_to_string(&path).await
        && let Some(id) = normalize_license_install_id(&text)
    {
        return id;
    }
    let id = Uuid::new_v4().to_string();
    if let Some(parent) = path.parent() {
        let _ = tokio::fs::create_dir_all(parent).await;
    }
    let _ = tokio::fs::write(&path, &id).await;
    id
}

/// 这一段清理本地安装 ID。
/// Normalize the local install id.
fn normalize_license_install_id(value: &str) -> Option<String> {
    let id = value.trim();
    if id.len() < 16 || id.len() > 80 {
        return None;
    }
    if !id.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '-') {
        return None;
    }
    Some(id.to_string())
}

/// 这一段读取 Windows MachineGuid。
/// Read the Windows MachineGuid.
#[cfg(windows)]
fn read_windows_machine_guid() -> Option<String> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use windows::Win32::System::Registry::{HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ, RegGetValueW};
    use windows::core::PCWSTR;

    fn wide_null(value: &str) -> Vec<u16> {
        // 这一段把 Rust 字符串转成 Win32 API 需要的 UTF-16 空结尾字符串。
        // Convert Rust strings into null-terminated UTF-16 for Win32 APIs.
        OsStr::new(value).encode_wide().chain([0]).collect()
    }

    let subkey = wide_null("SOFTWARE\\Microsoft\\Cryptography");
    let value_name = wide_null("MachineGuid");
    let mut buffer = vec![0u16; 128];
    let mut size_bytes = (buffer.len() * std::mem::size_of::<u16>()) as u32;
    let result = unsafe {
        RegGetValueW(
            HKEY_LOCAL_MACHINE,
            PCWSTR(subkey.as_ptr()),
            PCWSTR(value_name.as_ptr()),
            RRF_RT_REG_SZ,
            None,
            Some(buffer.as_mut_ptr().cast()),
            Some(&mut size_bytes),
        )
    };
    if result.0 != 0 || size_bytes < 2 {
        return None;
    }
    let char_count = (size_bytes as usize / std::mem::size_of::<u16>()).min(buffer.len());
    let value = String::from_utf16_lossy(&buffer[..char_count])
        .trim_matches('\0')
        .trim()
        .to_string();
    if value.is_empty() { None } else { Some(value) }
}

/// 这一段在非 Windows 平台不读取 MachineGuid。
/// Do not read MachineGuid on non-Windows platforms.
#[cfg(not(windows))]
fn read_windows_machine_guid() -> Option<String> {
    None
}

/// 这一段计算 SHA-256 hex。
/// Compute SHA-256 hex.
fn sha256_hex(bytes: &[u8]) -> String {
    let hash = Sha256::digest(bytes);
    hash.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 这一段确认授权码状态会映射到本地化错误。
    /// Confirm license statuses map to localized errors.
    #[test]
    fn license_status_maps_to_error_key() {
        // 这一段模拟授权服务返回已过期授权码。
        // Simulate an expired license from the license service.
        let payload = LicenseValidationResponse {
            license: Some(LicenseData {
                status: Some("expired".to_string()),
                ..Default::default()
            }),
            ..Default::default()
        };

        // 这一段确认页面能拿到稳定 i18n key。
        // Confirm the page receives a stable i18n key.
        assert_eq!(
            unusable_license_status_message_key(&payload),
            Some("sync.error.licenseExpired")
        );
    }

    /// 这一段确认授权到期时间只作为安全展示字段透传。
    /// Confirm license expiry is passed through only as safe display metadata.
    #[test]
    fn license_authorization_extracts_expiry() {
        // 这一段模拟授权服务返回可解析的到期时间。
        // Simulate a parseable expiry timestamp from the license service.
        let payload = LicenseValidationResponse {
            license: Some(LicenseData {
                expires_at: Some("2026-07-01T08:30:00Z".to_string()),
                status: Some("active".to_string()),
                ..Default::default()
            }),
            ..Default::default()
        };

        // 这一段只暴露到期时间，不包含原始授权码或其它授权服务字段。
        // Expose only the expiry timestamp, not the raw key or other service fields.
        assert_eq!(
            sync_license_authorization_from_response(&payload).expires_at,
            Some("2026-07-01T08:30:00Z".to_string())
        );
    }

    /// 这一段确认异常到期字段不会进入页面协议。
    /// Confirm malformed expiry fields do not enter the page contract.
    #[test]
    fn license_authorization_rejects_malformed_expiry() {
        // 这一段模拟带控制字符的异常到期字段。
        // Simulate a malformed expiry field with control characters.
        let payload = LicenseValidationResponse {
            license: Some(LicenseData {
                expires_at: Some("2026-07-01\nsecret".to_string()),
                ..Default::default()
            }),
            ..Default::default()
        };

        // 这一段确认页面不会显示异常字符串。
        // Confirm the page will not display the malformed string.
        assert_eq!(
            sync_license_authorization_from_response(&payload).expires_at,
            None
        );
    }

    /// 这一段确认 LicenseSeat UUID 激活 ID 不会导致整包解析失败。
    /// Confirm LicenseSeat UUID activation ids do not fail the whole response parse.
    #[test]
    fn license_validation_accepts_uuid_activation_id() {
        // 这一段覆盖真实 LicenseSeat validate 成功响应的关键字段形状。
        // Cover the key field shapes from a real successful LicenseSeat validate response.
        let payload: LicenseValidationResponse = serde_json::from_str(
            r#"{
              "object": "validation_result",
              "valid": true,
              "license": {
                "object": "license",
                "key": "TEST-KEY",
                "status": "active",
                "expires_at": null,
                "seat_limit": 10,
                "active_seats": 1
              },
              "activation": {
                "object": "activation",
                "id": "c9d2ec42-1f0a-4381-9b9b-6515731c3967",
                "fingerprint": "device-fingerprint"
              }
            }"#,
        )
        .expect("LicenseSeat validation response should parse");

        // 这一段确认授权码和激活对象都被保留下来。
        // Confirm both license and activation objects remain available.
        assert_eq!(payload.valid, Some(true));
        assert_eq!(
            payload.license.and_then(|license| license.status),
            Some("active".to_string())
        );
        assert_eq!(
            payload.activation.and_then(|activation| activation.id),
            Some("c9d2ec42-1f0a-4381-9b9b-6515731c3967".to_string())
        );
    }

    /// 这一段确认设备上限错误可被识别。
    /// Confirm device-limit activation errors can be recognized.
    #[test]
    fn device_limit_error_is_detected() {
        // 这一段模拟授权设备数量上限错误。
        // Simulate a license seat-limit error.
        let payload = LicenseValidationResponse {
            error: Some(LicenseResponseError {
                code: Some("seat_limit_exceeded".to_string()),
                message: Some("seat limit reached".to_string()),
            }),
            ..Default::default()
        };

        // 这一段让前端展示“设备已达上限”而不是泛化授权失败。
        // Let the frontend show device-limit copy instead of a generic activation failure.
        assert!(is_device_limit_error(&payload, "seat limit reached"));
    }

    /// 这一段确认授权路径片段会被百分号编码。
    /// Confirm license path segments are percent-encoded.
    #[test]
    fn license_path_segments_are_encoded() {
        // 这一段使用包含空格和斜杠的输入覆盖路径编码。
        // Cover path encoding with values that contain spaces and slashes.
        assert_eq!(encode_license_path_segment("A B/C"), "A%20B%2FC");
    }

    /// 这一段确认本地安装 ID 只接受稳定安全字符。
    /// Confirm local install ids accept only stable safe characters.
    #[test]
    fn license_install_id_is_normalized() {
        // 这一段允许 UUID 格式，拒绝控制字符。
        // Allow UUID-shaped values and reject control characters.
        assert!(normalize_license_install_id("550e8400-e29b-41d4-a716-446655440000").is_some());
        assert!(normalize_license_install_id("bad\nid").is_none());
    }

    /// 这一段确认授权设备名不会透出真实主机名。
    /// Confirm license machine names do not expose the real host name.
    #[test]
    fn license_machine_name_uses_fingerprint_prefix() {
        // 这一段只从设备指纹生成稳定短标签，不读取 COMPUTERNAME/HOSTNAME。
        // Generate only a stable short label from the fingerprint, without reading COMPUTERNAME/HOSTNAME.
        let name = license_machine_name("abcdef1234567890");
        assert_eq!(name, "Codex-Pro device abcdef12");
        assert!(!name.contains("Workstation"));
        assert_eq!(
            license_machine_name("not-a-hex-fingerprint"),
            "Codex-Pro device"
        );
    }

    /// 这一段确认 SHA-256 输出满足设备指纹形状预期。
    /// Confirm SHA-256 output matches the expected fingerprint shape.
    #[test]
    fn sha256_hex_outputs_stable_fingerprint_shape() {
        // 这一段使用固定输入验证 hex 长度和可重复性。
        // Use fixed input to verify hex length and repeatability.
        let first = sha256_hex(b"codex-pro");
        let second = sha256_hex(b"codex-pro");
        assert_eq!(first, second);
        assert_eq!(first.len(), 64);
        assert!(first.chars().all(|ch| ch.is_ascii_hexdigit()));
    }

    /// 这一段确认授权成功缓存不暴露明文密钥。
    /// Confirm the successful-license cache key does not expose plaintext keys.
    #[test]
    fn success_cache_key_does_not_include_plaintext_key() {
        // 这一段用固定授权码和设备指纹生成缓存键。
        // Build a cache key from a fixed license key and device fingerprint.
        let sync_key = "test-placeholder-license-key-123456";
        let cache_key = sync_license_success_cache_key(sync_key, "fingerprint-hash");

        // 这一段确认缓存键是 hash 形状，且不包含原始授权码。
        // Confirm the cache key is hash-shaped and does not contain the original license key.
        assert_eq!(cache_key.len(), 64);
        assert!(!cache_key.contains(sync_key));
        assert!(cache_key.chars().all(|ch| ch.is_ascii_hexdigit()));
    }

    /// 这一段确认授权成功缓存能被普通同步动作复用。
    /// Confirm ordinary sync actions can reuse the successful-license cache.
    #[test]
    fn success_cache_round_trips_fresh_entries() {
        // 这一段清理共享测试缓存，避免其它测试的缓存项影响断言。
        // Clear the shared test cache so other tests cannot affect the assertion.
        let cache_key = sync_license_success_cache_key(
            "test-placeholder-license-key-123456",
            "fingerprint-hash",
        );
        sync_license_success_cache()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clear();

        // 这一段写入成功授权缓存并立即读取，模拟普通非强制同步路径。
        // Write a successful authorization and read it immediately, matching the ordinary non-forced sync path.
        write_sync_license_success_cache(
            cache_key.clone(),
            SyncLicenseAuthorization {
                expires_at: Some("2026-07-01T08:30:00Z".to_string()),
            },
        );
        let cached = read_sync_license_success_cache(&cache_key).unwrap();
        assert_eq!(cached.expires_at, Some("2026-07-01T08:30:00Z".to_string()));
    }

    /// 这一段确认强制重验会先移除旧成功缓存。
    /// Confirm forced revalidation clears old successful-license cache first.
    #[test]
    fn success_cache_can_be_removed_before_forced_validation() {
        // 这一段先写入一条成功缓存，模拟之前通过授权的设备。
        // Write one successful cache entry to simulate a previously authorized device.
        let cache_key = sync_license_success_cache_key(
            "test-placeholder-license-key-123456",
            "fingerprint-hash",
        );
        write_sync_license_success_cache(cache_key.clone(), SyncLicenseAuthorization::default());
        assert!(read_sync_license_success_cache(&cache_key).is_some());

        // 这一段移除缓存，模拟强制联网重验开始前的状态清理。
        // Remove the cache entry to model cleanup before forced network revalidation.
        remove_sync_license_success_cache(&cache_key);
        assert!(read_sync_license_success_cache(&cache_key).is_none());
    }

    /// 这一段确认授权错误响应不会泄露供应商名。
    /// Confirm license errors do not expose provider names in user-facing response fields.
    #[test]
    fn license_error_response_uses_neutral_key_copy() {
        // 这一段构造无效授权码错误并检查页面协议字段。
        // Build an invalid-license error and inspect the page contract fields.
        let response =
            SyncLicenseError::new("sync.error.licenseInvalid", "invalid", 404).into_response();
        assert_eq!(response["data"]["messageKey"], "sync.error.licenseInvalid");
        assert_eq!(response["data"]["licenseInvalid"], true);
        assert_eq!(response["error"], "Sync key authorization failed");
    }
}
