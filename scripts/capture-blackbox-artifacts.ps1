$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$out = Join-Path $root 'blackbox/artifacts/phase-2.1'
$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$captures = @(
  @{ Name = 'happy-claim-terminal'; Drawer = $false },
  @{ Name = 'wrong-secret-rejection-boundary'; Drawer = $false },
  @{ Name = 'replay-attack-rejection'; Drawer = $false },
  @{ Name = 'mutated-canonical-frame-rejection'; Drawer = $false },
  @{ Name = 'mid-replay-scrub'; Drawer = $false },
  @{ Name = 'chaos-lab'; Drawer = $false },
  @{ Name = 'evidence-capsule-drawer'; Drawer = $true }
)

function Remove-EdgeProfile([string] $Path) {
  for ($attempt = 0; $attempt -lt 10 -and (Test-Path $Path); $attempt++) {
    try { Remove-Item $Path -Recurse -Force -ErrorAction Stop } catch {
      if (Test-Path $Path) { Start-Sleep -Milliseconds 200 }
    }
    if (Test-Path $Path) { Start-Sleep -Milliseconds 200 }
  }
}

if (-not (Test-Path $edge)) {
  throw "Microsoft Edge not found at $edge"
}

Push-Location $root
try {
  node blackbox/artifacts/generate.mjs
  if ($LASTEXITCODE) { exit $LASTEXITCODE }

  foreach ($capture in $captures) {
    $html = Join-Path $out ($capture.Name + '.html')
    $png = Join-Path $out ($capture.Name + '.png')
    $profile = Join-Path ([IO.Path]::GetTempPath()) ('tclk-blackbox-edge-' + $capture.Name + '-' + [Guid]::NewGuid())
    $url = [Uri]::new($html).AbsoluteUri

    & $edge '--headless=new' '--disable-gpu' '--hide-scrollbars' '--no-first-run' `
      "--user-data-dir=$profile" '--run-all-compositor-stages-before-draw' `
      '--virtual-time-budget=1200' '--window-size=1600,1200' "--screenshot=$png" $url | Out-Null
    if ($LASTEXITCODE) { throw "Screenshot failed: $($capture.Name)" }

    $dom = & $edge '--headless=new' '--disable-gpu' '--no-first-run' `
      "--user-data-dir=$profile" '--virtual-time-budget=1200' '--dump-dom' $url
    if ($LASTEXITCODE) { throw "DOM capture failed: $($capture.Name)" }

    foreach ($landmark in @('DEAL FLIGHT PATH', 'STATE BEFORE', 'THREE-LANE FORENSIC TRACE', 'FORENSIC SCRUBBER')) {
      if ($dom -notmatch [Regex]::Escape($landmark)) {
        throw "$($capture.Name): rendered DOM missing $landmark"
      }
    }
    if ($capture.Drawer -and $dom -notmatch 'role="dialog"') {
      throw "$($capture.Name): evidence drawer did not render"
    }

    Remove-EdgeProfile $profile
  }
} finally {
  Get-ChildItem ([IO.Path]::GetTempPath()) -Directory -Filter 'tclk-blackbox-edge-*' -ErrorAction SilentlyContinue |
    ForEach-Object { Remove-EdgeProfile $_.FullName }
  Pop-Location
}

Write-Host "visual artifacts PASS ($($captures.Count) screenshots): $out"