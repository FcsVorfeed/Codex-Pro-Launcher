import { readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";

const rootDir = path.resolve(import.meta.dirname, "..");
const i18nPath = path.join(rootDir, "src", "inject", "core", "i18n.js");
const validLocalePattern = /^[a-z]{2}-[A-Z]{2}$/u;

function assert(condition, message) {
  // 这一段用明确错误终止测试，方便定位翻译字典漂移。
  // Fail with explicit messages so translation catalog drift is easy to locate.
  if (!condition) throw new Error(message);
}

function sortedKeys(object) {
  // 这一段稳定排序 key，保证错误输出可读且不受对象插入顺序影响。
  // Sort keys deterministically so failures are readable and independent of insertion order.
  return Object.keys(object).sort((left, right) => left.localeCompare(right));
}

function readPlaceholders(message) {
  // 这一段提取命名插值参数，要求不同语言的同一 key 参数集合一致。
  // Extract named interpolation params and require matching param sets across locales.
  return Array.from(String(message).matchAll(/\{([A-Za-z0-9_.-]+)\}/gu), (match) => match[1]).sort();
}

const windowObject = {
  __codexProRuntime: {
    systemModules: {},
  },
};
const context = vm.createContext({
  Intl,
  console,
  window: windowObject,
});

const source = await readFile(i18nPath, "utf8");
assert(
  source.includes("interpolate(escapeHtml(getRawMessage"),
  "html() must escape dictionary message bodies before interpolation",
);
vm.runInContext(source, context, { filename: i18nPath });

const i18n = windowObject.__codexProRuntime.i18n;
assert(i18n, "runtime.i18n was not registered");
assert(i18n.defaultLocale === "en-US", "defaultLocale must stay en-US");
assert(Array.isArray(i18n.supportedLocales), "supportedLocales must be an array");
assert(
  JSON.stringify(i18n.supportedLocales) === JSON.stringify(["zh-CN", "en-US", "ja-JP"]),
  "supportedLocales must expose zh-CN, en-US, and ja-JP",
);

for (const locale of i18n.supportedLocales) {
  assert(validLocalePattern.test(locale), `invalid locale code: ${locale}`);
  assert(i18n.dictionaries[locale], `missing dictionary for ${locale}`);
}
assert(i18n.normalizeLocale("fr-FR") === "en-US", "invalid locale must fall back to en-US");

const baseKeys = sortedKeys(i18n.dictionaries["zh-CN"]);
for (const locale of i18n.supportedLocales) {
  const dictionary = i18n.dictionaries[locale];
  const keys = sortedKeys(dictionary);
  assert(JSON.stringify(keys) === JSON.stringify(baseKeys), `${locale} keys must match zh-CN keys exactly`);
  for (const key of keys) {
    const value = dictionary[key];
    assert(typeof value === "string", `${locale}.${key} must be a string`);
    assert(value.trim().length > 0, `${locale}.${key} must not be empty`);
    assert(!/[<>]/u.test(value), `${locale}.${key} must not contain raw HTML`);
    assert(
      JSON.stringify(readPlaceholders(value)) === JSON.stringify(readPlaceholders(i18n.dictionaries["zh-CN"][key])),
      `${locale}.${key} placeholders must match zh-CN`,
    );
  }
}

console.log(`i18n catalog checks passed: ${baseKeys.length} keys`);
