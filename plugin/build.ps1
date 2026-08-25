# Builds the BakkesMod plugin and reloads it in Rocket League if it's running.
#
#   .\plugin\build.ps1              build + hot reload over RCON
#   .\plugin\build.ps1 -NoReload    build only
#
# CMake's POST_BUILD copies the DLL into BakkesMod's plugins folder.
param([switch]$NoReload)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
if (-not (Test-Path $vswhere)) { throw "Visual Studio Build Tools not found. choco install visualstudio2022-workload-vctools" }
$vs = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
$cmake = Join-Path $vs 'Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe'
if (-not (Test-Path $cmake)) { throw "cmake not found in $vs" }

$src = Join-Path $root 'plugin'
$build = Join-Path $src 'build'

# BakkesMod keeps the DLL open: it must be unloaded before rewriting the file.
$reload = -not $NoReload -and (Get-Process RocketLeague -ErrorAction SilentlyContinue)
if ($reload) { & (Join-Path $PSScriptRoot 'rcon.ps1') 'plugin unload rloverlayplugin' }

if (-not (Test-Path (Join-Path $build 'CMakeCache.txt'))) {
    & $cmake -S $src -B $build -G 'Visual Studio 17 2022' -A x64 -T host=x64
}
& $cmake --build $build --config Release
if ($LASTEXITCODE -ne 0) { throw "build failed" }

if ($reload) {
    & (Join-Path $PSScriptRoot 'rcon.ps1') 'plugin load rloverlayplugin'
    Write-Host "plugin reloaded in Rocket League"
} else {
    Write-Host "DLL copied. In RL: BakkesMod console (F6) -> plugin load rloverlayplugin"
}
