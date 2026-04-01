using System.Diagnostics;
using System.Security.Principal;
using System.Text;

namespace FTD.Mercury.Dashboard.ServiceHost;

internal static class ServiceCommandHandler
{
  public static async Task<int?> TryHandleAsync(HostOptions options, CancellationToken cancellationToken)
  {
    if (options.Command == ServiceCommand.None)
    {
      return null;
    }

    if (!OperatingSystem.IsWindows())
    {
      Console.Error.WriteLine("Service commands are only supported on Windows.");
      return 2;
    }

    var requiresElevation = options.Command != ServiceCommand.Status;
    if (requiresElevation && !IsElevated())
    {
      Console.Error.WriteLine("Service commands require an elevated (Administrator) terminal.");
      return 2;
    }

    try
    {
      switch (options.Command)
      {
        case ServiceCommand.Install:
          await InstallOrUpdateAsync(options, cancellationToken);
          return 0;
        case ServiceCommand.Uninstall:
          await UninstallAsync(options.ServiceName, cancellationToken);
          return 0;
        case ServiceCommand.Start:
          await StartAsync(options.ServiceName, cancellationToken);
          return 0;
        case ServiceCommand.Stop:
          await StopAsync(options.ServiceName, cancellationToken);
          return 0;
        case ServiceCommand.Status:
          await ShowStatusAsync(options, cancellationToken);
          return 0;
        default:
          Console.Error.WriteLine($"Unsupported command: {options.Command}");
          return 2;
      }
    }
    catch (Exception ex)
    {
      Console.Error.WriteLine($"Service command failed: {ex.Message}");
      return 1;
    }
  }

  private static async Task InstallOrUpdateAsync(HostOptions options, CancellationToken cancellationToken)
  {
    var exePath = ResolveExecutablePath();
    var binPath = BuildBinPath(exePath, options);
    var startMode = ResolveStartMode(options.StartMode);
    var exists = await ServiceExistsAsync(options.ServiceName, cancellationToken);

    if (!exists)
    {
      Console.WriteLine($"Creating service '{options.ServiceName}' ...");
      var create = $"create {EscapeArg(options.ServiceName)} binPath= {EscapeArg(binPath)} start= {startMode} DisplayName= {EscapeArg(options.ServiceName)}";
      if (!string.IsNullOrWhiteSpace(options.DependsOnService))
      {
        create += $" depend= {EscapeArg(options.DependsOnService)}";
      }

      await RunScCheckedAsync(create, cancellationToken);
    }
    else
    {
      Console.WriteLine($"Updating service '{options.ServiceName}' ...");
      await StopAsync(options.ServiceName, cancellationToken);

      var config = $"config {EscapeArg(options.ServiceName)} binPath= {EscapeArg(binPath)} start= {startMode} DisplayName= {EscapeArg(options.ServiceName)}";
      if (!string.IsNullOrWhiteSpace(options.DependsOnService))
      {
        config += $" depend= {EscapeArg(options.DependsOnService)}";
      }
      await RunScCheckedAsync(config, cancellationToken);
    }

    await ConfigureRecoveryAsync(options.ServiceName, cancellationToken);
    await StartAsync(options.ServiceName, cancellationToken);
    await VerifyHealthAsync(options, cancellationToken);
  }

  private static async Task UninstallAsync(string serviceName, CancellationToken cancellationToken)
  {
    if (!await ServiceExistsAsync(serviceName, cancellationToken))
    {
      Console.WriteLine($"Service '{serviceName}' not found.");
      return;
    }

    await StopAsync(serviceName, cancellationToken);
    await RunScAsync($"delete {EscapeArg(serviceName)}", cancellationToken);
    Console.WriteLine($"Service '{serviceName}' deleted.");
  }

  private static async Task StartAsync(string serviceName, CancellationToken cancellationToken)
  {
    if (!await ServiceExistsAsync(serviceName, cancellationToken))
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
    if (!await ServiceExistsAsync(serviceName, cancellationToken))
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

  private static async Task ShowStatusAsync(HostOptions options, CancellationToken cancellationToken)
  {
    if (!await ServiceExistsAsync(options.ServiceName, cancellationToken))
    {
      Console.WriteLine($"Service '{options.ServiceName}' not found.");
      return;
    }

    var query = await RunScCheckedAsync($"query {EscapeArg(options.ServiceName)}", cancellationToken);
    Console.WriteLine(query.Message.Trim());

    var qc = await RunScCheckedAsync($"qc {EscapeArg(options.ServiceName)}", cancellationToken);
    Console.WriteLine(qc.Message.Trim());

    using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(2) };
    try
    {
      var response = await http.GetStringAsync(options.HealthUrl, cancellationToken);
      Console.WriteLine($"Health ({options.HealthUrl}): {response}");
    }
    catch
    {
      Console.WriteLine($"Health ({options.HealthUrl}): not reachable");
    }
  }

  private static async Task VerifyHealthAsync(HostOptions options, CancellationToken cancellationToken)
  {
    using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(2) };
    var deadline = DateTimeOffset.UtcNow.AddSeconds(20);

    while (DateTimeOffset.UtcNow < deadline)
    {
      cancellationToken.ThrowIfCancellationRequested();
      try
      {
        var body = await http.GetStringAsync(options.HealthUrl, cancellationToken);
        if (!string.IsNullOrWhiteSpace(body))
        {
          Console.WriteLine($"Health check passed ({options.HealthUrl}).");
          return;
        }
      }
      catch
      {
        // Retry until deadline.
      }

      await Task.Delay(400, cancellationToken);
    }

    throw new InvalidOperationException($"Service started but health endpoint did not become ready: {options.HealthUrl}");
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

  private static async Task WaitForStateAsync(string serviceName, string state, TimeSpan timeout, CancellationToken cancellationToken)
  {
    var deadline = DateTimeOffset.UtcNow.Add(timeout);
    while (DateTimeOffset.UtcNow < deadline)
    {
      cancellationToken.ThrowIfCancellationRequested();
      var result = await RunScAsync($"query {EscapeArg(serviceName)}", cancellationToken);
      if (result.ExitCode == 0 && result.Message.Contains("STATE", StringComparison.OrdinalIgnoreCase) && result.Message.Contains(state, StringComparison.OrdinalIgnoreCase))
      {
        return;
      }

      await Task.Delay(300, cancellationToken);
    }

    throw new TimeoutException($"Timed out waiting for service '{serviceName}' state '{state}'.");
  }

  private static async Task ConfigureRecoveryAsync(string serviceName, CancellationToken cancellationToken)
  {
    const int delay = 60000;
    await RunScCheckedAsync($"failure {EscapeArg(serviceName)} reset= 86400 actions= restart/{delay}/restart/{delay}/restart/{delay}", cancellationToken);
    await RunScCheckedAsync($"failureflag {EscapeArg(serviceName)} 1", cancellationToken);
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

    using var process = new Process { StartInfo = psi };
    process.Start();

    var stdoutTask = process.StandardOutput.ReadToEndAsync(cancellationToken);
    var stderrTask = process.StandardError.ReadToEndAsync(cancellationToken);
    await process.WaitForExitAsync(cancellationToken);

    var stdout = await stdoutTask;
    var stderr = await stderrTask;
    var message = BuildMessage(stdout, stderr);
    return new ScResult(process.ExitCode, message);
  }

  private static string BuildBinPath(string exePath, HostOptions options)
  {
    var role = options.Role == ServiceRole.Web ? "web" : "bridge";
    var parts = new List<string>
    {
      EscapeArg(exePath),
      $"--service-role={role}",
      $"--service-name={EscapeValue(options.ServiceName)}",
      $"--bridge-port={options.BridgePort}",
      $"--web-port={options.WebPort}",
      $"--bridge-host={EscapeValue(options.BridgeHost)}",
      $"--web-host={EscapeValue(options.WebHost)}",
      $"--workflow-api-base-url={EscapeValue(options.WorkflowApiBaseUrl)}",
      $"--mercury-base-url={EscapeValue(options.MercuryBaseUrl)}",
      $"--mercury-soap-namespace={EscapeValue(options.MercurySoapNamespace)}",
      $"--mercury-local-network-only={EscapeValue(options.MercuryLocalNetworkOnly)}",
      $"--node-exe={EscapeValue(options.NodeExePath)}",
      $"--script={EscapeValue(options.ScriptPath)}",
      $"--working-dir={EscapeValue(options.WorkingDirectory)}",
      $"--log-dir={EscapeValue(options.LogDirectory)}",
      $"--restart-delay-ms={options.RestartDelayMs}",
    };

    return string.Join(" ", parts);
  }

  private static string ResolveExecutablePath()
  {
    var processPath = Environment.ProcessPath;
    if (string.IsNullOrWhiteSpace(processPath))
    {
      throw new InvalidOperationException("Unable to resolve current executable path.");
    }

    if (string.Equals(Path.GetFileName(processPath), "dotnet.exe", StringComparison.OrdinalIgnoreCase))
    {
      throw new InvalidOperationException("Service commands must run from the compiled executable, not dotnet host.");
    }

    return processPath;
  }

  private static string ResolveStartMode(string mode)
  {
    var normalized = (mode ?? string.Empty).Trim().ToLowerInvariant();
    return normalized switch
    {
      "auto" => "auto",
      "demand" => "demand",
      "disabled" => "disabled",
      _ => "auto",
    };
  }

  private static string EscapeArg(string value)
  {
    var escaped = (value ?? string.Empty).Replace("\"", "\\\"", StringComparison.Ordinal);
    return $"\"{escaped}\"";
  }

  private static string EscapeValue(string value)
  {
    var trimmed = (value ?? string.Empty).Trim();
    if (trimmed.Length == 0)
    {
      return "\"\"";
    }

    if (!trimmed.Contains(' '))
    {
      return trimmed.Replace("\"", string.Empty, StringComparison.Ordinal);
    }

    return EscapeArg(trimmed);
  }

  private static string BuildMessage(string stdout, string stderr)
  {
    var sb = new StringBuilder();
    if (!string.IsNullOrWhiteSpace(stdout)) sb.AppendLine(stdout.Trim());
    if (!string.IsNullOrWhiteSpace(stderr)) sb.AppendLine(stderr.Trim());
    return sb.ToString().Trim();
  }

  private static bool IsElevated()
  {
    using var identity = WindowsIdentity.GetCurrent();
    var principal = new WindowsPrincipal(identity);
    return principal.IsInRole(WindowsBuiltInRole.Administrator);
  }

  private sealed record ScResult(int ExitCode, string Message);
}
