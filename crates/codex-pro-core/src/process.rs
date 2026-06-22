#[cfg(windows)]
use std::ffi::OsString;
#[cfg(windows)]
use std::os::windows::ffi::OsStringExt;
use std::path::{Path, PathBuf};

#[cfg(windows)]
use windows::Win32::Foundation::{CloseHandle, HANDLE};
#[cfg(windows)]
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW, TH32CS_SNAPPROCESS,
};
#[cfg(windows)]
use windows::Win32::System::Threading::{
    OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_TERMINATE, QueryFullProcessImageNameW,
    TerminateProcess,
};
#[cfg(windows)]
use windows::core::PWSTR;

/// 这一段定义 Windows 无窗口进程创建标记。
/// Windows process creation flag for hidden subprocesses.
#[cfg(windows)]
pub const CREATE_NO_WINDOW: u32 = 0x08000000;

/// 这一段在非 Windows 平台提供占位常量。
/// Placeholder flag on non-Windows platforms.
#[cfg(not(windows))]
pub const CREATE_NO_WINDOW: u32 = 0;

/// 这一段判断进程是否仍然存活。
/// Return whether a process is still alive.
pub fn is_process_alive(pid: u32) -> bool {
    // 这一段使用平台命令做轻量探测，失败即按不存在处理。
    // Use lightweight platform commands and treat failures as not alive.
    if pid == 0 || pid == std::process::id() {
        return false;
    }
    #[cfg(windows)]
    {
        std::process::Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/NH"])
            .output()
            .ok()
            .map(|output| String::from_utf8_lossy(&output.stdout).contains(&pid.to_string()))
            .unwrap_or(false)
    }
    #[cfg(not(windows))]
    {
        std::process::Command::new("kill")
            .args(["-0", &pid.to_string()])
            .status()
            .ok()
            .is_some_and(|status| status.success())
    }
}

/// 这一段读取指定进程的可执行文件路径。
/// Read the executable path for a process id.
pub fn process_executable_path(pid: u32) -> Option<PathBuf> {
    // 这一段按平台分发，非 Windows 暂无 launcher fallback 需要。
    // Dispatch per platform; non-Windows does not need the launcher fallback yet.
    #[cfg(windows)]
    {
        windows_process_executable_path(pid)
    }
    #[cfg(not(windows))]
    {
        let _ = pid;
        None
    }
}

/// 这一段查找指定可执行文件路径对应的运行中进程。
/// Find running processes for a specific executable path.
pub fn process_ids_for_executable_path(path: &Path) -> Vec<u32> {
    // 这一段只按真实进程镜像路径匹配，避免用窗口标题或界面文案猜测。
    // Match only by real process image path instead of window titles or UI text.
    #[cfg(windows)]
    {
        windows_process_ids_for_executable_path(path)
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        Vec::new()
    }
}

/// 这一段判断系统进程表是否确认官方 Codex.exe 已全部退出。
/// Return whether process enumeration confirms that all official Codex.exe processes are gone.
pub fn codex_processes_are_absent() -> bool {
    // 这一段枚举失败时按 Codex 仍可能存在处理，避免因为权限或系统瞬时错误提前关闭 worker。
    // Treat enumeration failures as possibly still running so permission or transient errors do not stop the worker early.
    #[cfg(windows)]
    {
        windows_count_codex_processes().is_some_and(|count| count == 0)
    }
    #[cfg(not(windows))]
    {
        false
    }
}

/// 这一段查找当前正在运行的官方 Codex.exe 路径。
/// Find the executable path of a currently running official Codex.exe.
pub fn find_running_codex_executable() -> Option<PathBuf> {
    // 这一段只在 Windows 需要从 MSIX 进程反推出真实 exe 路径。
    // Only Windows needs to infer the real exe path from an MSIX process.
    #[cfg(windows)]
    {
        windows_find_running_codex_executable()
    }
    #[cfg(not(windows))]
    {
        None
    }
}

/// 这一段终止指定进程，调用方必须确保这是自己刚启动且可安全回收的进程。
/// Terminate a process; callers must ensure it is a process they just started and can safely reclaim.
pub fn terminate_process(pid: u32) -> bool {
    // 这一段只用于 Windows packaged activation 未打开 CDP 时的受控回收。
    // Used only for controlled cleanup after Windows packaged activation fails to expose CDP.
    if pid == 0 || pid == std::process::id() {
        return false;
    }
    #[cfg(windows)]
    {
        windows_terminate_process(pid)
    }
    #[cfg(not(windows))]
    {
        let _ = pid;
        false
    }
}

/// 这一段判断路径是否属于官方 Codex WindowsApps 安装。
/// Return whether a path belongs to the official Codex WindowsApps package.
pub fn is_windowsapps_codex_executable(path: &std::path::Path) -> bool {
    // 这一段只做路径结构判断，不读取用户数据。
    // Check only path structure and do not read user data.
    let text = path
        .to_string_lossy()
        .replace('/', "\\")
        .to_ascii_lowercase();
    text.contains("\\windowsapps\\openai.codex") && text.ends_with("\\app\\codex.exe")
}

/// 这一段判断进程镜像名是否是官方 Codex 进程名。
/// Return whether a process image name is the official Codex process name.
fn is_codex_process_image_name(exe_file: &str) -> bool {
    // 这一段只匹配完整镜像名，避免误把 Codex-Pro-Launcher 等工具进程算作官方 Codex。
    // Match only the full image name so tools such as Codex-Pro-Launcher are not counted as official Codex.
    exe_file.eq_ignore_ascii_case("Codex.exe")
}

#[cfg(windows)]
struct HandleGuard(HANDLE);

#[cfg(windows)]
impl Drop for HandleGuard {
    fn drop(&mut self) {
        // 这一段关闭 Win32 handle，避免 launcher 多次探测时泄漏句柄。
        // Close the Win32 handle so repeated launcher probes do not leak handles.
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

#[cfg(windows)]
fn windows_count_codex_processes() -> Option<usize> {
    // 这一段只按进程镜像名枚举，不读取窗口标题或界面文案，适配多语言界面。
    // Enumerate by process image name only, not by window title or UI text, so localized UI does not matter.
    let Ok(snapshot) = (unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }) else {
        return None;
    };
    if snapshot.is_invalid() {
        return None;
    }
    let _guard = HandleGuard(snapshot);
    let mut entry = PROCESSENTRY32W {
        dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
        ..Default::default()
    };
    if unsafe { Process32FirstW(snapshot, &mut entry) }.is_err() {
        return None;
    }
    let mut count = 0_usize;
    loop {
        let exe_file = nul_terminated_wide_to_string(&entry.szExeFile);
        if is_codex_process_image_name(&exe_file) {
            count += 1;
        }
        if unsafe { Process32NextW(snapshot, &mut entry) }.is_err() {
            break;
        }
    }
    Some(count)
}

#[cfg(windows)]
fn windows_process_executable_path(pid: u32) -> Option<PathBuf> {
    // 这一段使用受限查询权限读取进程镜像路径。
    // Use limited query permission to read the process image path.
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()? };
    if handle.is_invalid() {
        return None;
    }
    let _guard = HandleGuard(handle);
    let mut buffer = vec![0u16; 32768];
    let mut len = buffer.len() as u32;
    unsafe {
        QueryFullProcessImageNameW(
            handle,
            Default::default(),
            PWSTR(buffer.as_mut_ptr()),
            &mut len,
        )
        .ok()?;
    }
    Some(PathBuf::from(OsString::from_wide(&buffer[..len as usize])))
}

#[cfg(windows)]
fn windows_process_ids_for_executable_path(path: &Path) -> Vec<u32> {
    // 这一段枚举进程并逐个读取镜像路径，支持单实例 Diff 工具把新请求转发给已有进程。
    // Enumerate processes and compare image paths so single-instance diff tools can be found.
    let target = normalize_process_path(path);
    if target.is_empty() {
        return Vec::new();
    }
    let Ok(snapshot) = (unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }) else {
        return Vec::new();
    };
    if snapshot.is_invalid() {
        return Vec::new();
    }
    let _guard = HandleGuard(snapshot);
    let mut entry = PROCESSENTRY32W {
        dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
        ..Default::default()
    };
    if unsafe { Process32FirstW(snapshot, &mut entry) }.is_err() {
        return Vec::new();
    }
    let mut process_ids = Vec::new();
    loop {
        if let Some(process_path) = windows_process_executable_path(entry.th32ProcessID)
            && normalize_process_path(&process_path) == target
        {
            process_ids.push(entry.th32ProcessID);
        }
        if unsafe { Process32NextW(snapshot, &mut entry) }.is_err() {
            break;
        }
    }
    process_ids
}

#[cfg(windows)]
fn windows_find_running_codex_executable() -> Option<PathBuf> {
    // 这一段枚举进程而不是依赖窗口标题，避免多语言界面和隐藏窗口影响判断。
    // Enumerate processes instead of relying on window titles so locale and hidden windows do not matter.
    let Ok(snapshot) = (unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }) else {
        return None;
    };
    if snapshot.is_invalid() {
        return None;
    }
    let _guard = HandleGuard(snapshot);
    let mut entry = PROCESSENTRY32W {
        dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
        ..Default::default()
    };
    if unsafe { Process32FirstW(snapshot, &mut entry) }.is_err() {
        return None;
    }
    loop {
        let exe_file = nul_terminated_wide_to_string(&entry.szExeFile);
        if is_codex_process_image_name(&exe_file)
            && let Some(path) = windows_process_executable_path(entry.th32ProcessID)
            && is_windowsapps_codex_executable(&path)
        {
            return Some(path);
        }
        if unsafe { Process32NextW(snapshot, &mut entry) }.is_err() {
            break;
        }
    }
    None
}

#[cfg(windows)]
fn normalize_process_path(path: &Path) -> String {
    // 这一段只做大小写和分隔符规整，不访问文件系统，避免权限或不存在路径导致误判。
    // Normalize case and separators without touching the filesystem.
    path.to_string_lossy()
        .replace('/', "\\")
        .trim_matches('"')
        .to_ascii_lowercase()
}

#[cfg(windows)]
fn windows_terminate_process(pid: u32) -> bool {
    // 这一段只请求终止权限，避免扩大进程访问范围。
    // Request only terminate permission to avoid broad process access.
    let Ok(handle) = (unsafe { OpenProcess(PROCESS_TERMINATE, false, pid) }) else {
        return false;
    };
    if handle.is_invalid() {
        return false;
    }
    let _guard = HandleGuard(handle);
    unsafe { TerminateProcess(handle, 0) }.is_ok()
}

#[cfg(windows)]
fn nul_terminated_wide_to_string(value: &[u16]) -> String {
    // 这一段按 Win32 固定宽字符数组的首个 NUL 截断。
    // Truncate a fixed Win32 wide string at the first NUL.
    let len = value.iter().position(|ch| *ch == 0).unwrap_or(value.len());
    OsString::from_wide(&value[..len])
        .to_string_lossy()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codex_process_image_name_matches_only_official_exe() {
        // 这一段确认只匹配官方 Codex 进程名，不把启动器或命令 runner 算进去。
        // Confirm only the official Codex process name matches, not the launcher or command runner.
        assert!(is_codex_process_image_name("Codex.exe"));
        assert!(is_codex_process_image_name("codex.exe"));
        assert!(!is_codex_process_image_name("Codex-Pro-Launcher.exe"));
        assert!(!is_codex_process_image_name(
            "codex-command-runner-0.142.0-alpha.6.exe"
        ));
    }
}
