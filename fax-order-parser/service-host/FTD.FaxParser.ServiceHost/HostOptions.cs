namespace FTD.FaxParser.ServiceHost;

internal enum ServiceCommand { None, Install, Uninstall, Start, Stop, Status }

internal sealed class HostOptions
{
  public ServiceCommand Command { get; init; } = ServiceCommand.None;
  public string ServiceName { get; init; } = "FTD Fax Order Parser";
  public string StartMode { get; init; } = "auto";

  public string NodeExePath { get; init; } = string.Empty;
  public string ScriptPath { get; init; } = string.Empty;
  public string WorkingDirectory { get; init; } = string.Empty;
  public string LogDirectory { get; init; } = string.Empty;
  public int RestartDelayMs { get; init; } = 5000;

  public string StdOutLogPath => Path.Combine(LogDirectory, "fax-parser.out.log");
  public string StdErrLogPath => Path.Combine(LogDirectory, "fax-parser.err.log");

  public static HostOptions FromArgs(string[] args)
  {
    var p = ArgumentParser.Parse(args);

    var command = p.Get("service-install") is not "" || p.HasFlag("service-install")
      ? ServiceCommand.Install
      : p.Get("service-uninstall") is not "" || p.HasFlag("service-uninstall")
        ? ServiceCommand.Uninstall
        : p.HasFlag("service-start") ? ServiceCommand.Start
        : p.HasFlag("service-stop") ? ServiceCommand.Stop
        : p.HasFlag("service-status") ? ServiceCommand.Status
        : ServiceCommand.None;

    // Resolve paths relative to the EXE directory
    var exeDir = AppContext.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
    var appRoot = Directory.GetParent(exeDir)?.FullName ?? exeDir;

    var defaultNodePath = Path.Combine(appRoot, "runtime", "node.exe");
    var defaultScriptPath = Path.Combine(appRoot, "service", "service.js");
    var defaultWorkDir = Path.Combine(appRoot, "service");
    var defaultLogDir = Path.Combine(
      Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
      "FTD", "FaxOrderParser", "logs");

    return new HostOptions
    {
      Command = command,
      ServiceName = p.Get("service-name", "FTD Fax Order Parser"),
      StartMode = p.Get("start-mode", "auto"),
      NodeExePath = Path.GetFullPath(p.Get("node-exe", defaultNodePath)),
      ScriptPath = Path.GetFullPath(p.Get("script-path", defaultScriptPath)),
      WorkingDirectory = Path.GetFullPath(p.Get("working-dir", defaultWorkDir)),
      LogDirectory = Path.GetFullPath(p.Get("log-dir", defaultLogDir)),
      RestartDelayMs = int.TryParse(p.Get("restart-delay-ms", "5000"), out var d) ? Math.Max(1000, d) : 5000,
    };
  }
}
