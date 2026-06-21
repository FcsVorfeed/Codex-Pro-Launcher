use crate::handlers::cloud_sync::normalize_request_id;
use serde_json::{Value, json};
use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

/// 这一段限制单次扫描的 JSONL 文件数量。
/// Maximum JSONL files scanned in one request.
const TODAY_TOKEN_USAGE_MAX_FILES: usize = 2000;
/// 这一段限制单行 JSONL 字节数，避免异常日志拖垮刷新。
/// Maximum bytes accepted for one JSONL line.
const TODAY_TOKEN_USAGE_MAX_LINE_BYTES: usize = 2 * 1024 * 1024;
/// 这一段给 mtime 预筛保留一天余量，避免文件系统时间轻微漂移导致漏计。
/// One-day mtime margin used to avoid misses from small filesystem clock drift.
const TODAY_TOKEN_USAGE_MTIME_MARGIN_MS: i64 = 24 * 60 * 60 * 1000;

/// 这一段描述 Today token 聚合请求。
/// Describes a Today token aggregation request.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TodayTokenUsageRequest {
    /// 这一段是页面请求 id。
    /// Page request id.
    pub request_id: String,
    /// 这一段是本地日期 YYYY-MM-DD。
    /// Local date in YYYY-MM-DD form.
    pub date: String,
    /// 这一段是本地日期起点 ISO 文本。
    /// ISO text for the local day start.
    pub start_iso: String,
    /// 这一段是本地日期终点 ISO 文本。
    /// ISO text for the local day end.
    pub end_iso: String,
    /// 这一段是本地日期起点毫秒时间戳。
    /// Millisecond timestamp for the local day start.
    pub start_ms: i64,
    /// 这一段是本地日期终点毫秒时间戳。
    /// Millisecond timestamp for the local day end.
    pub end_ms: i64,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct TokenTotals {
    cached_input_tokens: i64,
    event_count: i64,
    input_tokens: i64,
    output_tokens: i64,
    reasoning_output_tokens: i64,
    scanned_files: i64,
    skipped_events: i64,
    total_tokens: i64,
}

/// 这一段解析 Today token 聚合请求，只允许日期、时间窗和 request id。
/// Parse a Today token aggregation request, allowing only date, time window, and request id.
pub fn parse_today_token_usage_request(value: &Value) -> Option<TodayTokenUsageRequest> {
    let request_id = normalize_request_id(value.get("requestId")?.as_str()?)?;
    let date = normalize_date(value.get("date")?.as_str()?)?;
    let start_iso = normalize_iso(value.get("startIso")?.as_str()?)?;
    let end_iso = normalize_iso(value.get("endIso")?.as_str()?)?;
    let start_ms = normalize_epoch_ms(value.get("startMs")?)?;
    let end_ms = normalize_epoch_ms(value.get("endMs")?)?;
    if start_ms >= end_ms {
        return None;
    }
    Some(TodayTokenUsageRequest {
        request_id,
        date,
        start_iso,
        end_iso,
        start_ms,
        end_ms,
    })
}

/// 这一段运行本机 Today token 聚合请求。
/// Run a local Today token aggregation request.
pub async fn run_today_token_usage_request(
    request: &TodayTokenUsageRequest,
) -> anyhow::Result<Value> {
    // 这一段把同步文件扫描放到 blocking 线程，避免阻塞 bridge 主异步任务。
    // Run synchronous file scanning on a blocking thread so the bridge async task is not blocked.
    let request = request.clone();
    tokio::task::spawn_blocking(move || read_today_token_usage_blocking(&request)).await?
}

fn read_today_token_usage_blocking(request: &TodayTokenUsageRequest) -> anyhow::Result<Value> {
    // 这一段只从 Codex 用户目录下的 sessions 和 archived_sessions 扫描 JSONL。
    // Scan JSONL only under Codex home sessions and archived_sessions.
    let codex_home = codex_pro_core::paths::codex_home_dir();
    let mut files = Vec::new();
    collect_jsonl_files(&codex_home.join("sessions"), &mut files);
    collect_jsonl_files(&codex_home.join("archived_sessions"), &mut files);

    let mut totals = TokenTotals::default();
    for file_path in files {
        if !is_recent_jsonl_file(&file_path, request) {
            continue;
        }
        totals.scanned_files += 1;
        match read_token_usage_file(&file_path, request) {
            Ok(file_totals) => merge_token_totals(&mut totals, &file_totals),
            Err(_) => totals.skipped_events += 1,
        }
    }

    Ok(json!({
        "data": {
            "cachedInputTokens": totals.cached_input_tokens,
            "date": request.date,
            "eventCount": totals.event_count,
            "inputTokens": totals.input_tokens,
            "outputTokens": totals.output_tokens,
            "reasoningOutputTokens": totals.reasoning_output_tokens,
            "scannedFiles": totals.scanned_files,
            "skippedEvents": totals.skipped_events,
            "source": "observer",
            "totalTokens": totals.total_tokens,
        },
        "error": "",
        "ok": true,
        "status": 200,
    }))
}

fn collect_jsonl_files(root: &Path, files: &mut Vec<PathBuf>) {
    // 这一段有界递归收集 JSONL，避免异常目录导致每分钟刷新过慢。
    // Recursively collect JSONL with a cap so unusual directories cannot make minute refreshes slow.
    if files.len() >= TODAY_TOKEN_USAGE_MAX_FILES {
        return;
    }
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        if files.len() >= TODAY_TOKEN_USAGE_MAX_FILES {
            break;
        }
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_dir() {
            collect_jsonl_files(&path, files);
        } else if file_type.is_file() && is_jsonl_path(&path) {
            files.push(path);
        }
    }
}

fn is_recent_jsonl_file(file_path: &Path, request: &TodayTokenUsageRequest) -> bool {
    // 这一段用文件修改时间预筛，提高每分钟 observer 刷新的稳定性。
    // Prefilter by file modification time to keep each minute observer refresh stable.
    let Ok(metadata) = fs::metadata(file_path) else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    let Ok(modified) = metadata.modified() else {
        return true;
    };
    let Ok(duration) = modified.duration_since(UNIX_EPOCH) else {
        return true;
    };
    let modified_ms = duration.as_millis().min(i64::MAX as u128) as i64;
    modified_ms >= request.start_ms - TODAY_TOKEN_USAGE_MTIME_MARGIN_MS
        && modified_ms < request.end_ms + TODAY_TOKEN_USAGE_MTIME_MARGIN_MS
}

fn read_token_usage_file(
    file_path: &Path,
    request: &TodayTokenUsageRequest,
) -> anyhow::Result<TokenTotals> {
    // 这一段流式读取单个 JSONL，只聚合 token_count 行，不读取或返回正文内容。
    // Stream one JSONL file and aggregate only token_count rows without returning transcript content.
    let file = File::open(file_path)?;
    let reader = BufReader::new(file);
    let mut current_date = String::new();
    let mut last_cumulative_total = -1i64;
    let mut totals = TokenTotals::default();

    for line_result in reader.lines() {
        let line = match line_result {
            Ok(line) => line,
            Err(_) => {
                totals.skipped_events += 1;
                continue;
            }
        };
        if line.trim().is_empty() || line.len() > TODAY_TOKEN_USAGE_MAX_LINE_BYTES {
            totals.skipped_events += 1;
            continue;
        }
        let Ok(envelope) = serde_json::from_str::<Value>(&line) else {
            totals.skipped_events += 1;
            continue;
        };
        let Some(payload) = envelope.get("payload").filter(|value| value.is_object()) else {
            continue;
        };
        if envelope.get("type").and_then(Value::as_str) == Some("turn_context") {
            if let Some(next_date) = payload
                .get("current_date")
                .and_then(Value::as_str)
                .and_then(normalize_date)
            {
                current_date = next_date;
            }
            continue;
        }
        if envelope.get("type").and_then(Value::as_str) != Some("event_msg")
            || payload.get("type").and_then(Value::as_str) != Some("token_count")
        {
            continue;
        }
        let Some(info) = payload.get("info").filter(|value| value.is_object()) else {
            totals.skipped_events += 1;
            continue;
        };
        let total_usage = info.get("total_token_usage").unwrap_or(&Value::Null);
        let last_usage = info.get("last_token_usage").unwrap_or(&Value::Null);
        let Some(cumulative_total) =
            token_count(total_usage.get("total_tokens").unwrap_or(&Value::Null))
        else {
            totals.skipped_events += 1;
            continue;
        };
        let Some(last_total) = token_count(last_usage.get("total_tokens").unwrap_or(&Value::Null))
        else {
            totals.skipped_events += 1;
            continue;
        };
        if cumulative_total <= last_cumulative_total {
            continue;
        }
        last_cumulative_total = cumulative_total;
        if !is_event_in_request_day(&current_date, &envelope, request) {
            continue;
        }
        totals.event_count += 1;
        totals.cached_input_tokens += token_count(
            last_usage
                .get("cached_input_tokens")
                .unwrap_or(&Value::Null),
        )
        .unwrap_or(0);
        totals.input_tokens +=
            token_count(last_usage.get("input_tokens").unwrap_or(&Value::Null)).unwrap_or(0);
        totals.output_tokens +=
            token_count(last_usage.get("output_tokens").unwrap_or(&Value::Null)).unwrap_or(0);
        totals.reasoning_output_tokens += token_count(
            last_usage
                .get("reasoning_output_tokens")
                .unwrap_or(&Value::Null),
        )
        .unwrap_or(0);
        totals.total_tokens += last_total;
    }
    Ok(totals)
}

fn is_event_in_request_day(
    current_date: &str,
    envelope: &Value,
    request: &TodayTokenUsageRequest,
) -> bool {
    // 这一段优先用 turn_context.current_date；缺失时才用 UTC ISO 时间文本兜底。
    // Prefer turn_context.current_date and only fall back to UTC ISO timestamp text when absent.
    if !current_date.is_empty() {
        return current_date == request.date.as_str();
    }
    let timestamp = envelope
        .get("timestamp")
        .and_then(Value::as_str)
        .unwrap_or_default();
    timestamp.ends_with('Z')
        && timestamp >= request.start_iso.as_str()
        && timestamp < request.end_iso.as_str()
}

fn merge_token_totals(left: &mut TokenTotals, right: &TokenTotals) {
    // 这一段合并单文件聚合结果，保持调用方只处理最终总数。
    // Merge one file aggregate so callers work only with final totals.
    left.cached_input_tokens += right.cached_input_tokens;
    left.event_count += right.event_count;
    left.input_tokens += right.input_tokens;
    left.output_tokens += right.output_tokens;
    left.reasoning_output_tokens += right.reasoning_output_tokens;
    left.skipped_events += right.skipped_events;
    left.total_tokens += right.total_tokens;
}

fn is_jsonl_path(path: &Path) -> bool {
    // 这一段只接受 .jsonl 文件名，避免读取其它 Codex 本机文件。
    // Accept only .jsonl filenames so other local Codex files are not read.
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("jsonl"))
}

fn normalize_date(value: &str) -> Option<String> {
    // 这一段只接受 YYYY-MM-DD 日期。
    // Accept only YYYY-MM-DD dates.
    let raw = value.trim();
    if raw.len() == 10
        && raw.as_bytes()[4] == b'-'
        && raw.as_bytes()[7] == b'-'
        && raw
            .bytes()
            .enumerate()
            .all(|(index, byte)| matches!(index, 4 | 7) || byte.is_ascii_digit())
    {
        Some(raw.to_string())
    } else {
        None
    }
}

fn normalize_iso(value: &str) -> Option<String> {
    // 这一段只接受短时间文本，具体时间意义由页面生成。
    // Accept only short timestamp text; the page owns the exact local-day boundary.
    let raw = value.trim();
    if !raw.is_empty() && raw.len() <= 40 && !raw.contains('\0') {
        Some(raw.to_string())
    } else {
        None
    }
}

fn normalize_epoch_ms(value: &Value) -> Option<i64> {
    // 这一段只接受非负毫秒时间戳，避免页面传任意字符串让 native 解析。
    // Accept only non-negative millisecond timestamps so native does not parse arbitrary strings.
    value.as_i64().filter(|value| *value >= 0)
}

fn token_count(value: &Value) -> Option<i64> {
    // 这一段把 token 数值收敛为非负整数。
    // Normalize token counts into non-negative integers.
    value.as_i64().filter(|count| *count >= 0)
}
