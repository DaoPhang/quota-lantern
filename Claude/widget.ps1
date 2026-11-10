param(
  [string]$PreviewPath,
  [string]$VerifyPath,
  [ValidateSet('live', 'stale', 'unknown', 'expired', 'zero', 'full')][string]$PreviewState = 'live',
  [switch]$PreviewExpanded,
  [ValidateSet('system', 'light', 'dark')][string]$PreviewTheme = 'system'
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
[void][Native.Shell]::SetCurrentProcessExplicitAppUserModelID('Claude.UsageWidget')
# Idle detection lets the reader slow down while nobody is at the PC.
Add-Type -Namespace Native -Name Idle -MemberDefinition @'
[StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
[DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO info);
'@
function Get-IdleSeconds {
  $info = New-Object Native.Idle+LASTINPUTINFO
  $info.cbSize = 8
  if (-not [Native.Idle]::GetLastInputInfo([ref]$info)) { return 0 }
  $tick = [long][Environment]::TickCount -band 0xFFFFFFFFL
  $delta = $tick - [long]$info.dwTime
  if ($delta -lt 0) { $delta += 4294967296 }
  [double]$delta / 1000
}
$script:idleSent = $false

function Send-Worker($command) {
  try {
    if ($script:worker -and -not $script:worker.HasExited) { $script:worker.StandardInput.WriteLine($command); $script:worker.StandardInput.Flush() }
  } catch { }
}

function Write-Diagnostic($stage) {
  @{ stage = $stage; pid = $PID; at = [DateTime]::UtcNow.ToString('o') } |
    ConvertTo-Json | Set-Content -LiteralPath (Join-Path $script:root 'widget-runtime.json') -Encoding UTF8
}
Write-Diagnostic 'Starting'

if (-not $PreviewPath) {
  $created = $false
  $script:mutex = New-Object System.Threading.Mutex($true, 'Local\ClaudeUsageWidget', [ref]$created)
  if (-not $created) { $script:mutex.Dispose(); exit }
}

# Quitting closes the only window, which ends the worker process and releases the single-instance mutex.
function Quit-Widget { $script:window.Close() }

function Save-Settings {
  try {
    @{ left = $script:window.Left; top = $script:window.Top; topmost = $script:window.Topmost } |
      ConvertTo-Json | Set-Content -LiteralPath $script:settingsPath -Encoding UTF8
  } catch { } # Read-only folders must not prevent the widget from closing.
}

# The ring shows the 5-hour limit. It starts at twelve o'clock and sweeps clockwise in proportion to the remaining allowance.
$script:ringCenter = [Windows.Point]::new(22, 22)

# The widget follows the Windows app theme (Settings > Personalization > Colors > Choose your mode).
$script:themes = @{
  dark = @{ CardBg = '#1F1E1D'; CardBorder = '#3A3936'; TextPrimary = '#FAF9F5'; TextSecondary = '#B5B2A9'; Accent = '#D97757'
    RingTrack = '#3A2A24'; BarTrack = '#33322F'; Divider = '#3A3936'; ButtonBg = '#2C2B29'; ButtonHover = '#3D3B38' }
  light = @{ CardBg = '#FAF9F5'; CardBorder = '#D9D5C7'; TextPrimary = '#141413'; TextSecondary = '#5E5B52'; Accent = '#C4623F'
    RingTrack = '#EBD9D0'; BarTrack = '#E6E2D6'; Divider = '#D9D5C7'; ButtonBg = '#ECE9DF'; ButtonHover = '#DDD9CC' }
}
$script:themeName = $null

function Get-SystemTheme {
  try {
    $key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize'
    if ((Get-ItemProperty -LiteralPath $key -Name AppsUseLightTheme -ErrorAction Stop).AppsUseLightTheme -eq 1) { return 'light' }
  } catch { }
  'dark'
}

function Set-Theme($name) {
  if ($name -eq $script:themeName) { return }
  $script:themeName = $name
  foreach ($entry in $script:themes[$name].GetEnumerator()) {
    $script:window.Resources[$entry.Key] = [Windows.Media.SolidColorBrush]::new([Windows.Media.ColorConverter]::ConvertFromString($entry.Value))
  }
}

function Get-RingPoint($angle, $radius) {
  $radians = $angle * [Math]::PI / 180
  [Windows.Point]::new($script:ringCenter.X + $radius * [Math]::Sin($radians), $script:ringCenter.Y - $radius * [Math]::Cos($radians))
}

function Get-Fraction($value) {
  if ($null -eq $value) { return [double]0 }
  [Math]::Min([double]1, [Math]::Max([double]0, [double]$value / 100))
}

function Set-Ring($name, $radius, $value, $opacity) {
  $arc = $script:window.FindName($name)
  $arc.Opacity = $opacity
  # An unknown or empty allowance draws no arc, so it is never mistaken for a reading.
  if ($null -eq $value -or $value -le 0) { $arc.Data = $null; return }
  # A full circle cannot be drawn as a single arc, so stop a hair short of 360 degrees.
  $sweep = 360 * [Math]::Min((Get-Fraction $value), 0.9999)
  $figure = [Windows.Media.PathFigure]::new()
  $figure.StartPoint = Get-RingPoint 0 $radius
  $segment = [Windows.Media.ArcSegment]::new((Get-RingPoint $sweep $radius),
    [Windows.Size]::new($radius, $radius), 0, ($sweep -gt 180), [Windows.Media.SweepDirection]::Clockwise, $true)
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

function Format-ResetShort($reset) {
  if (-not $reset) { return '--' }
  $delta = ([DateTimeOffset]::Parse($reset) - [DateTimeOffset]::UtcNow).TotalMinutes
  if ($delta -le 0) { return 'reset due' }
  $minutes = [int][Math]::Ceiling($delta)
  if ($minutes -ge 1440) { return ('{0}d {1}h' -f [Math]::Floor($minutes / 1440), [Math]::Floor(($minutes % 1440) / 60)) }
  if ($minutes -ge 60) { return ('{0}h {1}m' -f [Math]::Floor($minutes / 60), ($minutes % 60)) }
  "${minutes}m"
}

function Export-Widget($path) {
  $script:window.UpdateLayout()
  $bitmap = [Windows.Media.Imaging.RenderTargetBitmap]::new([int]$script:window.Width, [int]$script:window.Height, 96, 96, [Windows.Media.PixelFormats]::Pbgra32)
  $bitmap.Render($script:window)
  $encoder = [Windows.Media.Imaging.PngBitmapEncoder]::new()
  $encoder.Frames.Add([Windows.Media.Imaging.BitmapFrame]::Create($bitmap))
  $stream = [IO.File]::Create($path)
  try { $encoder.Save($stream) } finally { $stream.Dispose() }
}

# Collapsed by default; the strip's arrow button reveals the per-product share of this week's usage.
$script:collapsedHeight = 76
$script:breakdownExpanded = $false

function Set-Breakdown($expanded) {
  $script:breakdownExpanded = $expanded
  $panel = $script:window.FindName('BreakdownPanel')
  $button = $script:window.FindName('ExpandButton')
  $panel.Visibility = if ($expanded) { 'Visible' } else { 'Collapsed' }
  $script:window.Height = $script:collapsedHeight + $(if ($expanded) { $panel.Height + $panel.Margin.Top } else { 0 })
  $button.Content = if ($expanded) { [string][char]0x25B4 } else { [string][char]0x25BE }
  $tip = if ($expanded) { 'Hide usage by product' } else { 'Show usage by product' }
  $button.ToolTip = $tip
  [Windows.Automation.AutomationProperties]::SetName($button, $tip)
  if ($expanded) { Send-Worker 'expand' }
  # Keep the widget fully on screen when it grows downward.
  $area = [Windows.SystemParameters]::WorkArea
  if ($script:window.Top + $script:window.Height -gt $area.Bottom) { $script:window.Top = [Math]::Max($area.Top, $area.Bottom - $script:window.Height) }
}

function Render-Breakdown {
  $snapshot = $script:snapshot
  $weekly = $snapshot.windows[1]
  # Shares belong to the weekly window, so they are unknown once that window has passed its reset.
  $known = $snapshot.breakdown -and $weekly -and -not $weekly.expired -and
    -not ($weekly.resetsAt -and [DateTimeOffset]::Parse($weekly.resetsAt) -le [DateTimeOffset]::UtcNow)
  $rows = if ($known) { @($snapshot.breakdown) } else { @() }
  for ($i = 0; $i -lt 4; $i++) {
    $row = $script:window.FindName("Brk${i}Row")
    $name = $script:window.FindName("Brk${i}Name"); $pct = $script:window.FindName("Brk${i}Pct")
    $fill = $script:window.FindName("Brk${i}Fill"); $rest = $script:window.FindName("Brk${i}Rest")
    $item = if ($i -lt $rows.Count) { $rows[$i] } else { $null }
    if (-not $item -and $rows.Count -gt 0) { $row.Visibility = 'Collapsed'; continue }
    $row.Visibility = 'Visible'
    if ($item) {
      $value = [Math]::Min(100.0, [Math]::Max(0.0, [double]$item.percent))
      $name.Text = $item.label; $pct.Text = ('{0:0.#}%' -f $value)
      $fill.Width = [Windows.GridLength]::new($value, 'Star'); $rest.Width = [Windows.GridLength]::new(100 - $value, 'Star')
      [Windows.Automation.AutomationProperties]::SetName($row, "$($item.label): $($pct.Text) of this week's usage")
    } else {
      $name.Text = @('Claude Code', 'Chats', 'Cowork', 'Other')[$i]; $pct.Text = '--'
      $fill.Width = [Windows.GridLength]::new(0, 'Star'); $rest.Width = [Windows.GridLength]::new(1, 'Star')
      [Windows.Automation.AutomationProperties]::SetName($row, "$($name.Text): unknown")
    }
  }
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
    $reset = $script:window.FindName($prefix + 'Reset')
    $label.Text = if ($null -eq $value) { '--' } else { ('{0:0.#}%' -f $value) }
    $label.ToolTip = if ($null -eq $value) { 'Allowance unknown. Refresh for a new reading.' } else { "$value% remaining" }
    [Windows.Automation.AutomationProperties]::SetName($label, "$prefix allowance: $($label.ToolTip)")
    $opacity = if ($script:disconnected -or $snapshot.source -ne 'live') { 0.65 } else { 1 }
    if ($prefix -eq 'Primary') {
      Set-Ring 'PrimaryArc' 17 $value $opacity
      [Windows.Automation.AutomationProperties]::SetName($script:window.FindName('Gauge'), "5-hour allowance ring: $($label.ToolTip)")
    }
    $label.Opacity = $opacity
    $caption = if ($prefix -eq 'Primary') { '5-hour' } else { 'Weekly' }
    $reset.Text = "$caption " + [char]0x00B7 + ' ' + $(if ($limit) { Format-ResetShort $limit.resetsAt } else { '--' })
    $reset.ToolTip = if ($limit -and $limit.resetsAt) { [DateTimeOffset]::Parse($limit.resetsAt).ToLocalTime().ToString('f') } else { 'No reset reported' }
  }
  Render-Breakdown
  $age = if ($snapshot.observedAt) { ([DateTimeOffset]::UtcNow - [DateTimeOffset]::Parse($snapshot.observedAt)).TotalSeconds } else { [double]::PositiveInfinity }
  $live = $snapshot.source -eq 'live' -and $age -le 300 -and -not $script:disconnected
  $status = if ($script:disconnected) { 'Disconnected - retrying' }
    elseif ($snapshot.source -eq 'unavailable') { 'Unavailable - sign in to Claude Code' }
    elseif ($snapshot.retryAt -and [DateTimeOffset]::Parse($snapshot.retryAt) -gt [DateTimeOffset]::UtcNow) {
      'Rate limited - retry ' + [DateTimeOffset]::Parse($snapshot.retryAt).ToLocalTime().ToString('h:mm tt') }
    elseif ($expired) { 'Awaiting reset confirmation' }
    elseif ($live) { 'Live account data' }
    else { 'Last known data' }
  if ($snapshot.observedAt) {
    $ageText = if ($age -lt 60) { 'just now' } elseif ($age -lt 3600) { "$([Math]::Floor($age / 60))m ago" }
      elseif ($age -lt 86400) { "$([Math]::Floor($age / 3600))h ago" } else { "$([Math]::Floor($age / 86400))d ago" }
    $status += " - $ageText"
  }
  $script:window.FindName('StatusText').Text = $status
  $script:window.FindName('StatusDot').Fill = if ($live -and -not $expired) { '#4ADE80' } else { '#FFB84D' }
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
  $iconPath = Join-Path $script:root 'claude.ico'
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
    $script:snapshot | Add-Member breakdown @(
      [pscustomobject]@{label = 'Claude Code'; percent = $(if ($PreviewState -eq 'zero') { 0 } else { 79 })},
      [pscustomobject]@{label = 'Chats'; percent = 0},
      [pscustomobject]@{label = 'Cowork'; percent = $(if ($PreviewState -eq 'zero') { 0 } else { 21 })},
      [pscustomobject]@{label = 'Other'; percent = 0})
    if ($PreviewState -eq 'unknown') { $script:snapshot.windows = @($null, $null); $script:snapshot.observedAt = $null }
    if ($PreviewState -eq 'expired') { $script:snapshot.windows[0].resetsAt = $now.AddSeconds(-1).ToString('o') }
    Set-Theme $(if ($PreviewTheme -eq 'system') { Get-SystemTheme } else { $PreviewTheme })
    Render-Usage
    Set-Breakdown ([bool]$PreviewExpanded)
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
  $startup.IsChecked = [bool](Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'ClaudeUsageWidget' -ErrorAction SilentlyContinue).ClaudeUsageWidget
  $startup.Add_Click({
    try {
      & (Join-Path $script:root 'startup.ps1') -Remove:(-not $startup.IsChecked) | Out-Null
    } catch {
      $startup.IsChecked = -not $startup.IsChecked
      [Windows.MessageBox]::Show('Unable to update automatic startup.', 'Claude Usage Widget') | Out-Null
    }
  })
  $menu.Items.Add($startup) | Out-Null
  $quit = [Windows.Controls.MenuItem]::new(); $quit.Header = 'Quit'
  $quit.Add_Click({ Quit-Widget })
  $menu.Items.Add($quit) | Out-Null
  $script:window.FindName('MenuButton').ContextMenu = $menu
  $script:window.FindName('Surface').ContextMenu = $menu # right-click anywhere on the strip
  $script:window.FindName('MenuButton').Add_Click({ $menu.IsOpen = $true })
  $script:window.FindName('QuitButton').Add_Click({ Quit-Widget })
  $script:window.FindName('DragHandle').Add_MouseLeftButtonDown({
    if ($_.ButtonState -eq 'Pressed') { $script:window.DragMove(); Save-Settings }
  })
  $script:window.FindName('ExpandButton').Add_Click({ Set-Breakdown (-not $script:breakdownExpanded) })
  $script:window.FindName('RefreshButton').Add_Click({
    try {
      if (-not $script:worker -or $script:worker.HasExited) { Start-Worker }
      else { $script:worker.StandardInput.WriteLine('refresh'); $script:worker.StandardInput.Flush() }
      $script:window.FindName('StatusText').Text = 'Refreshing...'
    } catch { $script:window.FindName('StatusText').Text = 'Unable to start reader - Node.js required' }
  })
  $script:window.Add_KeyDown({
    if ($_.Key -eq 'F5') { $script:window.FindName('RefreshButton').RaiseEvent([Windows.RoutedEventArgs]::new([Windows.Controls.Button]::ClickEvent)) }
    if ($_.Key -eq 'Escape') { Quit-Widget }
  })

  $script:retryAt = [DateTime]::UtcNow
  $script:verifyDeadline = [DateTime]::UtcNow.AddSeconds(25)
  $script:lastRender = [DateTime]::MinValue
  $script:lastThemeCheck = [DateTime]::MinValue
  $script:lastIdleCheck = [DateTime]::UtcNow
  Set-Theme (Get-SystemTheme)
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
      if (([DateTime]::UtcNow - $script:lastIdleCheck).TotalSeconds -ge 10) {
        $script:lastIdleCheck = [DateTime]::UtcNow
        $isIdle = (Get-IdleSeconds) -ge 300
        if ($isIdle -ne $script:idleSent) { $script:idleSent = $isIdle; Send-Worker $(if ($isIdle) { 'idle' } else { 'active' }) }
      }
      if (([DateTime]::UtcNow - $script:lastThemeCheck).TotalSeconds -ge 3) {
        Set-Theme (Get-SystemTheme)
        $script:lastThemeCheck = [DateTime]::UtcNow
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
