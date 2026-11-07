param([switch]$Remove, [switch]$Status)
$ErrorActionPreference = 'Stop'
$key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$name = 'ClaudeUsageWidget'
if ($Status) {
  $value = (Get-ItemProperty -LiteralPath $key -Name $name -ErrorAction SilentlyContinue).$name
  if ($value) { Write-Output $value } else { Write-Output 'Disabled' }
} elseif ($Remove) {
  if (Get-ItemProperty -LiteralPath $key -Name $name -ErrorAction SilentlyContinue) {
    Remove-ItemProperty -LiteralPath $key -Name $name
  }
  Write-Output 'Automatic startup disabled.'
} else {
  $launcherPath = Join-Path $PSScriptRoot 'Claude Widget.exe'
  if (-not (Test-Path -LiteralPath $launcherPath)) { throw 'Build the native launcher with build-launcher.ps1 first.' }
  $command = '"{0}"' -f $launcherPath
  if (-not (Test-Path -LiteralPath $key)) { New-Item -Path $key -Force | Out-Null }
  New-ItemProperty -LiteralPath $key -Name $name -Value $command -PropertyType String -Force | Out-Null
  Write-Output 'Widget will open automatically when you sign in to Windows.'
}
