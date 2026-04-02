using Microsoft.Extensions.Logging;

namespace FTD.OposBridge.Service;

public sealed class BridgeOptions
{
  public string Version { get; init; } = "0.1.0-phase1";
  public string LogicalName { get; init; } = "ZEBRA_SCANNER";
  public int Port { get; init; } = 17331;
  public string ServiceName { get; init; } = "FTD.OposBridge.Service";
  public int ClaimTimeoutMs { get; init; } = 3000;
  public int DefaultLeaseMs { get; init; } = 3500;
  public int MaxLeaseMs { get; init; } = 12000;
  public string LogDirectory { get; init; } = @"C:\ProgramData\FTD\OposBridge\Logs";
  public int MaxLogFileBytes { get; init; } = 1048576;
  public int MaxLogFiles { get; init; } = 5;
  public string EventLogName { get; init; } = "Application";
  public string EventLogSource { get; init; } = "FTD.OposBridge";
  public int PollIntervalMs { get; init; } = 100;
  public int PollingDebounceMs { get; init; } = 1200;
  public int SpikeTimeoutSeconds { get; init; } = 20;
  public bool ScannerSpike { get; init; }
  public bool AgentRelay { get; init; }
  public bool VerboseLogging { get; init; }
  public bool DisableEventLog { get; init; }
  public string ScannerMode { get; init; } = "opos";
  public string InteropDllPath { get; init; } = @"C:\Wings\Interop.OposScanner_1_9_Lib.dll";
  public string BridgeBaseUrl { get; init; } = "http://127.0.0.1:17331";
  public int AgentPollIntervalMs { get; init; } = 120;
  public bool TrayIconEnabled { get; init; } = true;
  public bool HideConsoleOnStartup { get; init; } = true;
  public bool TrayCompanion { get; init; }
  public int TrayPollIntervalMs { get; init; } = 900;
  public LogLevel MinimumLogLevel { get; init; } = LogLevel.Information;

  public static BridgeOptions FromArgs(string[] args)
  {
    var kv = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
    var flags = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

    foreach (var arg in args ?? Array.Empty<string>())
    {
      if (!arg.StartsWith("--", StringComparison.OrdinalIgnoreCase))
      {
        continue;
      }

      var body = arg[2..];
      var split = body.Split('=', 2);
      if (split.Length == 2)
      {
        kv[split[0]] = split[1];
      }
      else if (!string.IsNullOrWhiteSpace(split[0]))
      {
        flags.Add(split[0]);
      }
    }

    return new BridgeOptions
    {
      LogicalName = ResolveString(kv, "logical-name", "FTD_OPOS_LOGICAL_NAME", "ZEBRA_SCANNER"),
      Port = ResolveInt(kv, "port", "FTD_OPOS_BRIDGE_PORT", 17331, 1024, 65535),
      ServiceName = ResolveString(kv, "service-name", "FTD_OPOS_SERVICE_NAME", "FTD.OposBridge.Service"),
      ClaimTimeoutMs = ResolveInt(kv, "claim-timeout-ms", "FTD_OPOS_CLAIM_TIMEOUT_MS", 3000, 100, 60000),
      DefaultLeaseMs = ResolveInt(kv, "default-lease-ms", "FTD_OPOS_DEFAULT_LEASE_MS", 3500, 500, 60000),
      MaxLeaseMs = ResolveInt(kv, "max-lease-ms", "FTD_OPOS_MAX_LEASE_MS", 12000, 500, 600000),
      LogDirectory = ResolveString(kv, "log-directory", "FTD_OPOS_LOG_DIR", @"C:\ProgramData\FTD\OposBridge\Logs"),
      MaxLogFileBytes = ResolveInt(kv, "max-log-file-bytes", "FTD_OPOS_MAX_LOG_FILE_BYTES", 1048576, 262144, 104857600),
      MaxLogFiles = ResolveInt(kv, "max-log-files", "FTD_OPOS_MAX_LOG_FILES", 5, 2, 50),
      EventLogName = ResolveString(kv, "event-log-name", "FTD_OPOS_EVENT_LOG_NAME", "Application"),
      EventLogSource = ResolveString(kv, "event-log-source", "FTD_OPOS_EVENT_LOG_SOURCE", "FTD.OposBridge"),
      PollIntervalMs = ResolveInt(kv, "poll-interval-ms", "FTD_OPOS_POLL_INTERVAL_MS", 100, 25, 5000),
      PollingDebounceMs = ResolveInt(kv, "polling-debounce-ms", "FTD_OPOS_POLLING_DEBOUNCE_MS", 1200, 100, 15000),
      SpikeTimeoutSeconds = ResolveInt(kv, "spike-timeout-seconds", "FTD_OPOS_SPIKE_TIMEOUT_SECONDS", 20, 5, 120),
      ScannerMode = ResolveString(kv, "scanner-mode", "FTD_OPOS_SCANNER_MODE", "opos").Trim().ToLowerInvariant(),
      InteropDllPath = ResolveString(kv, "interop-dll-path", "FTD_OPOS_INTEROP_DLL_PATH", @"C:\Wings\Interop.OposScanner_1_9_Lib.dll"),
      BridgeBaseUrl = ResolveString(kv, "bridge-base-url", "FTD_OPOS_BRIDGE_BASE_URL", "http://127.0.0.1:17331"),
      AgentPollIntervalMs = ResolveInt(kv, "agent-poll-interval-ms", "FTD_OPOS_AGENT_POLL_INTERVAL_MS", 120, 50, 2000),
      TrayIconEnabled = ResolveBool(kv, flags, "tray-icon", "FTD_OPOS_TRAY_ICON", true),
      HideConsoleOnStartup = ResolveBool(kv, flags, "hide-console", "FTD_OPOS_HIDE_CONSOLE", true),
      TrayCompanion = flags.Contains("tray-companion"),
      TrayPollIntervalMs = ResolveInt(kv, "tray-poll-interval-ms", "FTD_OPOS_TRAY_POLL_INTERVAL_MS", 900, 250, 10000),
      ScannerSpike = flags.Contains("scanner-spike"),
      AgentRelay = flags.Contains("agent-relay"),
      VerboseLogging = flags.Contains("verbose"),
      DisableEventLog = flags.Contains("disable-event-log"),
      MinimumLogLevel = ResolveLogLevel(kv, "log-level", "FTD_OPOS_LOG_LEVEL", flags.Contains("verbose") ? LogLevel.Debug : LogLevel.Information),
    };
  }

  private static string ResolveString(
    IReadOnlyDictionary<string, string> kv,
    string key,
    string envName,
    string defaultValue)
  {
    if (kv.TryGetValue(key, out var fromArg) && !string.IsNullOrWhiteSpace(fromArg))
    {
      return fromArg.Trim();
    }

    var fromEnv = Environment.GetEnvironmentVariable(envName);
    if (!string.IsNullOrWhiteSpace(fromEnv))
    {
      return fromEnv.Trim();
    }

    return defaultValue;
  }

  private static int ResolveInt(
    IReadOnlyDictionary<string, string> kv,
    string key,
    string envName,
    int defaultValue,
    int minValue,
    int maxValue)
  {
    if (kv.TryGetValue(key, out var fromArg) && int.TryParse(fromArg, out var parsedArg))
    {
      return Math.Clamp(parsedArg, minValue, maxValue);
    }

    var fromEnv = Environment.GetEnvironmentVariable(envName);
    if (int.TryParse(fromEnv, out var parsedEnv))
    {
      return Math.Clamp(parsedEnv, minValue, maxValue);
    }

    return Math.Clamp(defaultValue, minValue, maxValue);
  }

  private static bool ResolveBool(
    IReadOnlyDictionary<string, string> kv,
    IReadOnlySet<string> flags,
    string key,
    string envName,
    bool defaultValue)
  {
    if (flags.Contains($"no-{key}"))
    {
      return false;
    }

    if (flags.Contains(key))
    {
      return true;
    }

    if (kv.TryGetValue(key, out var fromArg))
    {
      return ParseBoolValue(fromArg, defaultValue);
    }

    var fromEnv = Environment.GetEnvironmentVariable(envName);
    if (!string.IsNullOrWhiteSpace(fromEnv))
    {
      return ParseBoolValue(fromEnv, defaultValue);
    }

    return defaultValue;
  }

  private static bool ParseBoolValue(string? value, bool fallback)
  {
    var raw = (value ?? "").Trim();
    if (string.IsNullOrWhiteSpace(raw))
    {
      return fallback;
    }

    if (raw is "1" or "yes" or "y" or "on")
    {
      return true;
    }

    if (raw is "0" or "no" or "n" or "off")
    {
      return false;
    }

    if (bool.TryParse(raw, out var parsed))
    {
      return parsed;
    }

    return fallback;
  }

  private static LogLevel ResolveLogLevel(
    IReadOnlyDictionary<string, string> kv,
    string key,
    string envName,
    LogLevel defaultValue)
  {
    if (kv.TryGetValue(key, out var fromArg))
    {
      return ParseLogLevelValue(fromArg, defaultValue);
    }

    var fromEnv = Environment.GetEnvironmentVariable(envName);
    if (!string.IsNullOrWhiteSpace(fromEnv))
    {
      return ParseLogLevelValue(fromEnv, defaultValue);
    }

    return defaultValue;
  }

  private static LogLevel ParseLogLevelValue(string? value, LogLevel fallback)
  {
    var raw = (value ?? "").Trim();
    if (string.IsNullOrWhiteSpace(raw))
    {
      return fallback;
    }

    if (int.TryParse(raw, out var numeric))
    {
      if (numeric >= 0 && numeric <= (int)LogLevel.None)
      {
        return (LogLevel)numeric;
      }

      return fallback;
    }

    switch (raw.ToLowerInvariant())
    {
      case "trace":
        return LogLevel.Trace;
      case "debug":
        return LogLevel.Debug;
      case "info":
      case "information":
        return LogLevel.Information;
      case "warn":
      case "warning":
        return LogLevel.Warning;
      case "error":
        return LogLevel.Error;
      case "critical":
      case "fatal":
        return LogLevel.Critical;
      case "none":
      case "off":
        return LogLevel.None;
      default:
        if (Enum.TryParse<LogLevel>(raw, true, out var parsed))
        {
          return parsed;
        }

        return fallback;
    }
  }
}
