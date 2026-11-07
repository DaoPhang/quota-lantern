param(
  [string]$PreviewPath,
  [string]$VerifyPath,
  [ValidateSet('live', 'stale', 'unknown', 'expired', 'zero', 'full')][string]$PreviewState = 'live'
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase, System.Windows.Forms, System.Drawing
$script:root = $PSScriptRoot
$script:settingsPath = Join-Path $script:root 'widget-settings.json'
$script:worker = $null
$script:pendingLine = $null
$script:snapshot = $null
$script:disconnected = $false
$script:mutex = $null
# Give the widget its own taskbar identity so Windows does not group it under powershell.exe and show PowerShell's icon.
Add-Type -Namespace Native -Name Shell -MemberDefinition '[System.Runtime.InteropServices.DllImport("shell32.dll")] public static extern int SetCurrentProcessExplicitAppUserModelID(string appId);'
[void][Native.Shell]::SetCurrentProcessExplicitAppUserModelID('Codex.UsageWidget')
function Write-Diagnostic($stage) {
  @{ stage = $stage; pid = $PID; at = [DateTime]::UtcNow.ToString('o') } |
    ConvertTo-Json | Set-Content -LiteralPath (Join-Path $script:root 'widget-runtime.json') -Encoding UTF8
}
Write-Diagnostic 'Starting'

if (-not $PreviewPath) {
  $created = $false
  $script:mutex = New-Object System.Threading.Mutex($true, 'Local\CodexUsageWidget', [ref]$created)
  if (-not $created) { $script:mutex.Dispose(); exit }
}

function Save-Settings {
  try {
    @{ left = $script:window.Left; top = $script:window.Top; topmost = $script:window.Topmost } |
      ConvertTo-Json | Set-Content -LiteralPath $script:settingsPath -Encoding UTF8
  } catch { } # Read-only folders must not prevent the widget from closing.
}

function Set-Ring($arc, $value) {
  if ($null -eq $value -or $value -le 0) { $arc.Data = $null; return }
  $fraction = [Math]::Min([double]1, [Math]::Max([double]0, [double]$value / 100))
  if ($fraction -ge 1) {
    $arc.Data = [Windows.Media.EllipseGeometry]::new([Windows.Point]::new(66, 66), 52, 52)
    return
  }
  $angle = 2 * [Math]::PI * $fraction
  $end = [Windows.Point]::new(66 + 52 * [Math]::Sin($angle), 66 - 52 * [Math]::Cos($angle))
  $figure = [Windows.Media.PathFigure]::new()
  $figure.StartPoint = [Windows.Point]::new(66, 14)
  $segment = [Windows.Media.ArcSegment]::new($end, [Windows.Size]::new(52, 52), 0,
    ($fraction -gt 0.5), [Windows.Media.SweepDirection]::Clockwise, $true)
  $figure.Segments.Add($segment)
  $geometry = [Windows.Media.PathGeometry]::new()
  $geometry.Figures.Add($figure)
  $arc.Data = $geometry
}

function Format-Reset($reset) {
  if (-not $reset) { return 'Reset time unavailable' }
  $delta = ([DateTimeOffset]::Parse($reset) - [DateTimeOffset]::UtcNow).TotalMinutes
  if ($delta -le 0) { return 'Awaiting new reading' }
  $minutes = [int][Math]::Ceiling($delta)
  if ($minutes -ge 1440) { return ('Resets in {0}d {1}h' -f [Math]::Floor($minutes / 1440), [Math]::Floor(($minutes % 1440) / 60)) }
  if ($minutes -ge 60) { return ('Resets in {0}h {1}m' -f [Math]::Floor($minutes / 60), ($minutes % 60)) }
  return "Resets in ${minutes}m"
}

function Export-Widget($path) {
  $script:window.UpdateLayout()
  $bitmap = [Windows.Media.Imaging.RenderTargetBitmap]::new(352, 292, 96, 96, [Windows.Media.PixelFormats]::Pbgra32)
  $bitmap.Render($script:window)
  $encoder = [Windows.Media.Imaging.PngBitmapEncoder]::new()
  $encoder.Frames.Add([Windows.Media.Imaging.BitmapFrame]::Create($bitmap))
  $stream = [IO.File]::Create($path)
  try { $encoder.Save($stream) } finally { $stream.Dispose() }
}

function Render-Usage {
  if (-not $script:snapshot) { return }
  $snapshot = $script:snapshot
  $expired = $false
  $index = 0
  foreach ($prefix in @('Primary', 'Weekly')) {
    $limit = $snapshot.windows[$index]
    $index++
    $value = $null
    if ($limit) {
      $isExpired = $limit.expired -or ($limit.resetsAt -and [DateTimeOffset]::Parse($limit.resetsAt) -le [DateTimeOffset]::UtcNow)
      if ($isExpired) { $expired = $true } else { $value = $limit.remainingPercent }
    }
    $label = $script:window.FindName($prefix + 'Value')
    $arc = $script:window.FindName($prefix + 'Arc')
    $reset = $script:window.FindName($prefix + 'Reset')
    $label.Text = if ($null -eq $value) { '--' } else { ('{0:0.#}%' -f $value) }
    $label.ToolTip = if ($null -eq $value) { 'Allowance unknown. Refresh for a new reading.' } else { "$value% remaining" }
    [Windows.Automation.AutomationProperties]::SetName($label, "$prefix allowance: $($label.ToolTip)")
    Set-Ring $arc $value
    $arc.Opacity = if ($script:disconnected -or $snapshot.source -ne 'live') { 0.65 } else { 1 }
    $reset.Text = if ($limit) { Format-Reset $limit.resetsAt } else { 'Waiting for data' }
    $reset.ToolTip = if ($limit -and $limit.resetsAt) { [DateTimeOffset]::Parse($limit.resetsAt).ToLocalTime().ToString('f') } else { 'No reset reported' }
  }
  $age = if ($snapshot.observedAt) { ([DateTimeOffset]::UtcNow - [DateTimeOffset]::Parse($snapshot.observedAt)).TotalSeconds } else { [double]::PositiveInfinity }
  $live = $snapshot.source -eq 'live' -and $age -le 120 -and -not $script:disconnected
  $status = if ($script:disconnected) { 'Disconnected - retrying' }
    elseif ($snapshot.source -eq 'unavailable') { 'Unavailable - sign in to Codex' }
    elseif ($expired) { 'Awaiting reset confirmation' }
    elseif ($live) { 'Live account data' }
    else { 'Last known data' }
  if ($snapshot.observedAt) {
    $ageText = if ($age -lt 60) { 'just now' } elseif ($age -lt 3600) { "$([Math]::Floor($age / 60))m ago" }
      elseif ($age -lt 86400) { "$([Math]::Floor($age / 3600))h ago" } else { "$([Math]::Floor($age / 86400))d ago" }
    $status += " - $ageText"
  }
  $script:window.FindName('StatusText').Text = $status
  $script:window.FindName('StatusDot').Fill = if ($live -and -not $expired) { '#79E2BD' } else { '#D8B77A' }
  $script:window.FindName('Surface').ToolTip = (@($snapshot.notice, $(if ($snapshot.observedAt) {
    'Reported ' + [DateTimeOffset]::Parse($snapshot.observedAt).ToLocalTime().ToString('f')
  })) | Where-Object { $_ }) -join "`n"
}

function Start-Worker {
  if ($script:worker) { $script:worker.Dispose() }
  $node = Get-Command node.exe -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $node) { throw 'Node.js 22 or newer is required.' }
  $info = [Diagnostics.ProcessStartInfo]::new()
  $info.FileName = $node.Source
  $info.Arguments = '"' + (Join-Path $script:root 'usage-worker.mjs') + '"'
  $info.WorkingDirectory = $script:root
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $info.RedirectStandardOutput = $true
  $info.RedirectStandardInput = $true
  $script:worker = [Diagnostics.Process]::Start($info)
  $script:pendingLine = $script:worker.StandardOutput.ReadLineAsync()
}

try {
  [xml]$xaml = Get-Content -LiteralPath (Join-Path $script:root 'widget.xaml') -Raw
  $reader = [Xml.XmlNodeReader]::new($xaml)
  $script:window = [Windows.Markup.XamlReader]::Load($reader)
  Write-Diagnostic 'Window created'
  # The taskbar and Alt+Tab use the window icon, so it must be set here, not only on the exe.
  $iconPath = Join-Path $script:root 'codex.ico'
  if (Test-Path -LiteralPath $iconPath) {
    $script:window.Icon = [Windows.Media.Imaging.BitmapFrame]::Create([Uri]::new($iconPath))
  }
  $script:window.Topmost = $true
  $reader.Close()
  $area = [Windows.SystemParameters]::WorkArea
  $script:window.Left = $area.Right - $script:window.Width - 24
  $script:window.Top = $area.Top + 32
  if (Test-Path -LiteralPath $script:settingsPath) {
    try {
      $settings = Get-Content -LiteralPath $script:settingsPath -Raw | ConvertFrom-Json
      # Clamp to the current work area when a monitor is unplugged or DPI changes.
      $script:window.Left = [Math]::Max($area.Left, [Math]::Min($area.Right - $script:window.Width, [double]$settings.left))
      $script:window.Top = [Math]::Max($area.Top, [Math]::Min($area.Bottom - $script:window.Height, [double]$settings.top))
      $script:window.Topmost = [bool]$settings.topmost
    } catch { }
  }

  if ($PreviewPath) {
    $now = [DateTimeOffset]::UtcNow
    $v1 = 72; $v2 = 46
    if ($PreviewState -eq 'zero') { $v1 = 0; $v2 = 0 }
    if ($PreviewState -eq 'full') { $v1 = 100; $v2 = 100 }
    $script:snapshot = [pscustomobject]@{
      source = $(if ($PreviewState -eq 'stale') { 'local' } elseif ($PreviewState -eq 'unknown') { 'unavailable' } else { 'live' })
      observedAt = $now.AddMinutes(-$(if ($PreviewState -eq 'stale') { 180 } else { 0 })).ToString('o')
      windows = @(
        [pscustomobject]@{remainingPercent = $v1; resetsAt = $now.AddMinutes(177).ToString('o'); expired = ($PreviewState -eq 'expired')},
        [pscustomobject]@{remainingPercent = $v2; resetsAt = $now.AddDays(4).AddHours(2).ToString('o'); expired = $false})
    }
    if ($PreviewState -eq 'unknown') { $script:snapshot.windows = @($null, $null); $script:snapshot.observedAt = $null }
    if ($PreviewState -eq 'expired') { $script:snapshot.windows[0].resetsAt = $now.AddSeconds(-1).ToString('o') }
    Render-Usage
    $script:window.ShowActivated = $false
    $script:window.Show()
    Export-Widget $PreviewPath
    $script:window.Close()
    Write-Output "Rendered $PreviewState preview: $PreviewPath"
    exit
  }

  $menu = [Windows.Controls.ContextMenu]::new()
  $pin = [Windows.Controls.MenuItem]::new()
  $pin.Header = 'Always on top'; $pin.IsCheckable = $true; $pin.IsChecked = $script:window.Topmost
  $pin.Add_Click({ $script:window.Topmost = $pin.IsChecked; Save-Settings })
  $menu.Items.Add($pin) | Out-Null
  $startup = [Windows.Controls.MenuItem]::new()
  $startup.Header = 'Start with Windows'; $startup.IsCheckable = $true
  $startup.IsChecked = [bool](Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'CodexUsageWidget' -ErrorAction SilentlyContinue).CodexUsageWidget
  $startup.Add_Click({
    try {
      & (Join-Path $script:root 'startup.ps1') -Remove:(-not $startup.IsChecked) | Out-Null
    } catch {
      $startup.IsChecked = -not $startup.IsChecked
      [Windows.MessageBox]::Show('Unable to update automatic startup.', 'Codex Usage Widget') | Out-Null
    }
  })
  $menu.Items.Add($startup) | Out-Null
  $quit = [Windows.Controls.MenuItem]::new(); $quit.Header = 'Quit'
  $quit.Add_Click({ $script:window.Close() })
  $menu.Items.Add($quit) | Out-Null
  $script:window.FindName('MenuButton').ContextMenu = $menu
  $script:window.FindName('MenuButton').Add_Click({ $menu.IsOpen = $true })
  $script:window.FindName('CloseButton').Add_Click({ $script:window.Close() })
  $script:window.FindName('DragHandle').Add_MouseLeftButtonDown({
    if ($_.ButtonState -eq 'Pressed') { $script:window.DragMove(); Save-Settings }
  })
  $script:window.FindName('RefreshButton').Add_Click({
    try {
      if (-not $script:worker -or $script:worker.HasExited) { Start-Worker }
      else { $script:worker.StandardInput.WriteLine('refresh'); $script:worker.StandardInput.Flush() }
      $script:window.FindName('StatusText').Text = 'Refreshing...'
    } catch { $script:window.FindName('StatusText').Text = 'Unable to start reader - Node.js required' }
  })
  $script:window.Add_KeyDown({
    if ($_.Key -eq 'F5') { $script:window.FindName('RefreshButton').RaiseEvent([Windows.RoutedEventArgs]::new([Windows.Controls.Button]::ClickEvent)) }
    if ($_.Key -eq 'Escape') { $script:window.Close() }
  })

  $script:retryAt = [DateTime]::UtcNow
  $script:verifyDeadline = [DateTime]::UtcNow.AddSeconds(25)
  $script:lastRender = [DateTime]::MinValue
  $timer = [Windows.Threading.DispatcherTimer]::new()
  $timer.Interval = [TimeSpan]::FromMilliseconds(250)
  $timer.Add_Tick({
    try {
      if ($script:pendingLine -and $script:pendingLine.IsCompleted) {
        $line = $script:pendingLine.GetAwaiter().GetResult()
        $script:pendingLine = $null
        if ($line) {
          $script:snapshot = $line | ConvertFrom-Json
          $script:disconnected = $false
          Render-Usage
          $script:pendingLine = $script:worker.StandardOutput.ReadLineAsync()
        }
      }
      if ((-not $script:worker -or $script:worker.HasExited) -and [DateTime]::UtcNow -ge $script:retryAt) {
        $script:disconnected = $true
        $script:retryAt = [DateTime]::UtcNow.AddSeconds(30)
        Start-Worker
      }
      if (([DateTime]::UtcNow - $script:lastRender).TotalSeconds -ge 1) {
        Render-Usage
        $script:lastRender = [DateTime]::UtcNow
      }
      if ($VerifyPath -and ($script:snapshot -or [DateTime]::UtcNow -gt $script:verifyDeadline)) {
        Export-Widget $VerifyPath
        Write-Output $script:window.FindName('StatusText').Text
        $script:window.Close()
      }
    } catch {
      $script:disconnected = $true
      $script:window.FindName('StatusText').Text = 'Reader unavailable - retrying'
    }
  })
  $script:window.Add_Closed({ $timer.Stop(); Save-Settings })
  $timer.Start()
  $script:window.Add_Loaded({ Write-Diagnostic ('Loaded; visible=' + $script:window.IsVisible) })
  $script:window.Add_ContentRendered({ Write-Diagnostic ('Rendered; visible=' + $script:window.IsVisible) })
  Write-Diagnostic 'Opening window'
  $script:window.ShowDialog() | Out-Null
} catch {
  # Do not log exception objects: future upstream errors could contain private data.
  'Widget startup failed. Check Node.js 22+ and Windows PowerShell with WPF.' |
    Set-Content -LiteralPath (Join-Path $script:root 'widget-error.log')
  throw
} finally {
  if ($script:worker) {
    try { $script:worker.StandardInput.Close(); if (-not $script:worker.WaitForExit(1500)) { $script:worker.Kill() } } catch { }
    $script:worker.Dispose()
  }
  if ($script:mutex) { $script:mutex.ReleaseMutex(); $script:mutex.Dispose() }
}
