using System.Diagnostics;
using System.Security.Principal;
using System.Text;
using Microsoft.Extensions.Hosting.WindowsServices;

namespace FTD.WoiSmtpGateway.ServiceHost;

internal enum ServiceCommand { None, Install, Uninstall, Start, Stop, Status }

internal sealed class HostOptions
{
  public ServiceCommand Command { get; init; } = ServiceCommand.None;
  public string ServiceName { get; init; } = "FTD Mercury Mail Gateway";
  public string StartMode { get; init; } = "auto";
  public string NodeExePath { get; init; } = string.Empty;
  public string ScriptPath { get; init; } = string.Empty;
  public string WorkingDirectory { get; init; } = string.Empty;
  public string LogDirectory { get; init; } = string.Empty;
  public int RestartDelayMs { get; init; } = 5000;

  public string StdOutLogPath => Path.Combine(LogDirectory, "woi-smtp-gateway.out.log");
  public string StdErrLogPath => Path.Combine(LogDirectory, "woi-smtp-gateway.err.log");

  public static HostOptions FromArgs(string[] args)
  {
    var p = ArgumentParser.Parse(args);
    var command =
      p.HasFlag("service-install") ? ServiceCommand.Install :
      p.HasFlag("service-uninstall") ? ServiceCommand.Uninstall :
      p.HasFlag("service-start") ? ServiceCommand.Start :
      p.HasFlag("service-stop") ? ServiceCommand.Stop :
      p.HasFlag("service-status") ? ServiceCommand.Status :
      ServiceCommand.None;

    var exeDir = AppContext.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
    var appRoot = Directory.GetParent(exeDir)?.FullName ?? exeDir;

    var defaultNodePath = Path.Combine(appRoot, "runtime", "node.exe");
    var defaultScriptPath = Path.Combine(appRoot, "service", "service.js");
    var defaultWorkDir = Path.Combine(appRoot, "service");
    var defaultLogDir = Path.Combine(
      Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
      "FTD", "WoiSmtpGateway", "logs");

    return new HostOptions
    {
      Command = command,
      ServiceName = p.Get("service-name", "FTD Mercury Mail Gateway"),
      StartMode = p.Get("start-mode", "auto"),
      NodeExePath = Path.GetFullPath(p.Get("node-exe", defaultNodePath)),
      ScriptPath = Path.GetFullPath(p.Get("script-path", defaultScriptPath)),
      WorkingDirectory = Path.GetFullPath(p.Get("working-dir", defaultWorkDir)),
      LogDirectory = Path.GetFullPath(p.Get("log-dir", defaultLogDir)),
      RestartDelayMs = int.TryParse(p.Get("restart-delay-ms", "5000"), out var delay)
        ? Math.Max(1000, delay)
        : 5000,
    };
  }
}

internal sealed class ArgumentParser
{
  private readonly Dictionary<string, string> _values = new(StringComparer.OrdinalIgnoreCase);
  private readonly HashSet<string> _flags = new(StringComparer.OrdinalIgnoreCase);

  public static ArgumentParser Parse(string[] args)
  {
    var parser = new ArgumentParser();
    foreach (var raw in args)
    {
      var arg = (raw ?? string.Empty).Trim();
      if (!arg.StartsWith("--", StringComparison.Ordinal)) continue;

      var eq = arg.IndexOf('=');
      if (eq < 0)
      {
        parser._flags.Add(arg[2..]);
        continue;
      }

      var key = arg[2..eq].Trim();
      var value = arg[(eq + 1)..].Trim().Trim('"');
      if (key.Length > 0) parser._values[key] = value;
    }
    return parser;
  }

  public bool HasFlag(string key) => _flags.Contains(key);

  public string Get(string key, string fallback = "") =>
    _values.TryGetValue(key, out var value) ? value : fallback;
}

internal sealed class NodeProcessHostedService : BackgroundService
{
  private readonly HostOptions _options;
  private readonly ILogger<NodeProcessHostedService> _logger;
  private readonly object _sync = new();
  private Process? _currentProcess;
  private StreamWriter? _stdoutWriter;
  private StreamWriter? _stderrWriter;

  public NodeProcessHostedService(HostOptions options, ILogger<NodeProcessHostedService> logger)
  {
    _options = options;
    _logger = logger;
  }

  protected override async Task ExecuteAsync(CancellationToken stoppingToken)
  {
    ValidateRequiredFiles();
    Directory.CreateDirectory(_options.LogDirectory);
    _stdoutWriter = CreateWriter(_options.StdOutLogPath);
    _stderrWriter = CreateWriter(_options.StdErrLogPath);

    _logger.LogInformation("Starting Mercury mail gateway service. Script: {Script}", _options.ScriptPath);

    while (!stoppingToken.IsCancellationRequested)
    {
      var process = CreateNodeProcess();
      try
      {
        process.Start();
        process.BeginOutputReadLine();
        process.BeginErrorReadLine();
        lock (_sync) { _currentProcess = process; }

        _logger.LogInformation("Node.js process started (pid {Pid}).", process.Id);
        await process.WaitForExitAsync(stoppingToken);
      }
      catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
      {
        TryTerminateProcess(process);
      }
      finally
      {
        lock (_sync)
        {
          if (ReferenceEquals(_currentProcess, process)) _currentProcess = null;
        }
        try { process.CancelOutputRead(); process.CancelErrorRead(); } catch { }
        process.Dispose();
      }

      if (stoppingToken.IsCancellationRequested) break;

      _logger.LogWarning("Node.js process exited unexpectedly. Restarting in {DelayMs}ms.", _options.RestartDelayMs);
      try { await Task.Delay(_options.RestartDelayMs, stoppingToken); }
      catch (OperationCanceledException) { break; }
    }
  }

  public override async Task StopAsync(CancellationToken cancellationToken)
  {
    Process? process;
    lock (_sync) { process = _currentProcess; }
    if (process is not null) TryTerminateProcess(process);

    await base.StopAsync(cancellationToken);

    lock (_sync)
    {
      _stdoutWriter?.Dispose();
      _stderrWriter?.Dispose();
      _stdoutWriter = null;
      _stderrWriter = null;
    }
  }

  private void ValidateRequiredFiles()
  {
    if (!File.Exists(_options.NodeExePath))
      throw new FileNotFoundException($"Node.js executable not found: {_options.NodeExePath}");
    if (!File.Exists(_options.ScriptPath))
      throw new FileNotFoundException($"Service script not found: {_options.ScriptPath}");
  }

  private Process CreateNodeProcess()
  {
    var process = new Process
    {
      StartInfo = new ProcessStartInfo
      {
        FileName = _options.NodeExePath,
        Arguments = $"\"{_options.ScriptPath}\"",
        WorkingDirectory = _options.WorkingDirectory,
        UseShellExecute = false,
        RedirectStandardOutput = true,
        RedirectStandardError = true,
        RedirectStandardInput = false,
        CreateNoWindow = true,
        StandardOutputEncoding = Encoding.UTF8,
        StandardErrorEncoding = Encoding.UTF8,
      },
      EnableRaisingEvents = true,
    };

    process.OutputDataReceived += (_, e) =>
    {
      if (e.Data is null) return;
      _logger.LogInformation("{Line}", e.Data);
      try { lock (_sync) { _stdoutWriter?.WriteLine(e.Data); _stdoutWriter?.Flush(); } } catch { }
    };

    process.ErrorDataReceived += (_, e) =>
    {
      if (e.Data is null) return;
      _logger.LogWarning("{Line}", e.Data);
      try { lock (_sync) { _stderrWriter?.WriteLine(e.Data); _stderrWriter?.Flush(); } } catch { }
    };

    return process;
  }

  private static void TryTerminateProcess(Process process)
  {
    try
    {
      if (!process.HasExited) process.Kill(entireProcessTree: true);
    }
    catch { }
  }

  private static StreamWriter CreateWriter(string filePath)
  {
    Directory.CreateDirectory(Path.GetDirectoryName(filePath)!);
    return new StreamWriter(filePath, append: true, Encoding.UTF8) { AutoFlush = false };
  }
}

internal static class ServiceCommandHandler
{
  public static async Task<int?> TryHandleAsync(HostOptions options, CancellationToken cancellationToken)
  {
    if (options.Command == ServiceCommand.None) return null;
    if (!OperatingSystem.IsWindows())
    {
      Console.Error.WriteLine("Service commands are only supported on Windows.");
      return 2;
    }

    if (options.Command != ServiceCommand.Status && !IsElevated())
    {
      Console.Error.WriteLine("Service commands require an elevated Administrator terminal.");
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
    var exePath = Environment.ProcessPath ?? Process.GetCurrentProcess().MainModule?.FileName
      ?? throw new InvalidOperationException("Cannot resolve current executable path.");
    var binPath = BuildBinPath(Path.GetFullPath(exePath), options);
    var startMode = options.StartMode.ToLowerInvariant() switch
    {
      "auto" or "automatic" => "auto",
      "manual" => "demand",
      "disabled" => "disabled",
      _ => "auto",
    };

    if (!await ServiceExistsAsync(options.ServiceName, cancellationToken))
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

    await RunScCheckedAsync(
      $"failure {Esc(options.ServiceName)} reset= 86400 actions= restart/60000/restart/60000/restart/60000",
      cancellationToken);
    await RunScAsync($"failureflag {Esc(options.ServiceName)} 1", cancellationToken);

    await StartAsync(options.ServiceName, cancellationToken);
    Console.WriteLine($"Service '{options.ServiceName}' installed and started.");
  }

  private static async Task UninstallAsync(string serviceName, CancellationToken cancellationToken)
  {
    if (!await ServiceExistsAsync(serviceName, cancellationToken))
    {
      Console.WriteLine($"Service '{serviceName}' not found. Nothing to uninstall.");
      return;
    }

    await StopAsync(serviceName, cancellationToken);
    await RunScAsync($"delete {Esc(serviceName)}", cancellationToken);
    Console.WriteLine($"Service '{serviceName}' removed.");
  }

  private static async Task StartAsync(string serviceName, CancellationToken cancellationToken)
  {
    var result = await RunScAsync($"start {Esc(serviceName)}", cancellationToken);
    if (result.ExitCode != 0 && result.ExitCode != 1056)
      throw new InvalidOperationException($"Could not start service '{serviceName}': {result.Message}");

    await WaitForStateAsync(serviceName, "RUNNING", TimeSpan.FromSeconds(25), cancellationToken);
    Console.WriteLine($"Service '{serviceName}' is running.");
  }

  private static async Task StopAsync(string serviceName, CancellationToken cancellationToken)
  {
    if (!await ServiceExistsAsync(serviceName, cancellationToken)) return;

    var result = await RunScAsync($"stop {Esc(serviceName)}", cancellationToken);
    if (result.ExitCode != 0 && result.ExitCode != 1062)
      throw new InvalidOperationException($"Could not stop service '{serviceName}': {result.Message}");

    await WaitForStateAsync(serviceName, "STOPPED", TimeSpan.FromSeconds(25), cancellationToken);
    Console.WriteLine($"Service '{serviceName}' stopped.");
  }

  private static async Task ShowStatusAsync(string serviceName, CancellationToken cancellationToken)
  {
    var result = await RunScAsync($"query {Esc(serviceName)}", cancellationToken);
    Console.WriteLine(result.Message.Trim());
  }

  private static async Task<bool> ServiceExistsAsync(string serviceName, CancellationToken cancellationToken)
  {
    var result = await RunScAsync($"query {Esc(serviceName)}", cancellationToken);
    return result.ExitCode switch
    {
      0 => true,
      1060 => false,
      _ => throw new InvalidOperationException($"Could not query service '{serviceName}': {result.Message}"),
    };
  }

  private static async Task WaitForStateAsync(
    string serviceName,
    string state,
    TimeSpan timeout,
    CancellationToken cancellationToken)
  {
    var deadline = DateTimeOffset.UtcNow.Add(timeout);
    while (DateTimeOffset.UtcNow < deadline)
    {
      cancellationToken.ThrowIfCancellationRequested();
      var result = await RunScAsync($"query {Esc(serviceName)}", cancellationToken);
      if (result.ExitCode == 0 &&
          result.Message.Contains("STATE", StringComparison.OrdinalIgnoreCase) &&
          result.Message.Contains(state, StringComparison.OrdinalIgnoreCase))
        return;
      await Task.Delay(300, cancellationToken);
    }

    throw new TimeoutException($"Timed out waiting for service '{serviceName}' to reach state '{state}'.");
  }

  private static async Task<ScResult> RunScCheckedAsync(string arguments, CancellationToken cancellationToken)
  {
    var result = await RunScAsync(arguments, cancellationToken);
    if (result.ExitCode != 0)
      throw new InvalidOperationException($"sc.exe failed ({result.ExitCode}): {result.Message}");
    return result;
  }

  private static async Task<ScResult> RunScAsync(string arguments, CancellationToken cancellationToken)
  {
    var psi = new ProcessStartInfo("sc.exe", arguments)
    {
      UseShellExecute = false,
      RedirectStandardOutput = true,
      RedirectStandardError = true,
      CreateNoWindow = true,
    };

    using var process = new Process { StartInfo = psi };
    var output = new StringBuilder();
    process.OutputDataReceived += (_, e) => { if (e.Data is not null) output.AppendLine(e.Data); };
    process.ErrorDataReceived += (_, e) => { if (e.Data is not null) output.AppendLine(e.Data); };

    process.Start();
    process.BeginOutputReadLine();
    process.BeginErrorReadLine();
    await process.WaitForExitAsync(cancellationToken);

    return new ScResult(process.ExitCode, output.ToString());
  }

  private static string BuildBinPath(string exePath, HostOptions options)
  {
    var parts = new List<string>
    {
      $"\"{exePath}\"",
      $"--node-exe=\"{options.NodeExePath}\"",
      $"--script-path=\"{options.ScriptPath}\"",
      $"--working-dir=\"{options.WorkingDirectory}\"",
      $"--log-dir=\"{options.LogDirectory}\"",
      $"--service-name=\"{options.ServiceName}\"",
    };
    return string.Join(" ", parts);
  }

  private static bool IsElevated()
  {
    using var identity = WindowsIdentity.GetCurrent();
    return new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator);
  }

  private static string Esc(string value) => $"\"{value}\"";

  private sealed record ScResult(int ExitCode, string Message);
}

internal static class Program
{
  public static async Task<int> Main(string[] args)
  {
    var options = HostOptions.FromArgs(args);
    var exitCode = await ServiceCommandHandler.TryHandleAsync(options, CancellationToken.None);
    if (exitCode.HasValue) return exitCode.Value;

    var builder = Host.CreateApplicationBuilder(args);
    if (OperatingSystem.IsWindows())
    {
      builder.Services.AddWindowsService(service => service.ServiceName = options.ServiceName);
    }

    builder.Services.AddSingleton(options);
    builder.Services.AddHostedService<NodeProcessHostedService>();

    builder.Logging.ClearProviders();
    builder.Logging.AddSimpleConsole(console =>
    {
      console.TimestampFormat = "yyyy-MM-dd HH:mm:ss.fff ";
      console.SingleLine = true;
    });
    builder.Logging.SetMinimumLevel(LogLevel.Information);

    await builder.Build().RunAsync();
    return 0;
  }
}
