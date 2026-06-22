/// 这一段描述注入模块归属的系统。
/// Describes an injectable system and its module paths.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InjectableSystem {
    /// 这一段是硬屏蔽使用的系统名。
    /// System name used by hard-disable.
    pub name: &'static str,
    /// 这一段是该系统的模块路径。
    /// Module paths belonging to the system.
    pub modules: &'static [&'static str],
}

/// 这一段描述设置页贡献模块。
/// Describes a settings-section contribution module.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SettingsSectionModule {
    /// 这一段是所属系统名。
    /// Owner system name.
    pub owner_system: &'static str,
    /// 这一段是模块路径。
    /// Module path.
    pub path: &'static str,
}

/// 这一段是核心注入模块顺序。
/// Core injection module order.
pub const CORE_INJECTION_MODULE_PATHS: &[&str] = &[
    "src/inject/core/runtime.js",
    "src/inject/core/i18n.js",
    "src/inject/core/dom.js",
    "src/inject/core/dialogs.js",
    "src/inject/core/fetch-bridge.js",
    "src/inject/core/native-bridge.js",
    "src/inject/core/lifecycle.js",
];

/// 这一段是 settings-menu 内置复杂分区。
/// Built-in settings-menu sections.
pub const SETTINGS_MENU_BUILTIN_SECTION_MODULES: &[&str] = &[
    "src/inject/systems/settings-menu/sections/language.js",
    "src/inject/systems/settings-menu/sections/cloud-sync.js",
    "src/inject/systems/settings-menu/sections/pet-sync.js",
    "src/inject/systems/settings-menu/sections/conversation-archive.js",
    "src/inject/systems/settings-menu/sections/background-wallpaper.js",
    "src/inject/systems/settings-menu/sections/diff-hover.js",
    "src/inject/systems/settings-menu/sections/mouse-gestures.js",
];

/// 这一段是其它系统贡献给 settings-menu 的分区。
/// Sections contributed to settings-menu by other systems.
pub const SETTINGS_MENU_SECTION_MODULES: &[SettingsSectionModule] = &[
    SettingsSectionModule {
        owner_system: "startup-sidebar",
        path: "src/inject/systems/startup-sidebar/settings.js",
    },
    SettingsSectionModule {
        owner_system: "usage-panel",
        path: "src/inject/systems/usage-panel/settings.js",
    },
    SettingsSectionModule {
        owner_system: "context-usage-inline",
        path: "src/inject/systems/context-usage-inline/settings.js",
    },
    SettingsSectionModule {
        owner_system: "chat-width-resizer",
        path: "src/inject/systems/chat-width-resizer/settings.js",
    },
    SettingsSectionModule {
        owner_system: "file-tree-filter",
        path: "src/inject/systems/file-tree-filter/settings.js",
    },
    SettingsSectionModule {
        owner_system: "file-tree-active-reveal",
        path: "src/inject/systems/file-tree-active-reveal/settings.js",
    },
    SettingsSectionModule {
        owner_system: "conversation-archive-sidebar",
        path: "src/inject/systems/conversation-archive-sidebar/settings.js",
    },
    SettingsSectionModule {
        owner_system: "tab-drag-to-chat",
        path: "src/inject/systems/tab-drag-to-chat/settings.js",
    },
    SettingsSectionModule {
        owner_system: "native-thread-drag-to-chat",
        path: "src/inject/systems/native-thread-drag-to-chat/settings.js",
    },
    SettingsSectionModule {
        owner_system: "update-check",
        path: "src/inject/systems/update-check/settings.js",
    },
];

/// 这一段是可注入功能系统清单。
/// Injectable feature-system list.
pub const INJECTABLE_SYSTEMS: &[InjectableSystem] = &[
    InjectableSystem {
        name: "legacy-cleanup",
        modules: &["src/inject/systems/legacy-cleanup/index.js"],
    },
    InjectableSystem {
        name: "pet-sync",
        modules: &["src/inject/systems/pet-sync/index.js"],
    },
    InjectableSystem {
        name: "conversation-archive",
        modules: &["src/inject/systems/conversation-archive/index.js"],
    },
    InjectableSystem {
        name: "settings-menu",
        modules: &[
            "src/inject/systems/settings-menu/settings.js",
            "src/inject/systems/settings-menu/cloud-sync.js",
            "src/inject/systems/settings-menu/section-registry.js",
            "src/inject/systems/settings-menu/form-binding.js",
            "src/inject/systems/settings-menu/view.js",
            "src/inject/systems/settings-menu/index.js",
        ],
    },
    InjectableSystem {
        name: "startup-sidebar",
        modules: &["src/inject/systems/startup-sidebar/index.js"],
    },
    InjectableSystem {
        name: "usage-panel",
        modules: &[
            "src/inject/systems/usage-panel/format.js",
            "src/inject/systems/usage-panel/usage-api.js",
            "src/inject/systems/usage-panel/view.js",
            "src/inject/systems/usage-panel/index.js",
        ],
    },
    InjectableSystem {
        name: "context-usage-inline",
        modules: &["src/inject/systems/context-usage-inline/index.js"],
    },
    InjectableSystem {
        name: "chat-width-resizer",
        modules: &["src/inject/systems/chat-width-resizer/index.js"],
    },
    InjectableSystem {
        name: "diff-hover-preview",
        modules: &[
            "src/inject/systems/diff-hover-preview/navigation-utils.js",
            "src/inject/systems/diff-hover-preview/index.js",
        ],
    },
    InjectableSystem {
        name: "background-wallpaper",
        modules: &["src/inject/systems/background-wallpaper/index.js"],
    },
    InjectableSystem {
        name: "conversation-archive-sidebar",
        modules: &[
            "src/inject/systems/diff-hover-preview/navigation-utils.js",
            "src/inject/systems/conversation-archive-sidebar/index.js",
        ],
    },
    InjectableSystem {
        name: "file-tree-response-filter",
        modules: &["src/inject/systems/file-tree-response-filter/index.js"],
    },
    InjectableSystem {
        name: "file-tree-filter",
        modules: &["src/inject/systems/file-tree-filter/index.js"],
    },
    InjectableSystem {
        name: "file-tree-active-reveal",
        modules: &["src/inject/systems/file-tree-active-reveal/index.js"],
    },
    InjectableSystem {
        name: "tab-drag-to-chat",
        modules: &["src/inject/systems/tab-drag-to-chat/index.js"],
    },
    InjectableSystem {
        name: "native-thread-drag-to-chat",
        modules: &["src/inject/systems/native-thread-drag-to-chat/index.js"],
    },
    InjectableSystem {
        name: "mouse-gestures",
        modules: &["src/inject/systems/mouse-gestures/index.js"],
    },
    InjectableSystem {
        name: "update-check",
        modules: &["src/inject/systems/update-check/index.js"],
    },
];

/// 这一段是最终入口模块。
/// Final entrypoint module.
pub const FINAL_INJECTION_MODULE_PATHS: &[&str] = &["src/inject/index.js"];

/// 这一段根据硬屏蔽系统构造最终注入模块顺序。
/// Build final injection module order from hard-disabled systems.
pub fn build_injection_module_paths(disabled_systems: &[String]) -> Vec<&'static str> {
    // 这一段把禁用列表转成集合，确保 settings-menu 贡献也跟随 ownerSystem 禁用。
    // Convert disabled systems into a set so settings-menu contributions follow ownerSystem disables.
    let disabled = disabled_systems
        .iter()
        .map(String::as_str)
        .collect::<std::collections::HashSet<_>>();
    let mut modules = Vec::new();
    modules.extend(CORE_INJECTION_MODULE_PATHS.iter().copied());

    // 这一段按系统顺序加入模块，对 settings-menu 做唯一特殊插入。
    // Add modules by system order, with the one settings-menu insertion special case.
    for system in INJECTABLE_SYSTEMS
        .iter()
        .filter(|system| !disabled.contains(system.name))
    {
        if system.name == "settings-menu" {
            for module in system.modules {
                if *module == "src/inject/systems/settings-menu/view.js" {
                    modules.extend(SETTINGS_MENU_BUILTIN_SECTION_MODULES.iter().copied());
                    modules.extend(
                        SETTINGS_MENU_SECTION_MODULES
                            .iter()
                            .filter(|item| !disabled.contains(item.owner_system))
                            .map(|item| item.path),
                    );
                }
                modules.push(module);
            }
        } else {
            modules.extend(system.modules.iter().copied());
        }
    }
    modules.extend(FINAL_INJECTION_MODULE_PATHS.iter().copied());

    // 这一段按首次出现顺序去重，保留 navigation-utils 这类复用模块的原语义。
    // Deduplicate by first appearance, preserving reused utility module semantics.
    let mut seen = std::collections::HashSet::new();
    modules
        .into_iter()
        .filter(|module| seen.insert(*module))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hard_disable_skips_system_and_settings_contribution() {
        let modules = build_injection_module_paths(&["usage-panel".to_string()]);
        assert!(!modules.contains(&"src/inject/systems/usage-panel/index.js"));
        assert!(!modules.contains(&"src/inject/systems/usage-panel/settings.js"));
    }
}
