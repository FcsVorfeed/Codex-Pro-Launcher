use super::codex_state::ConversationThreadRow;

/// 这一段创建兜底 Markdown。
/// Create fallback Markdown.
pub fn create_fallback_markdown(row: &ConversationThreadRow) -> String {
    // 这一段不读取正文时只输出安全元数据。
    // Output safe metadata only when body parsing is unavailable.
    format!(
        "# {}\n\n- Thread: `{}`\n- Updated: `{}`\n",
        sanitize_text(&row.title),
        row.thread_id,
        row.updated_at
    )
}

/// 这一段清洗导出文本。
/// Sanitize exported text.
pub fn sanitize_text(value: &str) -> String {
    // 这一段移除记忆引用块和本机截图临时路径包装。
    // Remove memory citation blocks and local screenshot temp-path wrappers.
    strip_memory_citations(value)
        .replace('\0', "")
        .replace("\r\n", "\n")
        .trim()
        .to_string()
}

/// 这一段移除记忆引用块。
/// Strip memory citation blocks.
fn strip_memory_citations(value: &str) -> String {
    // 这一段用状态机删除 <oai-mem-citation> 块。
    // Use a small state machine to remove <oai-mem-citation> blocks.
    let mut output = String::new();
    let mut skipping = false;
    for line in value.lines() {
        if line.contains("<oai-mem-citation>") {
            skipping = true;
            continue;
        }
        if line.contains("</oai-mem-citation>") {
            skipping = false;
            continue;
        }
        if !skipping {
            output.push_str(line);
            output.push('\n');
        }
    }
    output
}
