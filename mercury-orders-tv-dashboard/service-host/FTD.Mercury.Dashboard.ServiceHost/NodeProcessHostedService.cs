using System.Diagnostics;
using System.Text;

namespace FTD.Mercury.Dashboard.ServiceHost;

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

    _logger.LogInformation(
      "Starting dashboard service host role {Role} with script {ScriptPath}",
      _options.Role,
      _options.ScriptPath);

    while (!stoppingToken.IsCancellationRequested)
    {
      var process = CreateNodeProcess();
      try
      {
        process.Start();
        process.BeginOutputReadLine();
        process.BeginErrorReadLine();

        lock (_sync)
        {
          _currentProcess = process;
        }

        _logger.LogInformation("Node child process started (pid {Pid}).", process.Id);
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
          {
            _currentProcess = null;
          }
        }

        try
        {
          process.CancelOutputRead();
          process.CancelErrorRead();
        }
        catch
        {
          // Ignore teardown failures.
        }

        process.Dispose();
      }

      if (stoppingToken.IsCancellationRequested)
      {
        break;
      }

      _logger.LogWarning(
        "Node child process exited unexpectedly. Restarting in {DelayMs}ms.",
        _options.RestartDelayMs);

      try
      {
        await Task.Delay(_options.RestartDelayMs, stoppingToken);
      }
      catch (OperationCanceledException)
      {
        break;
      }
    }
  }

  public override async Task StopAsync(CancellationToken cancellationToken)
  {
    Process? process;
    lock (_sync)
    {
      process = _currentProcess;
    }

    if (process is not null)
    {
      TryTerminateProcess(process);
    }

    await base.StopAsync(cancellationToken);

    lock (_sync)
    {
      _stdoutWriter?.Dispose();
      _stderrWriter?.Dispose();
      _stdoutWriter = null;
      _stderrWriter = null;
    }
  }

  private Process CreateNodeProcess()
  {
    var psi = new ProcessStartInfo
    {
      FileName = _options.NodeExePath,
      Arguments = QuoteArg(_options.ScriptPath),
      WorkingDirectory = _options.WorkingDirectory,
      UseShellExecute = false,
      RedirectStandardOutput = true,
      RedirectStandardError = true,
      CreateNoWindow = true,
    };

    foreach (var pair in _options.BuildEnvironment())
    {
      psi.Environment[pair.Key] = pair.Value;
    }

    var process = new Process
    {
      StartInfo = psi,
      EnableRaisingEvents = true,
    };
    process.OutputDataReceived += (_, eventArgs) => WriteChildLine(eventArgs.Data, isError: false);
    process.ErrorDataReceived += (_, eventArgs) => WriteChildLine(eventArgs.Data, isError: true);
    return process;
  }

  private void WriteChildLine(string? line, bool isError)
  {
    if (string.IsNullOrWhiteSpace(line))
    {
      return;
    }

    var timestamp = DateTimeOffset.Now.ToString("yyyy-MM-dd HH:mm:ss.fff");
    var logLine = $"{timestamp} {line}";

    lock (_sync)
    {
      var writer = isError ? _stderrWriter : _stdoutWriter;
      writer?.WriteLine(logLine);
    }

    if (isError)
    {
      _logger.LogWarning("[node] {Line}", line);
    }
    else
    {
      _logger.LogInformation("[node] {Line}", line);
    }
  }

  private void TryTerminateProcess(Process process)
  {
    try
    {
      if (process.HasExited)
      {
        return;
      }

      _logger.LogInformation("Stopping node child process (pid {Pid})...", process.Id);
      process.Kill(entireProcessTree: true);
      if (!process.WaitForExit(5000))
      {
        _logger.LogWarning("Node child process did not exit within timeout.");
      }
    }
    catch (Exception ex)
    {
      _logger.LogWarning(ex, "Failed to terminate node child process cleanly.");
    }
  }

  private void ValidateRequiredFiles()
  {
    if (!File.Exists(_options.NodeExePath))
    {
      throw new FileNotFoundException($"node.exe not found: {_options.NodeExePath}");
    }

    if (!File.Exists(_options.ScriptPath))
    {
      throw new FileNotFoundException($"Node script not found: {_options.ScriptPath}");
    }

    if (!Directory.Exists(_options.WorkingDirectory))
    {
      throw new DirectoryNotFoundException($"Working directory not found: {_options.WorkingDirectory}");
    }
  }

  private static StreamWriter CreateWriter(string path)
  {
    var stream = new FileStream(path, FileMode.Append, FileAccess.Write, FileShare.ReadWrite);
    return new StreamWriter(stream, new UTF8Encoding(encoderShouldEmitUTF8Identifier: false))
    {
      AutoFlush = true,
    };
  }

  private static string QuoteArg(string value)
  {
    var escaped = (value ?? string.Empty).Replace("\"", "\\\"", StringComparison.Ordinal);
    return $"\"{escaped}\"";
  }
}
