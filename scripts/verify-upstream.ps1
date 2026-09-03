$ErrorActionPreference = "Stop"
$u = Join-Path $PSScriptRoot "..\.upstream\tclk"
if (!(Test-Path (Join-Path $u ".git"))) { throw "Missing .upstream/tclk; run bootstrap-upstream.ps1" }
$pm = (Get-Content (Join-Path $u "package.json") -Raw | ConvertFrom-Json).packageManager
if ($pm) { corepack prepare $pm --activate }
Push-Location $u
try {
  pnpm install --frozen-lockfile
  pnpm -r --include-workspace-root build
  pnpm -r --include-workspace-root test
} finally { Pop-Location }
