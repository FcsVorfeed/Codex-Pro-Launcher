/// 这一段在非 Windows 平台返回明确错误。
/// Return a clear error on non-Windows platforms.
#[cfg(not(windows))]
pub async fn activate_packaged_app(
    _app_user_model_id: &str,
    _arguments: &str,
) -> anyhow::Result<u32> {
    anyhow::bail!("Packaged app activation is only supported on Windows")
}

/// 这一段通过 Windows ApplicationActivationManager 激活 MSIX 应用。
/// Activate a Windows MSIX app through ApplicationActivationManager.
#[cfg(windows)]
pub async fn activate_packaged_app(
    app_user_model_id: &str,
    arguments: &str,
) -> anyhow::Result<u32> {
    // 这一段把 COM 调用放到 blocking 线程，避免阻塞 tokio runtime。
    // Run COM activation on a blocking thread to avoid blocking tokio runtime.
    let app_user_model_id = app_user_model_id.to_string();
    let arguments = arguments.to_string();
    tokio::task::spawn_blocking(move || {
        activate_packaged_app_blocking(&app_user_model_id, &arguments)
    })
    .await
    .map_err(|error| anyhow::anyhow!("packaged activation task failed: {error}"))?
}

/// 这一段在非 Windows 平台返回明确错误。
/// Return a clear error on non-Windows platforms.
#[cfg(not(windows))]
pub async fn launch_elevated_executable(_executable: &str, _arguments: &str) -> anyhow::Result<()> {
    anyhow::bail!("Elevated executable launch is only supported on Windows")
}

/// 这一段用 UAC 只提升指定可执行文件启动动作。
/// Elevate only the specified executable launch through UAC.
#[cfg(windows)]
pub async fn launch_elevated_executable(executable: &str, arguments: &str) -> anyhow::Result<()> {
    // 这一段把 ShellExecute 放到 blocking 线程，避免 UAC 等待阻塞 tokio runtime。
    // Run ShellExecute on a blocking thread so UAC waiting does not block the tokio runtime.
    let executable = executable.to_string();
    let arguments = arguments.to_string();
    tokio::task::spawn_blocking(move || {
        launch_elevated_executable_blocking(&executable, &arguments)
    })
    .await
    .map_err(|error| anyhow::anyhow!("elevated launch task failed: {error}"))?
}

/// 这一段执行同步提升启动。
/// Execute a synchronous elevated launch.
#[cfg(windows)]
fn launch_elevated_executable_blocking(executable: &str, arguments: &str) -> anyhow::Result<()> {
    use anyhow::bail;
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;

    const SHOW_WINDOW_SHOW: i32 = 5;

    #[link(name = "shell32")]
    unsafe extern "system" {
        fn ShellExecuteW(
            hwnd: isize,
            operation: *const u16,
            file: *const u16,
            parameters: *const u16,
            directory: *const u16,
            show_command: i32,
        ) -> isize;
    }

    fn wide_null(value: &str) -> Vec<u16> {
        // 这一段转换 UTF-16 空结尾字符串给 Win32 API。
        // Convert a string into null-terminated UTF-16 for Win32 APIs.
        OsStr::new(value).encode_wide().chain([0]).collect()
    }

    // 这一段只在 direct spawn 权限失败后调用，避免普通双击入口每次触发 UAC。
    // This is called only after direct spawn hits permission denial, avoiding UAC on normal double-clicks.
    let operation = wide_null("runas");
    let file = wide_null(executable);
    let parameters = wide_null(arguments);
    let result = unsafe {
        ShellExecuteW(
            0,
            operation.as_ptr(),
            file.as_ptr(),
            parameters.as_ptr(),
            std::ptr::null(),
            SHOW_WINDOW_SHOW,
        )
    };
    if result <= 32 {
        bail!("elevated ShellExecute failed with code {result}");
    }
    Ok(())
}

/// 这一段在非 Windows 平台忽略 GUI 错误提示。
/// Ignore GUI error dialogs on non-Windows platforms.
#[cfg(not(windows))]
pub fn show_error_message_box(_title: &str, _message: &str) {}

/// 这一段显示前台 launcher 错误提示。
/// Show a foreground launcher error message.
#[cfg(windows)]
pub fn show_error_message_box(title: &str, message: &str) {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;

    const MB_OK: u32 = 0x0000_0000;
    const MB_ICONERROR: u32 = 0x0000_0010;

    #[link(name = "user32")]
    unsafe extern "system" {
        fn MessageBoxW(hwnd: isize, text: *const u16, caption: *const u16, flags: u32) -> i32;
    }

    fn wide_null(value: &str) -> Vec<u16> {
        // 这一段转换 UTF-16 空结尾字符串给 Win32 API。
        // Convert a string into null-terminated UTF-16 for Win32 APIs.
        OsStr::new(value).encode_wide().chain([0]).collect()
    }

    // 这一段只显示已脱敏的调用方消息，不读取额外环境或用户数据。
    // Show only the caller-provided sanitized message without reading extra environment or user data.
    let title = wide_null(title);
    let message = wide_null(message);
    unsafe {
        let _ = MessageBoxW(0, message.as_ptr(), title.as_ptr(), MB_OK | MB_ICONERROR);
    }
}

/// 这一段执行同步 COM 激活。
/// Execute synchronous COM activation.
#[cfg(windows)]
fn activate_packaged_app_blocking(app_user_model_id: &str, arguments: &str) -> anyhow::Result<u32> {
    // 这一段使用 Windows crate 官方 COM 绑定，不经由 PowerShell 脚本。
    // Use Windows crate COM bindings instead of a PowerShell helper.
    use windows::Win32::System::Com::{
        CLSCTX_LOCAL_SERVER, COINIT_APARTMENTTHREADED, CoCreateInstance, CoInitializeEx,
        CoUninitialize,
    };
    use windows::Win32::UI::Shell::{ApplicationActivationManager, IApplicationActivationManager};
    use windows::core::HSTRING;

    unsafe {
        let coinit = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let should_uninitialize = coinit.is_ok();
        if let Err(error) = coinit.ok() {
            const RPC_E_CHANGED_MODE: i32 = -2147417850;
            if error.code().0 != RPC_E_CHANGED_MODE {
                return Err(error.into());
            }
        }

        let result: windows::core::Result<u32> = (|| {
            let manager: IApplicationActivationManager =
                CoCreateInstance(&ApplicationActivationManager, None, CLSCTX_LOCAL_SERVER)?;
            manager.ActivateApplication(
                &HSTRING::from(app_user_model_id),
                &HSTRING::from(arguments),
                windows::Win32::UI::Shell::ACTIVATEOPTIONS(0),
            )
        })();

        if should_uninitialize {
            CoUninitialize();
        }
        result.map_err(Into::into)
    }
}

/// 这一段描述已有 Codex 窗口复用结果。
/// Describes the result of reusing an existing Codex window.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct WindowReuseResult {
    /// 这一段表示本次是否已处理已有 Codex。
    /// Whether this run handled an existing Codex instance.
    pub handled: bool,
    /// 这一段表示是否成功请求置前。
    /// Whether a foreground request succeeded.
    pub focused: bool,
    /// 这一段记录复用途径。
    /// Reuse method used for this run.
    pub method: String,
    /// 这一段保存脱敏诊断日志。
    /// Sanitized diagnostic log lines.
    pub diagnostics: Vec<String>,
}

/// 这一段在非 Windows 平台不做外部 Diff 前台激活。
/// Do not foreground external diff windows on non-Windows platforms.
#[cfg(not(windows))]
pub async fn focus_external_diff_window(
    _process_id: u32,
    _tool_path: &str,
) -> anyhow::Result<bool> {
    Ok(false)
}

/// 这一段按进程 id 和工具路径置前外部 Diff 窗口。
/// Foreground an external diff window by process id and tool path.
#[cfg(windows)]
pub async fn focus_external_diff_window(process_id: u32, tool_path: &str) -> anyhow::Result<bool> {
    use std::collections::HashSet;
    use std::path::{Path, PathBuf};
    use tokio::time::{Duration, sleep};

    const FOCUS_RETRY_COUNT: usize = 24;
    const FOCUS_RETRY_DELAY_MS: u64 = 100;

    type Bool = i32;
    type Hwnd = isize;
    type Lparam = isize;

    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    struct WindowRect {
        left: i32,
        top: i32,
        right: i32,
        bottom: i32,
    }

    struct ExternalDiffEnumState<'a> {
        process_ids: &'a HashSet<u32>,
        window: Hwnd,
    }

    fn collect_external_diff_process_ids(process_id: u32, tool_path: &Path) -> HashSet<u32> {
        // 这一段同时保留刚启动 pid 和按 exe 路径找到的单实例进程。
        // Include both the launched pid and single-instance processes matched by exe path.
        let mut process_ids = HashSet::new();
        if process_id > 0 {
            process_ids.insert(process_id);
        }
        for candidate in crate::process::process_ids_for_executable_path(tool_path) {
            process_ids.insert(candidate);
        }
        process_ids
    }

    unsafe extern "system" fn enum_windows_callback(hwnd: Hwnd, lparam: Lparam) -> Bool {
        // 这一段枚举外部工具顶层窗口，不依赖窗口标题或界面文案。
        // Enumerate top-level external tool windows without relying on title text.
        const GET_WINDOW_OWNER: u32 = 4;

        #[link(name = "user32")]
        unsafe extern "system" {
            fn IsWindowVisible(hwnd: Hwnd) -> Bool;
            fn GetWindow(hwnd: Hwnd, command: u32) -> Hwnd;
            fn GetWindowRect(hwnd: Hwnd, rect: *mut WindowRect) -> Bool;
            fn GetWindowThreadProcessId(hwnd: Hwnd, process_id: *mut u32) -> u32;
        }

        let state = unsafe { &mut *(lparam as *mut ExternalDiffEnumState<'_>) };
        let mut window_process_id = 0_u32;
        unsafe { GetWindowThreadProcessId(hwnd, &mut window_process_id) };
        if !state.process_ids.contains(&window_process_id) {
            return 1;
        }
        if unsafe { IsWindowVisible(hwnd) == 0 || GetWindow(hwnd, GET_WINDOW_OWNER) != 0 } {
            return 1;
        }
        let mut rect = WindowRect::default();
        if unsafe { GetWindowRect(hwnd, &mut rect) == 0 }
            || rect.right <= rect.left
            || rect.bottom <= rect.top
        {
            return 1;
        }
        state.window = hwnd;
        0
    }

    fn find_external_diff_window(process_ids: &HashSet<u32>) -> Hwnd {
        // 这一段查找第一个可激活的外部工具顶层窗口。
        // Find the first activatable top-level window owned by the external tool.
        if process_ids.is_empty() {
            return 0;
        }

        #[link(name = "user32")]
        unsafe extern "system" {
            fn EnumWindows(
                callback: Option<unsafe extern "system" fn(Hwnd, Lparam) -> Bool>,
                lparam: Lparam,
            ) -> Bool;
        }

        let mut state = ExternalDiffEnumState {
            process_ids,
            window: 0,
        };
        unsafe {
            EnumWindows(
                Some(enum_windows_callback),
                (&mut state as *mut ExternalDiffEnumState<'_>) as Lparam,
            );
        }
        state.window
    }

    fn focus_external_diff_hwnd(hwnd: Hwnd) -> bool {
        // 这一段先普通置前，失败后短暂附加输入队列再重试。
        // Try normal foregrounding first, then briefly attach input queues and retry.
        const SHOW_WINDOW_RESTORE: i32 = 9;
        const SHOW_WINDOW_SHOW: i32 = 5;

        #[link(name = "user32")]
        unsafe extern "system" {
            fn IsIconic(hwnd: Hwnd) -> Bool;
            fn ShowWindowAsync(hwnd: Hwnd, command: i32) -> Bool;
            fn BringWindowToTop(hwnd: Hwnd) -> Bool;
            fn SetForegroundWindow(hwnd: Hwnd) -> Bool;
            fn GetForegroundWindow() -> Hwnd;
            fn GetWindowThreadProcessId(hwnd: Hwnd, process_id: *mut u32) -> u32;
            fn AttachThreadInput(current: u32, target: u32, attach: Bool) -> Bool;
        }

        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn GetCurrentThreadId() -> u32;
        }

        if hwnd == 0 {
            return false;
        }
        let was_iconic = unsafe { IsIconic(hwnd) != 0 };
        unsafe {
            ShowWindowAsync(
                hwnd,
                if was_iconic {
                    SHOW_WINDOW_RESTORE
                } else {
                    SHOW_WINDOW_SHOW
                },
            );
            BringWindowToTop(hwnd);
            if SetForegroundWindow(hwnd) != 0 {
                return true;
            }
        }

        let current_thread_id = unsafe { GetCurrentThreadId() };
        let mut target_process_id = 0_u32;
        let target_thread_id = unsafe { GetWindowThreadProcessId(hwnd, &mut target_process_id) };
        let mut foreground_process_id = 0_u32;
        let foreground_thread_id =
            unsafe { GetWindowThreadProcessId(GetForegroundWindow(), &mut foreground_process_id) };
        let mut attached_target = false;
        let mut attached_foreground = false;
        if target_thread_id != 0 && target_thread_id != current_thread_id {
            attached_target =
                unsafe { AttachThreadInput(current_thread_id, target_thread_id, 1) != 0 };
        }
        if foreground_thread_id != 0
            && foreground_thread_id != current_thread_id
            && foreground_thread_id != target_thread_id
        {
            attached_foreground =
                unsafe { AttachThreadInput(current_thread_id, foreground_thread_id, 1) != 0 };
        }
        let focused = unsafe {
            BringWindowToTop(hwnd);
            SetForegroundWindow(hwnd) != 0
        };
        if attached_foreground {
            unsafe { AttachThreadInput(current_thread_id, foreground_thread_id, 0) };
        }
        if attached_target {
            unsafe { AttachThreadInput(current_thread_id, target_thread_id, 0) };
        }
        focused
    }

    // 这一段在外部工具创建窗口和单实例转发期间短暂重试。
    // Retry briefly while the external tool creates a window or forwards to an existing instance.
    let tool_path = PathBuf::from(tool_path.trim().trim_matches('"'));
    if process_id == 0 && tool_path.as_os_str().is_empty() {
        return Ok(false);
    }
    for _ in 0..FOCUS_RETRY_COUNT {
        let process_ids = collect_external_diff_process_ids(process_id, &tool_path);
        let hwnd = find_external_diff_window(&process_ids);
        if focus_external_diff_hwnd(hwnd) {
            return Ok(true);
        }
        sleep(Duration::from_millis(FOCUS_RETRY_DELAY_MS)).await;
    }
    Ok(false)
}

/// 这一段在非 Windows 平台不做窗口复用。
/// Do not attempt window reuse on non-Windows platforms.
#[cfg(not(windows))]
pub async fn try_reuse_running_codex(
    _app_user_model_id: &str,
) -> anyhow::Result<WindowReuseResult> {
    Ok(WindowReuseResult::default())
}

/// 这一段复用并置前已运行的 Windows Codex 主窗口。
/// Reuse and foreground an already-running Windows Codex main window.
#[cfg(windows)]
pub async fn try_reuse_running_codex(app_user_model_id: &str) -> anyhow::Result<WindowReuseResult> {
    use std::collections::HashSet;
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::process::CommandExt;
    use std::process::Command;
    use tokio::time::{Duration, sleep};

    const AUXILIARY_WINDOW_MAX_WIDTH: i32 = 520;
    const AUXILIARY_WINDOW_MAX_HEIGHT: i32 = 420;
    const GET_WINDOW_OWNER: u32 = 4;
    const SHOW_WINDOW_RESTORE: i32 = 9;
    const SHOW_WINDOW_SHOW: i32 = 5;
    const TRAY_RESTORE_RETRY_COUNT: usize = 12;
    const SHELL_RESTORE_RETRY_COUNT: usize = 3;
    const RESTORE_RETRY_DELAY_MS: u64 = 150;
    const CREATE_NO_WINDOW: u32 = 0x08000000;

    type Bool = i32;
    type Hwnd = isize;
    type Lparam = isize;

    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    struct WindowRect {
        left: i32,
        top: i32,
        right: i32,
        bottom: i32,
    }

    #[link(name = "user32")]
    unsafe extern "system" {
        fn EnumWindows(
            callback: Option<unsafe extern "system" fn(Hwnd, Lparam) -> Bool>,
            lparam: Lparam,
        ) -> Bool;
        fn IsWindowVisible(hwnd: Hwnd) -> Bool;
        fn IsIconic(hwnd: Hwnd) -> Bool;
        fn GetWindow(hwnd: Hwnd, command: u32) -> Hwnd;
        fn GetWindowRect(hwnd: Hwnd, rect: *mut WindowRect) -> Bool;
        fn GetWindowTextLengthW(hwnd: Hwnd) -> i32;
        fn GetWindowThreadProcessId(hwnd: Hwnd, process_id: *mut u32) -> u32;
        fn ShowWindowAsync(hwnd: Hwnd, command: i32) -> Bool;
        fn BringWindowToTop(hwnd: Hwnd) -> Bool;
        fn SetForegroundWindow(hwnd: Hwnd) -> Bool;
        fn GetForegroundWindow() -> Hwnd;
        fn AttachThreadInput(current: u32, target: u32, attach: Bool) -> Bool;
    }

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetCurrentThreadId() -> u32;
    }

    #[link(name = "shell32")]
    unsafe extern "system" {
        fn ShellExecuteW(
            hwnd: Hwnd,
            operation: *const u16,
            file: *const u16,
            parameters: *const u16,
            directory: *const u16,
            show_command: i32,
        ) -> isize;
    }

    struct EnumState<'a> {
        process_ids: &'a HashSet<u32>,
        matched_window: Hwnd,
        process_window_count: usize,
        visible_window_count: usize,
        owned_window_count: usize,
        untitled_window_count: usize,
        diagnostics: &'a mut Vec<String>,
        phase: &'a str,
    }

    unsafe extern "system" fn enum_windows_callback(hwnd: Hwnd, lparam: Lparam) -> Bool {
        // 这一段把 Win32 枚举回调重新映射到 Rust 状态结构。
        // Map the Win32 enumeration callback back into the Rust state structure.
        let state = unsafe { &mut *(lparam as *mut EnumState<'_>) };
        let mut process_id = 0_u32;
        unsafe { GetWindowThreadProcessId(hwnd, &mut process_id) };
        if process_id == 0 || !state.process_ids.contains(&process_id) {
            return 1;
        }

        // 这一段记录候选窗口信息，只保留句柄、pid、尺寸等脱敏诊断。
        // Record candidate window details with only handles, pids, and sizes as diagnostics.
        state.process_window_count += 1;
        let is_visible = unsafe { IsWindowVisible(hwnd) != 0 };
        let is_iconic = unsafe { IsIconic(hwnd) != 0 };
        let has_owner = unsafe { GetWindow(hwnd, GET_WINDOW_OWNER) != 0 };
        let title_length = unsafe { GetWindowTextLengthW(hwnd) };
        let (has_rect, width, height) = get_window_size(hwnd);
        let small_auxiliary = is_likely_auxiliary_codex_window(is_iconic, has_rect, width, height);
        if is_visible {
            state.visible_window_count += 1;
        }
        if has_owner {
            state.owned_window_count += 1;
        }
        if title_length <= 0 {
            state.untitled_window_count += 1;
        }
        state.diagnostics.push(format!(
            "RustWindowCandidate[{}]: handle={} pid={} visible={} iconic={} owned={} titleLength={} size={}x{} smallAuxiliary={}",
            state.phase,
            format_handle(hwnd),
            process_id,
            is_visible,
            is_iconic,
            has_owner,
            title_length,
            width,
            height,
            small_auxiliary
        ));

        // 这一段只接受可见、无 owner、非小尺寸辅助窗且属于 Codex 进程的顶层窗口。
        // Accept only visible, ownerless, non-auxiliary top-level windows belonging to Codex.
        if !is_candidate_codex_window(hwnd, state.process_ids) {
            return 1;
        }

        state.matched_window = hwnd;
        0
    }

    fn wide_null(value: &str) -> Vec<u16> {
        // 这一段转换 UTF-16 空结尾字符串给 Win32 API。
        // Convert a string into null-terminated UTF-16 for Win32 APIs.
        OsStr::new(value).encode_wide().chain([0]).collect()
    }

    fn parse_tasklist_csv_line(line: &str) -> Option<(String, u32)> {
        // 这一段只解析 tasklist CSV 的镜像名和 PID 两列。
        // Parse only the image-name and PID columns from tasklist CSV.
        let trimmed = line.trim();
        if trimmed.is_empty() || !trimmed.starts_with('"') {
            return None;
        }
        let columns = trimmed
            .trim_matches('"')
            .split("\",\"")
            .map(str::to_string)
            .collect::<Vec<_>>();
        if columns.len() < 2 {
            return None;
        }
        let pid = columns[1].parse::<u32>().ok()?;
        Some((columns[0].clone(), pid))
    }

    fn find_codex_process_ids(diagnostics: &mut Vec<String>, phase: &str) -> HashSet<u32> {
        // 这一段通过系统进程表查找 Codex.exe，避免按窗口标题或界面文案判断。
        // Query the process table for Codex.exe instead of relying on window titles or UI text.
        let mut command = Command::new("tasklist.exe");
        command.args(["/FI", "IMAGENAME eq Codex.exe", "/FO", "CSV", "/NH"]);
        command.creation_flags(CREATE_NO_WINDOW);
        let mut process_ids = HashSet::new();
        match command.output() {
            Ok(output) => {
                let stdout = String::from_utf8_lossy(&output.stdout);
                for line in stdout.lines() {
                    if let Some((image_name, pid)) = parse_tasklist_csv_line(line)
                        && image_name.eq_ignore_ascii_case("Codex.exe")
                    {
                        process_ids.insert(pid);
                    }
                }
                diagnostics.push(format!(
                    "RustCodexProcesses[{phase}]: count={} status={}",
                    process_ids.len(),
                    output.status.code().unwrap_or_default()
                ));
            }
            Err(error) => diagnostics.push(format!(
                "RustCodexProcesses[{phase}]: tasklistFailed={}",
                error
            )),
        }
        process_ids
    }

    fn get_window_size(hwnd: Hwnd) -> (bool, i32, i32) {
        // 这一段读取窗口尺寸，只用于区分主窗口和宠物悬浮窗。
        // Read window size only to distinguish the main window from the avatar overlay.
        let mut rect = WindowRect::default();
        let ok = unsafe { GetWindowRect(hwnd, &mut rect) != 0 };
        if !ok {
            return (false, 0, 0);
        }
        (
            true,
            (rect.right - rect.left).max(0),
            (rect.bottom - rect.top).max(0),
        )
    }

    fn is_likely_auxiliary_codex_window(
        is_iconic: bool,
        has_rect: bool,
        width: i32,
        height: i32,
    ) -> bool {
        // 这一段只排除非最小化的小窗口，最小化主窗口仍允许恢复。
        // Exclude only non-minimized small windows; minimized main windows are still restorable.
        !is_iconic
            && has_rect
            && width > 0
            && height > 0
            && width <= AUXILIARY_WINDOW_MAX_WIDTH
            && height <= AUXILIARY_WINDOW_MAX_HEIGHT
    }

    fn is_candidate_codex_window(hwnd: Hwnd, process_ids: &HashSet<u32>) -> bool {
        // 这一段过滤不可见和附属窗口，不要求标题存在。
        // Filter invisible and owned windows without requiring a title.
        if unsafe { IsWindowVisible(hwnd) == 0 || GetWindow(hwnd, GET_WINDOW_OWNER) != 0 } {
            return false;
        }

        // 这一段跳过宠物悬浮窗这类小尺寸辅助顶层窗。
        // Skip small auxiliary top-level windows such as the avatar overlay.
        let is_iconic = unsafe { IsIconic(hwnd) != 0 };
        let (has_rect, width, height) = get_window_size(hwnd);
        if is_likely_auxiliary_codex_window(is_iconic, has_rect, width, height) {
            return false;
        }

        // 这一段确认窗口归属于 Codex 进程。
        // Confirm the window belongs to a Codex process.
        let mut process_id = 0_u32;
        unsafe { GetWindowThreadProcessId(hwnd, &mut process_id) };
        process_id > 0 && process_ids.contains(&process_id)
    }

    fn find_codex_window(
        process_ids: &HashSet<u32>,
        diagnostics: &mut Vec<String>,
        phase: &str,
    ) -> Hwnd {
        // 这一段枚举顶层窗口，找到第一个可激活 Codex 主窗口后停止。
        // Enumerate top-level windows and stop at the first activatable Codex main window.
        let mut state = EnumState {
            process_ids,
            matched_window: 0,
            process_window_count: 0,
            visible_window_count: 0,
            owned_window_count: 0,
            untitled_window_count: 0,
            diagnostics,
            phase,
        };
        unsafe {
            EnumWindows(
                Some(enum_windows_callback),
                (&mut state as *mut EnumState<'_>) as Lparam,
            );
        }
        state.diagnostics.push(format!(
            "RustWindowScan[{phase}]: processIds={} processWindows={} visible={} owned={} untitled={} matched={}",
            process_ids.len(),
            state.process_window_count,
            state.visible_window_count,
            state.owned_window_count,
            state.untitled_window_count,
            format_handle(state.matched_window)
        ));
        state.matched_window
    }

    fn try_shell_activate_packaged_codex(
        app_user_model_id: &str,
        diagnostics: &mut Vec<String>,
    ) -> bool {
        // 这一段通过 AppsFolder Shell 入口恢复窗口，贴近用户双击官方 Codex 快捷方式。
        // Restore through the AppsFolder shell entry to match the official Codex shortcut behavior.
        if app_user_model_id.trim().is_empty() {
            diagnostics.push("RustShellActivation: skipped empty AppUserModelId".to_string());
            return false;
        }
        let target = format!("shell:AppsFolder\\{}", app_user_model_id.trim());
        let operation = wide_null("open");
        let file = wide_null(&target);
        let result = unsafe {
            ShellExecuteW(
                0,
                operation.as_ptr(),
                file.as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                SHOW_WINDOW_SHOW,
            )
        };
        let ok = result > 32;
        diagnostics.push(format!(
            "RustShellActivation: appUserModelId={} ok={} result={}",
            app_user_model_id.trim(),
            ok,
            result
        ));
        ok
    }

    fn focus_window(hwnd: Hwnd, diagnostics: &mut Vec<String>) -> bool {
        // 这一段根据窗口状态显示或还原，避免把最大化窗口变成普通尺寸。
        // Show or restore based on window state so maximized windows are not resized.
        let was_iconic = unsafe { IsIconic(hwnd) != 0 };
        let show_requested = unsafe {
            ShowWindowAsync(
                hwnd,
                if was_iconic {
                    SHOW_WINDOW_RESTORE
                } else {
                    SHOW_WINDOW_SHOW
                },
            ) != 0
        };

        // 这一段先尝试普通置前，用户双击启动器时通常具备前台权限。
        // Try normal foregrounding first; user double-clicks usually grant foreground permission.
        let bring_to_top = unsafe { BringWindowToTop(hwnd) != 0 };
        let foreground = unsafe { SetForegroundWindow(hwnd) != 0 };
        diagnostics.push(format!(
            "RustFocusAttempt: handle={} wasIconic={} showRequested={} bringToTop={} foreground={}",
            format_handle(hwnd),
            was_iconic,
            show_requested,
            bring_to_top,
            foreground
        ));
        if foreground {
            return true;
        }

        // 这一段在普通置前失败时短暂附加输入队列，提高从其它前台窗口切回成功率。
        // Briefly attach input queues when normal foregrounding fails.
        let current_thread_id = unsafe { GetCurrentThreadId() };
        let mut target_process_id = 0_u32;
        let target_thread_id = unsafe { GetWindowThreadProcessId(hwnd, &mut target_process_id) };
        let foreground_thread_id =
            unsafe { GetWindowThreadProcessId(GetForegroundWindow(), &mut target_process_id) };
        let mut attached_target = false;
        let mut attached_foreground = false;
        if target_thread_id != 0 && target_thread_id != current_thread_id {
            attached_target =
                unsafe { AttachThreadInput(current_thread_id, target_thread_id, 1) != 0 };
        }
        if foreground_thread_id != 0
            && foreground_thread_id != current_thread_id
            && foreground_thread_id != target_thread_id
        {
            attached_foreground =
                unsafe { AttachThreadInput(current_thread_id, foreground_thread_id, 1) != 0 };
        }
        let retry_bring_to_top = unsafe { BringWindowToTop(hwnd) != 0 };
        let retry_foreground = unsafe { SetForegroundWindow(hwnd) != 0 };
        diagnostics.push(format!(
            "RustFocusRetry: handle={} attachTarget={} attachForeground={} bringToTop={} foreground={}",
            format_handle(hwnd),
            attached_target,
            attached_foreground,
            retry_bring_to_top,
            retry_foreground
        ));
        if attached_foreground {
            unsafe { AttachThreadInput(current_thread_id, foreground_thread_id, 0) };
        }
        if attached_target {
            unsafe { AttachThreadInput(current_thread_id, target_thread_id, 0) };
        }
        retry_foreground
    }

    async fn wait_for_codex_window(
        process_ids: &mut HashSet<u32>,
        diagnostics: &mut Vec<String>,
        phase: &str,
        retry_count: usize,
        require_restored: bool,
    ) -> Hwnd {
        // 这一段激活后刷新进程集合，因为 Windows 返回的 pid 不一定是最终窗口进程。
        // Refresh process ids after activation because Windows may return a non-window process id.
        for attempt in 1..=retry_count {
            sleep(Duration::from_millis(RESTORE_RETRY_DELAY_MS)).await;
            process_ids.extend(find_codex_process_ids(
                diagnostics,
                &format!("{phase}:{attempt}"),
            ));
            let hwnd = find_codex_window(process_ids, diagnostics, &format!("{phase}:{attempt}"));
            if hwnd != 0 {
                if require_restored && unsafe { IsIconic(hwnd) != 0 } {
                    diagnostics.push(format!(
                        "RustWindowWait[{phase}]: found minimized window on attempt {attempt}, keep waiting"
                    ));
                    continue;
                }
                return hwnd;
            }
        }
        diagnostics.push(format!(
            "RustWindowWait[{phase}]: no {} window after {} attempts",
            if require_restored {
                "restored"
            } else {
                "visible"
            },
            retry_count
        ));
        0
    }

    fn format_handle(hwnd: Hwnd) -> String {
        // 这一段把 Win32 句柄格式化成十六进制，便于对照诊断。
        // Format Win32 handles as hexadecimal for diagnostics.
        format!("0x{hwnd:X}")
    }

    let mut diagnostics = vec!["RustWindowReuse: begin".to_string()];
    let mut process_ids = find_codex_process_ids(&mut diagnostics, "initial");
    if process_ids.is_empty() {
        diagnostics.push("RustReuseDecision: no running Codex process".to_string());
        return Ok(WindowReuseResult {
            handled: false,
            focused: false,
            method: "not-running".to_string(),
            diagnostics,
        });
    }

    let mut hwnd = find_codex_window(&process_ids, &mut diagnostics, "initial");
    if try_shell_activate_packaged_codex(app_user_model_id, &mut diagnostics) {
        hwnd = wait_for_codex_window(
            &mut process_ids,
            &mut diagnostics,
            "shell-activation",
            SHELL_RESTORE_RETRY_COUNT,
            true,
        )
        .await;
        if hwnd != 0 {
            let focused = focus_window(hwnd, &mut diagnostics);
            diagnostics.push(format!(
                "RustReuseDecision: shell activation restored window={} focused={}",
                format_handle(hwnd),
                focused
            ));
            return Ok(WindowReuseResult {
                handled: true,
                focused,
                method: "shell-activation".to_string(),
                diagnostics,
            });
        }

        hwnd = find_codex_window(
            &process_ids,
            &mut diagnostics,
            "shell-activation:fallback-scan",
        );
        if hwnd != 0 {
            let focused = focus_window(hwnd, &mut diagnostics);
            diagnostics.push(format!(
                "RustReuseDecision: shell fallback focused window={} focused={}",
                format_handle(hwnd),
                focused
            ));
            return Ok(WindowReuseResult {
                handled: true,
                focused,
                method: "shell-fallback".to_string(),
                diagnostics,
            });
        }
    }

    if hwnd != 0 {
        let focused = focus_window(hwnd, &mut diagnostics);
        diagnostics.push(format!(
            "RustReuseDecision: manual focus window={} focused={}",
            format_handle(hwnd),
            focused
        ));
        return Ok(WindowReuseResult {
            handled: true,
            focused,
            method: "manual-focus".to_string(),
            diagnostics,
        });
    }

    match activate_packaged_app(app_user_model_id, "").await {
        Ok(pid) => {
            process_ids.insert(pid);
            diagnostics.push(format!(
                "RustPackagedActivation: appUserModelId={} pid={}",
                app_user_model_id.trim(),
                pid
            ));
            hwnd = wait_for_codex_window(
                &mut process_ids,
                &mut diagnostics,
                "packaged-activation",
                TRAY_RESTORE_RETRY_COUNT,
                false,
            )
            .await;
            if hwnd != 0 {
                let focused = focus_window(hwnd, &mut diagnostics);
                diagnostics.push(format!(
                    "RustReuseDecision: packaged activation restored window={} focused={}",
                    format_handle(hwnd),
                    focused
                ));
                return Ok(WindowReuseResult {
                    handled: true,
                    focused,
                    method: "packaged-activation".to_string(),
                    diagnostics,
                });
            }
        }
        Err(error) => diagnostics.push(format!(
            "RustPackagedActivationFailed: appUserModelId={} error={}",
            app_user_model_id.trim(),
            error
        )),
    }

    diagnostics.push("RustReuseDecision: activation failed, continue cold start".to_string());
    Ok(WindowReuseResult {
        handled: false,
        focused: false,
        method: "cold-start".to_string(),
        diagnostics,
    })
}
