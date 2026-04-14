using System.Drawing;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace FTD.OposBridge.Service;

public sealed class BridgeTrayIconHost : IHostedService, IDisposable
{
  private readonly BridgeOptions _options;
  private readonly BridgeRuntime _runtime;
  private readonly IHostApplicationLifetime _appLifetime;
  private readonly ILogger<BridgeTrayIconHost> _logger;
  private readonly object _uiSyncGate = new();

  private Thread? _uiThread;
  private SynchronizationContext? _uiContext;
  private ApplicationContext? _applicationContext;
  private NotifyIcon? _notifyIcon;
  private System.Windows.Forms.Timer? _refreshTimer;
  private Icon? _readyIcon;
  private Icon? _waitingIcon;
  private Icon? _errorIcon;
  private LogViewerWindow? _logViewerWindow;
  private bool _refreshInProgress;
  private bool _disposed;

  public BridgeTrayIconHost(
    BridgeOptions options,
    BridgeRuntime runtime,
    IHostApplicationLifetime appLifetime,
    ILogger<BridgeTrayIconHost> logger)
  {
    _options = options;
    _runtime = runtime;
    _appLifetime = appLifetime;
    _logger = logger;
  }

  public Task StartAsync(CancellationToken cancellationToken)
  {
    if (!ShouldRunTrayIcon())
    {
      return Task.CompletedTask;
    }

    _uiThread = new Thread(RunUiThread)
    {
      IsBackground = true,
      Name = "FTD.OposBridge.TrayIcon",
    };
    _uiThread.SetApartmentState(ApartmentState.STA);
    _uiThread.Start();
    return Task.CompletedTask;
  }

  public Task StopAsync(CancellationToken cancellationToken)
  {
    if (_uiContext is not null)
    {
      _uiContext.Post(_ => _applicationContext?.ExitThread(), null);
    }

    return Task.CompletedTask;
  }

  public void Dispose()
  {
    if (_disposed) return;
    _disposed = true;

    try
    {
      _uiContext?.Post(_ => _applicationContext?.ExitThread(), null);
    }
    catch
    {
      // Best effort on shutdown.
    }
  }

  private bool ShouldRunTrayIcon()
  {
    if (!OperatingSystem.IsWindows()) return false;
    if (!Environment.UserInteractive) return false;
    if (!_options.TrayIconEnabled) return false;
    return true;
  }

  private void RunUiThread()
  {
    lock (_uiSyncGate)
    {
      _uiContext = SynchronizationContext.Current ?? new WindowsFormsSynchronizationContext();
      SynchronizationContext.SetSynchronizationContext(_uiContext);



      // Use new .ico for tray icon
      string iconPath = Path.Combine(AppContext.BaseDirectory, "opos-bridge.ico");
      Icon? trayIcon = null;
      if (File.Exists(iconPath))
      {
        try { trayIcon = new Icon(iconPath); } catch { }
      }
      _readyIcon = trayIcon ?? CreateStatusIcon(Color.FromArgb(46, 139, 87));
      _waitingIcon = trayIcon ?? CreateStatusIcon(Color.FromArgb(216, 155, 36));
      _errorIcon = trayIcon ?? CreateStatusIcon(Color.FromArgb(198, 40, 40));

      var menu = new ContextMenuStrip();
      if (_options.EnableScanner)
        menu.Items.Add("Scanner Settings", null, (_, _) => ShowScannerSettingsDialog());
      if (_options.EnablePrinter)
        menu.Items.Add("Printer Settings", null, (_, _) => ShowPrinterSettingsDialog());
      menu.Items.Add("About", null, (_, _) => ShowAboutDialog());
      menu.Items.Add("View Logs", null, (_, _) => OpenLogViewer());
      menu.Items.Add(new ToolStripSeparator());
      menu.Items.Add("Exit", null, (_, _) => _appLifetime.StopApplication());

      // Show the printer settings dialog and persist preferences
      void ShowPrinterSettingsDialog()
      {
        PrinterSettingsDialog.ShowDialogForPrefs($"http://127.0.0.1:{_options.Port}");
      }

      // Show the scanner settings dialog and update BridgeOptions.LogicalName
      void ShowScannerSettingsDialog()
      {
        var currentLogicalName = _options.LogicalName;
        var selected = ScannerSettingsDialog.ShowDialogForLogicalName(currentLogicalName);
        if (!string.IsNullOrWhiteSpace(selected) && selected != currentLogicalName)
        {
          // This only updates the in-memory options for the tray; persist as needed
          typeof(BridgeOptions).GetProperty("LogicalName")?.SetValue(_options, selected);
          MessageBox.Show($"Scanner logical name set to: {selected}\nRestart the service for changes to take effect.", "Scanner Settings", MessageBoxButtons.OK, MessageBoxIcon.Information);
        }
      }

      _notifyIcon = new NotifyIcon
      {
        Text = TruncateNotifyText("FTD OPOS Bridge: starting"),
        Icon = _waitingIcon ?? SystemIcons.Application,
        Visible = true,
        ContextMenuStrip = menu,
      };

      // Always show menu on left or right click
      _notifyIcon.MouseUp += (s, e) =>
      {
        if (e.Button == MouseButtons.Right || e.Button == MouseButtons.Left)
        {
          // Show the context menu at the cursor position
          menu.Show(Cursor.Position);
        }
      };

      _refreshTimer = new System.Windows.Forms.Timer { Interval = 800 };
      _refreshTimer.Tick += async (_, _) => await RefreshStatusAsync();
      _refreshTimer.Start();

      _applicationContext = new ApplicationContext();
    }

    try
    {
      Application.Run(_applicationContext);
    }
    finally
    {
      CleanupUi();
    }
  }

  private async Task RefreshStatusAsync()
  {
    if (_refreshInProgress || _disposed)
    {
      return;
    }

    _refreshInProgress = true;
    try
    {
      var snapshot = await _runtime.GetStatusSnapshotAsync(CancellationToken.None);
      if (_notifyIcon is null) return;

      var icon = _waitingIcon ?? SystemIcons.Application;
      var statusText = "Waiting for scanner lease";
      if (string.Equals(snapshot.ScannerStatus, "error", StringComparison.OrdinalIgnoreCase))
      {
        icon = _errorIcon ?? SystemIcons.Error;
        statusText = "Error";
      }
      else if (snapshot.ScannerClaimed && string.Equals(snapshot.ScannerStatus, "ready", StringComparison.OrdinalIgnoreCase))
      {
        icon = _readyIcon ?? SystemIcons.Application;
        statusText = "Ready";
      }
      else if (string.Equals(snapshot.ScannerStatus, "starting", StringComparison.OrdinalIgnoreCase))
      {
        icon = _waitingIcon ?? SystemIcons.Application;
        statusText = "Starting";
      }

      _notifyIcon.Icon = icon;
      _notifyIcon.Text = TruncateNotifyText($"FTD OPOS Bridge: {statusText} (seq {snapshot.LastSeq})");
    }
    catch (Exception ex)
    {
      _logger.LogDebug(ex, "Tray status refresh failed.");
      if (_notifyIcon is not null)
      {
        _notifyIcon.Icon = _errorIcon ?? SystemIcons.Error;
        _notifyIcon.Text = TruncateNotifyText("FTD OPOS Bridge: status unavailable");
      }
    }
    finally
    {
      _refreshInProgress = false;
    }
  }

  private void ShowAboutDialog()
  {
    try
    {
      // Get detected scanner and printer logical names
      var scannerNames = OposDeviceEnumerator.GetOposLogicalNames("Scanner");
      var printerNames = OposDeviceEnumerator.GetOposLogicalNames("POSPrinter");
      var configuredPrinter = PrinterPreferences.Load().PrinterLogicalName ?? "";
      var lines = new[]
      {
        $"Version: {_options.Version}",
        $"Logical Name: {_options.LogicalName}",
        $"Configured Printer Logical Name: {configuredPrinter}",
        $"Port: {_options.Port}",
        $"Mode: {_options.ScannerMode}",
        $"Logs: {Path.Combine(_options.LogDirectory, "opos-scanner-bridge.log")}",
      };
      // Use the new .ico for the about dialog
      AboutDialogWindow.Show(
        "FTD OPOS Bridge",
        string.Join(Environment.NewLine, lines),
        "opos-bridge.ico",
        scannerNames,
        printerNames,
        configuredPrinter);
    }
    catch (Exception ex)
    {
      _logger.LogDebug(ex, "Unable to show tray about dialog.");
    }
  }

  private void OpenLogViewer()
  {
    try
    {
      var logFile = Path.Combine(_options.LogDirectory, "opos-scanner-bridge.log");
      _logViewerWindow = LogViewerWindow.ShowOrFocus(_logViewerWindow, logFile, "FTD OPOS Bridge Logs");
    }
    catch (Exception ex)
    {
      _logger.LogDebug(ex, "Unable to open log viewer from tray menu.");
    }
  }

  private void CleanupUi()
  {
    try
    {
      if (_refreshTimer is not null)
      {
        _refreshTimer.Stop();
        _refreshTimer.Dispose();
      }
    }
    catch
    {
      // Ignore UI cleanup failures.
    }

    try
    {
      if (_notifyIcon is not null)
      {
        _notifyIcon.Visible = false;
        _notifyIcon.Dispose();
      }
    }
    catch
    {
      // Ignore UI cleanup failures.
    }

    _readyIcon?.Dispose();
    _waitingIcon?.Dispose();
    _errorIcon?.Dispose();
    if (_logViewerWindow is { IsDisposed: false })
    {
      _logViewerWindow.Close();
      _logViewerWindow.Dispose();
      _logViewerWindow = null;
    }
  }

  private static string TruncateNotifyText(string text)
  {
    var raw = string.IsNullOrWhiteSpace(text) ? "FTD OPOS Bridge" : text.Trim();
    return raw.Length <= 63 ? raw : raw[..63];
  }

  private static Icon CreateStatusIcon(Color color)
  {
    using var bitmap = new Bitmap(16, 16);
    using (var graphics = Graphics.FromImage(bitmap))
    {
      graphics.Clear(Color.Transparent);
      graphics.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
      using var brush = new SolidBrush(color);
      using var pen = new Pen(Color.FromArgb(40, 40, 40));
      graphics.FillEllipse(brush, 1, 1, 13, 13);
      graphics.DrawEllipse(pen, 1, 1, 13, 13);
    }

    var handle = bitmap.GetHicon();
    try
    {
      return (Icon)Icon.FromHandle(handle).Clone();
    }
    finally
    {
      _ = DestroyIcon(handle);
    }
  }

  [DllImport("user32.dll", SetLastError = true)]
  private static extern bool DestroyIcon(IntPtr hIcon);
}
