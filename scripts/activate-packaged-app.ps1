param(
  # 这一段接收 MSIX 应用标识，Windows 通过它激活已安装应用。
  # Receive the MSIX app id used by Windows to activate the installed app.
  [Parameter(Mandatory = $true)]
  [string]$AppUserModelId,

  # 这一段接收要传给 Codex 的 Chromium 参数，例如远程调试端口。
  # Receive Chromium arguments passed through to Codex, such as the remote debugging port.
  [string]$Arguments = ""
)

# 这一段让脚本遇到错误立即失败，避免启动器误判为成功。
# Stop immediately on errors so the launcher does not report false success.
$ErrorActionPreference = "Stop"

# 这一段只在当前 PowerShell 会话没有加载类型时编译 C# 激活桥接代码。
# Compile the C# activation bridge only when the type is not already loaded.
$typeName = "CodexPro.ApplicationActivationManager"
if (-not ($typeName -as [type])) {
  Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

namespace CodexPro
{
    [Flags]
    public enum ActivateOptions
    {
        None = 0,
        DesignMode = 1,
        NoErrorUI = 2,
        NoSplashScreen = 4
    }

    [ComImport]
    [Guid("2e941141-7f97-4756-ba1d-9decde894a3d")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IApplicationActivationManager
    {
        int ActivateApplication(
            [MarshalAs(UnmanagedType.LPWStr)] string appUserModelId,
            [MarshalAs(UnmanagedType.LPWStr)] string arguments,
            ActivateOptions options,
            out uint processId);
    }

    [ComImport]
    [Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C")]
    public class ApplicationActivationManager
    {
    }

    public static class PackagedAppActivator
    {
        public static uint Activate(string appUserModelId, string arguments)
        {
            var manager = (IApplicationActivationManager)new ApplicationActivationManager();
            uint processId;
            int hr = manager.ActivateApplication(appUserModelId, arguments, ActivateOptions.None, out processId);
            Marshal.ThrowExceptionForHR(hr);
            return processId;
        }
    }
}
"@
}

# 这一段调用 Windows ApplicationActivationManager，并把进程 id 输出给启动器。
# Call Windows ApplicationActivationManager and write the process id back to the launcher.
[CodexPro.PackagedAppActivator]::Activate($AppUserModelId, $Arguments)
