# Sends a command to the BakkesMod console over RCON (WebSocket, port 9002).
# The password is read from the BakkesMod config, nothing to enter.
param([Parameter(Mandatory = $true)][string]$Command)

$ErrorActionPreference = 'Stop'

$cfg = Join-Path $env:APPDATA 'bakkesmod\bakkesmod\cfg\config.cfg'
$line = Select-String -Path $cfg -Pattern '^\s*rcon_password\s+"([^"]+)"' | Select-Object -First 1
if (-not $line) { throw "rcon_password not found in $cfg" }
$password = $line.Matches[0].Groups[1].Value

$port = 9002
$enabled = Select-String -Path $cfg -Pattern '^\s*rcon_enabled\s+"1"'
if (-not $enabled) { throw "RCON disabled: set rcon_enabled to 1 in the BakkesMod console" }

$script = Join-Path $PSScriptRoot 'rcon.js'
$env:BM_RCON_PASSWORD = $password
$env:BM_RCON_PORT = $port
node $script $Command
