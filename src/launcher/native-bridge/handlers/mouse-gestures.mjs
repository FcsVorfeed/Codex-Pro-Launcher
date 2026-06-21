const nativeShortcutMaxLength = 80;
const nativeShortcutModifierFlags = {
  Alt: 1,
  Ctrl: 2,
  Meta: 4,
  Shift: 8,
};
const nativeShortcutModifierOrder = ["Ctrl", "Alt", "Shift", "Meta"];
const nativeShortcutModifierAliases = {
  alt: "Alt",
  cmd: "Meta",
  command: "Meta",
  control: "Ctrl",
  ctrl: "Ctrl",
  meta: "Meta",
  option: "Alt",
  shift: "Shift",
  super: "Meta",
  win: "Meta",
  windows: "Meta",
};
const nativeShortcutKeyAliases = {
  arrowdown: "Down",
  arrowleft: "Left",
  arrowright: "Right",
  arrowup: "Up",
  backspace: "Backspace",
  backquote: "Backquote",
  backslash: "Backslash",
  bracketleft: "BracketLeft",
  bracketright: "BracketRight",
  comma: "Comma",
  del: "Delete",
  delete: "Delete",
  down: "Down",
  end: "End",
  enter: "Enter",
  equal: "Equal",
  esc: "Escape",
  escape: "Escape",
  home: "Home",
  ins: "Insert",
  insert: "Insert",
  left: "Left",
  minus: "Minus",
  pagedown: "PageDown",
  pageup: "PageUp",
  period: "Period",
  pgdn: "PageDown",
  pgup: "PageUp",
  quote: "Quote",
  return: "Enter",
  right: "Right",
  semicolon: "Semicolon",
  slash: "Slash",
  space: "Space",
  spacebar: "Space",
  tab: "Tab",
  up: "Up",
};
const nativeShortcutPunctuationKeys = {
  "`": "Backquote",
  "-": "Minus",
  "=": "Equal",
  "[": "BracketLeft",
  "]": "BracketRight",
  "\\": "Backslash",
  ";": "Semicolon",
  "'": "Quote",
  ",": "Comma",
  ".": "Period",
  "/": "Slash",
};
const nativeShortcutKeyDefinitions = {
  Backquote: { code: "Backquote", key: "`", windowsVirtualKeyCode: 192 },
  Backslash: { code: "Backslash", key: "\\", windowsVirtualKeyCode: 220 },
  Backspace: { code: "Backspace", key: "Backspace", windowsVirtualKeyCode: 8 },
  BracketLeft: { code: "BracketLeft", key: "[", windowsVirtualKeyCode: 219 },
  BracketRight: { code: "BracketRight", key: "]", windowsVirtualKeyCode: 221 },
  Comma: { code: "Comma", key: ",", windowsVirtualKeyCode: 188 },
  Delete: { code: "Delete", key: "Delete", windowsVirtualKeyCode: 46 },
  Down: { code: "ArrowDown", key: "ArrowDown", windowsVirtualKeyCode: 40 },
  End: { code: "End", key: "End", windowsVirtualKeyCode: 35 },
  Enter: { code: "Enter", key: "Enter", windowsVirtualKeyCode: 13 },
  Equal: { code: "Equal", key: "=", windowsVirtualKeyCode: 187 },
  Escape: { code: "Escape", key: "Escape", windowsVirtualKeyCode: 27 },
  Home: { code: "Home", key: "Home", windowsVirtualKeyCode: 36 },
  Insert: { code: "Insert", key: "Insert", windowsVirtualKeyCode: 45 },
  Left: { code: "ArrowLeft", key: "ArrowLeft", windowsVirtualKeyCode: 37 },
  Minus: { code: "Minus", key: "-", windowsVirtualKeyCode: 189 },
  PageDown: { code: "PageDown", key: "PageDown", windowsVirtualKeyCode: 34 },
  PageUp: { code: "PageUp", key: "PageUp", windowsVirtualKeyCode: 33 },
  Period: { code: "Period", key: ".", windowsVirtualKeyCode: 190 },
  Quote: { code: "Quote", key: "'", windowsVirtualKeyCode: 222 },
  Right: { code: "ArrowRight", key: "ArrowRight", windowsVirtualKeyCode: 39 },
  Semicolon: { code: "Semicolon", key: ";", windowsVirtualKeyCode: 186 },
  Slash: { code: "Slash", key: "/", windowsVirtualKeyCode: 191 },
  Space: { code: "Space", key: " ", windowsVirtualKeyCode: 32 },
  Tab: { code: "Tab", key: "Tab", windowsVirtualKeyCode: 9 },
  Up: { code: "ArrowUp", key: "ArrowUp", windowsVirtualKeyCode: 38 },
};

for (let index = 0; index < 26; index += 1) {
  const letter = String.fromCharCode(65 + index);
  nativeShortcutKeyDefinitions[letter] = {
    code: `Key${letter}`,
    key: letter.toLowerCase(),
    shiftKey: letter,
    windowsVirtualKeyCode: 65 + index,
  };
}

for (let digit = 0; digit <= 9; digit += 1) {
  nativeShortcutKeyDefinitions[String(digit)] = {
    code: `Digit${digit}`,
    key: String(digit),
    windowsVirtualKeyCode: 48 + digit,
  };
}

for (let number = 1; number <= 12; number += 1) {
  nativeShortcutKeyDefinitions[`F${number}`] = {
    code: `F${number}`,
    key: `F${number}`,
    windowsVirtualKeyCode: 111 + number,
  };
}

function normalizeNativeShortcutMainKey(value) {
  // 这一段把主键文本映射到固定键定义名称，避免页面传入任意 key/code。
  // Map main-key text to a fixed key definition name so the page cannot pass arbitrary key/code values.
  const token = String(value || "").trim();
  const compactToken = token.replace(/\s+/g, "");
  if (/^[a-z]$/i.test(compactToken)) return compactToken.toUpperCase();
  if (/^[0-9]$/.test(compactToken)) return compactToken;

  // 这一段接受常见别名和标点主键，最终都必须命中 nativeShortcutKeyDefinitions。
  // Accept common aliases and punctuation keys, all of which must resolve through nativeShortcutKeyDefinitions.
  const normalizedNamedKey = nativeShortcutKeyAliases[compactToken.toLowerCase()];
  if (normalizedNamedKey) return normalizedNamedKey;
  if (/^f([1-9]|1[0-2])$/i.test(compactToken)) return compactToken.toUpperCase();
  return nativeShortcutPunctuationKeys[compactToken] || "";
}

function parseNativeShortcut(shortcut) {
  // 这一段把页面传来的快捷键字符串解析成一个受限 key event 描述；空值和非法值都拒绝。
  // Parse the page-provided shortcut string into a constrained key-event descriptor; empty or invalid values are rejected.
  const rawShortcut = typeof shortcut === "string" ? shortcut.trim().slice(0, nativeShortcutMaxLength) : "";
  if (!rawShortcut) return null;
  const tokens = rawShortcut
    .split("+")
    .map((token) => token.trim())
    .filter(Boolean);

  // 这一段只允许修饰键集合加一个主键，不支持多步序列或宏。
  // Allow only a modifier set plus one main key, with no multi-step sequences or macros.
  const modifiers = new Set();
  let mainKey = "";
  for (const token of tokens) {
    const modifier = nativeShortcutModifierAliases[token.toLowerCase()];
    if (modifier) {
      modifiers.add(modifier);
      continue;
    }
    const normalizedMainKey = normalizeNativeShortcutMainKey(token);
    if (!normalizedMainKey || mainKey) return null;
    mainKey = normalizedMainKey;
  }
  if (!mainKey || modifiers.size === 0) return null;

  // 这一段生成 CDP 需要的修饰键位和主键参数，Alt 组合按系统键发送。
  // Build the CDP modifier bitfield and main-key params, sending Alt chords as system keys.
  const keyDefinition = nativeShortcutKeyDefinitions[mainKey];
  if (!keyDefinition) return null;
  const modifierFlags = [...modifiers].reduce((flags, modifier) => flags | nativeShortcutModifierFlags[modifier], 0);
  const normalizedShortcut = [...nativeShortcutModifierOrder.filter((modifier) => modifiers.has(modifier)), mainKey].join("+");
  const key = {
    ...keyDefinition,
    isSystemKey: Boolean(modifierFlags & nativeShortcutModifierFlags.Alt),
    key: (modifierFlags & nativeShortcutModifierFlags.Shift) && keyDefinition.shiftKey
      ? keyDefinition.shiftKey
      : keyDefinition.key,
    modifiers: modifierFlags,
  };
  return {
    description: normalizedShortcut,
    keys: [key],
  };
}

export function parseShortcutRequest(request) {
  // 这一段把鼠标手势发来的快捷键请求转换成统一 request 对象。
  // Convert shortcut requests from mouse gestures into the common request object.
  const shortcut = parseNativeShortcut(request?.shortcut);
  if (!shortcut) return null;
  return {
    shortcut,
    type: "shortcut",
  };
}

function createKeyEventParams(key, type) {
  // 这一段把集中配置的快捷键描述转成 CDP Input.dispatchKeyEvent 参数。
  // Convert centralized shortcut descriptors into CDP Input.dispatchKeyEvent parameters.
  return {
    code: key.code,
    isSystemKey: Boolean(key.isSystemKey),
    key: key.key,
    modifiers: key.modifiers || 0,
    nativeVirtualKeyCode: key.nativeVirtualKeyCode ?? key.windowsVirtualKeyCode,
    type,
    windowsVirtualKeyCode: key.windowsVirtualKeyCode,
  };
}

export async function dispatchNativeShortcut(client, shortcut) {
  // 这一段按顺序发送 keyDown/keyUp，让 Electron/Chromium 自己处理对应快捷键。
  // Send keyDown/keyUp in order so Electron/Chromium handles the matching shortcut itself.
  if (!shortcut) return;
  for (const key of shortcut.keys) {
    await client.send("Input.dispatchKeyEvent", createKeyEventParams(key, "rawKeyDown"));
    await client.send("Input.dispatchKeyEvent", createKeyEventParams(key, "keyUp"));
  }
}
