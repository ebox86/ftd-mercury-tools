using System.Diagnostics;
using System.Text;

namespace FTD.FaxParser.ServiceHost;

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

    _logger.LogInformation("Starting fax parser service. Script: {Script}", _options.ScriptPath);

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
          if (ReferenceEquals(_currentProcess, process))
            _currentProcess = null;
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
      _stdoutWriter?.Dispose(); _stderrWriter?.Dispose();
      _stdoutWriter = null; _stderrWriter = null;
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────

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
      if (!process.HasExited)
        process.Kill(entireProcessTree: true);
    }
    catch { }
  }

  private static StreamWriter CreateWriter(string filePath)
  {
    Directory.CreateDirectory(Path.GetDirectoryName(filePath)!);
    return new StreamWriter(filePath, append: true, Encoding.UTF8) { AutoFlush = false };
  }
}
