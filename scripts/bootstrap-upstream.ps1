param([string]$UpstreamUrl = "https://github.com/flop-labs/tclk")
$ErrorActionPreference = "Stop"
New-Item -ItemType Directory -Force .upstream | Out-Null
if (Test-Path .upstream/tclk/.git) { git -C .upstream/tclk fetch --prune origin; git -C .upstream/tclk checkout --detach origin/main } else { git clone $UpstreamUrl .upstream/tclk }
Write-Host "Pinned workspace refreshed; inspect evidence/upstream-baseline.json after verification."
