$ErrorActionPreference = 'Stop'
# csc.exe is used instead of Add-Type so the Claude icon can be embedded in the executable.
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $csc)) { throw 'The .NET Framework C# compiler (csc.exe) is required.' }
$output = Join-Path $PSScriptRoot 'Claude Widget.exe'
$icon = Join-Path $PSScriptRoot 'claude.ico'
$source = Join-Path $PSScriptRoot 'WidgetLauncher.cs'
& $csc /nologo /target:winexe "/win32icon:$icon" /reference:System.Windows.Forms.dll "/out:$output" $source
if ($LASTEXITCODE -ne 0) { throw "Launcher build failed with exit code $LASTEXITCODE." }
