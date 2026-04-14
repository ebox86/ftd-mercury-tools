using System.Diagnostics;
using System.Security.Principal;
using System.Text.Json;
using Microsoft.Extensions.Logging;

namespace FTD.OposBridge.Service;

public sealed class BridgeObservability
{
  private readonly BridgeOptions _options;
  private readonly object _sync = new();
  private string _logFilePath = "";
  private bool _eventLogEnabled;
  private string _eventLogSourceResolved = "Windows PowerShell";

  public BridgeObservability(BridgeOptions options)
  {
    _options = options;
    InitializeLogging();
    InitializeEventLog();
  }

  public string LogFilePath
  {
    get
    {
      lock (_sync)
      {
        return _logFilePath;
      }
    }
  }

  public bool EventLogEnabled
  {
    get
    {
      lock (_sync)
      {
        return _eventLogEnabled;
      }
    }
  }

  public string EventLogSourceResolved
  {
    get
    {
      lock (_sync)
      {
        return _eventLogSourceResolved;
      }
    }
  }

  public void Debug(string message, int eventId = 1000) => Write("DEBUG", message, eventId);
  public void Info(string message, int eventId = 1000) => Write("INFO", message, eventId);
  public void Warn(string message, int eventId = 1000) => Write("WARN", message, eventId);
  public void Error(string message, int eventId = 1000) => Write("ERROR", message, eventId);

  public void StructuredInfo(string eventName, IReadOnlyDictionary<string, object?> fields, int eventId = 1000)
    => WriteStructured("INFO", eventName, fields, eventId);

  public void StructuredWarn(string eventName, IReadOnlyDictionary<string, object?> fields, int eventId = 1000)
    => WriteStructured("WARN", eventName, fields, eventId);

  public void StructuredError(string eventName, IReadOnlyDictionary<string, object?> fields, int eventId = 1000)
    => WriteStructured("ERROR", eventName, fields, eventId);

  private void InitializeLogging()
  {
    lock (_sync)
    {
      var candidates = new List<string>
      {
        _options.LogDirectory,
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "FTD", "OposBridge", "Logs"),
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "FTD", "OposBridge", "Logs"),
        Path.Combine(AppContext.BaseDirectory, "logs"),
      };

      foreach (var candidate in candidates)
      {
        if (string.IsNullOrWhiteSpace(candidate))
        {
          continue;
        }

        try
        {
          if (!Directory.Exists(candidate))
          {
            Directory.CreateDirectory(candidate);
          }

          var candidateFile = Path.Combine(candidate, "opos-scanner-bridge.log");
          File.AppendAllText(candidateFile, "");
          _logFilePath = candidateFile;
          return;
        }
        catch
        {
          // Try next candidate.
        }
      }

      _logFilePath = "";
    }
  }

  private void InitializeEventLog()
  {
    lock (_sync)
    {
      if (_options.DisableEventLog)
      {
        _eventLogEnabled = false;
        _eventLogSourceResolved = "disabled";
        return;
      }

      var resolved = "Windows PowerShell";
      var enabled = true;
      try
      {
        if (!string.IsNullOrWhiteSpace(_options.EventLogSource))
        {
          if (EventLog.SourceExists(_options.EventLogSource))
          {
            resolved = _options.EventLogSource;
          }
          else if (IsElevated())
          {
            var data = new EventSourceCreationData(_options.EventLogSource, _options.EventLogName);
            EventLog.CreateEventSource(data);
            resolved = _options.EventLogSource;
          }
        }
      }
      catch
      {
        enabled = true;
      }

      _eventLogSourceResolved = resolved;
      _eventLogEnabled = enabled;
    }
  }

  private void Write(string level, string message, int eventId)
  {
    if (string.IsNullOrWhiteSpace(message))
    {
      return;
    }

    if (!ShouldWrite(level))
    {
      return;
    }

    var stamp = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss.fff");
    var line = $"[{stamp}] [{level}] {message}";

    lock (_sync)
    {
      RotateLogIfNeededUnsafe();
      if (!string.IsNullOrWhiteSpace(_logFilePath))
      {
        try
        {
          File.AppendAllText(_logFilePath, line + Environment.NewLine);
        }
        catch
        {
          // Keep bridge running even if disk log is unavailable.
        }
      }

      if (_eventLogEnabled && !string.Equals(level, "DEBUG", StringComparison.OrdinalIgnoreCase))
      {
        try
        {
          var entryType = EventLogEntryType.Information;
          if (string.Equals(level, "WARN", StringComparison.OrdinalIgnoreCase))
          {
            entryType = EventLogEntryType.Warning;
          }
          else if (string.Equals(level, "ERROR", StringComparison.OrdinalIgnoreCase))
          {
            entryType = EventLogEntryType.Error;
          }

          EventLog.WriteEntry(_eventLogSourceResolved, message, entryType, eventId);
        }
        catch
        {
          _eventLogEnabled = false;
        }
      }
    }
  }

  private void WriteStructured(string level, string eventName, IReadOnlyDictionary<string, object?> fields, int eventId)
  {
    var payload = new Dictionary<string, object?>(StringComparer.OrdinalIgnoreCase)
    {
      ["event"] = eventName,
      ["level"] = level,
      ["at"] = DateTimeOffset.Now.ToString("o"),
    };

    if (fields is not null)
    {
      foreach (var pair in fields)
      {
        payload[pair.Key] = pair.Value;
      }
    }

    var json = JsonSerializer.Serialize(payload);
    Write(level, json, eventId);
  }

  private bool ShouldWrite(string level)
  {
    var normalized = (level ?? "").Trim();
    if (string.IsNullOrWhiteSpace(normalized))
    {
      return true;
    }

    var mapped = ParseLogLevel(normalized);
    if (!mapped.HasValue)
    {
      return true;
    }

    return mapped.Value >= _options.MinimumLogLevel;
  }

  private static LogLevel? ParseLogLevel(string level)
  {
    switch (level.ToUpperInvariant())
    {
      case "TRACE":
        return LogLevel.Trace;
      case "DEBUG":
        return LogLevel.Debug;
      case "INFO":
      case "INFORMATION":
        return LogLevel.Information;
      case "WARN":
      case "WARNING":
        return LogLevel.Warning;
      case "ERROR":
        return LogLevel.Error;
      case "CRITICAL":
      case "FATAL":
        return LogLevel.Critical;
      default:
        if (Enum.TryParse<LogLevel>(level, true, out var parsed))
        {
          return parsed;
        }

        return null;
    }
  }

  private void RotateLogIfNeededUnsafe()
  {
    if (string.IsNullOrWhiteSpace(_logFilePath))
    {
      return;
    }

    try
    {
      if (!File.Exists(_logFilePath))
      {
        return;
      }

      var maxBytes = Math.Max(262144, _options.MaxLogFileBytes);
      var maxFiles = Math.Max(2, _options.MaxLogFiles);
      var size = new FileInfo(_logFilePath).Length;
      if (size < maxBytes)
      {
        return;
      }

      for (var i = maxFiles - 1; i >= 1; i--)
      {
        var src = $"{_logFilePath}.{i}";
        var dst = $"{_logFilePath}.{i + 1}";
        if (File.Exists(dst))
        {
          File.Delete(dst);
        }

        if (File.Exists(src))
        {
          File.Move(src, dst);
        }
      }

      var firstArchive = $"{_logFilePath}.1";
      if (File.Exists(firstArchive))
      {
        File.Delete(firstArchive);
      }

      File.Move(_logFilePath, firstArchive);
    }
    catch
    {
      // Avoid throwing from log rotation.
    }
  }

  private static bool IsElevated()
  {
    if (!OperatingSystem.IsWindows())
    {
      return false;
    }

    try
    {
      using var identity = WindowsIdentity.GetCurrent();
      var principal = new WindowsPrincipal(identity);
      return principal.IsInRole(WindowsBuiltInRole.Administrator);
    }
    catch
    {
      return false;
    }
  }
}
