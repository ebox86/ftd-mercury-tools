using System.Diagnostics;
using System.Security.Principal;
using System.Text;

namespace FTD.OposBridge.Service;

internal static class ServiceCommandHandler
{
  private const string None = "none";
  private const string Install = "install";
  private const string Uninstall = "uninstall";
  private const string Start = "start";
  private const string Stop = "stop";
  private const string Restart = "restart";
  private const string Status = "status";

  public static async Task<int?> TryHandleAsync(string[] args, BridgeOptions options, CancellationToken cancellationToken)
  {
    var command = ResolveCommand(args);
    if (command == None)
    {
      return null;
    }

    if (!OperatingSystem.IsWindows())
    {
      Console.Error.WriteLine("Service commands are only supported on Windows.");
      return 2;
    }

    var requiresElevation = command is not Status;
    if (requiresElevation && !IsElevated())
    {
      Console.Error.WriteLine("Service commands require an elevated (Administrator) terminal.");
      return 2;
    }

    var serviceName = ResolveArg(args, "service-name", options.ServiceName);
    var displayName = ResolveArg(args, "service-display-name", serviceName);
    var startMode = ResolveStartMode(ResolveArg(args, "service-start-mode", "auto"));
    var exePath = ResolveExecutablePath(args);
    var serviceAccount = ResolveArg(args, "service-account", "localservice");
    var servicePassword = ResolveArg(args, "service-password", "");
    var restartDelayMs = ResolveIntArg(args, "service-restart-delay-ms", 60000, 1000, 600000);

    try
    {
      switch (command)
      {
        case Install:
          await InstallOrUpdateAsync(serviceName, displayName, startMode, exePath, serviceAccount, servicePassword, restartDelayMs, options, cancellationToken);
          return 0;
        case Uninstall:
          await UninstallAsync(serviceName, cancellationToken);
          return 0;
        case Start:
          await StartAsync(serviceName, cancellationToken);
          return 0;
        case Stop:
          await StopAsync(serviceName, cancellationToken);
          return 0;
        case Restart:
          await StopAsync(serviceName, cancellationToken);
          await StartAsync(serviceName, cancellationToken);
          return 0;
        case Status:
          await ShowStatusAsync(serviceName, options.Port, cancellationToken);
          return 0;
        default:
          Console.Error.WriteLine($"Unsupported service command: {command}");
          return 2;
      }
    }
    catch (Exception ex)
    {
      Console.Error.WriteLine($"Service command failed: {ex.Message}");
      return 1;
    }
  }

  private static async Task InstallOrUpdateAsync(
    string serviceName,
    string displayName,
    string startMode,
    string exePath,
    string serviceAccount,
    string servicePassword,
    int restartDelayMs,
    BridgeOptions options,
    CancellationToken cancellationToken)
  {
    var binPath = BuildBinPath(exePath, options);
    var identity = ResolveServiceIdentity(serviceAccount, servicePassword);
    var exists = await ServiceExistsAsync(serviceName, cancellationToken);

    if (!exists)
    {
      Console.WriteLine($"Creating service '{serviceName}' ...");
      var create = $"create {EscapeArg(serviceName)} binPath= {EscapeArg(binPath)} start= {startMode} DisplayName= {EscapeArg(displayName)}";
      if (!string.IsNullOrWhiteSpace(identity.ObjectName))
      {
        create += $" obj= {EscapeArg(identity.ObjectName)}";
      }

      if (identity.Password is not null)
      {
        create += $" password= {EscapeArg(identity.Password)}";
      }

      await RunScCheckedAsync(
        create,
        cancellationToken);
    }
    else
    {
      Console.WriteLine($"Updating service '{serviceName}' ...");
      await StopAsync(serviceName, cancellationToken);
      var config = $"config {EscapeArg(serviceName)} binPath= {EscapeArg(binPath)} start= {startMode} DisplayName= {EscapeArg(displayName)}";
      if (!string.IsNullOrWhiteSpace(identity.ObjectName))
      {
        config += $" obj= {EscapeArg(identity.ObjectName)}";
      }

      if (identity.Password is not null)
      {
        config += $" password= {EscapeArg(identity.Password)}";
      }

      await RunScCheckedAsync(
        config,
        cancellationToken);
    }

    await ConfigureRecoveryAsync(serviceName, restartDelayMs, cancellationToken);
    await StartAsync(serviceName, cancellationToken);
    await VerifyHealthAsync(options.Port, options.LogicalName, cancellationToken);
  }

  private static async Task UninstallAsync(string serviceName, CancellationToken cancellationToken)
  {
    var exists = await ServiceExistsAsync(serviceName, cancellationToken);
    if (!exists)
    {
      Console.WriteLine($"Service '{serviceName}' not found.");
      return;
    }

    await StopAsync(serviceName, cancellationToken);
    var deleteResult = await RunScAsync($"delete {EscapeArg(serviceName)}", cancellationToken);
    if (deleteResult.ExitCode != 0)
    {
      throw new InvalidOperationException($"Could not delete service '{serviceName}': {deleteResult.Message}");
    }

    Console.WriteLine($"Service '{serviceName}' deleted.");
  }

  private static async Task StartAsync(string serviceName, CancellationToken cancellationToken)
  {
    var exists = await ServiceExistsAsync(serviceName, cancellationToken);
    if (!exists)
    {
      throw new InvalidOperationException($"Service '{serviceName}' not found.");
    }

    var startResult = await RunScAsync($"start {EscapeArg(serviceName)}", cancellationToken);
    if (startResult.ExitCode != 0 && startResult.ExitCode != 1056)
    {
      throw new InvalidOperationException($"Could not start service '{serviceName}': {startResult.Message}");
    }

    await WaitForStateAsync(serviceName, "RUNNING", TimeSpan.FromSeconds(20), cancellationToken);
    Console.WriteLine($"Service '{serviceName}' is running.");
  }

  private static async Task StopAsync(string serviceName, CancellationToken cancellationToken)
  {
    var exists = await ServiceExistsAsync(serviceName, cancellationToken);
    if (!exists)
    {
      return;
    }

    var stopResult = await RunScAsync($"stop {EscapeArg(serviceName)}", cancellationToken);
    if (stopResult.ExitCode != 0 && stopResult.ExitCode != 1062)
    {
      throw new InvalidOperationException($"Could not stop service '{serviceName}': {stopResult.Message}");
    }

    await WaitForStateAsync(serviceName, "STOPPED", TimeSpan.FromSeconds(20), cancellationToken);
    Console.WriteLine($"Service '{serviceName}' is stopped.");
  }

  private static async Task ShowStatusAsync(string serviceName, int port, CancellationToken cancellationToken)
  {
    var exists = await ServiceExistsAsync(serviceName, cancellationToken);
    if (!exists)
    {
      Console.WriteLine($"Service '{serviceName}' not found.");
      return;
    }

    var query = await RunScCheckedAsync($"query {EscapeArg(serviceName)}", cancellationToken);
    Console.WriteLine(query.Message.Trim());

    var qc = await RunScCheckedAsync($"qc {EscapeArg(serviceName)}", cancellationToken);
    Console.WriteLine(qc.Message.Trim());

    var healthUrl = $"http://127.0.0.1:{port}/health";
    using var http = new HttpClient
    {
      Timeout = TimeSpan.FromSeconds(2),
    };
    try
    {
      var response = await http.GetStringAsync(healthUrl, cancellationToken);
      Console.WriteLine($"Health ({healthUrl}): {response}");
    }
    catch
    {
      Console.WriteLine($"Health ({healthUrl}): not reachable");
    }
  }

  private static async Task VerifyHealthAsync(int port, string logicalName, CancellationToken cancellationToken)
  {
    var healthUrl = $"http://127.0.0.1:{port}/health";
    using var http = new HttpClient
    {
      Timeout = TimeSpan.FromSeconds(2),
    };

    var deadline = DateTimeOffset.UtcNow.AddSeconds(15);
    while (DateTimeOffset.UtcNow < deadline)
    {
      cancellationToken.ThrowIfCancellationRequested();
      try
      {
        var body = await http.GetStringAsync(healthUrl, cancellationToken);
        if (!string.IsNullOrWhiteSpace(body) && body.Contains("\"ok\":true", StringComparison.OrdinalIgnoreCase))
        {
          Console.WriteLine($"Health check passed ({healthUrl}) for logical '{logicalName}'.");
          return;
        }
      }
      catch
      {
        // Retry until deadline.
      }

      await Task.Delay(300, cancellationToken);
    }

    throw new InvalidOperationException($"Service started but health endpoint did not become ready: {healthUrl}");
  }

  private static async Task WaitForStateAsync(string serviceName, string state, TimeSpan timeout, CancellationToken cancellationToken)
  {
    var deadline = DateTimeOffset.UtcNow.Add(timeout);
    while (DateTimeOffset.UtcNow < deadline)
    {
      cancellationToken.ThrowIfCancellationRequested();
      var result = await RunScAsync($"query {EscapeArg(serviceName)}", cancellationToken);
      if (result.ExitCode == 1060)
      {
        if (string.Equals(state, "DELETED", StringComparison.OrdinalIgnoreCase))
        {
          return;
        }

        throw new InvalidOperationException($"Service '{serviceName}' not found while waiting for state '{state}'.");
      }

      if (result.ExitCode == 0 && result.Message.Contains($"STATE", StringComparison.OrdinalIgnoreCase) && result.Message.Contains(state, StringComparison.OrdinalIgnoreCase))
      {
        return;
      }

      await Task.Delay(300, cancellationToken);
    }

    throw new TimeoutException($"Timed out waiting for service '{serviceName}' state '{state}'.");
  }

  private static async Task<bool> ServiceExistsAsync(string serviceName, CancellationToken cancellationToken)
  {
    var result = await RunScAsync($"query {EscapeArg(serviceName)}", cancellationToken);
    if (result.ExitCode == 0)
    {
      return true;
    }

    if (result.ExitCode == 1060)
    {
      return false;
    }

    throw new InvalidOperationException($"Could not query service '{serviceName}': {result.Message}");
  }

  private static async Task<ScResult> RunScCheckedAsync(string arguments, CancellationToken cancellationToken)
  {
    var result = await RunScAsync(arguments, cancellationToken);
    if (result.ExitCode != 0)
    {
      throw new InvalidOperationException($"sc.exe failed ({result.ExitCode}): {result.Message}");
    }

    return result;
  }

  private static async Task<ScResult> RunScAsync(string arguments, CancellationToken cancellationToken)
  {
    var psi = new ProcessStartInfo("sc.exe", arguments)
    {
      CreateNoWindow = true,
      UseShellExecute = false,
      RedirectStandardOutput = true,
      RedirectStandardError = true,
    };

    using var process = new Process
    {
      StartInfo = psi,
    };

    process.Start();
    var stdoutTask = process.StandardOutput.ReadToEndAsync(cancellationToken);
    var stderrTask = process.StandardError.ReadToEndAsync(cancellationToken);
    await process.WaitForExitAsync(cancellationToken);

    var stdout = await stdoutTask;
    var stderr = await stderrTask;
    var message = BuildMessage(stdout, stderr);
    return new ScResult(process.ExitCode, message);
  }

  private static string BuildBinPath(string exePath, BridgeOptions options)
  {
    var parts = new List<string>
    {
      EscapeArg(exePath),
      $"--port={options.Port}",
      $"--logical-name={EscapeValue(options.LogicalName)}",
      $"--scanner-mode={EscapeValue(options.ScannerMode)}",
      $"--claim-timeout-ms={options.ClaimTimeoutMs}",
    };

    if (!string.IsNullOrWhiteSpace(options.InteropDllPath))
    {
      parts.Add($"--interop-dll-path={EscapeValue(options.InteropDllPath)}");
    }

    return string.Join(" ", parts);
  }

  private static async Task ConfigureRecoveryAsync(string serviceName, int restartDelayMs, CancellationToken cancellationToken)
  {
    var delay = Math.Clamp(restartDelayMs, 1000, 600000);
    await RunScCheckedAsync(
      $"failure {EscapeArg(serviceName)} reset= 86400 actions= restart/{delay}/restart/{delay}/restart/{delay}",
      cancellationToken);
    await RunScCheckedAsync($"failureflag {EscapeArg(serviceName)} 1", cancellationToken);
  }

  private static ServiceIdentity ResolveServiceIdentity(string serviceAccount, string servicePassword)
  {
    var account = (serviceAccount ?? "").Trim();
    if (string.IsNullOrWhiteSpace(account))
    {
      account = "localservice";
    }

    var normalized = account.ToLowerInvariant();
    return normalized switch
    {
      "localservice" => new ServiceIdentity(@"NT AUTHORITY\LocalService", ""),
      "networkservice" => new ServiceIdentity(@"NT AUTHORITY\NetworkService", ""),
      "localsystem" => new ServiceIdentity("LocalSystem", null),
      "current-user" => ResolveCurrentUserIdentity(servicePassword),
      _ => ResolveNamedUserIdentity(account, servicePassword),
    };
  }

  private static ServiceIdentity ResolveCurrentUserIdentity(string password)
  {
    using var identity = WindowsIdentity.GetCurrent();
    var userName = identity.Name;
    if (string.IsNullOrWhiteSpace(userName))
    {
      throw new InvalidOperationException("Could not resolve current user identity for service account.");
    }

    if (string.IsNullOrWhiteSpace(password))
    {
      throw new InvalidOperationException("service-password is required when service-account=current-user.");
    }

    return new ServiceIdentity(userName, password);
  }

  private static ServiceIdentity ResolveNamedUserIdentity(string account, string password)
  {
    if (string.IsNullOrWhiteSpace(password))
    {
      throw new InvalidOperationException("service-password is required when using a named service-account.");
    }

    return new ServiceIdentity(account, password);
  }

  private static string ResolveExecutablePath(string[] args)
  {
    var fromArg = ResolveArg(args, "service-exe-path", "");
    if (!string.IsNullOrWhiteSpace(fromArg))
    {
      var full = Path.GetFullPath(fromArg);
      if (!File.Exists(full))
      {
        throw new FileNotFoundException($"service-exe-path does not exist: {full}");
      }

      return full;
    }

    var processPath = Environment.ProcessPath;
    if (string.IsNullOrWhiteSpace(processPath))
    {
      throw new InvalidOperationException("Unable to resolve current executable path. Pass --service-exe-path=<full-path>.");
    }

    var fileName = Path.GetFileName(processPath);
    if (string.Equals(fileName, "dotnet.exe", StringComparison.OrdinalIgnoreCase))
    {
      throw new InvalidOperationException(
        "Service install commands must be run from the compiled bridge executable, not dotnet host. " +
        "Pass --service-exe-path=<full-path-to-FTD.OposBridge.Service.exe> if needed.");
    }

    return processPath;
  }

  private static string ResolveStartMode(string mode)
  {
    var normalized = (mode ?? "").Trim().ToLowerInvariant();
    return normalized switch
    {
      "auto" => "auto",
      "demand" => "demand",
      "disabled" => "disabled",
      _ => "auto",
    };
  }

  private static string ResolveArg(string[] args, string key, string fallback)
  {
    if (args is null || args.Length == 0)
    {
      return fallback;
    }

    var prefix = $"--{key}=";
    foreach (var arg in args)
    {
      if (!arg.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
      {
        continue;
      }

      var value = arg[prefix.Length..].Trim();
      return string.IsNullOrWhiteSpace(value) ? fallback : value;
    }

    return fallback;
  }

  private static int ResolveIntArg(string[] args, string key, int fallback, int min, int max)
  {
    var raw = ResolveArg(args, key, "");
    if (!int.TryParse(raw, out var parsed))
    {
      return Math.Clamp(fallback, min, max);
    }

    return Math.Clamp(parsed, min, max);
  }

  private static string ResolveCommand(string[] args)
  {
    if (HasFlag(args, "service-install")) return Install;
    if (HasFlag(args, "service-uninstall")) return Uninstall;
    if (HasFlag(args, "service-start")) return Start;
    if (HasFlag(args, "service-stop")) return Stop;
    if (HasFlag(args, "service-restart")) return Restart;
    if (HasFlag(args, "service-status")) return Status;
    return None;
  }

  private static bool HasFlag(string[] args, string flag)
  {
    var target = $"--{flag}";
    return args.Any(arg => string.Equals(arg.Trim(), target, StringComparison.OrdinalIgnoreCase));
  }

  private static string EscapeArg(string value)
  {
    if (string.IsNullOrWhiteSpace(value))
    {
      return "\"\"";
    }

    var escaped = value.Replace("\"", "\\\"");
    return $"\"{escaped}\"";
  }

  private static string EscapeValue(string value)
  {
    if (string.IsNullOrWhiteSpace(value))
    {
      return "";
    }

    var trimmed = value.Trim();
    if (!trimmed.Contains(' '))
    {
      return trimmed.Replace("\"", "");
    }

    return EscapeArg(trimmed);
  }

  private static string BuildMessage(string stdout, string stderr)
  {
    var sb = new StringBuilder();
    if (!string.IsNullOrWhiteSpace(stdout))
    {
      sb.AppendLine(stdout.Trim());
    }

    if (!string.IsNullOrWhiteSpace(stderr))
    {
      sb.AppendLine(stderr.Trim());
    }

    return sb.ToString().Trim();
  }

  private static bool IsElevated()
  {
    using var identity = WindowsIdentity.GetCurrent();
    var principal = new WindowsPrincipal(identity);
    return principal.IsInRole(WindowsBuiltInRole.Administrator);
  }

  private sealed record ScResult(int ExitCode, string Message);
  private sealed record ServiceIdentity(string ObjectName, string? Password);
}
