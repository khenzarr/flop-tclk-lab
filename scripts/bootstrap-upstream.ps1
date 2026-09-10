param([string]$UpstreamUrl = "https://github.com/flop-labs/tclk")
$ErrorActionPreference = "Stop"
$RepositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$UpstreamRoot = Join-Path $RepositoryRoot ".upstream/tclk"
$BaselinePath = Join-Path $RepositoryRoot "evidence/upstream-baseline.json"
$PinnedCommit = (Get-Content $BaselinePath -Raw | ConvertFrom-Json).commit
if ($PinnedCommit -notmatch '^[0-9a-f]{40}$') { throw "Invalid pinned upstream commit in evidence/upstream-baseline.json" }

New-Item -ItemType Directory -Force (Split-Path $UpstreamRoot) | Out-Null
if (Test-Path (Join-Path $UpstreamRoot ".git")) {
  git -C $UpstreamRoot fetch --prune origin
  if ($LASTEXITCODE -ne 0) { throw "Failed to fetch pinned TCLK upstream" }
} else {
  git clone $UpstreamUrl $UpstreamRoot
  if ($LASTEXITCODE -ne 0) { throw "Failed to clone pinned TCLK upstream" }
}

git -C $UpstreamRoot checkout --detach $PinnedCommit
if ($LASTEXITCODE -ne 0) { throw "Failed to check out pinned TCLK commit $PinnedCommit" }
$ActualCommit = (git -C $UpstreamRoot rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $ActualCommit -ne $PinnedCommit) { throw "Pinned TCLK checkout mismatch" }

& (Join-Path $PSScriptRoot "verify-upstream.ps1")
if ($LASTEXITCODE -ne 0) { throw "Pinned TCLK verification failed" }
Write-Host "Pinned TCLK workspace verified at $PinnedCommit."
