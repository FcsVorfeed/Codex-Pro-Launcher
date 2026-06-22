export const coreInjectionModulePaths = [
  ["src", "inject", "core", "runtime.js"],
  ["src", "inject", "core", "i18n.js"],
  ["src", "inject", "core", "dom.js"],
  ["src", "inject", "core", "dialogs.js"],
  ["src", "inject", "core", "fetch-bridge.js"],
  ["src", "inject", "core", "native-bridge.js"],
  ["src", "inject", "core", "lifecycle.js"],
];

const settingsMenuViewModulePath = ["src", "inject", "systems", "settings-menu", "view.js"];

export const settingsMenuBuiltinSectionModules = [
  {
    path: ["src", "inject", "systems", "settings-menu", "sections", "language.js"],
  },
  {
    path: ["src", "inject", "systems", "settings-menu", "sections", "cloud-sync.js"],
  },
  {
    path: ["src", "inject", "systems", "settings-menu", "sections", "pet-sync.js"],
  },
  {
    path: ["src", "inject", "systems", "settings-menu", "sections", "conversation-archive.js"],
  },
  {
    path: ["src", "inject", "systems", "settings-menu", "sections", "background-wallpaper.js"],
  },
  {
    path: ["src", "inject", "systems", "settings-menu", "sections", "diff-hover.js"],
  },
  {
    path: ["src", "inject", "systems", "settings-menu", "sections", "mouse-gestures.js"],
  },
];

export const settingsMenuSectionModules = [
  {
    ownerSystem: "startup-sidebar",
    path: ["src", "inject", "systems", "startup-sidebar", "settings.js"],
  },
  {
    ownerSystem: "usage-panel",
    path: ["src", "inject", "systems", "usage-panel", "settings.js"],
  },
  {
    ownerSystem: "context-usage-inline",
    path: ["src", "inject", "systems", "context-usage-inline", "settings.js"],
  },
  {
    ownerSystem: "file-tree-filter",
    path: ["src", "inject", "systems", "file-tree-filter", "settings.js"],
  },
  {
    ownerSystem: "file-tree-active-reveal",
    path: ["src", "inject", "systems", "file-tree-active-reveal", "settings.js"],
  },
  {
    ownerSystem: "conversation-archive-sidebar",
    path: ["src", "inject", "systems", "conversation-archive-sidebar", "settings.js"],
  },
  {
    ownerSystem: "tab-drag-to-chat",
    path: ["src", "inject", "systems", "tab-drag-to-chat", "settings.js"],
  },
  {
    ownerSystem: "native-thread-drag-to-chat",
    path: ["src", "inject", "systems", "native-thread-drag-to-chat", "settings.js"],
  },
  {
    ownerSystem: "update-check",
    path: ["src", "inject", "systems", "update-check", "settings.js"],
  },
];

export const injectableSystems = [
  {
    name: "legacy-cleanup",
    modules: [
      ["src", "inject", "systems", "legacy-cleanup", "index.js"],
    ],
  },
  {
    name: "pet-sync",
    modules: [
      ["src", "inject", "systems", "pet-sync", "index.js"],
    ],
  },
  {
    name: "conversation-archive",
    modules: [
      ["src", "inject", "systems", "conversation-archive", "index.js"],
    ],
  },
  {
    name: "settings-menu",
    modules: [
      ["src", "inject", "systems", "settings-menu", "settings.js"],
      ["src", "inject", "systems", "settings-menu", "cloud-sync.js"],
      ["src", "inject", "systems", "settings-menu", "section-registry.js"],
      ["src", "inject", "systems", "settings-menu", "form-binding.js"],
      settingsMenuViewModulePath,
      ["src", "inject", "systems", "settings-menu", "index.js"],
    ],
  },
  {
    name: "startup-sidebar",
    modules: [
      ["src", "inject", "systems", "startup-sidebar", "index.js"],
    ],
  },
  {
    name: "usage-panel",
    modules: [
      ["src", "inject", "systems", "usage-panel", "format.js"],
      ["src", "inject", "systems", "usage-panel", "usage-api.js"],
      ["src", "inject", "systems", "usage-panel", "view.js"],
      ["src", "inject", "systems", "usage-panel", "index.js"],
    ],
  },
  {
    name: "context-usage-inline",
    modules: [
      ["src", "inject", "systems", "context-usage-inline", "index.js"],
    ],
  },
  {
    name: "diff-hover-preview",
    modules: [
      ["src", "inject", "systems", "diff-hover-preview", "navigation-utils.js"],
      ["src", "inject", "systems", "diff-hover-preview", "index.js"],
    ],
  },
  {
    name: "background-wallpaper",
    modules: [
      ["src", "inject", "systems", "background-wallpaper", "index.js"],
    ],
  },
  {
    name: "conversation-archive-sidebar",
    modules: [
      ["src", "inject", "systems", "diff-hover-preview", "navigation-utils.js"],
      ["src", "inject", "systems", "conversation-archive-sidebar", "index.js"],
    ],
  },
  {
    name: "file-tree-response-filter",
    modules: [
      ["src", "inject", "systems", "file-tree-response-filter", "index.js"],
    ],
  },
  {
    name: "file-tree-filter",
    modules: [
      ["src", "inject", "systems", "file-tree-filter", "index.js"],
    ],
  },
  {
    name: "file-tree-active-reveal",
    modules: [
      ["src", "inject", "systems", "file-tree-active-reveal", "index.js"],
    ],
  },
  {
    name: "tab-drag-to-chat",
    modules: [
      ["src", "inject", "systems", "tab-drag-to-chat", "index.js"],
    ],
  },
  {
    name: "native-thread-drag-to-chat",
    modules: [
      ["src", "inject", "systems", "native-thread-drag-to-chat", "index.js"],
    ],
  },
  {
    name: "mouse-gestures",
    modules: [
      ["src", "inject", "systems", "mouse-gestures", "index.js"],
    ],
  },
  {
    name: "update-check",
    modules: [
      ["src", "inject", "systems", "update-check", "index.js"],
    ],
  },
];

export const finalInjectionModulePaths = [
  ["src", "inject", "index.js"],
];

export function splitSystemNames(value) {
  // 这一段把命令行或环境变量中的系统名统一成小写列表，方便做硬屏蔽匹配。
  // Normalize system names from CLI or environment values into lowercase entries for hard-disable matching.
  return String(value || "")
    .split(/[,\s;]+/)
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
}

export function parseDisabledSystems(value) {
  // 这一段去重硬屏蔽系统名，避免重复参数影响诊断输出。
  // Deduplicate hard-disabled system names so repeated inputs do not affect diagnostics.
  return Array.from(new Set(splitSystemNames(value)));
}

function getModulePathId(parts) {
  // 这一段生成跨平台稳定的注入路径 id，用于识别 settings-menu 的插入点。
  // Build a platform-stable injection path id for identifying the settings-menu insertion point.
  return parts.join("/");
}

function buildSettingsMenuSectionModulePaths(disabledSet) {
  // 这一段把各系统的设置页贡献插到 settings-menu/view.js 之前，同时保留系统硬屏蔽隔离能力。
  // Insert each system's settings contribution before settings-menu/view.js while preserving hard-disable isolation.
  const builtinSectionModulePaths = settingsMenuBuiltinSectionModules.map((module) => module.path);
  const systemSectionModulePaths = settingsMenuSectionModules
    .filter((module) => !disabledSet.has(module.ownerSystem))
    .map((module) => module.path);
  return [
    ...builtinSectionModulePaths,
    ...systemSectionModulePaths,
  ];
}

function buildSystemModulePaths(system, disabledSet) {
  // 这一段对 settings-menu 做唯一特殊处理：它需要预加载其它系统的设置页贡献。
  // Handle the one settings-menu special case: it must preload settings contributions from other systems.
  if (system.name !== "settings-menu") return system.modules;
  const viewModuleId = getModulePathId(settingsMenuViewModulePath);
  const sectionModulePaths = buildSettingsMenuSectionModulePaths(disabledSet);
  return system.modules.flatMap((modulePath) => (
    getModulePathId(modulePath) === viewModuleId
      ? [...sectionModulePaths, modulePath]
      : [modulePath]
  ));
}

function dedupeModulePaths(modulePaths) {
  // 这一段按首次出现顺序去重注入模块，允许多个系统复用同一个只注册工具的文件。
  // Deduplicate injection modules by first occurrence so multiple systems can share one utility-only file.
  const seen = new Set();
  return modulePaths.filter((modulePath) => {
    const id = getModulePathId(modulePath);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

export function buildInjectionModulePaths(disabledSystems) {
  // 这一段根据系统清单拼接注入文件，禁用某系统时整组模块都会跳过。
  // Build injection files from the system manifest, skipping every module in a disabled system group.
  const disabledSet = new Set(disabledSystems);
  const systemModulePaths = injectableSystems
    .filter((system) => !disabledSet.has(system.name))
    .flatMap((system) => buildSystemModulePaths(system, disabledSet));
  return dedupeModulePaths([
    ...coreInjectionModulePaths,
    ...systemModulePaths,
    ...finalInjectionModulePaths,
  ]);
}
