using System.Diagnostics;
using System.Security.Principal;
using System.Text;

namespace FTD.FaxParser.ServiceHost;

internal static class ServiceCommandHandler
{
  public static async Task<int?> TryHandleAsync(HostOptions options, CancellationToken cancellationToken)
  {
    if (options.Command == ServiceCommand.None)
      return null;

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
          await ShowStatusAsync(options.ServiceName, cancellationToken);
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

  // ── Install / Update ──────────────────────────────────────────────────────────

  private static async Task InstallOrUpdateAsync(HostOptions options, CancellationToken cancellationToken)
  {
    var exePath = ResolveExecutablePath();
    var binPath = BuildBinPath(exePath, options);
    var startMode = options.StartMode.ToLowerInvariant() switch
    {
      "auto" or "automatic" => "auto",
      "manual" => "demand",
      "disabled" => "disabled",
      _ => "auto",
    };

    var exists = await ServiceExistsAsync(options.ServiceName, cancellationToken);
    if (!exists)
    {
      Console.WriteLine($"Creating service '{options.ServiceName}' ...");
      await RunScCheckedAsync(
        $"create {Esc(options.ServiceName)} binPath= {Esc(binPath)} start= {startMode} DisplayName= {Esc(options.ServiceName)}",
        cancellationToken);
    }
    else
    {
      Console.WriteLine($"Updating service '{options.ServiceName}' ...");
      await StopAsync(options.ServiceName, cancellationToken);
      await RunScCheckedAsync(
        $"config {Esc(options.ServiceName)} binPath= {Esc(binPath)} start= {startMode} DisplayName= {Esc(options.ServiceName)}",
        cancellationToken);
    }

    // Configure automatic restart on failure (retry after 60 s, up to 3 times)
    await RunScCheckedAsync(
      $"failure {Esc(options.ServiceName)} reset= 86400 actions= restart/60000/restart/60000/restart/60000",
      cancellationToken);
    await RunScCheckedAsync($"failureflag {Esc(options.ServiceName)} 1", cancellationToken);

    await StartAsync(options.ServiceName, cancellationToken);
    Console.WriteLine($"Service '{options.ServiceName}' installed and started.");
  }

  // ── Uninstall ─────────────────────────────────────────────────────────────────

  private static async Task UninstallAsync(string serviceName, CancellationToken cancellationToken)
  {
    if (!await ServiceExistsAsync(serviceName, cancellationToken))
    {
      Console.WriteLine($"Service '{serviceName}' not found — nothing to uninstall.");
      return;
    }

    await StopAsync(serviceName, cancellationToken);
    await RunScAsync($"delete {Esc(serviceName)}", cancellationToken);
    Console.WriteLine($"Service '{serviceName}' removed.");
  }

  // ── Start / Stop ──────────────────────────────────────────────────────────────

  private static async Task StartAsync(string serviceName, CancellationToken cancellationToken)
  {
    var r = await RunScAsync($"start {Esc(serviceName)}", cancellationToken);
    // Exit code 1056 = already running
    if (r.ExitCode != 0 && r.ExitCode != 1056)
      throw new InvalidOperationException($"Could not start service '{serviceName}': {r.Message}");

    await WaitForStateAsync(serviceName, "RUNNING", TimeSpan.FromSeconds(20), cancellationToken);
    Console.WriteLine($"Service '{serviceName}' is running.");
  }

  private static async Task StopAsync(string serviceName, CancellationToken cancellationToken)
  {
    if (!await ServiceExistsAsync(serviceName, cancellationToken)) return;

    var r = await RunScAsync($"stop {Esc(serviceName)}", cancellationToken);
    // Exit code 1062 = not running
    if (r.ExitCode != 0 && r.ExitCode != 1062)
      throw new InvalidOperationException($"Could not stop service '{serviceName}': {r.Message}");

    await WaitForStateAsync(serviceName, "STOPPED", TimeSpan.FromSeconds(20), cancellationToken);
    Console.WriteLine($"Service '{serviceName}' stopped.");
  }

  private static async Task ShowStatusAsync(string serviceName, CancellationToken cancellationToken)
  {
    if (!await ServiceExistsAsync(serviceName, cancellationToken))
    {
      Console.WriteLine($"Service '{serviceName}' not found.");
      return;
    }

    var q = await RunScCheckedAsync($"query {Esc(serviceName)}", cancellationToken);
    Console.WriteLine(q.Message.Trim());
  }

  // ── sc.exe helpers ────────────────────────────────────────────────────────────

  private static async Task<bool> ServiceExistsAsync(string serviceName, CancellationToken ct)
  {
    var r = await RunScAsync($"query {Esc(serviceName)}", ct);
    return r.ExitCode switch
    {
      0 => true,
      1060 => false,
      _ => throw new InvalidOperationException($"Could not query service '{serviceName}': {r.Message}"),
    };
  }

  private static async Task WaitForStateAsync(
    string serviceName, string state, TimeSpan timeout, CancellationToken ct)
  {
    var deadline = DateTimeOffset.UtcNow.Add(timeout);
    while (DateTimeOffset.UtcNow < deadline)
    {
      ct.ThrowIfCancellationRequested();
      var r = await RunScAsync($"query {Esc(serviceName)}", ct);
      if (r.ExitCode == 0 &&
          r.Message.Contains("STATE", StringComparison.OrdinalIgnoreCase) &&
          r.Message.Contains(state, StringComparison.OrdinalIgnoreCase))
        return;
      await Task.Delay(300, ct);
    }
    throw new TimeoutException($"Timed out waiting for service '{serviceName}' to reach state '{state}'.");
  }

  private static async Task<ScResult> RunScCheckedAsync(string args, CancellationToken ct)
  {
    var r = await RunScAsync(args, ct);
    if (r.ExitCode != 0)
      throw new InvalidOperationException($"sc.exe failed ({r.ExitCode}): {r.Message}");
    return r;
  }

  private static async Task<ScResult> RunScAsync(string args, CancellationToken ct)
  {
    var psi = new ProcessStartInfo("sc.exe", args)
    {
      UseShellExecute = false,
      RedirectStandardOutput = true,
      RedirectStandardError = true,
      CreateNoWindow = true,
    };

    using var proc = new Process { StartInfo = psi };
    var sb = new StringBuilder();

    proc.OutputDataReceived += (_, e) => { if (e.Data is not null) sb.AppendLine(e.Data); };
    proc.ErrorDataReceived  += (_, e) => { if (e.Data is not null) sb.AppendLine(e.Data); };

    proc.Start();
    proc.BeginOutputReadLine();
    proc.BeginErrorReadLine();
    await proc.WaitForExitAsync(ct);

    return new ScResult(proc.ExitCode, sb.ToString());
  }

  private record ScResult(int ExitCode, string Message);

  // ── Misc helpers ──────────────────────────────────────────────────────────────

  private static string ResolveExecutablePath()
  {
    var path = Environment.ProcessPath ?? Process.GetCurrentProcess().MainModule?.FileName
      ?? throw new InvalidOperationException("Cannot resolve the current executable path.");
    return Path.GetFullPath(path);
  }

  private static string BuildBinPath(string exePath, HostOptions options)
  {
    // Build a command-line string sc.exe stores as the service binPath.
    // Paths are wrapped with escaped inner quotes (\" instead of ") so that
    // when Esc() adds the outer "…" wrapper the result is valid:
    //   "\"C:\path\exe.exe\" --node-exe=\"C:\path\node.exe\" …"
    // sc.exe stores the inner value; SCM later calls CreateProcess with it.
    var parts = new List<string>
    {
      $"\\\"{exePath}\\\"",
      $"--node-exe=\\\"{options.NodeExePath}\\\"",
      $"--script-path=\\\"{options.ScriptPath}\\\"",
      $"--working-dir=\\\"{options.WorkingDirectory}\\\"",
      $"--log-dir=\\\"{options.LogDirectory}\\\"",
      $"--service-name=\\\"{options.ServiceName}\\\"",
    };
    return string.Join(" ", parts);
  }

  private static bool IsElevated()
  {
    using var id = WindowsIdentity.GetCurrent();
    return new WindowsPrincipal(id).IsInRole(WindowsBuiltInRole.Administrator);
  }

  /// <summary>Wraps a value in double-quotes for sc.exe arguments.</summary>
  private static string Esc(string value) => $"\"{value}\"";
}
