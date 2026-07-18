param(
  [Parameter(Mandatory = $true)]
  [string]$TargetTag
)

$ErrorActionPreference = "Stop"
$checkout = (Get-Location).Path
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT -or $env:PROCESSOR_ARCHITECTURE -ne "AMD64") {
  throw "Release smoke поддерживает только Windows x64."
}
if ($checkout -notmatch "\s" -or $checkout -notmatch "[^\x00-\x7F]") {
  throw "Запустите release smoke из чистого checkout, путь которого содержит пробелы и кириллицу."
}
if ((git status --porcelain).Length -ne 0) {
  throw "Release smoke требует чистый Git checkout."
}

function Invoke-Required([string]$Command, [string[]]$Arguments, [int[]]$Allowed = @(0)) {
  & $Command @Arguments
  if ($Allowed -notcontains $LASTEXITCODE) {
    throw "$Command $($Arguments -join ' ') завершилась с кодом $LASTEXITCODE."
  }
}

Invoke-Required "npm.cmd" @("ci")
Invoke-Required "npm.cmd" @("run", "install:chromium")
Invoke-Required "npm.cmd" @("run", "build")
Invoke-Required "npm.cmd" @("test")
Invoke-Required "node.exe" @("dist/server/cli.js", "doctor") @(0, 2)
Invoke-Required "node.exe" @("scripts/built-app-smoke.mjs")
$smokeBackup = Join-Path $env:LOCALAPPDATA "WebsiteChangeMonitor\backups\release-smoke-$(Get-Date -Format 'yyyyMMdd-HHmmssfff').sqlite3"
Invoke-Required "node.exe" @("dist/server/cli.js", "backup", "--output", $smokeBackup)
Invoke-Required "node.exe" @("dist/server/cli.js", "restore", "--input", $smokeBackup)
Invoke-Required "node.exe" @("dist/server/cli.js", "update", $TargetTag)
Invoke-Required "node.exe" @("dist/server/cli.js", "doctor") @(0, 2)
Invoke-Required "node.exe" @("dist/server/cli.js", "rollback")
Invoke-Required "node.exe" @("dist/server/cli.js", "doctor") @(0, 2)

Write-Host "Автоматическая часть release smoke завершена. Выполните UI-чеклист из docs/windows-release.md."
