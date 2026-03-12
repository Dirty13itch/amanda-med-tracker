$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$indexPath = Join-Path $root 'index.html'
$manifestPath = Join-Path $root 'manifest.json'
$swPath = Join-Path $root 'sw.js'

foreach ($path in @($indexPath, $manifestPath, $swPath)) {
    if (-not (Test-Path $path)) {
        throw "Missing required file: $path"
    }
}

$index = Get-Content -Raw $indexPath
$manifest = Get-Content -Raw $manifestPath | ConvertFrom-Json
$sw = Get-Content -Raw $swPath

if ($manifest.display -ne 'standalone') {
    throw 'Manifest display mode is not standalone.'
}

foreach ($asset in @('/index.html', '/manifest.json', '/icon.svg')) {
    if ($sw -notmatch [regex]::Escape($asset)) {
        throw "Service worker cache list is missing $asset"
    }
}

foreach ($marker in @("Log Dose Now", "Open settings", "serviceWorker.register('/sw.js')")) {
    if ($index -notmatch [regex]::Escape($marker)) {
        throw "Expected marker not found in index.html: $marker"
    }
}

Write-Host 'Amanda Med Tracker smoke passed.'
