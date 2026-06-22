use crate::handlers::cloud_sync::normalize_request_id;
use anyhow::Context;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::path::PathBuf;
use std::time::Duration;
use url::Url;

/// 这一段定义更新检查请求超时。
/// Update-check request timeout.
const UPDATE_CHECK_REQUEST_TIMEOUT_MS: u64 = 10_000;
/// 这一段定义更新索引地址长度上限。
/// Maximum update-index URL length.
const UPDATE_CHECK_MAX_URL_LENGTH: usize = 500;
/// 这一段定义 Release 正文摘要长度上限。
/// Maximum release-summary length.
const UPDATE_CHECK_MAX_SUMMARY_LENGTH: usize = 1200;

/// 这一段描述更新检查请求。
/// Describes an update-check request.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct UpdateCheckRequest {
    /// 这一段是请求 id。
    /// Request id.
    #[serde(rename = "requestId")]
    pub request_id: String,
    /// 这一段是手动强制检查标记，当前用于页面契约保留。
    /// Manual force-check flag, kept for the page contract.
    pub force: bool,
}

/// 这一段描述 Release 资产。
/// Describes one release asset.
#[derive(Clone, Debug, PartialEq, Eq)]
struct ReleaseAsset {
    /// 这一段是资产文件名。
    /// Asset file name.
    name: String,
    /// 这一段是浏览器下载地址。
    /// Browser download URL.
    url: String,
}

/// 这一段描述可用于更新提示的 Release 元数据。
/// Describes release metadata used by the update indicator.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Release {
    /// 这一段是 Release 版本号或 tag。
    /// Release version or tag.
    version: String,
    /// 这一段是 Release 页面地址。
    /// Release page URL.
    url: String,
    /// 这一段是 Release 摘要。
    /// Release summary.
    body: String,
    /// 这一段是当前平台资产。
    /// Current-platform asset.
    asset: Option<ReleaseAsset>,
}

/// 这一段解析更新检查请求。
/// Parse an update-check request.
pub fn parse_update_check_request(value: &Value) -> Option<UpdateCheckRequest> {
    // 这一段只接受短 request id 和可选 force 布尔值，不允许页面传入 URL。
    // Accept only a short request id and optional force boolean; the page cannot pass URLs.
    let request_id = normalize_request_id(value.get("requestId")?.as_str()?)?;
    Some(UpdateCheckRequest {
        request_id,
        force: value.get("force").and_then(Value::as_bool).unwrap_or(false),
    })
}

/// 这一段运行更新检查请求。
/// Run an update-check request.
pub async fn run_update_check_request(_request: &UpdateCheckRequest) -> anyhow::Result<Value> {
    // 这一段从受控配置或 Cargo repository 推导更新索引，不接受页面传入的网络目标。
    // Resolve the update index from controlled config or Cargo repository, never from page input.
    let current_version = env!("CARGO_PKG_VERSION");
    let release = fetch_latest_release().await?;
    let update_available = is_newer_version(&release.version, current_version)?;
    Ok(json!({
        "ok": true,
        "status": 200,
        "data": {
            "assetName": release.asset.as_ref().map(|asset| asset.name.as_str()),
            "assetUrl": release.asset.as_ref().map(|asset| asset.url.as_str()),
            "checkedAt": current_unix_millis_text(),
            "currentVersion": current_version,
            "latestVersion": release.version,
            "releaseSummary": release.body,
            "releaseUrl": release.url,
            "updateAvailable": update_available,
        },
        "error": "",
    }))
}

/// 这一段获取最新 Release，latest.json 失败时回退 GitHub REST latest release。
/// Fetch the latest release, falling back to GitHub REST latest release if latest.json fails.
async fn fetch_latest_release() -> anyhow::Result<Release> {
    // 这一段使用短超时 HTTP client，更新检查失败不能拖慢 Codex 主界面。
    // Use a short-timeout HTTP client because update-check failures must not slow the Codex UI.
    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(UPDATE_CHECK_REQUEST_TIMEOUT_MS))
        .user_agent(format!("Codex-Pro-Launcher/{}", env!("CARGO_PKG_VERSION")))
        .build()?;
    let latest_json_url = configured_latest_json_url()?;
    match fetch_latest_json_release(&client, &latest_json_url).await {
        Ok(release) => Ok(release),
        Err(latest_json_error) => {
            let repository = repository_slug_from_url(env!("CARGO_PKG_REPOSITORY"))
                .context("Cargo repository is not a GitHub URL")?;
            fetch_github_latest_release(&client, &repository)
                .await
                .with_context(|| format!("latest.json failed: {latest_json_error}"))
        }
    }
}

/// 这一段读取配置中的 latest.json 地址，缺省时从 Cargo repository 推导。
/// Read the configured latest.json URL, falling back to the Cargo repository-derived URL.
fn configured_latest_json_url() -> anyhow::Result<String> {
    // 这一段只使用本机或内嵌公开配置，避免页面操控更新源。
    // Use only local or embedded public config so the page cannot control the update source.
    let config = codex_pro_core::local_config::load_local_config(update_source_root().as_deref());
    if let Some(url) = normalize_update_url(&config.update.latest_json_url) {
        return Ok(url);
    }
    default_latest_json_url()
}

/// 这一段读取开发模式传入的源码根目录。
/// Read the source root passed by development mode.
fn update_source_root() -> Option<PathBuf> {
    // 这一段只用于读取 private/config，不会把路径传给页面。
    // Use this only to read private/config; the path is never returned to the page.
    let value = std::env::var("CODEX_PRO_SOURCE_ROOT").ok()?;
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(PathBuf::from(trimmed))
}

/// 这一段从 Cargo repository 推导 latest.json 下载地址。
/// Derive the latest.json download URL from Cargo repository metadata.
fn default_latest_json_url() -> anyhow::Result<String> {
    let repository = repository_slug_from_url(env!("CARGO_PKG_REPOSITORY"))
        .context("Cargo repository is not a GitHub URL")?;
    Ok(format!(
        "https://github.com/{repository}/releases/latest/download/latest.json"
    ))
}

/// 这一段从 GitHub repository URL 提取 owner/repo。
/// Extract owner/repo from a GitHub repository URL.
fn repository_slug_from_url(value: &str) -> Option<String> {
    // 这一段只接受 github.com 的前两个路径片段，避免把任意 host 当作 GitHub API 目标。
    // Accept only the first two github.com path segments so arbitrary hosts are not used as GitHub API targets.
    let url = Url::parse(value.trim()).ok()?;
    if url.scheme() != "https" || url.host_str()? != "github.com" {
        return None;
    }
    let mut segments = url.path_segments()?;
    let owner = segments.next()?.trim();
    let repo = segments.next()?.trim().trim_end_matches(".git");
    if owner.is_empty() || repo.is_empty() {
        return None;
    }
    Some(format!("{owner}/{repo}"))
}

/// 这一段校验更新索引和资产 URL。
/// Validate update-index and asset URLs.
fn normalize_update_url(value: &str) -> Option<String> {
    // 这一段允许 HTTPS 和本机 HTTP，方便开发测试但拒绝远程明文和携带凭证的 URL。
    // Allow HTTPS and local HTTP for development tests, while rejecting remote cleartext and credential URLs.
    let raw = value.trim();
    if raw.is_empty() || raw.len() > UPDATE_CHECK_MAX_URL_LENGTH || raw.contains('\0') {
        return None;
    }
    let url = Url::parse(raw).ok()?;
    if !url.username().is_empty() || url.password().is_some() {
        return None;
    }
    let local_http =
        url.scheme() == "http" && matches!(url.host_str(), Some("127.0.0.1" | "::1" | "localhost"));
    if url.scheme() != "https" && !local_http {
        return None;
    }
    Some(url.to_string())
}

/// 这一段请求 latest.json 并解析为 Release。
/// Fetch latest.json and parse it into release metadata.
async fn fetch_latest_json_release(client: &reqwest::Client, url: &str) -> anyhow::Result<Release> {
    let payload = client
        .get(url)
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await?
        .error_for_status()?
        .json::<Value>()
        .await?;
    release_from_latest_json_payload(&payload)
}

/// 这一段请求 GitHub latest release API 并解析为 Release。
/// Fetch the GitHub latest release API and parse it into release metadata.
async fn fetch_github_latest_release(
    client: &reqwest::Client,
    repository: &str,
) -> anyhow::Result<Release> {
    let payload = client
        .get(format!(
            "https://api.github.com/repos/{repository}/releases/latest"
        ))
        .header(reqwest::header::ACCEPT, "application/vnd.github+json")
        .send()
        .await?
        .error_for_status()?
        .json::<Value>()
        .await?;
    release_from_github_payload(&payload)
}

/// 这一段从 latest.json 载荷解析 Release。
/// Parse release metadata from the latest.json payload.
fn release_from_latest_json_payload(payload: &Value) -> anyhow::Result<Release> {
    // 这一段兼容参考项目 latest.json 的 version/url/body/assets 结构。
    // Support the reference latest.json shape with version/url/body/assets fields.
    let version = payload
        .get("version")
        .or_else(|| payload.get("tag_name"))
        .and_then(Value::as_str)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .context("latest.json missing version")?;
    let release_url = payload
        .get("url")
        .or_else(|| payload.get("html_url"))
        .and_then(Value::as_str)
        .and_then(normalize_update_url)
        .unwrap_or_default();
    let body = truncate_summary(
        payload
            .get("body")
            .or_else(|| payload.get("releaseSummary"))
            .or_else(|| payload.get("notes"))
            .and_then(Value::as_str)
            .unwrap_or_default(),
    );
    let assets = payload
        .get("assets")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(asset_from_latest_json_value)
        .collect::<Vec<_>>();
    Ok(Release {
        version,
        url: release_url,
        body,
        asset: select_update_asset(&assets),
    })
}

/// 这一段从 GitHub API 载荷解析 Release。
/// Parse release metadata from the GitHub API payload.
fn release_from_github_payload(payload: &Value) -> anyhow::Result<Release> {
    // 这一段使用 GitHub Release 标准字段 tag_name/html_url/body/assets。
    // Use standard GitHub Release fields: tag_name, html_url, body, and assets.
    let version = payload
        .get("tag_name")
        .and_then(Value::as_str)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .context("release payload missing tag_name")?;
    let release_url = payload
        .get("html_url")
        .and_then(Value::as_str)
        .and_then(normalize_update_url)
        .unwrap_or_default();
    let body = truncate_summary(
        payload
            .get("body")
            .and_then(Value::as_str)
            .unwrap_or_default(),
    );
    let assets = payload
        .get("assets")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(asset_from_github_value)
        .collect::<Vec<_>>();
    Ok(Release {
        version,
        url: release_url,
        body,
        asset: select_update_asset(&assets),
    })
}

/// 这一段从 latest.json asset 项读取安全资产。
/// Read a safe asset entry from latest.json.
fn asset_from_latest_json_value(value: &Value) -> Option<ReleaseAsset> {
    let name = normalize_asset_name(value.get("name")?.as_str()?)?;
    let url = value
        .get("url")
        .or_else(|| value.get("browser_download_url"))
        .and_then(Value::as_str)
        .and_then(normalize_update_url)?;
    Some(ReleaseAsset { name, url })
}

/// 这一段从 GitHub asset 项读取安全资产。
/// Read a safe asset entry from a GitHub asset.
fn asset_from_github_value(value: &Value) -> Option<ReleaseAsset> {
    let name = normalize_asset_name(value.get("name")?.as_str()?)?;
    let url = value
        .get("browser_download_url")
        .and_then(Value::as_str)
        .and_then(normalize_update_url)?;
    Some(ReleaseAsset { name, url })
}

/// 这一段净化资产文件名。
/// Sanitize an asset file name.
fn normalize_asset_name(value: &str) -> Option<String> {
    // 这一段只接受单个文件名，避免远端索引把路径写进页面状态。
    // Accept only a single file name so remote indexes cannot write paths into page state.
    let name = value.trim();
    if name.is_empty()
        || name.len() > 240
        || name.contains(['/', '\\', '\0'])
        || name == "."
        || name == ".."
    {
        return None;
    }
    Some(name.to_string())
}

/// 这一段选择当前平台优先的更新资产。
/// Select the preferred update asset for the current platform.
fn select_update_asset(assets: &[ReleaseAsset]) -> Option<ReleaseAsset> {
    // 这一段 Windows 优先 zip，再回退 exe；其它平台保留宽松 platform rank 以便后续扩展。
    // Prefer ZIP then EXE on Windows, with a loose platform rank kept for future expansion.
    assets
        .iter()
        .filter_map(|asset| {
            let rank = platform_asset_rank(&asset.name.to_ascii_lowercase());
            (rank < 100).then_some((rank, asset))
        })
        .min_by_key(|(rank, _)| *rank)
        .map(|(_, asset)| asset.clone())
}

/// 这一段给资产名称打平台匹配分。
/// Rank asset names by platform match.
fn platform_asset_rank(name: &str) -> u8 {
    if cfg!(windows) {
        if name.contains("codex-pro-launcher") && name.contains("windows") && name.ends_with(".zip")
        {
            return 0;
        }
        if name.contains("codex-pro-launcher") && name.ends_with(".exe") {
            return 1;
        }
        return 100;
    }
    100
}

/// 这一段截断 Release 摘要。
/// Truncate release summary.
fn truncate_summary(value: &str) -> String {
    value
        .replace('\0', " ")
        .trim()
        .chars()
        .take(UPDATE_CHECK_MAX_SUMMARY_LENGTH)
        .collect()
}

/// 这一段解析版本字符串。
/// Parse a version string.
fn parse_version_tag(value: &str) -> anyhow::Result<Vec<u64>> {
    // 这一段允许 v 前缀，只比较数字和点，避免 tag 名称里的说明文字影响判断。
    // Allow a v prefix and compare only digits and dots so tag copy does not affect ordering.
    let normalized = value.trim().trim_start_matches(['v', 'V']);
    let mut digits = String::new();
    for ch in normalized.chars() {
        if ch.is_ascii_digit() || ch == '.' {
            digits.push(ch);
        } else {
            break;
        }
    }
    if digits.is_empty() {
        anyhow::bail!("invalid version tag: {value}");
    }
    digits
        .split('.')
        .map(|part| part.parse::<u64>().map_err(Into::into))
        .collect()
}

/// 这一段判断候选版本是否比当前版本新。
/// Return whether the candidate version is newer than the current version.
fn is_newer_version(candidate: &str, current: &str) -> anyhow::Result<bool> {
    let mut left = parse_version_tag(candidate)?;
    let mut right = parse_version_tag(current)?;
    let len = left.len().max(right.len());
    left.resize(len, 0);
    right.resize(len, 0);
    Ok(left > right)
}

/// 这一段生成当前 UTC 毫秒时间戳字符串。
/// Build a UTC millisecond timestamp string.
fn current_unix_millis_text() -> String {
    // 这一段避免新增时间依赖，使用 std 时间生成页面可解析的 Unix 毫秒时间戳字符串。
    // Avoid adding a time crate; use std time to build a page-parseable Unix-millis timestamp string.
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    format!("{millis}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_compare_accepts_v_prefix() {
        // 这一段确认 v 前缀和不同段数不会影响版本比较。
        // Confirm v prefixes and different segment counts do not break version comparison.
        assert!(is_newer_version("v1.2.1", "1.2.0").unwrap());
        assert!(!is_newer_version("v1.2", "1.2.0").unwrap());
    }

    #[test]
    fn repository_slug_accepts_project_repository_url() {
        // 这一段确认默认更新源可以从 workspace repository 推导。
        // Confirm the default update source can be derived from the workspace repository.
        assert_eq!(
            repository_slug_from_url("https://github.com/FcsVorfeed/Codex-Pro-Launcher"),
            Some("FcsVorfeed/Codex-Pro-Launcher".to_string())
        );
    }

    #[test]
    fn latest_json_payload_selects_windows_zip() {
        // 这一段模拟发布索引，确认 Windows 主资产优先选择 zip。
        // Simulate the release index and confirm the Windows primary asset prefers the ZIP.
        let release = release_from_latest_json_payload(&json!({
            "version": "v1.1.0",
            "url": "https://github.com/FcsVorfeed/Codex-Pro-Launcher/releases/tag/v1.1.0",
            "body": "Release notes",
            "assets": [
                {
                    "name": "Codex-Pro-Launcher-v1.1.0.exe",
                    "url": "https://github.com/FcsVorfeed/Codex-Pro-Launcher/releases/download/v1.1.0/Codex-Pro-Launcher-v1.1.0.exe"
                },
                {
                    "name": "Codex-Pro-Launcher-v1.1.0-windows.zip",
                    "url": "https://github.com/FcsVorfeed/Codex-Pro-Launcher/releases/download/v1.1.0/Codex-Pro-Launcher-v1.1.0-windows.zip"
                }
            ]
        })).unwrap();

        assert_eq!(release.version, "v1.1.0");
        if cfg!(windows) {
            assert_eq!(
                release.asset.unwrap().name,
                "Codex-Pro-Launcher-v1.1.0-windows.zip"
            );
        }
    }

    #[test]
    fn parser_rejects_page_supplied_url() {
        // 这一段确认页面请求不能携带 URL 字段影响更新源。
        // Confirm page requests cannot carry a URL field that changes the update source.
        let request = parse_update_check_request(&json!({
            "force": true,
            "requestId": "req_update",
            "url": "https://example.com/latest.json"
        }))
        .unwrap();

        assert_eq!(request.request_id, "req_update");
        assert!(request.force);
    }
}
