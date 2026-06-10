namespace FTD.Mercury.Dashboard.ServiceHost;

internal enum ServiceRole
{
  Bridge,
  Web,
}

internal enum ServiceCommand
{
  None,
  Install,
  Uninstall,
  Start,
  Stop,
  Status,
}

internal sealed class HostOptions
{
  public ServiceRole Role { get; init; } = ServiceRole.Bridge;
  public ServiceCommand Command { get; init; } = ServiceCommand.None;
  public string ServiceName { get; init; } = "FTD Mercury Workflow Bridge";
  public string DependsOnService { get; init; } = string.Empty;
  public string StartMode { get; init; } = "auto";

  public string NodeExePath { get; init; } = string.Empty;
  public string ScriptPath { get; init; } = string.Empty;
  public string WorkingDirectory { get; init; } = string.Empty;
  public string LogDirectory { get; init; } = string.Empty;

  public int BridgePort { get; init; } = 17344;
  public int WebPort { get; init; } = 5173;
  public string BridgeHost { get; init; } = "0.0.0.0";
  public string WebHost { get; init; } = "0.0.0.0";
  public string WorkflowApiBaseUrl { get; init; } = "http://127.0.0.1:17344";

  public string MercuryBaseUrl { get; init; } = "http://127.0.0.1/WsMercuryWebAPI";
  public string MercurySoapNamespace { get; init; } = "http://localhost/webservices/";
  public string MercuryLocalNetworkOnly { get; init; } = "true";
  public string MapboxToken { get; init; } = string.Empty;
  public string MapboxTokenProtected { get; init; } = string.Empty;

  public int RestartDelayMs { get; init; } = 3000;

  public string StdOutLogPath
  {
    get
    {
      var file = Role == ServiceRole.Web ? "dashboard-web.out.log" : "workflow-bridge.out.log";
      return Path.Combine(LogDirectory, file);
    }
  }

  public string StdErrLogPath
  {
    get
    {
      var file = Role == ServiceRole.Web ? "dashboard-web.err.log" : "workflow-bridge.err.log";
      return Path.Combine(LogDirectory, file);
    }
  }

  public string HealthUrl => Role == ServiceRole.Web
    ? $"http://127.0.0.1:{WebPort}/web-health"
    : $"http://127.0.0.1:{BridgePort}/health";

  public IReadOnlyDictionary<string, string> BuildEnvironment()
  {
    if (Role == ServiceRole.Web)
    {
      return new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
      {
        ["WEB_PORT"] = WebPort.ToString(),
        ["WEB_HOST"] = WebHost,
        ["WORKFLOW_API_BASE_URL"] = WorkflowApiBaseUrl,
      };
    }

    var env = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
    {
      ["PORT"] = BridgePort.ToString(),
      ["BRIDGE_HOST"] = BridgeHost,
      ["MERCURY_BASE_URL"] = MercuryBaseUrl,
      ["MERCURY_SOAP_NAMESPACE"] = MercurySoapNamespace,
      ["MERCURY_LOCAL_NETWORK_ONLY"] = MercuryLocalNetworkOnly,
    };

    var resolvedMapboxToken = ResolveMapboxToken();
    if (!string.IsNullOrWhiteSpace(resolvedMapboxToken))
    {
      env["MAPBOX_TOKEN"] = resolvedMapboxToken;
    }

    return env;
  }

  public static HostOptions FromArgs(string[] args)
  {
    var parser = ArgumentParser.Parse(args);
    var command = ResolveCommand(parser);

    var exeDir = AppContext.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
    var appRoot = Directory.GetParent(exeDir)?.FullName ?? exeDir;

    var roleText = parser.Get("service-role", "bridge").Trim().ToLowerInvariant();
    var role = roleText == "web" ? ServiceRole.Web : ServiceRole.Bridge;

    var bridgePort = parser.GetInt("bridge-port", 17344, 1, 65535);
    var webPort = parser.GetInt("web-port", 5173, 1, 65535);

    var defaultServiceName = role == ServiceRole.Web
      ? "FTD Mercury Dashboard Web"
      : "FTD Mercury Workflow Bridge";

    var defaultNodePath = Path.GetFullPath(Path.Combine(appRoot, "runtime", "node.exe"));
    var defaultBridgeScript = Path.GetFullPath(Path.Combine(appRoot, "workflow-bridge", "server.mjs"));
    var defaultWebScript = Path.GetFullPath(Path.Combine(appRoot, "service-host", "dashboard-web-server.mjs"));
    var defaultBridgeWorkingDir = Path.GetFullPath(Path.Combine(appRoot, "workflow-bridge"));
    var defaultWebWorkingDir = Path.GetFullPath(Path.Combine(appRoot, "service-host"));
    var defaultLogDir = Path.GetFullPath(Path.Combine(appRoot, "logs"));

    var serviceName = parser.Get("service-name", defaultServiceName);

    var workflowApiBaseUrl = parser.Get("workflow-api-base-url", $"http://127.0.0.1:{bridgePort}");

    return new HostOptions
    {
      Role = role,
      Command = command,
      ServiceName = serviceName,
      DependsOnService = parser.Get("depends-on-service", string.Empty),
      StartMode = parser.Get("start-mode", "auto"),

      NodeExePath = Path.GetFullPath(parser.Get("node-exe", defaultNodePath)),
      ScriptPath = Path.GetFullPath(parser.Get("script", role == ServiceRole.Web ? defaultWebScript : defaultBridgeScript)),
      WorkingDirectory = Path.GetFullPath(parser.Get("working-dir", role == ServiceRole.Web ? defaultWebWorkingDir : defaultBridgeWorkingDir)),
      LogDirectory = Path.GetFullPath(parser.Get("log-dir", defaultLogDir)),

      BridgePort = bridgePort,
      WebPort = webPort,
      BridgeHost = parser.Get("bridge-host", "0.0.0.0"),
      WebHost = parser.Get("web-host", "0.0.0.0"),
      WorkflowApiBaseUrl = workflowApiBaseUrl,

      MercuryBaseUrl = parser.Get("mercury-base-url", "http://127.0.0.1/WsMercuryWebAPI"),
      MercurySoapNamespace = parser.Get("mercury-soap-namespace", "http://localhost/webservices/"),
      MercuryLocalNetworkOnly = parser.GetBool("mercury-local-network-only", true) ? "true" : "false",
      MapboxToken = parser.Get("mapbox-token", string.Empty),
      MapboxTokenProtected = parser.Get("mapbox-token-protected", string.Empty),

      RestartDelayMs = parser.GetInt("restart-delay-ms", 3000, 500, 300000),
    };
  }

  private string ResolveMapboxToken()
  {
    if (!string.IsNullOrWhiteSpace(MapboxToken))
    {
      return MapboxTokenNormalizer.Normalize(MapboxToken);
    }

    if (string.IsNullOrWhiteSpace(MapboxTokenProtected))
    {
      return string.Empty;
    }

    return MapboxTokenNormalizer.Normalize(SecretProtection.UnprotectForLocalMachine(MapboxTokenProtected));
  }

  private static ServiceCommand ResolveCommand(ArgumentParser parser)
  {
    if (parser.HasFlag("service-install")) return ServiceCommand.Install;
    if (parser.HasFlag("service-uninstall")) return ServiceCommand.Uninstall;
    if (parser.HasFlag("service-start")) return ServiceCommand.Start;
    if (parser.HasFlag("service-stop")) return ServiceCommand.Stop;
    if (parser.HasFlag("service-status")) return ServiceCommand.Status;
    return ServiceCommand.None;
  }
}
