use super::codex_state::ConversationThreadRow;
use super::markdown::sanitize_text;
use super::package::RelatedMarkdownFile;
use serde_json::Value;
use sha2::{Digest, Sha256};

/// 这一段定义单会话最大思考附件数量。
/// Maximum reasoning attachments per thread.
const MAX_THINKING_FILES_PER_THREAD: usize = 500;
/// 这一段定义单个 Markdown 最大字节数。
/// Maximum bytes for one Markdown file.
const MAX_MARKDOWN_BYTES: usize = 5 * 1024 * 1024;

/// 这一段描述导出的会话 Markdown。
/// Describes exported thread Markdown.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ExportedThreadMarkdown {
    /// 这一段是主 Markdown。
    /// Main Markdown.
    pub markdown: String,
    /// 这一段是可见消息数量。
    /// Visible message count.
    pub message_count: usize,
    /// 这一段是解析错误数量。
    /// Parse error count.
    pub parse_errors: usize,
    /// 这一段是思考附件。
    /// Reasoning attachments.
    pub related_files: Vec<RelatedMarkdownFile>,
}

/// 这一段从 rollout JSONL 导出完整归档 Markdown。
/// Export full archive Markdown from rollout JSONL.
pub async fn export_thread_archive(
    row: &ConversationThreadRow,
    archive_path: &str,
) -> anyhow::Result<Option<ExportedThreadMarkdown>> {
    // 这一段读取 rollout 文本；解析失败由调用方降级为 fallback。
    // Read rollout text; parse failures are handled by the caller as fallback.
    let text = tokio::fs::read_to_string(&row.rollout_path).await?;
    Ok(export_thread_archive_from_text(row, archive_path, &text))
}

/// 这一段从 JSONL 文本导出会话归档。
/// Export a thread archive from JSONL text.
pub fn export_thread_archive_from_text(
    row: &ConversationThreadRow,
    archive_path: &str,
    text: &str,
) -> Option<ExportedThreadMarkdown> {
    // 这一段流式等价处理 JSONL 行，只保留用户/助手可见内容和“已处理”附件。
    // Process JSONL lines equivalently to streaming, keeping only visible user/assistant content and processed attachments.
    let mut lines = vec![format!("# {}", sanitize_text(&row.title)), String::new()];
    let mut previous_speaker = String::new();
    let mut message_count = 0usize;
    let mut parse_errors = 0usize;
    let mut previous_event_timestamp_ms = None;
    let mut last_visible_event_timestamp_ms = None;
    let mut related_files = Vec::new();
    let mut processing_group = ProcessingGroup::default();
    for raw_line in text.lines() {
        if raw_line.trim().is_empty() {
            continue;
        }
        let Ok(event) = serde_json::from_str::<Value>(raw_line) else {
            parse_errors += 1;
            continue;
        };
        if event.get("type").and_then(Value::as_str) != Some("response_item") {
            continue;
        }
        let event_timestamp_ms = event_timestamp_ms(&event);
        let payload = event.get("payload").unwrap_or(&event);
        match payload
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default()
        {
            "reasoning" => {
                if related_files.len() < MAX_THINKING_FILES_PER_THREAD {
                    ensure_processing_group(
                        &mut processing_group,
                        last_visible_event_timestamp_ms,
                        previous_event_timestamp_ms,
                    );
                    let summary = serialize_reasoning_summary(payload.get("summary"));
                    if !summary.is_empty() {
                        append_processing_message(
                            &mut processing_group,
                            summary,
                            event_timestamp_ms,
                        );
                    } else {
                        set_processing_timestamp(&mut processing_group, event_timestamp_ms);
                    }
                }
            }
            "function_call" | "custom_tool_call" | "web_search_call" | "tool_search_call" => {
                ensure_processing_group(
                    &mut processing_group,
                    last_visible_event_timestamp_ms,
                    previous_event_timestamp_ms,
                );
                let label = tool_summary_label(payload);
                if !label.is_empty() {
                    append_processing_tool_summary(
                        &mut processing_group,
                        label,
                        event_timestamp_ms,
                    );
                } else {
                    set_processing_timestamp(&mut processing_group, event_timestamp_ms);
                }
            }
            "message" => {
                let role = payload
                    .get("role")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let speaker = if role == "user" {
                    "User"
                } else if role == "assistant" {
                    "Assistant"
                } else {
                    ""
                };
                if speaker.is_empty() {
                    continue;
                }
                let body = serialize_message_content(payload.get("content"));
                if body.trim().is_empty() {
                    continue;
                }
                if role == "assistant"
                    && payload.get("phase").and_then(Value::as_str) == Some("commentary")
                {
                    ensure_processing_group(
                        &mut processing_group,
                        last_visible_event_timestamp_ms,
                        previous_event_timestamp_ms,
                    );
                    append_processing_message(&mut processing_group, body, event_timestamp_ms);
                    if event_timestamp_ms.is_some() {
                        previous_event_timestamp_ms = event_timestamp_ms;
                    }
                    continue;
                }
                flush_processing_group(
                    row,
                    archive_path,
                    &mut lines,
                    &mut related_files,
                    &mut processing_group,
                    event_timestamp_ms,
                );
                if speaker == previous_speaker {
                    lines.push(body);
                    lines.push(String::new());
                } else {
                    if !previous_speaker.is_empty() {
                        lines.push("---".to_string());
                        lines.push(String::new());
                    }
                    lines.push(format!("### {speaker}"));
                    lines.push(String::new());
                    lines.push(body);
                    lines.push(String::new());
                    previous_speaker = speaker.to_string();
                }
                message_count += 1;
                if event_timestamp_ms.is_some() {
                    last_visible_event_timestamp_ms = event_timestamp_ms;
                }
            }
            _ => {}
        }
        if event_timestamp_ms.is_some() {
            previous_event_timestamp_ms = event_timestamp_ms;
        }
        if joined_markdown_len(&lines) > MAX_MARKDOWN_BYTES {
            return None;
        }
    }
    flush_processing_group(
        row,
        archive_path,
        &mut lines,
        &mut related_files,
        &mut processing_group,
        None,
    );
    if message_count == 0 {
        return None;
    }
    Some(ExportedThreadMarkdown {
        markdown: format!("{}\n", lines.join("\n").trim_end()),
        message_count,
        parse_errors,
        related_files,
    })
}

/// 这一段描述待落盘的处理过程组。
/// Describes a pending processed group.
#[derive(Clone, Debug, Default)]
struct ProcessingGroup {
    /// 这一段表示当前处理组已被事件激活。
    /// Whether events have activated this processing group.
    active: bool,
    /// 这一段是处理组开始前最近的可见事件时间。
    /// Latest visible event timestamp before this processing group.
    started_after_timestamp_ms: Option<i64>,
    /// 这一段是处理组内最近的处理事件时间。
    /// Latest processing event timestamp inside this group.
    last_timestamp_ms: Option<i64>,
    /// 这一段是可读过程消息。
    /// Readable process messages.
    messages: Vec<String>,
    /// 这一段是工具调用统计。
    /// Tool-call counts.
    tool_counts: std::collections::BTreeMap<String, usize>,
}

/// 这一段按旧 Node 逻辑懒创建“已处理”组。
/// Lazily create a processed group using the legacy Node timing anchor.
fn ensure_processing_group(
    group: &mut ProcessingGroup,
    last_visible_event_timestamp_ms: Option<i64>,
    previous_event_timestamp_ms: Option<i64>,
) {
    // 这一段只在新处理组首次出现时记录开始锚点，后续事件共享同一个耗时区间。
    // Record the start anchor only when a group first appears so later events share one duration window.
    if group.active {
        return;
    }
    group.active = true;
    group.started_after_timestamp_ms =
        last_visible_event_timestamp_ms.or(previous_event_timestamp_ms);
}

/// 这一段记录处理组里最近的事件时间。
/// Record the latest event timestamp inside a processed group.
fn set_processing_timestamp(group: &mut ProcessingGroup, event_timestamp_ms: Option<i64>) {
    // 这一段保留旧 Node 行为：缺少时间戳不影响导出，只是不显示耗时。
    // Match legacy Node behavior: missing timestamps still export, just without a duration.
    if let Some(timestamp_ms) = event_timestamp_ms {
        group.last_timestamp_ms = Some(timestamp_ms);
    }
}

/// 这一段把可读过程消息加入处理组。
/// Add a readable process message into a processed group.
fn append_processing_message(
    group: &mut ProcessingGroup,
    message: String,
    event_timestamp_ms: Option<i64>,
) {
    // 这一段只保存清理后的正文；时间戳单独更新供主 Markdown 标签使用。
    // Store only the sanitized body; update timestamp separately for the main Markdown label.
    if !message.trim().is_empty() {
        group.messages.push(message);
    }
    set_processing_timestamp(group, event_timestamp_ms);
}

/// 这一段把工具调用摘要加入处理组。
/// Add a tool-call summary into a processed group.
fn append_processing_tool_summary(
    group: &mut ProcessingGroup,
    label: String,
    event_timestamp_ms: Option<i64>,
) {
    // 这一段只累计工具类型数量，不导出参数或输出。
    // Count tool types only, without exporting arguments or output.
    if !label.is_empty() {
        *group.tool_counts.entry(label).or_insert(0) += 1;
    }
    set_processing_timestamp(group, event_timestamp_ms);
}

/// 这一段落盘一个“已处理”附件。
/// Flush one processed attachment.
fn flush_processing_group(
    row: &ConversationThreadRow,
    archive_path: &str,
    lines: &mut Vec<String>,
    related_files: &mut Vec<RelatedMarkdownFile>,
    group: &mut ProcessingGroup,
    end_timestamp_ms: Option<i64>,
) {
    // 这一段没有可读内容时不生成空附件。
    // Do not generate an empty attachment when there is no readable content.
    if !group.active {
        return;
    }
    let body = serialize_processing_group(group);
    let label = processing_label(
        group.started_after_timestamp_ms,
        end_timestamp_ms.or(group.last_timestamp_ms),
    );
    *group = ProcessingGroup::default();
    if body.is_empty() || related_files.len() >= MAX_THINKING_FILES_PER_THREAD {
        return;
    }
    let thinking_index = related_files.len() + 1;
    let thinking_markdown = format!(
        "# {}\n\n## {label}\n\n{}\n",
        sanitize_text(&row.title),
        body.trim()
    );
    let link_name = thinking_link_name(thinking_index, &thinking_markdown);
    related_files.push(RelatedMarkdownFile {
        link_name: link_name.clone(),
        markdown: thinking_markdown,
        thinking_index,
    });
    let _ = archive_path;
    lines.push(format!("[{label}](<{link_name}>)"));
    lines.push(String::new());
}

/// 这一段生成主 Markdown 里的“已处理 + 耗时”标签。
/// Build the main Markdown "processed + duration" label.
fn processing_label(start_timestamp_ms: Option<i64>, end_timestamp_ms: Option<i64>) -> String {
    // 这一段对齐旧 Node：只有开始和结束时间都合法且结束不早于开始时才显示耗时。
    // Match legacy Node: show duration only when both timestamps are valid and ordered.
    let duration = match (start_timestamp_ms, end_timestamp_ms) {
        (Some(start), Some(end)) if end >= start => format_processing_duration(end - start),
        _ => String::new(),
    };
    if duration.is_empty() {
        "已处理".to_string()
    } else {
        format!("已处理 {duration}")
    }
}

/// 这一段把毫秒时长格式化成旧 Node 使用的短标签。
/// Format a millisecond duration into the compact label used by legacy Node.
fn format_processing_duration(duration_ms: i64) -> String {
    // 这一段等价于 Math.round(durationMs / 1000)，非正数不显示。
    // Match Math.round(durationMs / 1000); non-positive values are omitted.
    if duration_ms <= 0 {
        return String::new();
    }
    let total_seconds = (duration_ms + 500) / 1000;
    if total_seconds <= 0 {
        return String::new();
    }
    let hours = total_seconds / 3600;
    let minutes = (total_seconds % 3600) / 60;
    let seconds = total_seconds % 60;
    if hours > 0 {
        format!("{hours}h {minutes}m {seconds}s")
    } else if minutes > 0 {
        format!("{minutes}m {seconds}s")
    } else {
        format!("{seconds}s")
    }
}

/// 这一段序列化处理过程组。
/// Serialize a processed group.
fn serialize_processing_group(group: &ProcessingGroup) -> String {
    // 这一段只保留 commentary/reasoning 摘要和工具调用数量，不导出工具参数或输出。
    // Keep only commentary/reasoning summaries and tool counts, excluding tool arguments and outputs.
    let mut blocks = Vec::new();
    let messages = group
        .messages
        .iter()
        .map(|message| message.trim())
        .filter(|message| !message.is_empty())
        .collect::<Vec<_>>();
    if !messages.is_empty() {
        blocks.push(format!("### 过程消息\n\n{}", messages.join("\n\n---\n\n")));
    }
    let tool_lines = group
        .tool_counts
        .iter()
        .filter(|(_, count)| **count > 0)
        .map(|(label, count)| format!("- 已运行 {count} 条{label}"))
        .collect::<Vec<_>>();
    if !tool_lines.is_empty() {
        blocks.push(format!("### 工具执行摘要\n\n{}", tool_lines.join("\n")));
    }
    blocks.join("\n\n").trim().to_string()
}

/// 这一段序列化消息 content。
/// Serialize message content.
fn serialize_message_content(value: Option<&Value>) -> String {
    // 这一段支持 Codex rollout 里的 content 数组和字符串形态。
    // Support both content arrays and string content shapes in Codex rollouts.
    let Some(value) = value else {
        return String::new();
    };
    if let Some(text) = value.as_str() {
        return sanitize_text_block(text);
    }
    let Some(items) = value.as_array() else {
        return String::new();
    };
    items
        .iter()
        .filter_map(|item| {
            let block_type = item.get("type").and_then(Value::as_str).unwrap_or_default();
            if block_type == "input_image" {
                let image_url = item
                    .get("image_url")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .trim();
                return Some(if image_url.is_empty() || image_url.starts_with("data:") {
                    "> Image attachment".to_string()
                } else {
                    format!("> Image attachment\n[Image link](<{image_url}>)")
                });
            }
            if matches!(block_type, "input_text" | "output_text" | "text") || block_type.is_empty()
            {
                return item
                    .get("text")
                    .or_else(|| item.get("content"))
                    .and_then(Value::as_str)
                    .map(sanitize_text_block);
            }
            None
        })
        .filter(|block| !block.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n\n")
}

/// 这一段读取 rollout 事件时间戳。
/// Read a rollout event timestamp.
fn event_timestamp_ms(event: &Value) -> Option<i64> {
    // 这一段兼容字符串和数字时间戳，主路径是 Codex JSONL 的 RFC3339 timestamp 字段。
    // Support string and numeric timestamps; the normal Codex JSONL path is RFC3339 timestamp.
    let value = event.get("timestamp")?;
    if let Some(number) = value.as_f64() {
        return numeric_timestamp_ms(number);
    }
    parse_timestamp_text_ms(value.as_str()?)
}

/// 这一段解析时间戳文本。
/// Parse timestamp text into Unix milliseconds.
fn parse_timestamp_text_ms(value: &str) -> Option<i64> {
    // 这一段先兼容 SQLite/JSON 数字时间戳，再解析 RFC3339 文本。
    // Try numeric SQLite/JSON timestamps first, then parse RFC3339 text.
    let text = value.trim();
    if text.is_empty() {
        return None;
    }
    if let Ok(number) = text.parse::<f64>() {
        return numeric_timestamp_ms(number);
    }
    parse_rfc3339_timestamp_ms(text)
}

/// 这一段归一化数字时间戳。
/// Normalize a numeric timestamp.
fn numeric_timestamp_ms(value: f64) -> Option<i64> {
    // 这一段沿用旧归档时间戳规则：小数字按秒，大数字按毫秒。
    // Reuse the archive timestamp rule: small values are seconds, large values are milliseconds.
    if !value.is_finite() || value <= 0.0 {
        return None;
    }
    let timestamp_ms = if value < 100_000_000_000.0 {
        value * 1000.0
    } else {
        value
    };
    if timestamp_ms > i64::MAX as f64 {
        return None;
    }
    Some(timestamp_ms.floor() as i64)
}

/// 这一段解析常见 RFC3339 时间戳。
/// Parse a common RFC3339 timestamp.
fn parse_rfc3339_timestamp_ms(value: &str) -> Option<i64> {
    // 这一段覆盖 Codex rollout 的 UTC/offset ISO 形态，避免新增时间库依赖。
    // Cover Codex rollout UTC/offset ISO forms without adding another time dependency.
    let text = value.trim();
    if text.len() < 19 {
        return None;
    }
    let year = parse_digits(text, 0, 4)?;
    expect_byte(text, 4, b'-')?;
    let month = parse_digits(text, 5, 2)? as u32;
    expect_byte(text, 7, b'-')?;
    let day = parse_digits(text, 8, 2)? as u32;
    let separator = byte_at(text, 10)?;
    if separator != b'T' && separator != b't' && separator != b' ' {
        return None;
    }
    let hour = parse_digits(text, 11, 2)?;
    expect_byte(text, 13, b':')?;
    let minute = parse_digits(text, 14, 2)?;
    expect_byte(text, 16, b':')?;
    let second = parse_digits(text, 17, 2)?;
    if !valid_date_parts(year, month, day) || hour > 23 || minute > 59 || second > 59 {
        return None;
    }

    let mut index = 19usize;
    let mut millis = 0i64;
    if byte_at(text, index) == Some(b'.') {
        let (parsed_millis, next_index) = parse_fraction_millis(text, index + 1)?;
        millis = parsed_millis;
        index = next_index;
    }

    let offset_minutes = parse_timezone_offset_minutes(text, index)?;
    let days = days_from_civil(year, month, day);
    let local_ms = days
        .checked_mul(86_400_000)?
        .checked_add(hour.checked_mul(3_600_000)?)?
        .checked_add(minute.checked_mul(60_000)?)?
        .checked_add(second.checked_mul(1000)?)?
        .checked_add(millis)?;
    local_ms.checked_sub(offset_minutes.checked_mul(60_000)?)
}

/// 这一段解析毫秒小数部分。
/// Parse the millisecond fraction.
fn parse_fraction_millis(value: &str, start: usize) -> Option<(i64, usize)> {
    // 这一段只保留前三位毫秒，额外精度按旧 JS Date 毫秒语义截断。
    // Keep only the first three millisecond digits, matching JS Date millisecond precision.
    let bytes = value.as_bytes();
    let mut index = start;
    let mut digits = 0usize;
    let mut millis = 0i64;
    while index < bytes.len() && bytes[index].is_ascii_digit() {
        if digits < 3 {
            millis = millis * 10 + i64::from(bytes[index] - b'0');
        }
        digits += 1;
        index += 1;
    }
    if digits == 0 {
        return None;
    }
    for _ in digits..3 {
        millis *= 10;
    }
    Some((millis, index))
}

/// 这一段解析时区偏移。
/// Parse the timezone offset.
fn parse_timezone_offset_minutes(value: &str, index: usize) -> Option<i64> {
    // 这一段接受 Z、+08:00、+0800；没有时区时按 UTC 处理，作为异常数据兜底。
    // Accept Z, +08:00, +0800; missing timezone is treated as UTC as a bad-data fallback.
    let Some(marker) = byte_at(value, index) else {
        return Some(0);
    };
    if (marker == b'Z' || marker == b'z') && index + 1 == value.len() {
        return Some(0);
    }
    let sign = if marker == b'+' {
        1
    } else if marker == b'-' {
        -1
    } else {
        return None;
    };
    let hour = parse_digits(value, index + 1, 2)?;
    let minute_index = index + 3;
    let (minute, end_index) = if byte_at(value, minute_index) == Some(b':') {
        (parse_digits(value, minute_index + 1, 2)?, minute_index + 3)
    } else {
        (parse_digits(value, minute_index, 2)?, minute_index + 2)
    };
    if end_index != value.len() || hour > 23 || minute > 59 {
        return None;
    }
    Some(sign * (hour * 60 + minute))
}

/// 这一段读取固定长度数字。
/// Read fixed-width digits.
fn parse_digits(value: &str, start: usize, len: usize) -> Option<i64> {
    // 这一段避免正则依赖，直接按 ASCII 数字解析。
    // Avoid a regex dependency by parsing ASCII digits directly.
    let bytes = value.as_bytes();
    if start.checked_add(len)? > bytes.len() {
        return None;
    }
    let mut number = 0i64;
    for byte in &bytes[start..start + len] {
        if !byte.is_ascii_digit() {
            return None;
        }
        number = number * 10 + i64::from(*byte - b'0');
    }
    Some(number)
}

/// 这一段检查固定位置字符。
/// Check a fixed byte at an index.
fn expect_byte(value: &str, index: usize, expected: u8) -> Option<()> {
    // 这一段让 RFC3339 解析失败保持安静，最终回退为无耗时标签。
    // Keep RFC3339 parse failures quiet so callers fall back to no duration label.
    (byte_at(value, index)? == expected).then_some(())
}

/// 这一段读取 ASCII 字节。
/// Read one ASCII byte.
fn byte_at(value: &str, index: usize) -> Option<u8> {
    // 这一段只解析 ASCII 时间戳格式，避免 UTF-8 边界复杂度。
    // Parse only ASCII timestamp syntax to avoid UTF-8 boundary complexity.
    value.as_bytes().get(index).copied()
}

/// 这一段校验日期字段。
/// Validate date fields.
fn valid_date_parts(year: i64, month: u32, day: u32) -> bool {
    // 这一段限制常规公历日期，异常日期不参与耗时计算。
    // Restrict to normal Gregorian dates; invalid dates do not participate in duration calculation.
    year >= 1970 && (1..=12).contains(&month) && (1..=days_in_month(year, month)).contains(&day)
}

/// 这一段返回月份天数。
/// Return the number of days in a month.
fn days_in_month(year: i64, month: u32) -> u32 {
    // 这一段处理闰年二月。
    // Handle February in leap years.
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if is_leap_year(year) => 29,
        2 => 28,
        _ => 0,
    }
}

/// 这一段判断闰年。
/// Return whether the year is a leap year.
fn is_leap_year(year: i64) -> bool {
    // 这一段按公历规则判断闰年。
    // Use Gregorian leap-year rules.
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

/// 这一段把公历日期转换为 Unix epoch 天数。
/// Convert a civil date into Unix epoch days.
fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    // 这一段使用无依赖 civil-date 算法，等价得到 UTC 日期到 1970-01-01 的天数。
    // Use a dependency-free civil-date algorithm to get days from 1970-01-01 UTC.
    let adjusted_year = year - i64::from(month <= 2);
    let era = if adjusted_year >= 0 {
        adjusted_year
    } else {
        adjusted_year - 399
    } / 400;
    let year_of_era = adjusted_year - era * 400;
    let month_i64 = i64::from(month);
    let day_of_year =
        (153 * (month_i64 + if month_i64 > 2 { -3 } else { 9 }) + 2) / 5 + i64::from(day) - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

/// 这一段序列化 reasoning summary。
/// Serialize reasoning summary.
fn serialize_reasoning_summary(value: Option<&Value>) -> String {
    // 这一段只导出明文 summary 字段，忽略 encrypted_content。
    // Export only plaintext summary fields and ignore encrypted_content.
    let Some(items) = value.and_then(Value::as_array) else {
        return String::new();
    };
    items
        .iter()
        .filter_map(|item| {
            if let Some(text) = item.as_str() {
                return Some(sanitize_text_block(text));
            }
            item.get("text")
                .or_else(|| item.get("summary"))
                .or_else(|| item.get("content"))
                .and_then(Value::as_str)
                .map(sanitize_text_block)
        })
        .filter(|block| !block.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n\n")
}

/// 这一段生成工具摘要标签。
/// Build a tool summary label.
fn tool_summary_label(payload: &Value) -> String {
    // 这一段压缩工具类型，不导出工具参数。
    // Compact tool types without exporting tool arguments.
    let call_type = payload
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let name = payload
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or_default();
    match (call_type, name) {
        ("function_call", "shell_command") => "命令".to_string(),
        ("custom_tool_call", "apply_patch") => "文件编辑".to_string(),
        ("web_search_call", _) => "网络搜索".to_string(),
        ("tool_search_call", _) => "工具搜索".to_string(),
        ("function_call", "") => "函数调用".to_string(),
        ("function_call", value) => format!("函数 {value}"),
        ("custom_tool_call", "") => "自定义工具".to_string(),
        ("custom_tool_call", value) => format!("工具 {value}"),
        _ => String::new(),
    }
}

/// 这一段清理消息文本块。
/// Sanitize one message text block.
fn sanitize_text_block(value: &str) -> String {
    // 这一段移除模型上下文、附件包装和记忆引用，避免泄露本机临时路径。
    // Remove model context, attachment wrappers, and memory citations to avoid leaking local temp paths.
    let text = sanitize_text(value);
    let trimmed = text.trim();
    if trimmed.is_empty()
        || trimmed.starts_with("# AGENTS.md instructions for")
        || trimmed.starts_with("<environment_context>")
        || trimmed.starts_with("<subagent_notification>")
        || trimmed == "<image>"
        || trimmed == "</image>"
    {
        return String::new();
    }
    trimmed
        .strip_prefix("# Files mentioned by the user:")
        .and_then(|rest| {
            rest.split_once("## My request for Codex:")
                .map(|(_, body)| body)
        })
        .or_else(|| trimmed.strip_prefix("## My request for Codex:"))
        .unwrap_or(trimmed)
        .trim()
        .to_string()
}

/// 这一段生成思考附件链接名。
/// Build a reasoning attachment link name.
fn thinking_link_name(index: usize, markdown: &str) -> String {
    // 这一段用内容 hash 避开 Codex 右侧预览缓存。
    // Use a content hash to avoid Codex side-preview cache reuse.
    let digest = format!("{:x}", Sha256::digest(markdown.as_bytes()));
    format!(
        "thinking-{:03}-{}.md",
        index.max(1),
        digest.chars().take(12).collect::<String>()
    )
}

/// 这一段估算当前 Markdown 长度。
/// Estimate current Markdown length.
fn joined_markdown_len(lines: &[String]) -> usize {
    // 这一段避免极端 rollout 在打包前占用过多内存。
    // Avoid excessive memory use before packaging extreme rollouts.
    lines.iter().map(|line| line.len() + 1).sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 这一段构造测试线程。
    /// Build a test row.
    fn row() -> ConversationThreadRow {
        ConversationThreadRow {
            archive_group_id: "conversation_default".to_string(),
            archive_group_name: "对话".to_string(),
            archive_group_type: "conversation".to_string(),
            archived_at: String::new(),
            created_at: "2026-06-14T00:00:00.000Z".to_string(),
            created_at_ms: 0,
            cwd: String::new(),
            deleted_detected_at: String::new(),
            lifecycle_status: "active".to_string(),
            rollout_path: "rollout.jsonl".to_string(),
            skip_reason: String::new(),
            thread_id: "thread_123".to_string(),
            thread_source: "user".to_string(),
            title: "测试会话".to_string(),
            updated_at: "2026-06-14T00:01:00.000Z".to_string(),
            updated_at_ms: 0,
        }
    }

    /// 这一段确认 commentary 会进入 thinking 附件。
    /// Confirm commentary is exported as a thinking attachment.
    #[test]
    fn commentary_becomes_related_thinking_file() {
        let jsonl = r#"{"type":"response_item","timestamp":"2026-06-14T00:00:00.000Z","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"你好"}]}}
{"type":"response_item","timestamp":"2026-06-14T00:00:04.000Z","payload":{"type":"message","role":"assistant","phase":"commentary","content":[{"type":"output_text","text":"我在处理"}]}}
{"type":"response_item","timestamp":"2026-06-14T00:00:08.000Z","payload":{"type":"custom_tool_call","name":"apply_patch"}}
{"type":"response_item","timestamp":"2026-06-14T00:00:10.000Z","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"完成"}]}}"#;
        let exported = export_thread_archive_from_text(
            &row(),
            "devices/device_a/profiles/profile_a/conversations/conversation_default/threads/2026/06/thread_123/index.md",
            jsonl,
        )
        .expect("archive should export");

        assert_eq!(exported.message_count, 2);
        assert_eq!(exported.related_files.len(), 1);
        assert!(exported.markdown.contains("[已处理 10s](<thinking-001-"));
        assert!(exported.related_files[0].markdown.contains("## 已处理 10s"));
        assert!(exported.related_files[0].markdown.contains("我在处理"));
        assert!(exported.related_files[0].markdown.contains("文件编辑"));
    }

    /// 这一段确认缺少时间戳时保留短标签。
    /// Confirm missing timestamps keep the short label.
    #[test]
    fn processed_label_falls_back_without_timestamp() {
        let jsonl = r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"你好"}]}}
{"type":"response_item","payload":{"type":"message","role":"assistant","phase":"commentary","content":[{"type":"output_text","text":"处理中"}]}}
{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"完成"}]}}"#;
        let exported = export_thread_archive_from_text(
            &row(),
            "devices/device_a/profiles/profile_a/conversations/conversation_default/threads/2026/06/thread_123/index.md",
            jsonl,
        )
        .expect("archive should export");

        assert!(exported.markdown.contains("[已处理](<thinking-001-"));
        assert!(exported.related_files[0].markdown.contains("## 已处理\n"));
    }

    /// 这一段确认时区偏移和分钟级耗时格式。
    /// Confirm timezone offsets and minute-scale duration formatting.
    #[test]
    fn processed_label_uses_event_timestamp_offset_duration() {
        let jsonl = r#"{"type":"response_item","timestamp":"2026-06-14T08:00:00+08:00","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"你好"}]}}
{"type":"response_item","timestamp":"2026-06-14T08:01:01+08:00","payload":{"type":"message","role":"assistant","phase":"commentary","content":[{"type":"output_text","text":"处理中"}]}}
{"type":"response_item","timestamp":"2026-06-14T08:01:02+08:00","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"完成"}]}}"#;
        let exported = export_thread_archive_from_text(
            &row(),
            "devices/device_a/profiles/profile_a/conversations/conversation_default/threads/2026/06/thread_123/index.md",
            jsonl,
        )
        .expect("archive should export");

        assert!(exported.markdown.contains("[已处理 1m 2s](<thinking-001-"));
    }

    /// 这一段确认末尾处理组用自身最后事件时间。
    /// Confirm a trailing processed group uses its own last event timestamp.
    #[test]
    fn trailing_processed_group_uses_last_processing_timestamp() {
        let jsonl = r#"{"type":"response_item","timestamp":"2026-06-14T00:00:00.000Z","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"你好"}]}}
{"type":"response_item","timestamp":"2026-06-14T00:00:03.500Z","payload":{"type":"message","role":"assistant","phase":"commentary","content":[{"type":"output_text","text":"处理中"}]}}"#;
        let exported = export_thread_archive_from_text(
            &row(),
            "devices/device_a/profiles/profile_a/conversations/conversation_default/threads/2026/06/thread_123/index.md",
            jsonl,
        )
        .expect("archive should export");

        assert_eq!(exported.message_count, 1);
        assert!(exported.markdown.contains("[已处理 4s](<thinking-001-"));
    }
}
