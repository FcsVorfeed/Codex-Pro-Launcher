/// 这一段返回嵌入的注入模块源码。
/// Return embedded injection module source.
pub fn module_source(path: &str) -> Option<&'static str> {
    // 这一段所有路径必须和 injection manifest 使用的路径完全一致。
    // Paths must exactly match the injection manifest paths.
    Some(match path {
        "src/inject/core/runtime.js" => include_str!("../../../src/inject/core/runtime.js"),
        "src/inject/core/i18n.js" => include_str!("../../../src/inject/core/i18n.js"),
        "src/inject/core/dom.js" => include_str!("../../../src/inject/core/dom.js"),
        "src/inject/core/dialogs.js" => include_str!("../../../src/inject/core/dialogs.js"),
        "src/inject/core/fetch-bridge.js" => {
            include_str!("../../../src/inject/core/fetch-bridge.js")
        }
        "src/inject/core/native-bridge.js" => {
            include_str!("../../../src/inject/core/native-bridge.js")
        }
        "src/inject/core/lifecycle.js" => include_str!("../../../src/inject/core/lifecycle.js"),
        "src/inject/systems/settings-menu/sections/language.js" => {
            include_str!("../../../src/inject/systems/settings-menu/sections/language.js")
        }
        "src/inject/systems/settings-menu/sections/cloud-sync.js" => {
            include_str!("../../../src/inject/systems/settings-menu/sections/cloud-sync.js")
        }
        "src/inject/systems/settings-menu/sections/pet-sync.js" => {
            include_str!("../../../src/inject/systems/settings-menu/sections/pet-sync.js")
        }
        "src/inject/systems/settings-menu/sections/conversation-archive.js" => include_str!(
            "../../../src/inject/systems/settings-menu/sections/conversation-archive.js"
        ),
        "src/inject/systems/settings-menu/sections/background-wallpaper.js" => include_str!(
            "../../../src/inject/systems/settings-menu/sections/background-wallpaper.js"
        ),
        "src/inject/systems/settings-menu/sections/diff-hover.js" => {
            include_str!("../../../src/inject/systems/settings-menu/sections/diff-hover.js")
        }
        "src/inject/systems/settings-menu/sections/mouse-gestures.js" => {
            include_str!("../../../src/inject/systems/settings-menu/sections/mouse-gestures.js")
        }
        "src/inject/systems/startup-sidebar/settings.js" => {
            include_str!("../../../src/inject/systems/startup-sidebar/settings.js")
        }
        "src/inject/systems/usage-panel/settings.js" => {
            include_str!("../../../src/inject/systems/usage-panel/settings.js")
        }
        "src/inject/systems/context-usage-inline/settings.js" => {
            include_str!("../../../src/inject/systems/context-usage-inline/settings.js")
        }
        "src/inject/systems/file-tree-filter/settings.js" => {
            include_str!("../../../src/inject/systems/file-tree-filter/settings.js")
        }
        "src/inject/systems/file-tree-active-reveal/settings.js" => {
            include_str!("../../../src/inject/systems/file-tree-active-reveal/settings.js")
        }
        "src/inject/systems/conversation-archive-sidebar/settings.js" => {
            include_str!("../../../src/inject/systems/conversation-archive-sidebar/settings.js")
        }
        "src/inject/systems/tab-drag-to-chat/settings.js" => {
            include_str!("../../../src/inject/systems/tab-drag-to-chat/settings.js")
        }
        "src/inject/systems/native-thread-drag-to-chat/settings.js" => {
            include_str!("../../../src/inject/systems/native-thread-drag-to-chat/settings.js")
        }
        "src/inject/systems/update-check/settings.js" => {
            include_str!("../../../src/inject/systems/update-check/settings.js")
        }
        "src/inject/systems/legacy-cleanup/index.js" => {
            include_str!("../../../src/inject/systems/legacy-cleanup/index.js")
        }
        "src/inject/systems/pet-sync/index.js" => {
            include_str!("../../../src/inject/systems/pet-sync/index.js")
        }
        "src/inject/systems/conversation-archive/index.js" => {
            include_str!("../../../src/inject/systems/conversation-archive/index.js")
        }
        "src/inject/systems/settings-menu/settings.js" => {
            include_str!("../../../src/inject/systems/settings-menu/settings.js")
        }
        "src/inject/systems/settings-menu/cloud-sync.js" => {
            include_str!("../../../src/inject/systems/settings-menu/cloud-sync.js")
        }
        "src/inject/systems/settings-menu/section-registry.js" => {
            include_str!("../../../src/inject/systems/settings-menu/section-registry.js")
        }
        "src/inject/systems/settings-menu/form-binding.js" => {
            include_str!("../../../src/inject/systems/settings-menu/form-binding.js")
        }
        "src/inject/systems/settings-menu/view.js" => {
            include_str!("../../../src/inject/systems/settings-menu/view.js")
        }
        "src/inject/systems/settings-menu/index.js" => {
            include_str!("../../../src/inject/systems/settings-menu/index.js")
        }
        "src/inject/systems/startup-sidebar/index.js" => {
            include_str!("../../../src/inject/systems/startup-sidebar/index.js")
        }
        "src/inject/systems/usage-panel/format.js" => {
            include_str!("../../../src/inject/systems/usage-panel/format.js")
        }
        "src/inject/systems/usage-panel/usage-api.js" => {
            include_str!("../../../src/inject/systems/usage-panel/usage-api.js")
        }
        "src/inject/systems/usage-panel/view.js" => {
            include_str!("../../../src/inject/systems/usage-panel/view.js")
        }
        "src/inject/systems/usage-panel/index.js" => {
            include_str!("../../../src/inject/systems/usage-panel/index.js")
        }
        "src/inject/systems/context-usage-inline/index.js" => {
            include_str!("../../../src/inject/systems/context-usage-inline/index.js")
        }
        "src/inject/systems/diff-hover-preview/navigation-utils.js" => {
            include_str!("../../../src/inject/systems/diff-hover-preview/navigation-utils.js")
        }
        "src/inject/systems/diff-hover-preview/index.js" => {
            include_str!("../../../src/inject/systems/diff-hover-preview/index.js")
        }
        "src/inject/systems/background-wallpaper/index.js" => {
            include_str!("../../../src/inject/systems/background-wallpaper/index.js")
        }
        "src/inject/systems/conversation-archive-sidebar/index.js" => {
            include_str!("../../../src/inject/systems/conversation-archive-sidebar/index.js")
        }
        "src/inject/systems/file-tree-response-filter/index.js" => {
            include_str!("../../../src/inject/systems/file-tree-response-filter/index.js")
        }
        "src/inject/systems/file-tree-filter/index.js" => {
            include_str!("../../../src/inject/systems/file-tree-filter/index.js")
        }
        "src/inject/systems/file-tree-active-reveal/index.js" => {
            include_str!("../../../src/inject/systems/file-tree-active-reveal/index.js")
        }
        "src/inject/systems/tab-drag-to-chat/index.js" => {
            include_str!("../../../src/inject/systems/tab-drag-to-chat/index.js")
        }
        "src/inject/systems/native-thread-drag-to-chat/index.js" => {
            include_str!("../../../src/inject/systems/native-thread-drag-to-chat/index.js")
        }
        "src/inject/systems/mouse-gestures/index.js" => {
            include_str!("../../../src/inject/systems/mouse-gestures/index.js")
        }
        "src/inject/systems/update-check/index.js" => {
            include_str!("../../../src/inject/systems/update-check/index.js")
        }
        "src/inject/index.js" => include_str!("../../../src/inject/index.js"),
        _ => return None,
    })
}
