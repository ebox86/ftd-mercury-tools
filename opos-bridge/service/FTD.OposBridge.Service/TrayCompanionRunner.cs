using System.Drawing;
using System.Diagnostics;
using System.IO.Pipes;
using System.Net.Http.Json;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Windows.Forms;

namespace FTD.OposBridge.Service;

public static class TrayCompanionRunner
{
  private static readonly object HandlerSync = new();
  private static bool _handlersRegistered;

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

    EnsureGlobalExceptionHandlers();
    Application.EnableVisualStyles();
    Application.SetCompatibleTextRenderingDefault(false);
    using var app = new TrayCompanionApp(options);
    return Task.FromResult(app.Run());
  }

  private static void EnsureGlobalExceptionHandlers()
  {
    lock (HandlerSync)
    {
      if (_handlersRegistered)
      {
        return;
      }

      Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
      Application.ThreadException += (_, args) => WriteCrashLog("thread", args.Exception);
      AppDomain.CurrentDomain.UnhandledException += (_, args) =>
      {
        if (args.ExceptionObject is Exception ex)
        {
          WriteCrashLog("domain", ex);
          return;
        }

        WriteCrashLog("domain", new Exception("Unhandled non-exception object."));
      };
      TaskScheduler.UnobservedTaskException += (_, args) =>
      {
        WriteCrashLog("task", args.Exception);
        args.SetObserved();
      };

      _handlersRegistered = true;
    }
  }

  private static void WriteCrashLog(string source, Exception ex)
  {
    try
    {
      var logDir = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
        "FTD",
        "OposBridge",
        "Logs");
      Directory.CreateDirectory(logDir);

      var crashLog = Path.Combine(logDir, "opos-tray-companion-crash.log");
      var message =
        $"[{DateTime.Now:yyyy-MM-dd HH:mm:ss.fff}] [{source}] {ex.GetType().Name}: {ex.Message}{Environment.NewLine}{ex.StackTrace}{Environment.NewLine}";
      File.AppendAllText(crashLog, message + Environment.NewLine);
    }
    catch
    {
      // Never crash the tray while writing crash diagnostics.
    }
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
    private string _logFilePath;
    private LogViewerWindow? _logViewerWindow;
    private bool _refreshInProgress;
    private bool _disposed;
    private DateTimeOffset _nextServiceStartAttemptAt = DateTimeOffset.MinValue;
    private DateTimeOffset _nextServiceRestartAttemptAt = DateTimeOffset.MinValue;
    private bool _serviceStopAttempted;
    private int _consecutiveHealthFailures;
    private readonly CancellationTokenSource _printRelayCts = new();
    private readonly Task _printRelayTask;
    private readonly BridgeObservability _printRelayObservability;
    private readonly OposPrinterDriver _printRelayDriver;
    private readonly string _printRelayPipeName;

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
      _logFilePath = ResolveBestLogFilePath(Path.Combine(options.LogDirectory, "opos-scanner-bridge.log"));
      _http = new HttpClient { Timeout = TimeSpan.FromSeconds(8) };
      _printRelayObservability = new BridgeObservability(options);
      _printRelayDriver = new OposPrinterDriver(options, _printRelayObservability);
      _printRelayPipeName = OposPrinterDriver.BuildPrintRelayPipeName(options.Port);
      _printRelayTask = Task.Run(() => RunPrintRelayServerAsync(_printRelayCts.Token));
      _readyIcon = CreateStatusIcon(Color.FromArgb(46, 139, 87));
      _waitingIcon = CreateStatusIcon(Color.FromArgb(216, 155, 36));
      _errorIcon = CreateStatusIcon(Color.FromArgb(198, 40, 40));

      var menu = new ContextMenuStrip();
      menu.Items.Add("Printer Settings", null, (_, _) => ShowPrinterSettingsDialog());
      menu.Items.Add("About", null, (_, _) => ShowAboutDialog());
      menu.Items.Add("View Logs", null, (_, _) => OpenLogs());
      menu.Items.Add(new ToolStripSeparator());
      menu.Items.Add("Exit", null, (_, _) =>
      {
        _context.ExitThread();
      });

      _notifyIcon = new NotifyIcon
      {
        Visible = true,
        Icon = _waitingIcon,
        Text = TruncateNotifyText("FTD OPOS Bridge: starting"),
        ContextMenuStrip = menu,
      };
      TrySetNotifyPresentation(_waitingIcon, "FTD OPOS Bridge: starting");

      _timer = new System.Windows.Forms.Timer
      {
        Interval = Math.Max(250, _options.TrayPollIntervalMs),
      };
      _timer.Tick += async (_, _) => await RefreshAsync();
      _timer.Start();
      _context.ThreadExit += (_, _) => Dispose();

      var startupError = EnsureServiceRunningFromTray("startup");
      if (!string.IsNullOrWhiteSpace(startupError))
      {
        _lastError = startupError;
      }
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

      StopServiceFromTray();
      try
      {
        _printRelayCts.Cancel();
      }
      catch
      {
        // Ignore relay cancellation failures.
      }

      try
      {
        _printRelayTask.Wait(TimeSpan.FromSeconds(2));
      }
      catch
      {
        // Ignore relay shutdown failures.
      }

      _timer.Dispose();
      _http.Dispose();
      _printRelayCts.Dispose();
      try
      {
        _notifyIcon.Visible = false;
      }
      catch
      {
        // Ignore notification area shutdown failures.
      }

      try
      {
        _notifyIcon.Dispose();
      }
      catch
      {
        // Ignore notification area shutdown failures.
      }
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

    private async Task RunPrintRelayServerAsync(CancellationToken cancellationToken)
    {
      while (!cancellationToken.IsCancellationRequested)
      {
        NamedPipeServerStream? server = null;
        try
        {
          server = new NamedPipeServerStream(
            _printRelayPipeName,
            PipeDirection.InOut,
            1,
            PipeTransmissionMode.Byte,
            PipeOptions.Asynchronous);

          await server.WaitForConnectionAsync(cancellationToken);
          await HandlePrintRelayRequestAsync(server, cancellationToken);
        }
        catch (OperationCanceledException)
        {
          break;
        }
        catch (Exception ex)
        {
          _lastError = $"Tray print relay error: {ex.Message}";
          try
          {
            await Task.Delay(300, cancellationToken);
          }
          catch
          {
            // Ignore cancellation during relay backoff.
          }
        }
        finally
        {
          try
          {
            server?.Dispose();
          }
          catch
          {
            // Best-effort cleanup.
          }
        }
      }
    }

    private async Task HandlePrintRelayRequestAsync(NamedPipeServerStream server, CancellationToken cancellationToken)
    {
      var response = new PrintRelayResponse
      {
        Ok = false,
        Error = "Invalid print relay request."
      };

      try
      {
        using var reader = new StreamReader(server, System.Text.Encoding.UTF8, detectEncodingFromByteOrderMarks: true, bufferSize: 1024, leaveOpen: true);

        var requestJson = await reader.ReadLineAsync(cancellationToken);
        var request = string.IsNullOrWhiteSpace(requestJson)
          ? null
          : JsonSerializer.Deserialize<PrintRelayRequest>(requestJson);
        if (request is null)
        {
          response.Error = "Print relay request body was empty.";
        }
        else
        {
          var prefs = PrinterPreferences.Load();
          var requestedLogicalName = (request.LogicalName ?? "").Trim();
          if (!string.IsNullOrWhiteSpace(requestedLogicalName))
          {
            prefs.PrinterLogicalName = requestedLogicalName;
          }

          var ok = await _printRelayDriver.PrintAsync(request.Data ?? "", prefs, cancellationToken);
          response.Ok = ok;
          response.Error = ok ? "" : (_printRelayDriver.LastError ?? "Print failed.");
        }
      }
      catch (OperationCanceledException)
      {
        throw;
      }
      catch (Exception ex)
      {
        response.Ok = false;
        response.Error = ex.Message;
      }

      using var outWriter = new StreamWriter(server, System.Text.Encoding.UTF8, 1024, leaveOpen: true)
      {
        AutoFlush = true
      };
      await outWriter.WriteLineAsync(JsonSerializer.Serialize(response));
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
          SetUnavailable($"HTTP {(int)response.StatusCode}", transient: false);
          return;
        }

        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        var scannerStatus = JsonGetString(body, "scannerStatus");
        var scannerClaimed = JsonGetBool(body, "scannerClaimed");
        var lastSeq = JsonGetLong(body, "lastSeq");
        var lastError = JsonGetString(body, "lastError");
        var logFile = JsonGetString(body, "logFile");

        _scannerStatus = string.IsNullOrWhiteSpace(scannerStatus) ? "unknown" : scannerStatus;
        _scannerClaimed = scannerClaimed;
        _lastSeq = lastSeq;
        _lastError = lastError;
        _logFilePath = ResolveBestLogFilePath(logFile);
        _lastUpdatedAt = DateTimeOffset.Now;
        _consecutiveHealthFailures = 0;

        if (string.Equals(_scannerStatus, "error", StringComparison.OrdinalIgnoreCase))
        {
          _statusText = "Error";
          TrySetNotifyPresentation(_errorIcon, $"FTD OPOS Bridge: {_statusText} (seq {_lastSeq})");
        }
        else if (_scannerClaimed && string.Equals(_scannerStatus, "ready", StringComparison.OrdinalIgnoreCase))
        {
          _statusText = "Ready";
          TrySetNotifyPresentation(_readyIcon, $"FTD OPOS Bridge: {_statusText} (seq {_lastSeq})");
        }
        else if (string.Equals(_scannerStatus, "starting", StringComparison.OrdinalIgnoreCase))
        {
          _statusText = "Starting";
          TrySetNotifyPresentation(_waitingIcon, $"FTD OPOS Bridge: {_statusText} (seq {_lastSeq})");
        }
        else
        {
          _statusText = "Waiting";
          TrySetNotifyPresentation(_waitingIcon, $"FTD OPOS Bridge: {_statusText} (seq {_lastSeq})");
        }
      }
      catch (Exception ex)
      {
        SetUnavailable(ex.Message, IsTransientConnectivityFailure(ex));
      }
      finally
      {
        _refreshInProgress = false;
      }
    }

    private void SetUnavailable(string reason, bool transient)
    {
      _consecutiveHealthFailures++;
      _scannerStatus = "offline";
      _scannerClaimed = false;
      _lastError = $"Bridge not reachable ({reason})";
      _logFilePath = ResolveBestLogFilePath(_logFilePath);

      var hasRecentSuccess =
        _lastUpdatedAt != DateTimeOffset.MinValue &&
        (DateTimeOffset.Now - _lastUpdatedAt) < TimeSpan.FromSeconds(45);
      var repeatedFailures = _consecutiveHealthFailures >= 3;

      if (transient && (hasRecentSuccess || !repeatedFailures))
      {
        _statusText = "Waiting";
        TrySetNotifyPresentation(_waitingIcon, "FTD OPOS Bridge: waiting");
      }
      else
      {
        _statusText = "Unavailable";
        TrySetNotifyPresentation(_errorIcon, "FTD OPOS Bridge: unavailable");
      }

      var neverHealthyYet = _lastUpdatedAt == DateTimeOffset.MinValue;
      if (!transient || repeatedFailures || neverHealthyYet)
      {
        var serviceError = EnsureServiceRunningFromTray("health-unavailable");
        if (!string.IsNullOrWhiteSpace(serviceError))
        {
          _lastError = serviceError;
        }
        else if (repeatedFailures)
        {
          var restartError = RestartServiceFromTray("health-unavailable");
          if (!string.IsNullOrWhiteSpace(restartError))
          {
            _lastError = restartError;
          }
        }
      }
    }

    private void ShowAboutDialog()
    {
      _logFilePath = ResolveBestLogFilePath(_logFilePath);
      var scannerNames = OposDeviceEnumerator.GetOposLogicalNames("Scanner");
      var printerNames = OposDeviceEnumerator.GetOposLogicalNames("POSPrinter");
      var configuredPrinter = PrinterPreferences.Load().PrinterLogicalName ?? "";
      var lines = new[]
      {
        $"Version: {_options.Version}",
        $"Service Name: {_options.ServiceName}",
        $"Bridge URL: {_healthUrl.Replace("/health", "", StringComparison.OrdinalIgnoreCase)}",
        $"Status: {_statusText}",
        $"Scanner: {_scannerStatus}",
        $"Claimed: {_scannerClaimed}",
        $"Configured Scanner Logical Name: {_options.LogicalName}",
        $"Configured Printer Logical Name: {configuredPrinter}",
        $"Last Seq: {_lastSeq}",
        $"Last Error: {(_lastError ?? "")}",
        $"Last Update: {(_lastUpdatedAt == DateTimeOffset.MinValue ? "n/a" : _lastUpdatedAt.ToString("g"))}",
        $"Logs: {_logFilePath}",
      };
      AboutDialogWindow.Show(
        "FTD OPOS Bridge Tray Companion",
        string.Join(Environment.NewLine, lines),
        "about-scanner.png",
        scannerNames,
        printerNames,
        configuredPrinter);
    }

    private void OpenLogs()
    {
      try
      {
        _logFilePath = ResolveBestLogFilePath(_logFilePath);
        _logViewerWindow = LogViewerWindow.ShowOrFocus(_logViewerWindow, _logFilePath, "FTD OPOS Bridge Logs");
      }
      catch
      {
        // Ignore viewer-launch failures.
      }
    }

    private void ShowPrinterSettingsDialog()
    {
      try
      {
        PrinterSettingsDialog.ShowDialogForPrefs(BuildBridgeBaseUrl(_options));
      }
      catch (Exception ex)
      {
        _lastError = $"Unable to open printer settings: {ex.Message}";
      }
    }

    private static string BuildBridgeBaseUrl(BridgeOptions options)
    {
      var baseUrl = string.IsNullOrWhiteSpace(options.BridgeBaseUrl)
        ? $"http://127.0.0.1:{options.Port}"
        : options.BridgeBaseUrl.Trim();
      return baseUrl.TrimEnd('/');
    }

    private static string BuildHealthUrl(BridgeOptions options)
    {
      return $"{BuildBridgeBaseUrl(options)}/health";
    }

    private bool IsTransientConnectivityFailure(Exception ex)
    {
      if (ex is TaskCanceledException or OperationCanceledException or TimeoutException)
      {
        return true;
      }

      var baseEx = ex.GetBaseException();
      if (baseEx is TimeoutException or TaskCanceledException or OperationCanceledException)
      {
        return true;
      }

      return ex.Message.Contains("HttpClient.Timeout", StringComparison.OrdinalIgnoreCase)
        || baseEx.Message.Contains("HttpClient.Timeout", StringComparison.OrdinalIgnoreCase);
    }

    private string ResolveBestLogFilePath(string? preferredPath)
    {
      var fallback = string.IsNullOrWhiteSpace(_logFilePath)
        ? Path.Combine(_options.LogDirectory, "opos-scanner-bridge.log")
        : _logFilePath;

      var candidates = new List<string>();
      var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

      void AddCandidate(string? candidate)
      {
        var value = (candidate ?? "").Trim();
        if (string.IsNullOrWhiteSpace(value))
        {
          return;
        }

        if (seen.Add(value))
        {
          candidates.Add(value);
        }
      }

      AddCandidate(preferredPath);
      AddCandidate(_logFilePath);
      AddCandidate(Path.Combine(_options.LogDirectory, "opos-scanner-bridge.log"));
      AddCandidate(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "FTD", "OposBridge", "Logs", "opos-scanner-bridge.log"));
      AddCandidate(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "FTD", "OposBridge", "Logs", "opos-scanner-bridge.log"));
      AddCandidate(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), @"Microsoft\Windows\Logs\FTD\opos-scanner-bridge.log"));
      AddCandidate(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), @"ServiceProfiles\LocalService\AppData\Local\FTD\OposBridge\Logs\opos-scanner-bridge.log"));
      AddCandidate(Path.Combine(AppContext.BaseDirectory, "logs", "opos-scanner-bridge.log"));

      string bestPath = "";
      DateTime bestWrite = DateTime.MinValue;
      foreach (var candidate in candidates)
      {
        try
        {
          if (!File.Exists(candidate))
          {
            continue;
          }

          var writeTime = File.GetLastWriteTimeUtc(candidate);
          if (writeTime >= bestWrite)
          {
            bestWrite = writeTime;
            bestPath = candidate;
          }
        }
        catch
        {
          // Ignore unreadable candidates.
        }
      }

      if (!string.IsNullOrWhiteSpace(bestPath))
      {
        return bestPath;
      }

      var preferred = (preferredPath ?? "").Trim();
      if (!string.IsNullOrWhiteSpace(preferred))
      {
        return preferred;
      }

      return fallback;
    }

    private string EnsureServiceRunningFromTray(string reason)
    {
      if (_disposed)
      {
        return "";
      }

      var now = DateTimeOffset.UtcNow;
      if (now < _nextServiceStartAttemptAt)
      {
        return "";
      }

      _nextServiceStartAttemptAt = now.AddSeconds(10);

      try
      {
        return EnsureServiceRunningCore(reason);
      }
      catch (Exception ex)
      {
        return $"Unable to start service '{_options.ServiceName}' from tray: {ex.Message}";
      }
    }

    private string RestartServiceFromTray(string reason)
    {
      if (_disposed)
      {
        return "";
      }

      var now = DateTimeOffset.UtcNow;
      if (now < _nextServiceRestartAttemptAt)
      {
        return "";
      }

      _nextServiceRestartAttemptAt = now.AddSeconds(45);

      try
      {
        var query = RunScCommand($"query \"{_options.ServiceName}\"");
        if (query.ExitCode == 1060)
        {
          return $"Service '{_options.ServiceName}' was not found.";
        }

        if (query.ExitCode != 0)
        {
          return $"Unable to query service '{_options.ServiceName}' for restart (exit {query.ExitCode}; {SummarizeScOutput(query.Output)}).";
        }

        var state = ParseServiceState(query.Output);
        if (!string.Equals(state, "STOPPED", StringComparison.OrdinalIgnoreCase))
        {
          var stop = RunScCommand($"stop \"{_options.ServiceName}\"");
          if (stop.ExitCode != 0 && stop.ExitCode != 1062 && stop.ExitCode != 1052)
          {
            return $"Unable to stop service '{_options.ServiceName}' for restart ({reason}, exit {stop.ExitCode}; {SummarizeScOutput(stop.Output)}).";
          }

          var stopWait = WaitForServiceState(TimeSpan.FromSeconds(15), "STOPPED");
          if (!stopWait.Reached)
          {
            return $"Service '{_options.ServiceName}' did not stop for restart ({reason}; state={stopWait.State}, exit {stopWait.ExitCode}).";
          }
        }

        return EnsureServiceRunningCore($"{reason}/restart");
      }
      catch (Exception ex)
      {
        return $"Unable to restart service '{_options.ServiceName}' from tray: {ex.Message}";
      }
    }

    private void StopServiceFromTray()
    {
      if (_serviceStopAttempted)
      {
        return;
      }

      _serviceStopAttempted = true;

      try
      {
        var stopResult = RunScCommand($"stop \"{_options.ServiceName}\"");
        if (stopResult.ExitCode == 0 || stopResult.ExitCode == 1062 || stopResult.ExitCode == 1060)
        {
          return;
        }

        _lastError = $"Unable to stop service '{_options.ServiceName}' when tray exited.";
      }
      catch (Exception ex)
      {
        _lastError = $"Unable to stop service '{_options.ServiceName}' when tray exited: {ex.Message}";
      }
    }

    private static (int ExitCode, string Output) RunScCommand(string arguments)
    {
      var psi = new ProcessStartInfo("sc.exe", arguments)
      {
        CreateNoWindow = true,
        UseShellExecute = false,
        RedirectStandardOutput = true,
        RedirectStandardError = true,
      };

      using var process = Process.Start(psi) ?? throw new InvalidOperationException("Unable to start sc.exe process.");
      var stdout = process.StandardOutput.ReadToEnd();
      var stderr = process.StandardError.ReadToEnd();
      process.WaitForExit();
      return (process.ExitCode, $"{stdout}{Environment.NewLine}{stderr}");
    }

    private string EnsureServiceRunningCore(string reason)
    {
      var queryResult = RunScCommand($"query \"{_options.ServiceName}\"");
      if (queryResult.ExitCode == 1060)
      {
        return $"Service '{_options.ServiceName}' was not found.";
      }

      if (queryResult.ExitCode != 0)
      {
        return $"Unable to query service '{_options.ServiceName}' from tray (exit {queryResult.ExitCode}; {SummarizeScOutput(queryResult.Output)}).";
      }

      var state = ParseServiceState(queryResult.Output);
      if (string.Equals(state, "RUNNING", StringComparison.OrdinalIgnoreCase))
      {
        return "";
      }

      if (string.Equals(state, "START_PENDING", StringComparison.OrdinalIgnoreCase))
      {
        var pendingWait = WaitForServiceState(TimeSpan.FromSeconds(18), "RUNNING");
        if (pendingWait.Reached)
        {
          return "";
        }
      }

      var startResult = RunScCommand($"start \"{_options.ServiceName}\"");
      if (startResult.ExitCode != 0 && startResult.ExitCode != 1056 && startResult.ExitCode != 1053)
      {
        return $"Unable to start service '{_options.ServiceName}' from tray ({reason}, exit {startResult.ExitCode}; {SummarizeScOutput(startResult.Output)}).";
      }

      var startWait = WaitForServiceState(TimeSpan.FromSeconds(20), "RUNNING");
      if (startWait.Reached)
      {
        return "";
      }

      if (startWait.ExitCode == 1060 || string.Equals(startWait.State, "NOT_FOUND", StringComparison.OrdinalIgnoreCase))
      {
        return $"Service '{_options.ServiceName}' was removed while starting ({reason}).";
      }

      return
        $"Service '{_options.ServiceName}' failed to reach RUNNING ({reason}; state={startWait.State}, startExit={startResult.ExitCode}, details={SummarizeScOutput(startResult.Output)}).";
    }

    private (bool Reached, string State, int ExitCode, string Output) WaitForServiceState(TimeSpan timeout, params string[] desiredStates)
    {
      var desired = new HashSet<string>(desiredStates ?? Array.Empty<string>(), StringComparer.OrdinalIgnoreCase);
      var deadline = DateTimeOffset.UtcNow.Add(timeout);
      var lastState = "UNKNOWN";
      var lastExit = 0;
      var lastOutput = "";

      while (DateTimeOffset.UtcNow < deadline)
      {
        var query = RunScCommand($"query \"{_options.ServiceName}\"");
        lastExit = query.ExitCode;
        lastOutput = query.Output;

        if (query.ExitCode == 1060)
        {
          lastState = "NOT_FOUND";
          return (false, lastState, lastExit, lastOutput);
        }

        if (query.ExitCode == 0)
        {
          lastState = ParseServiceState(query.Output);
          if (desired.Contains(lastState))
          {
            return (true, lastState, lastExit, lastOutput);
          }
        }
        else
        {
          lastState = "UNKNOWN";
        }

        Thread.Sleep(300);
      }

      return (false, lastState, lastExit, lastOutput);
    }

    private static string ParseServiceState(string output)
    {
      var text = output ?? "";
      if (text.Contains("START_PENDING", StringComparison.OrdinalIgnoreCase))
      {
        return "START_PENDING";
      }

      if (text.Contains("STOP_PENDING", StringComparison.OrdinalIgnoreCase))
      {
        return "STOP_PENDING";
      }

      if (text.Contains("RUNNING", StringComparison.OrdinalIgnoreCase))
      {
        return "RUNNING";
      }

      if (text.Contains("STOPPED", StringComparison.OrdinalIgnoreCase))
      {
        return "STOPPED";
      }

      if (text.Contains("PAUSED", StringComparison.OrdinalIgnoreCase))
      {
        return "PAUSED";
      }

      return "UNKNOWN";
    }

    private static string SummarizeScOutput(string output)
    {
      if (string.IsNullOrWhiteSpace(output))
      {
        return "no sc.exe output";
      }

      var lines = output
        .Replace("\r", "", StringComparison.Ordinal)
        .Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
        .Where(line => !string.IsNullOrWhiteSpace(line))
        .Take(2)
        .ToArray();
      if (lines.Length == 0)
      {
        return "no sc.exe output";
      }

      var summary = string.Join(" | ", lines);
      if (summary.Length > 220)
      {
        return summary[..220] + "...";
      }

      return summary;
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

    private void TrySetNotifyPresentation(Icon icon, string text)
    {
      if (_disposed)
      {
        return;
      }

      try
      {
        _notifyIcon.Icon = icon;
      }
      catch (Exception ex)
      {
        WriteCrashLog("notify-icon", ex);
      }

      try
      {
        _notifyIcon.Text = TruncateNotifyText(text);
      }
      catch (Exception ex)
      {
        WriteCrashLog("notify-text", ex);
      }
    }

    private static string TruncateNotifyText(string text)
    {
      var raw = string.IsNullOrWhiteSpace(text) ? "FTD OPOS Bridge" : text.Trim();
      return raw.Length <= 63 ? raw : raw[..63];
    }

    private sealed class PrintRelayRequest
    {
      public string Data { get; set; } = "";
      public string LogicalName { get; set; } = "";
    }

    private sealed class PrintRelayResponse
    {
      public bool Ok { get; set; }
      public string Error { get; set; } = "";
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
