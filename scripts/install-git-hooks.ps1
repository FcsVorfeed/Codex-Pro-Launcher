[CmdletBinding()]
param(
    [switch]$SkipCoreHooksPath,
    [switch]$SkipLegacyGitHooksCopy
)

$ErrorActionPreference = "Stop"

# Locate the repository root so running from subdirectories is safe.
$repoRoot = (& git rev-parse --show-toplevel).Trim()
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($repoRoot)) {
    throw "This script must be run inside a Git repository."
}

$hookSourceDir = Join-Path $repoRoot ".githooks"
$requiredHooks = @("pre-commit", "pre-push")
foreach ($hook in $requiredHooks) {
    $sourcePath = Join-Path $hookSourceDir $hook
    if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
        throw "Missing versioned hook: $sourcePath"
    }
}

# Enable the versioned hook path; each fresh clone only needs this once.
if (-not $SkipCoreHooksPath) {
    & git config core.hooksPath .githooks
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to configure core.hooksPath."
    }
}

# Copy hooks into .git/hooks as a local redundant layer if core.hooksPath is removed.
if (-not $SkipLegacyGitHooksCopy) {
    $gitDir = (& git rev-parse --git-dir).Trim()
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($gitDir)) {
        throw "Failed to locate .git directory."
    }

    if (-not [System.IO.Path]::IsPathRooted($gitDir)) {
        $gitDir = Join-Path $repoRoot $gitDir
    }

    $legacyHookDir = Join-Path $gitDir "hooks"
    New-Item -ItemType Directory -Force -Path $legacyHookDir | Out-Null

    foreach ($hook in $requiredHooks) {
        Copy-Item -LiteralPath (Join-Path $hookSourceDir $hook) -Destination (Join-Path $legacyHookDir $hook) -Force
    }
}

# Set executable bits when chmod exists, for Linux/macOS compatibility.
$chmod = Get-Command chmod -ErrorAction SilentlyContinue
if ($null -ne $chmod) {
    foreach ($hook in $requiredHooks) {
        & chmod +x (Join-Path $hookSourceDir $hook)
        if (-not $SkipLegacyGitHooksCopy) {
            $gitDir = (& git rev-parse --git-dir).Trim()
            if (-not [System.IO.Path]::IsPathRooted($gitDir)) {
                $gitDir = Join-Path $repoRoot $gitDir
            }
            & chmod +x (Join-Path $gitDir "hooks" $hook)
        }
    }
}

Write-Host "Git public-boundary hooks installed."
Write-Host "core.hooksPath: $(git config --get core.hooksPath)"
