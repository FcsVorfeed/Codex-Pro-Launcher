use codex_pro_core::cdp::CdpClient;
use serde::{Deserialize, Serialize};
use serde_json::json;

/// 这一段定义快捷键最大长度。
/// Maximum shortcut string length.
const NATIVE_SHORTCUT_MAX_LENGTH: usize = 80;
/// 这一段定义 CDP 修饰键位：Alt=1 Ctrl=2 Meta=4 Shift=8。
/// CDP modifier bit flags: Alt=1 Ctrl=2 Meta=4 Shift=8.
const MODIFIER_ALT: u32 = 1;
const MODIFIER_CTRL: u32 = 2;
const MODIFIER_META: u32 = 4;
const MODIFIER_SHIFT: u32 = 8;

/// 这一段描述已解析快捷键请求。
/// Describes a parsed shortcut request.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct ShortcutRequest {
    /// 这一段是可读快捷键描述。
    /// Human-readable shortcut description.
    pub description: String,
    /// 这一段是需要发送的 CDP 键事件。
    /// CDP key events to dispatch.
    pub keys: Vec<ShortcutKey>,
}

/// 这一段描述单个 CDP 快捷键主键。
/// Describes one CDP shortcut main key.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct ShortcutKey {
    /// 这一段是 CDP code 字段。
    /// CDP code field.
    pub code: String,
    /// 这一段是 CDP key 字段。
    /// CDP key field.
    pub key: String,
    /// 这一段标记 Alt 组合是否作为系统键发送。
    /// Marks whether an Alt chord is sent as a system key.
    pub is_system_key: bool,
    /// 这一段是 CDP modifiers 位标志。
    /// CDP modifiers bit flags.
    pub modifiers: u32,
    /// 这一段是 Windows 虚拟键码。
    /// Windows virtual key code.
    pub windows_virtual_key_code: u32,
    /// 这一段是原生虚拟键码。
    /// Native virtual key code.
    pub native_virtual_key_code: u32,
}

/// 这一段描述受支持主键的稳定定义。
/// Stable definition for a supported main key.
#[derive(Clone, Debug, PartialEq, Eq)]
struct KeyDefinition {
    /// 这一段是归一化主键名。
    /// Normalized main-key name.
    name: String,
    /// 这一段是 CDP code 字段。
    /// CDP code field.
    code: String,
    /// 这一段是无 Shift 时的 CDP key 字段。
    /// CDP key field without Shift.
    key: String,
    /// 这一段是有 Shift 时的 CDP key 字段。
    /// CDP key field with Shift.
    shift_key: Option<String>,
    /// 这一段是 Windows 虚拟键码。
    /// Windows virtual key code.
    windows_virtual_key_code: u32,
}

/// 这一段描述一个解析后的修饰键。
/// Describes one parsed modifier.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ShortcutModifier {
    Ctrl,
    Alt,
    Shift,
    Meta,
}

/// 这一段解析快捷键请求。
/// Parse a shortcut request.
pub fn parse_shortcut_request(value: &serde_json::Value) -> Option<ShortcutRequest> {
    // 这一段只接受短格式单组合键。
    // Accept only short single-combination shortcuts.
    let shortcut = value.get("shortcut")?.as_str()?.trim();
    parse_shortcut(shortcut)
}

/// 这一段解析快捷键文本。
/// Parse shortcut text.
pub fn parse_shortcut(shortcut: &str) -> Option<ShortcutRequest> {
    // 这一段拒绝过长和非法字符。
    // Reject oversized or unsafe strings.
    if shortcut.is_empty()
        || shortcut.len() > NATIVE_SHORTCUT_MAX_LENGTH
        || !shortcut.chars().all(|ch| {
            ch.is_ascii_alphanumeric()
                || matches!(
                    ch,
                    '+' | '`' | '-' | '=' | '[' | ']' | '\\' | ';' | '\'' | ',' | '.' | '/' | ' '
                )
        })
    {
        return None;
    }

    // 这一段只允许修饰键集合加一个主键，不支持多步序列或宏。
    // Allow only a modifier set plus one main key, with no multi-step sequences or macros.
    let mut ctrl = false;
    let mut alt = false;
    let mut shift = false;
    let mut meta = false;
    let mut main_key: Option<KeyDefinition> = None;
    for part in shortcut
        .split('+')
        .map(str::trim)
        .filter(|part| !part.is_empty())
    {
        match normalize_modifier(part) {
            Some(ShortcutModifier::Ctrl) => ctrl = true,
            Some(ShortcutModifier::Alt) => alt = true,
            Some(ShortcutModifier::Shift) => shift = true,
            Some(ShortcutModifier::Meta) => meta = true,
            None if main_key.is_none() => main_key = normalize_main_key(part),
            None => return None,
        }
    }
    if main_key.is_none() || !(ctrl || alt || shift || meta) {
        return None;
    }
    let main_key = main_key?;
    let modifiers = modifier_flags(ctrl, alt, shift, meta);
    let description = format_description(&main_key.name, ctrl, alt, shift, meta);
    let key = ShortcutKey {
        code: main_key.code,
        key: if shift {
            main_key.shift_key.unwrap_or(main_key.key)
        } else {
            main_key.key
        },
        is_system_key: alt,
        modifiers,
        native_virtual_key_code: main_key.windows_virtual_key_code,
        windows_virtual_key_code: main_key.windows_virtual_key_code,
    };
    Some(ShortcutRequest {
        description,
        keys: vec![key],
    })
}

/// 这一段通过 CDP 发送原生快捷键。
/// Dispatch a native shortcut through CDP.
pub async fn dispatch_native_shortcut(
    client: &mut CdpClient,
    request: &ShortcutRequest,
) -> anyhow::Result<()> {
    // 这一段按旧 Node handler 的顺序发送 rawKeyDown/keyUp，让 Chromium 处理组合键。
    // Send rawKeyDown/keyUp in the old Node handler order so Chromium handles the chord.
    for key in &request.keys {
        client
            .send(
                "Input.dispatchKeyEvent",
                key_event_params("rawKeyDown", key),
            )
            .await?;
        client
            .send("Input.dispatchKeyEvent", key_event_params("keyUp", key))
            .await?;
    }
    Ok(())
}

/// 这一段构造 CDP key event 参数。
/// Build CDP key event params.
fn key_event_params(event_type: &str, key: &ShortcutKey) -> serde_json::Value {
    // 这一段输出旧 Node handler 的完整 CDP 参数形状。
    // Emit the full CDP parameter shape used by the old Node handler.
    json!({
        "type": event_type,
        "code": key.code,
        "isSystemKey": key.is_system_key,
        "key": key.key,
        "modifiers": key.modifiers,
        "nativeVirtualKeyCode": key.native_virtual_key_code,
        "windowsVirtualKeyCode": key.windows_virtual_key_code,
    })
}

/// 这一段归一化修饰键别名。
/// Normalize modifier aliases.
fn normalize_modifier(value: &str) -> Option<ShortcutModifier> {
    // 这一段保持和旧 Node handler 一致的修饰键别名集合。
    // Keep the same modifier alias set as the old Node handler.
    match value.to_ascii_lowercase().as_str() {
        "ctrl" | "control" => Some(ShortcutModifier::Ctrl),
        "alt" | "option" => Some(ShortcutModifier::Alt),
        "shift" => Some(ShortcutModifier::Shift),
        "cmd" | "command" | "meta" | "super" | "win" | "windows" => Some(ShortcutModifier::Meta),
        _ => None,
    }
}

/// 这一段归一化主键到受支持 key definition。
/// Normalize the main key into a supported key definition.
fn normalize_main_key(value: &str) -> Option<KeyDefinition> {
    // 这一段去掉主键内部空白，让 Page Up、pageup 和 PgUp 归到同一键。
    // Remove internal whitespace so Page Up, pageup, and PgUp map to the same key.
    let token = value.trim();
    let compact = token.split_whitespace().collect::<String>();
    if compact.len() == 1 {
        let ch = compact.chars().next()?;
        if ch.is_ascii_alphabetic() {
            return Some(letter_key_definition(ch));
        }
        if ch.is_ascii_digit() {
            return Some(digit_key_definition(ch));
        }
    }
    if let Some(key) = named_key_alias(&compact) {
        return key_definition(key);
    }
    if is_function_key(&compact) {
        return function_key_definition(&compact);
    }
    punctuation_key_alias(&compact).and_then(key_definition)
}

/// 这一段返回命名键别名。
/// Return named key aliases.
fn named_key_alias(value: &str) -> Option<&'static str> {
    // 这一段保持和旧 Node handler 一致的命名键、方向键和编辑键别名。
    // Keep named-key, arrow-key, and editing-key aliases aligned with the old Node handler.
    match value.to_ascii_lowercase().as_str() {
        "arrowdown" | "down" => Some("Down"),
        "arrowleft" | "left" => Some("Left"),
        "arrowright" | "right" => Some("Right"),
        "arrowup" | "up" => Some("Up"),
        "backspace" => Some("Backspace"),
        "backquote" => Some("Backquote"),
        "backslash" => Some("Backslash"),
        "bracketleft" => Some("BracketLeft"),
        "bracketright" => Some("BracketRight"),
        "comma" => Some("Comma"),
        "del" | "delete" => Some("Delete"),
        "end" => Some("End"),
        "enter" | "return" => Some("Enter"),
        "equal" => Some("Equal"),
        "esc" | "escape" => Some("Escape"),
        "home" => Some("Home"),
        "ins" | "insert" => Some("Insert"),
        "minus" => Some("Minus"),
        "pagedown" | "pgdn" => Some("PageDown"),
        "pageup" | "pgup" => Some("PageUp"),
        "period" => Some("Period"),
        "quote" => Some("Quote"),
        "semicolon" => Some("Semicolon"),
        "slash" => Some("Slash"),
        "space" | "spacebar" => Some("Space"),
        "tab" => Some("Tab"),
        _ => None,
    }
}

/// 这一段返回标点键别名。
/// Return punctuation key aliases.
fn punctuation_key_alias(value: &str) -> Option<&'static str> {
    // 这一段只允许旧 Node handler 支持的单字符标点主键。
    // Allow only punctuation main keys supported by the old Node handler.
    match value {
        "`" => Some("Backquote"),
        "-" => Some("Minus"),
        "=" => Some("Equal"),
        "[" => Some("BracketLeft"),
        "]" => Some("BracketRight"),
        "\\" => Some("Backslash"),
        ";" => Some("Semicolon"),
        "'" => Some("Quote"),
        "," => Some("Comma"),
        "." => Some("Period"),
        "/" => Some("Slash"),
        _ => None,
    }
}

/// 这一段判断是否为 F1-F12。
/// Return whether the token is F1-F12.
fn is_function_key(value: &str) -> bool {
    // 这一段使用解析而不是正则，保持依赖简单。
    // Use parsing instead of regex to keep dependencies simple.
    let Some(number_text) = value.strip_prefix('F').or_else(|| value.strip_prefix('f')) else {
        return false;
    };
    number_text
        .parse::<u32>()
        .is_ok_and(|number| (1..=12).contains(&number))
}

/// 这一段构造字母键定义。
/// Build a letter key definition.
fn letter_key_definition(ch: char) -> KeyDefinition {
    // 这一段匹配旧 Node handler：无 Shift 时 key 为小写，Shift 时为大写。
    // Match the old Node handler: key is lowercase without Shift and uppercase with Shift.
    let letter = ch.to_ascii_uppercase();
    KeyDefinition {
        name: letter.to_string(),
        code: format!("Key{letter}"),
        key: letter.to_ascii_lowercase().to_string(),
        shift_key: Some(letter.to_string()),
        windows_virtual_key_code: letter as u32,
    }
}

/// 这一段构造数字键定义。
/// Build a digit key definition.
fn digit_key_definition(ch: char) -> KeyDefinition {
    // 这一段匹配旧 Node handler 的 Digit0-Digit9 定义。
    // Match the old Node handler's Digit0-Digit9 definitions.
    KeyDefinition {
        name: ch.to_string(),
        code: format!("Digit{ch}"),
        key: ch.to_string(),
        shift_key: None,
        windows_virtual_key_code: ch as u32,
    }
}

/// 这一段构造功能键定义。
/// Build a function-key definition.
fn function_key_definition(value: &str) -> Option<KeyDefinition> {
    // 这一段匹配旧 Node handler 的 F1-F12 虚拟键码。
    // Match the old Node handler's F1-F12 virtual key codes.
    let number = value.get(1..)?.parse::<u32>().ok()?;
    if !(1..=12).contains(&number) {
        return None;
    }
    let name = format!("F{number}");
    Some(KeyDefinition {
        name: name.clone(),
        code: name.clone(),
        key: name,
        shift_key: None,
        windows_virtual_key_code: 111 + number,
    })
}

/// 这一段返回命名键定义。
/// Return named key definitions.
fn key_definition(name: &str) -> Option<KeyDefinition> {
    // 这一段完整复刻旧 Node handler 的非字母数字键定义。
    // Fully mirror the old Node handler's non-alphanumeric key definitions.
    let (code, key, windows_virtual_key_code) = match name {
        "Backquote" => ("Backquote", "`", 192),
        "Backslash" => ("Backslash", "\\", 220),
        "Backspace" => ("Backspace", "Backspace", 8),
        "BracketLeft" => ("BracketLeft", "[", 219),
        "BracketRight" => ("BracketRight", "]", 221),
        "Comma" => ("Comma", ",", 188),
        "Delete" => ("Delete", "Delete", 46),
        "Down" => ("ArrowDown", "ArrowDown", 40),
        "End" => ("End", "End", 35),
        "Enter" => ("Enter", "Enter", 13),
        "Equal" => ("Equal", "=", 187),
        "Escape" => ("Escape", "Escape", 27),
        "Home" => ("Home", "Home", 36),
        "Insert" => ("Insert", "Insert", 45),
        "Left" => ("ArrowLeft", "ArrowLeft", 37),
        "Minus" => ("Minus", "-", 189),
        "PageDown" => ("PageDown", "PageDown", 34),
        "PageUp" => ("PageUp", "PageUp", 33),
        "Period" => ("Period", ".", 190),
        "Quote" => ("Quote", "'", 222),
        "Right" => ("ArrowRight", "ArrowRight", 39),
        "Semicolon" => ("Semicolon", ";", 186),
        "Slash" => ("Slash", "/", 191),
        "Space" => ("Space", " ", 32),
        "Tab" => ("Tab", "Tab", 9),
        "Up" => ("ArrowUp", "ArrowUp", 38),
        _ => return None,
    };
    Some(KeyDefinition {
        name: name.to_string(),
        code: code.to_string(),
        key: key.to_string(),
        shift_key: None,
        windows_virtual_key_code,
    })
}

/// 这一段组合 CDP modifiers。
/// Compose CDP modifiers.
fn modifier_flags(ctrl: bool, alt: bool, shift: bool, meta: bool) -> u32 {
    // 这一段使用旧 Node handler 的位顺序和数值。
    // Use the old Node handler's bit values.
    let mut modifiers = 0;
    if alt {
        modifiers |= MODIFIER_ALT;
    }
    if ctrl {
        modifiers |= MODIFIER_CTRL;
    }
    if meta {
        modifiers |= MODIFIER_META;
    }
    if shift {
        modifiers |= MODIFIER_SHIFT;
    }
    modifiers
}

/// 这一段生成归一化快捷键描述。
/// Build the normalized shortcut description.
fn format_description(main_key: &str, ctrl: bool, alt: bool, shift: bool, meta: bool) -> String {
    // 这一段使用 Ctrl、Alt、Shift、Meta 的固定顺序。
    // Use the fixed Ctrl, Alt, Shift, Meta order.
    let mut parts = Vec::new();
    if ctrl {
        parts.push("Ctrl");
    }
    if alt {
        parts.push("Alt");
    }
    if shift {
        parts.push("Shift");
    }
    if meta {
        parts.push("Meta");
    }
    parts.push(main_key);
    parts.join("+")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parser_rejects_modifier_only_and_macros() {
        assert!(parse_shortcut("Ctrl").is_none());
        assert!(parse_shortcut("Ctrl+K+P").is_none());
        assert!(parse_shortcut("Ctrl+DefinitelyNotAKey").is_none());
        assert_eq!(
            parse_shortcut("Ctrl+Alt+T").unwrap().description,
            "Ctrl+Alt+T"
        );
    }

    #[test]
    fn parser_matches_node_shortcut_descriptors() {
        let shortcut = parse_shortcut("control + option + b").unwrap();
        assert_eq!(shortcut.description, "Ctrl+Alt+B");
        assert_eq!(shortcut.keys.len(), 1);
        assert_eq!(
            shortcut.keys[0],
            ShortcutKey {
                code: "KeyB".to_string(),
                key: "b".to_string(),
                is_system_key: true,
                modifiers: MODIFIER_ALT | MODIFIER_CTRL,
                native_virtual_key_code: 66,
                windows_virtual_key_code: 66,
            },
        );

        let shifted = parse_shortcut("Ctrl+Shift+P").unwrap();
        assert_eq!(shifted.keys[0].key, "P");
        assert_eq!(shifted.keys[0].code, "KeyP");
        assert_eq!(shifted.keys[0].modifiers, MODIFIER_CTRL | MODIFIER_SHIFT);
    }

    #[test]
    fn parser_covers_default_gesture_shortcut_keys() {
        let defaults = [
            (
                "Ctrl+Alt+B",
                "KeyB",
                "b",
                66,
                MODIFIER_CTRL | MODIFIER_ALT,
                true,
            ),
            ("Ctrl+PageUp", "PageUp", "PageUp", 33, MODIFIER_CTRL, false),
            (
                "Ctrl+PageDown",
                "PageDown",
                "PageDown",
                34,
                MODIFIER_CTRL,
                false,
            ),
            ("Ctrl+W", "KeyW", "w", 87, MODIFIER_CTRL, false),
            ("Ctrl+N", "KeyN", "n", 78, MODIFIER_CTRL, false),
        ];
        for (shortcut_text, code, key, virtual_key_code, modifiers, is_system_key) in defaults {
            let shortcut = parse_shortcut(shortcut_text).unwrap();
            let key_event = &shortcut.keys[0];
            assert_eq!(key_event.code, code);
            assert_eq!(key_event.key, key);
            assert_eq!(key_event.windows_virtual_key_code, virtual_key_code);
            assert_eq!(key_event.native_virtual_key_code, virtual_key_code);
            assert_eq!(key_event.modifiers, modifiers);
            assert_eq!(key_event.is_system_key, is_system_key);
        }
    }

    #[test]
    fn key_event_params_match_node_cdp_shape() {
        let shortcut = parse_shortcut("Ctrl+Alt+B").unwrap();
        let key = &shortcut.keys[0];
        assert_eq!(
            key_event_params("rawKeyDown", key),
            json!({
                "type": "rawKeyDown",
                "code": "KeyB",
                "isSystemKey": true,
                "key": "b",
                "modifiers": MODIFIER_CTRL | MODIFIER_ALT,
                "nativeVirtualKeyCode": 66,
                "windowsVirtualKeyCode": 66,
            }),
        );
        assert_eq!(
            key_event_params("keyUp", key),
            json!({
                "type": "keyUp",
                "code": "KeyB",
                "isSystemKey": true,
                "key": "b",
                "modifiers": MODIFIER_CTRL | MODIFIER_ALT,
                "nativeVirtualKeyCode": 66,
                "windowsVirtualKeyCode": 66,
            }),
        );
    }
}
