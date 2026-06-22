param(
  [switch]$SkipTests,
  [switch]$Desktop
)

$ErrorActionPreference = "Stop"

# Keep this executable script ASCII-only. Windows PowerShell 5.1 can parse
# UTF-8-without-BOM files as the legacy ANSI code page before the script runs.
$utf8NoBomEncoding = New-Object System.Text.UTF8Encoding -ArgumentList $false
[Console]::OutputEncoding = $utf8NoBomEncoding
$OutputEncoding = $utf8NoBomEncoding

# Locate the repository root and private log directory.
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Resolve-Path (Join-Path $scriptDir "..")
$logDir = Join-Path $repoRoot "private\build\logs"
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss-fff"
$logPath = Join-Path $logDir "release-build-$timestamp-$PID.log"

# Print a consistent section header for screenshots and log searches.
function Write-Section {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Title
  )

  Write-Host ""
  Write-Host "========== $Title =========="
}

# Print tool version information without stopping the real build on probe errors.
function Write-ToolVersion {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Name,

    [Parameter(Mandatory = $true)]
    [string]$Command,

    [Parameter(Mandatory = $true)]
    [string[]]$Arguments
  )

  try {
    $output = & $Command @Arguments 2>&1
    if ($LASTEXITCODE -eq 0) {
      Write-Host "${Name}: $output"
      return
    }

    Write-Host "${Name}: failed with exit code $LASTEXITCODE"
    Write-Host $output
  } catch {
    Write-Host "${Name}: missing or not runnable"
    Write-Host $_.Exception.Message
  }
}

# Run a required command and fail with a clear message if it returns non-zero.
function Invoke-RequiredCommand {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Step,

    [Parameter(Mandatory = $true)]
    [string]$Command,

    [string[]]$Arguments = @()
  )

  Write-Section $Step

  # Merge stdout and stderr before printing to keep external tool output ordered.
  $previousErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    & $Command @Arguments 2>&1 | ForEach-Object {
      Write-Host $_
    }
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
  $exitCode = $LASTEXITCODE
  if ($exitCode -ne 0) {
    throw "$Step failed with exit code $exitCode"
  }
}

# Compute SHA256 through .NET so old powershell.exe builds do not need Get-FileHash.
function Get-FileSha256 {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path
  )

  # Use a read-only stream so the executable is not fully loaded into memory.
  $stream = [System.IO.File]::OpenRead($Path)
  try {
    # Convert the SHA256 bytes to uppercase hex for checksum comparison.
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
      $hashBytes = $sha256.ComputeHash($stream)
      return (($hashBytes | ForEach-Object { $_.ToString("X2") }) -join "")
    } finally {
      $sha256.Dispose()
    }
  } finally {
    $stream.Dispose()
  }
}

# Print release artifact metadata for screenshots and issue reports.
function Write-ArtifactInfo {
  param(
    [Parameter(Mandatory = $true)]
    [string]$ArtifactPath,

    [string]$Title = "Build Artifact"
  )

  Write-Section $Title
  if (-not (Test-Path -LiteralPath $ArtifactPath)) {
    throw "build artifact does not exist: $ArtifactPath"
  }

  $artifact = Get-Item -LiteralPath $ArtifactPath
  $sha256 = Get-FileSha256 -Path $artifact.FullName
  $versionInfo = $artifact.VersionInfo
  $sizeMb = [Math]::Round($artifact.Length / 1MB, 2)

  Write-Host "Path: $($artifact.FullName)"
  Write-Host "Size: $sizeMb MB ($($artifact.Length) bytes)"
  Write-Host "LastWriteTime: $($artifact.LastWriteTime.ToString("yyyy-MM-dd HH:mm:ss"))"
  Write-Host "SHA256: $sha256"
  Write-Host "FileVersion: $($versionInfo.FileVersion)"
  Write-Host "ProductVersion: $($versionInfo.ProductVersion)"
  Write-Host "ProductName: $($versionInfo.ProductName)"
  Write-Host "FileDescription: $($versionInfo.FileDescription)"
}

New-Item -ItemType Directory -Force -Path $logDir | Out-Null
Set-Location $repoRoot

$transcriptStarted = $false
try {
  # Start a transcript so the visible window and diagnostic log stay aligned.
  Start-Transcript -Path $logPath -Force | Out-Null
  $transcriptStarted = $true

  Write-Section "Build Context"
  Write-Host "Time: $(Get-Date -Format "yyyy-MM-dd HH:mm:ss zzz")"
  Write-Host "Repository: $repoRoot"
  Write-Host "Log: $logPath"
  Write-Host "SkipTests: $SkipTests"
  Write-Host "Desktop: $Desktop"

  Write-Section "Tool Versions"
  Write-ToolVersion -Name "node" -Command "node" -Arguments @("--version")
  Write-ToolVersion -Name "npm" -Command "npm" -Arguments @("--version")
  Write-ToolVersion -Name "cargo" -Command "cargo" -Arguments @("--version")
  Write-ToolVersion -Name "rustc" -Command "rustc" -Arguments @("--version")
  Write-ToolVersion -Name "git" -Command "git" -Arguments @("--version")

  Write-Section "Git Status"
  git status --short --branch
  if ($LASTEXITCODE -ne 0) {
    Write-Host "Failed to read Git status, continuing build attempt."
  }

  # Call the official single-exe build script so release logic has one owner.
  $buildArguments = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $repoRoot "scripts\build-rust-single-exe.ps1"))
  if ($SkipTests) {
    $buildArguments += "-SkipTests"
  }
  if ($Desktop) {
    $buildArguments += "-Desktop"
  }
  Invoke-RequiredCommand -Step "Release Build" -Command "powershell.exe" -Arguments $buildArguments

  # Smoke-test the release artifact with dry-run before reporting success.
  $artifactPath = Join-Path $repoRoot "private\build\rust\Codex-Pro-Launcher.exe"
  Invoke-RequiredCommand -Step "Artifact Smoke Test" -Command $artifactPath -Arguments @("--dry-run")
  Write-ArtifactInfo -ArtifactPath $artifactPath -Title "Build Artifact"

  # Read the version from the built executable so the printed release asset matches the actual binary metadata.
  $artifactVersionInfo = (Get-Item -LiteralPath $artifactPath).VersionInfo
  $artifactVersion = $artifactVersionInfo.ProductVersion
  if ($artifactVersion -notmatch '^[0-9]+\.[0-9]+\.[0-9]+$') {
    throw "build artifact has invalid ProductVersion: $artifactVersion"
  }
  $releaseZipAssetPath = Join-Path (Split-Path -Parent $artifactPath) "Codex-Pro-Launcher-v$artifactVersion-windows.zip"
  Write-ArtifactInfo -ArtifactPath $releaseZipAssetPath -Title "Primary ZIP Asset"
  $releaseIndexAssetPath = Join-Path (Split-Path -Parent $artifactPath) "latest.json"
  Write-ArtifactInfo -ArtifactPath $releaseIndexAssetPath -Title "Release Index Asset"

  Write-Section "Build Complete"
  Write-Host "Release executable, ZIP asset, and latest.json index have been generated."
  Write-Host "Log: $logPath"
  exit 0
} catch {
  Write-Section "Build Failed"
  Write-Host $_.Exception.Message
  Write-Host "Log: $logPath"
  exit 1
} finally {
  if ($transcriptStarted) {
    # Stop the transcript without hiding the real build result.
    try {
      Stop-Transcript | Out-Null
    } catch {
      Write-Host "failed to stop transcript: $($_.Exception.Message)"
    }
  }
}
