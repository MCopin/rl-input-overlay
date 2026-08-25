# Packs the overlay as four static files, for use with no app at all.
#
#   npm run pack
#
# What this ships is the whole "without the app" route: the page talks straight
# to the plugin's WebSocket, so an OBS user needs Rocket League and the plugin,
# and nothing else — no Node, no Electron, no install. That is the most
# accessible way to use any of this, and it costs four files.
#
# Written with the .NET ZIP API rather than Compress-Archive: PowerShell 5.1
# writes backslashes into entry names, which the ZIP spec forbids and some
# extractors turn into a file literally named "a\b".
$ErrorActionPreference = 'Stop'

$app = Split-Path -Parent $PSScriptRoot
$root = Split-Path -Parent $app
$public = Join-Path $app 'public'
$dist = Join-Path $root 'dist'

$version = (Get-Content (Join-Path $app 'package.json') -Raw | ConvertFrom-Json).version
$files = @('overlay.html', 'overlay.css', 'overlay.js', 'actions.js')

New-Item -ItemType Directory -Force -Path $dist | Out-Null
$zipPath = Join-Path $dist "rl-input-overlay-$version.zip"
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$stream = [System.IO.File]::Open($zipPath, [System.IO.FileMode]::CreateNew)
$archive = New-Object System.IO.Compression.ZipArchive($stream, [System.IO.Compression.ZipArchiveMode]::Create)
foreach ($name in $files) {
    $source = Join-Path $public $name
    if (-not (Test-Path $source)) { throw "missing $source" }
    $entry = $archive.CreateEntry($name, [System.IO.Compression.CompressionLevel]::Optimal)
    $out = $entry.Open()
    $bytes = [System.IO.File]::ReadAllBytes($source)
    $out.Write($bytes, 0, $bytes.Length)
    $out.Dispose()
}
$archive.Dispose()
$stream.Dispose()

"{0}  {1:N0} bytes" -f $zipPath, (Get-Item $zipPath).Length
"Check it with: npm run standalone"
