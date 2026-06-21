[CmdletBinding()]
param(
    [ValidateSet("PreCommit", "PrePush", "ScanPaths")]
    [string]$Mode = "PreCommit",

    [string]$PrePushInputPath,

    [string]$RemoteName,

    [string]$RemoteUrl,

    [string[]]$Paths = @()
)

$ErrorActionPreference = "Stop"
$ZeroObjectId = "0000000000000000000000000000000000000000"

# Normalize repository-relative paths across Windows and Git Bash separators.
function Normalize-RepoPath {
    param([string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path)) {
        return ""
    }

    $normalized = $Path.Trim() -replace "\\", "/"
    while ($normalized.StartsWith("./", [System.StringComparison]::Ordinal)) {
        $normalized = $normalized.Substring(2)
    }
    return $normalized.Trim("/")
}

# Decide whether a path crosses the public repository boundary.
function Get-PublicBoundaryViolation {
    param([string]$Path)

    $normalized = Normalize-RepoPath $Path
    if ($normalized -eq "") {
        return $null
    }

    $lower = $normalized.ToLowerInvariant()
    $fileName = ($lower -split "/")[-1]
    $extension = [System.IO.Path]::GetExtension($fileName)

    if ($lower -eq "private" -or $lower.StartsWith("private/", [System.StringComparison]::Ordinal)) {
        return "private directory is local-only"
    }

    if ($lower -eq "modules.md") {
        return "root MODULES.md is reserved for the private module index"
    }

    if ($fileName -eq ".env" -or $fileName.StartsWith(".env.", [System.StringComparison]::Ordinal)) {
        return "environment file"
    }

    if ($lower.EndsWith(".local.json", [System.StringComparison]::Ordinal) -or
        $lower.EndsWith(".private.json", [System.StringComparison]::Ordinal) -or
        $lower.EndsWith(".secret.json", [System.StringComparison]::Ordinal)) {
        return "local/private/secret JSON file"
    }

    $blockedExtensions = @(
        ".pem", ".key", ".p12", ".pfx", ".crt", ".cer", ".der",
        ".xlsx", ".xls", ".xlsm",
        ".zip", ".7z", ".rar",
        ".exe", ".msi", ".msix"
    )

    if ($blockedExtensions -contains $extension) {
        return "blocked extension $extension"
    }

    return $null
}

# Run Git and return non-empty lines for staged and push-range checks.
function Invoke-GitLines {
    param([string[]]$Arguments)

    $output = & git -c core.quotepath=false @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "git $($Arguments -join ' ') failed with exit code $LASTEXITCODE"
    }

    return @($output | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
}

# Print violating paths and stop the current Git operation.
function Assert-NoForbiddenPaths {
    param(
        [string[]]$CandidatePaths,
        [string]$Context
    )

    $violations = New-Object System.Collections.Generic.List[object]
    foreach ($path in ($CandidatePaths | ForEach-Object { Normalize-RepoPath $_ } | Where-Object { $_ } | Sort-Object -Unique)) {
        $reason = Get-PublicBoundaryViolation $path
        if ($null -ne $reason) {
            $violations.Add([pscustomobject]@{
                Path = $path
                Reason = $reason
            }) | Out-Null
        }
    }

    if ($violations.Count -eq 0) {
        Write-Host "Public boundary check passed: $Context"
        return
    }

    Write-Host ""
    Write-Host "Public boundary check failed: $Context" -ForegroundColor Red
    Write-Host "These paths are blocked from the public main repository:" -ForegroundColor Red
    foreach ($violation in $violations) {
        Write-Host ("- {0} ({1})" -f $violation.Path, $violation.Reason) -ForegroundColor Red
    }
    Write-Host ""
    Write-Host "Move them to an external private directory, or keep them under ignored private/ without committing them." -ForegroundColor Yellow
    exit 1
}

# Read pre-push ref updates and collect paths that are about to be pushed.
function Get-PrePushCandidatePaths {
    param([string]$InputPath)

    if ([string]::IsNullOrWhiteSpace($InputPath) -or -not (Test-Path -LiteralPath $InputPath -PathType Leaf)) {
        return @()
    }

    $candidatePaths = New-Object System.Collections.Generic.List[string]
    $lines = Get-Content -LiteralPath $InputPath
    foreach ($line in $lines) {
        if ([string]::IsNullOrWhiteSpace($line)) {
            continue
        }

        $parts = $line -split "\s+"
        if ($parts.Count -lt 4) {
            continue
        }

        $localRef = $parts[0]
        $localObject = $parts[1]
        $remoteObject = $parts[3]

        if ($localRef -eq "(delete)" -or $localObject -eq $ZeroObjectId) {
            continue
        }

        if ($remoteObject -eq $ZeroObjectId) {
            foreach ($path in (Invoke-GitLines @("ls-tree", "-r", "--name-only", $localObject))) {
                $candidatePaths.Add($path) | Out-Null
            }

            if (-not [string]::IsNullOrWhiteSpace($RemoteName)) {
                foreach ($path in (Invoke-GitLines @("log", "--format=", "--name-only", $localObject, "--not", "--remotes=$RemoteName"))) {
                    $candidatePaths.Add($path) | Out-Null
                }
            }
            continue
        }

        foreach ($path in (Invoke-GitLines @("log", "--format=", "--name-only", "$remoteObject..$localObject"))) {
            $candidatePaths.Add($path) | Out-Null
        }
    }

    return @($candidatePaths)
}

switch ($Mode) {
    "PreCommit" {
        $stagedPaths = Invoke-GitLines @("diff", "--cached", "--name-only", "--diff-filter=ACMRTUXB")
        Assert-NoForbiddenPaths -CandidatePaths $stagedPaths -Context "staged files"
    }
    "PrePush" {
        $pushPaths = Get-PrePushCandidatePaths -InputPath $PrePushInputPath
        Assert-NoForbiddenPaths -CandidatePaths $pushPaths -Context "push to $RemoteName $RemoteUrl"
    }
    "ScanPaths" {
        Assert-NoForbiddenPaths -CandidatePaths $Paths -Context "explicit path scan"
    }
}
