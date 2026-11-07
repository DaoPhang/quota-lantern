using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;

internal static class WidgetLauncher
{
    [STAThread]
    private static void Main()
    {
        string root = AppDomain.CurrentDomain.BaseDirectory;
        string script = Path.Combine(root, "widget.ps1");
        if (!File.Exists(script))
        {
            MessageBox.Show("Keep Codex Widget.exe in the same folder as widget.ps1.", "Codex Usage Widget");
            return;
        }
        try
        {
            Process.Start(new ProcessStartInfo
            {
                FileName = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), @"WindowsPowerShell\v1.0\powershell.exe"),
                Arguments = "-NoProfile -STA -ExecutionPolicy Bypass -File \"" + script + "\"",
                WorkingDirectory = root,
                UseShellExecute = false,
                CreateNoWindow = true
            });
        }
        catch (Exception)
        {
            MessageBox.Show("Unable to start the widget. Windows PowerShell is required.", "Codex Usage Widget");
        }
    }
}
