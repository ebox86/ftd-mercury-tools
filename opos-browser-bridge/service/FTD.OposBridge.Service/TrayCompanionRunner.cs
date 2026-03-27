using System.Drawing;
using System.Net.Http.Json;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Windows.Forms;

namespace FTD.OposBridge.Service;

public static class TrayCompanionRunner
{
  public static Task<int> RunAsync(BridgeOptions options)
  {
    if (!OperatingSystem.IsWindows())
    {
      Console.Error.WriteLine("Tray companion mode is only supported on Windows.");
      return Task.FromResult(1);
    }

    if (!Environment.UserInteractive)
    {
      Console.Error.WriteLine("Tray companion mode requires an interactive user session.");
      return Task.FromResult(1);
    }

    Application.EnableVisualStyles();
    Application.SetCompatibleTextRenderingDefault(false);
    using var app = new TrayCompanionApp(options);
    return Task.FromResult(app.Run());
  }

  private sealed class TrayCompanionApp : IDisposable
  {
    private readonly BridgeOptions _options;
    private readonly HttpClient _http;
    private readonly ApplicationContext _context = new();
    private readonly NotifyIcon _notifyIcon;
    private readonly System.Windows.Forms.Timer _timer;
    private readonly Icon _readyIcon;
    private readonly Icon _waitingIcon;
    private readonly Icon _errorIcon;
    private readonly string _healthUrl;
    private readonly string _logFilePath;
    private LogViewerWindow? _logViewerWindow;
    private bool _refreshInProgress;
    private bool _disposed;

    private string _statusText = "Starting";
    private string _scannerStatus = "starting";
    private bool _scannerClaimed;
    private long _lastSeq;
    private string _lastError = "";
    private DateTimeOffset _lastUpdatedAt = DateTimeOffset.MinValue;

    public TrayCompanionApp(BridgeOptions options)
    {
      _options = options;
      _healthUrl = BuildHealthUrl(options);
      _logFilePath = Path.Combine(options.LogDirectory, "opos-scanner-bridge.log");
      _http = new HttpClient { Timeout = TimeSpan.FromSeconds(2) };
      _readyIcon = CreateStatusIcon(Color.FromArgb(46, 139, 87));
      _waitingIcon = CreateStatusIcon(Color.FromArgb(216, 155, 36));
      _errorIcon = CreateStatusIcon(Color.FromArgb(198, 40, 40));

      var menu = new ContextMenuStrip();
      menu.Items.Add("About", null, (_, _) => ShowAboutDialog());
      menu.Items.Add("View Logs", null, (_, _) => OpenLogs());
      menu.Items.Add(new ToolStripSeparator());
      menu.Items.Add("Exit", null, (_, _) => _context.ExitThread());

      _notifyIcon = new NotifyIcon
      {
        Visible = true,
        Icon = _waitingIcon,
        Text = TruncateNotifyText("FTD OPOS Bridge: starting"),
        ContextMenuStrip = menu,
      };

      _timer = new System.Windows.Forms.Timer
      {
        Interval = Math.Max(250, _options.TrayPollIntervalMs),
      };
      _timer.Tick += async (_, _) => await RefreshAsync();
      _timer.Start();
      _context.ThreadExit += (_, _) => Dispose();
    }

    public int Run()
    {
      Application.Run(_context);
      return 0;
    }

    public void Dispose()
    {
      if (_disposed) return;
      _disposed = true;

      try
      {
        _timer.Stop();
      }
      catch
      {
        // Ignore timer shutdown failures.
      }

      _timer.Dispose();
      _http.Dispose();
      _notifyIcon.Visible = false;
      _notifyIcon.Dispose();
      _readyIcon.Dispose();
      _waitingIcon.Dispose();
      _errorIcon.Dispose();
      if (_logViewerWindow is { IsDisposed: false })
      {
        _logViewerWindow.Close();
        _logViewerWindow.Dispose();
        _logViewerWindow = null;
      }
    }

    private async Task RefreshAsync()
    {
      if (_disposed || _refreshInProgress) return;
      _refreshInProgress = true;
      try
      {
        using var response = await _http.GetAsync(_healthUrl);
        if (!response.IsSuccessStatusCode)
        {
          SetUnavailable($"HTTP {(int)response.StatusCode}");
          return;
        }

        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        var scannerStatus = JsonGetString(body, "scannerStatus");
        var scannerClaimed = JsonGetBool(body, "scannerClaimed");
        var lastSeq = JsonGetLong(body, "lastSeq");
        var lastError = JsonGetString(body, "lastError");

        _scannerStatus = string.IsNullOrWhiteSpace(scannerStatus) ? "unknown" : scannerStatus;
        _scannerClaimed = scannerClaimed;
        _lastSeq = lastSeq;
        _lastError = lastError;
        _lastUpdatedAt = DateTimeOffset.Now;

        if (!string.IsNullOrWhiteSpace(lastError) || string.Equals(_scannerStatus, "error", StringComparison.OrdinalIgnoreCase))
        {
          _statusText = "Error";
          _notifyIcon.Icon = _errorIcon;
        }
        else if (_scannerClaimed && string.Equals(_scannerStatus, "ready", StringComparison.OrdinalIgnoreCase))
        {
          _statusText = "Ready";
          _notifyIcon.Icon = _readyIcon;
        }
        else if (string.Equals(_scannerStatus, "starting", StringComparison.OrdinalIgnoreCase))
        {
          _statusText = "Starting";
          _notifyIcon.Icon = _waitingIcon;
        }
        else
        {
          _statusText = "Waiting";
          _notifyIcon.Icon = _waitingIcon;
        }

        _notifyIcon.Text = TruncateNotifyText($"FTD OPOS Bridge: {_statusText} (seq {_lastSeq})");
      }
      catch (Exception ex)
      {
        SetUnavailable(ex.Message);
      }
      finally
      {
        _refreshInProgress = false;
      }
    }

    private void SetUnavailable(string reason)
    {
      _statusText = "Unavailable";
      _scannerStatus = "offline";
      _scannerClaimed = false;
      _lastError = $"Bridge not reachable ({reason})";
      _notifyIcon.Icon = _errorIcon;
      _notifyIcon.Text = TruncateNotifyText("FTD OPOS Bridge: unavailable");
    }

    private void ShowAboutDialog()
    {
      var lines = new[]
      {
        $"Version: {_options.Version}",
        $"Bridge URL: {_healthUrl.Replace("/health", "", StringComparison.OrdinalIgnoreCase)}",
        $"Status: {_statusText}",
        $"Scanner: {_scannerStatus}",
        $"Claimed: {_scannerClaimed}",
        $"Last Seq: {_lastSeq}",
        $"Last Error: {(_lastError ?? "")}",
        $"Last Update: {(_lastUpdatedAt == DateTimeOffset.MinValue ? "n/a" : _lastUpdatedAt.ToString("g"))}",
        $"Logs: {_logFilePath}",
      };
      AboutDialogWindow.Show(
        "FTD OPOS Bridge Tray Companion",
        string.Join(Environment.NewLine, lines));
    }

    private void OpenLogs()
    {
      try
      {
        _logViewerWindow = LogViewerWindow.ShowOrFocus(_logViewerWindow, _logFilePath, "FTD OPOS Bridge Logs");
      }
      catch
      {
        // Ignore viewer-launch failures.
      }
    }

    private static string BuildHealthUrl(BridgeOptions options)
    {
      var baseUrl = string.IsNullOrWhiteSpace(options.BridgeBaseUrl)
        ? $"http://127.0.0.1:{options.Port}"
        : options.BridgeBaseUrl.Trim();
      return $"{baseUrl.TrimEnd('/')}/health";
    }

    private static string JsonGetString(JsonElement root, string propertyName)
    {
      if (root.ValueKind != JsonValueKind.Object) return "";
      if (!root.TryGetProperty(propertyName, out var prop)) return "";
      return prop.ValueKind switch
      {
        JsonValueKind.String => prop.GetString() ?? "",
        JsonValueKind.Number => prop.GetRawText(),
        JsonValueKind.True => "true",
        JsonValueKind.False => "false",
        _ => "",
      };
    }

    private static bool JsonGetBool(JsonElement root, string propertyName)
    {
      if (root.ValueKind != JsonValueKind.Object) return false;
      if (!root.TryGetProperty(propertyName, out var prop)) return false;
      if (prop.ValueKind == JsonValueKind.True) return true;
      if (prop.ValueKind == JsonValueKind.False) return false;
      if (prop.ValueKind == JsonValueKind.String && bool.TryParse(prop.GetString(), out var parsed)) return parsed;
      return false;
    }

    private static long JsonGetLong(JsonElement root, string propertyName)
    {
      if (root.ValueKind != JsonValueKind.Object) return 0;
      if (!root.TryGetProperty(propertyName, out var prop)) return 0;
      if (prop.ValueKind == JsonValueKind.Number && prop.TryGetInt64(out var parsedNum)) return parsedNum;
      if (prop.ValueKind == JsonValueKind.String && long.TryParse(prop.GetString(), out var parsedText)) return parsedText;
      return 0;
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
}
