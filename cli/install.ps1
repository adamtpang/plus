# Installer for plus, an unofficial CLI for Surplus Intelligence (Windows).
#
#   irm https://raw.githubusercontent.com/adamtpang/plus/main/cli/install.ps1 | iex
#
# It downloads one JavaScript file and a small launcher into
# %LOCALAPPDATA%\plus\bin and adds that folder to your user PATH.
# Needs Node 18 or newer. Set PLUS_INSTALL_DIR to install somewhere else,
# or PLUS_NO_MODIFY_PATH=1 to leave PATH alone.

$ErrorActionPreference = 'Stop'

$name = 'plus'
$base = if ($env:PLUS_BASE_URL) { $env:PLUS_BASE_URL } else { 'https://raw.githubusercontent.com/adamtpang/plus/main/cli' }
$dir = if ($env:PLUS_INSTALL_DIR) { $env:PLUS_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'plus\bin' }

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "$name needs Node 18 or newer, and node was not found. Get it at https://nodejs.org"
}
$major = [int]((node --version) -replace '^v(\d+).*', '$1')
if ($major -lt 18) { throw "$name needs Node 18 or newer; this machine has Node $major." }

New-Item -ItemType Directory -Force $dir | Out-Null
Invoke-WebRequest "$base/plus.mjs" -OutFile (Join-Path $dir "$name.mjs") -UseBasicParsing
Invoke-WebRequest "$base/wallet.mjs" -OutFile (Join-Path $dir 'wallet.mjs') -UseBasicParsing

# The launcher: a two-line script so the name works as a command.
Set-Content -Path (Join-Path $dir "$name.cmd") -Value "@echo off`r`nnode `"%~dp0$name.mjs`" %*" -Encoding ascii

Write-Host "Installed $name to $dir"
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (($userPath -split ';') -notcontains $dir) {
  if ($env:PLUS_NO_MODIFY_PATH) {
    Write-Host "Add it to your PATH: $dir"
  } else {
    [Environment]::SetEnvironmentVariable('Path', "$userPath;$dir", 'User')
    Write-Host 'Added to your PATH. Open a new terminal to use it.'
  }
}
Write-Host "Next:  $name login"
