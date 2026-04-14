
using System;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Hosting.WindowsServices;
using FTD.OposBridge.Service;
using FTD.OposBridge.Service.Scanner;

var options = BridgeOptions.FromArgs(args);
var serviceCommandExit = await ServiceCommandHandler.TryHandleAsync(args, options, CancellationToken.None);
if (serviceCommandExit.HasValue)
{
  return serviceCommandExit.Value;
}

if (options.TrayIconEnabled && options.HideConsoleOnStartup && OperatingSystem.IsWindows() && Environment.UserInteractive)
{
  ConsoleWindow.TryHide();
}

if (options.ScannerSpike)
{
  return await ScannerSpikeRunner.RunAsync(options);
}

if (options.TrayCompanion)
{
  return await TrayCompanionRunner.RunAsync(options);
}

if (options.AgentRelay)
{
  return await AgentRelayRunner.RunAsync(options);
}

var builder = WebApplication.CreateBuilder(args);
if (OperatingSystem.IsWindows())
{
  builder.Host.UseWindowsService(service =>
  {
    service.ServiceName = options.ServiceName;
  });
}

builder.WebHost.UseUrls($"http://127.0.0.1:{options.Port}/");
builder.Services.AddCors(cors =>
{
  cors.AddPolicy("bridge-cors", policy =>
  {
    policy.AllowAnyOrigin().AllowAnyMethod().AllowAnyHeader();
  });
});

builder.Logging.ClearProviders();
builder.Logging.AddSimpleConsole(console =>
{
  console.TimestampFormat = "yyyy-MM-dd HH:mm:ss.fff ";
  console.SingleLine = true;
});
builder.Logging.SetMinimumLevel(options.MinimumLogLevel);

BridgeInstanceLock instanceLock;
try
{
  instanceLock = BridgeInstanceLock.Acquire(options.Port);
}
catch (Exception ex)
{
  Console.Error.WriteLine(ex.Message);
  return 2;
}

builder.Services.AddSingleton(options);
builder.Services.AddSingleton(instanceLock);
builder.Services.AddSingleton<BridgeObservability>();
if (options.EnableScanner)
{
  builder.Services.AddSingleton<IScannerDriver>(sp =>
  {
    var logger = sp.GetRequiredService<ILoggerFactory>().CreateLogger("ScannerDriver");
    return ScannerDriverFactory.Create(options, logger);
  });
}
if (options.EnablePrinter)
{
  builder.Services.AddSingleton<IPrinterDriver>(sp =>
  {
    var logger = sp.GetRequiredService<ILoggerFactory>().CreateLogger("PrinterDriver");
    var observability = sp.GetRequiredService<BridgeObservability>();
    return PrinterDriverFactory.Create(options, logger, observability);
  });
}
builder.Services.AddSingleton<BridgeRuntime>(sp =>
{
  return new BridgeRuntime(
    options,
    sp.GetService<IScannerDriver>(),
    sp.GetService<IPrinterDriver>(),
    instanceLock,
    sp.GetRequiredService<BridgeObservability>(),
    sp.GetRequiredService<ILogger<BridgeRuntime>>()
  );
});

builder.Services.AddHostedService(sp => sp.GetRequiredService<BridgeRuntime>());
builder.Services.AddHostedService<BridgeTrayIconHost>();

var app = builder.Build();
app.UseCors("bridge-cors");

// Only one program flow: all setup above, then build and map endpoints below


app.MapPost("/api/print-receipt", async (HttpRequest request, BridgeRuntime runtime, CancellationToken ct) =>
{
  using var reader = new StreamReader(request.Body);
  var body = await reader.ReadToEndAsync();
  // Accepts raw text or JSON { data: "..." }
  string data = body;
  if (request.ContentType?.Contains("application/json") == true)
  {
    try
    {
      var json = System.Text.Json.JsonDocument.Parse(body);
      if (json.RootElement.TryGetProperty("data", out var dataProp))
      {
        data = dataProp.GetString() ?? "";
      }
    }
    catch { }
  }
  var result = await runtime.PrintReceiptAsync(data, ct);
  return Results.Json(result, statusCode: result.Ok ? StatusCodes.Status200OK : StatusCodes.Status500InternalServerError);
});

// Test endpoint: print a test receipt
app.MapGet("/api/print-test-receipt", async (BridgeRuntime runtime, CancellationToken ct) =>
{
  var result = await runtime.PrintTestReceiptAsync(ct);
  return Results.Json(result, statusCode: result.Ok ? StatusCodes.Status200OK : StatusCodes.Status500InternalServerError);
});

app.MapGet("/api/print-test-star", async (HttpRequest request, BridgeRuntime runtime, CancellationToken ct) =>
{
  var logicalName = request.Query["logicalName"].ToString();
  var message = request.Query["message"].ToString();
  var result = await runtime.PrintTestReceiptAsync(logicalName, message, ct);
  return Results.Json(result, statusCode: result.Ok ? StatusCodes.Status200OK : StatusCodes.Status500InternalServerError);
});

app.MapGet("/api/opos/devices", () =>
{
  var printers = OposDeviceEnumerator.GetOposLogicalNames("POSPrinter");
  var scanners = OposDeviceEnumerator.GetOposLogicalNames("Scanner");
  var prefs = PrinterPreferences.Load();
  return Results.Json(new
  {
    ok = true,
    configuredPrinterLogicalName = prefs.PrinterLogicalName ?? "",
    printers,
    scanners,
  });
});

app.MapGet("/api/printer/config", () =>
{
  var prefs = PrinterPreferences.Load();
  return Results.Json(new
  {
    ok = true,
    logicalName = prefs.PrinterLogicalName ?? "",
    paperWidthMm = prefs.PaperWidthMm,
    printDensity = prefs.PrintDensity,
  });
});

app.MapPost("/api/printer/config", async (HttpRequest request) =>
{
  string logicalName = request.Query["logicalName"].ToString();
  if (string.IsNullOrWhiteSpace(logicalName))
  {
    try
    {
      var body = await request.ReadFromJsonAsync<Dictionary<string, string>>();
      if (body is not null && body.TryGetValue("logicalName", out var fromBody))
      {
        logicalName = fromBody ?? "";
      }
    }
    catch
    {
      // Ignore malformed bodies; query value takes precedence.
    }
  }

  var selected = (logicalName ?? "").Trim();
  if (string.IsNullOrWhiteSpace(selected))
  {
    return Results.BadRequest(new { ok = false, error = "logicalName is required." });
  }

  var prefs = PrinterPreferences.Load();
  prefs.PrinterLogicalName = selected;
  prefs.Save();
  return Results.Json(new
  {
    ok = true,
    logicalName = prefs.PrinterLogicalName ?? "",
  });
});

app.MapGet("/", async (BridgeRuntime runtime, CancellationToken ct) =>
{
  var body = await runtime.GetRootAsync(ct);
  return Results.Json(body);
});

app.MapGet("/health", async (BridgeRuntime runtime, CancellationToken ct) =>
{
  var body = await runtime.GetHealthAsync(ct);
  return Results.Json(body);
});

app.MapGet("/diagnostics/startup", async (BridgeRuntime runtime, CancellationToken ct) =>
{
  var body = await runtime.GetStartupDiagnosticsAsync(ct);
  return Results.Json(body);
});

app.MapGet("/scan/latest", async (BridgeRuntime runtime, CancellationToken ct) =>
{
  var body = await runtime.GetLatestScanAsync(ct);
  return Results.Json(body);
});

app.MapGet("/scan/next", async (HttpRequest request, BridgeRuntime runtime, CancellationToken ct) =>
{
  var owner = request.Query["owner"].ToString();
  var body = await runtime.GetNextScanAsync(owner, ct);
  return Results.Json(body);
});

app.MapGet("/scan/clear", async (BridgeRuntime runtime, CancellationToken ct) =>
{
  var body = await runtime.ClearScanAsync(ct);
  return Results.Json(body);
});

app.MapGet("/scanner/lease", async (HttpRequest request, BridgeRuntime runtime, CancellationToken ct) =>
{
  var owner = request.Query["owner"].ToString();
  var requestedMs = 0;
  _ = int.TryParse(request.Query["ms"], out requestedMs);
  var body = await runtime.AcquireOrRenewLeaseAsync(owner, requestedMs, ct);
  return Results.Json(body);
});

app.MapGet("/scanner/release", async (HttpRequest request, BridgeRuntime runtime, CancellationToken ct) =>
{
  var owner = request.Query["owner"].ToString();
  var force = string.Equals(request.Query["force"], "1", StringComparison.OrdinalIgnoreCase);
  var body = await runtime.ReleaseLeaseAsync(owner, force, ct);
  return Results.Json(body);
});

app.MapGet("/scanner/rearm", async (BridgeRuntime runtime, CancellationToken ct) =>
{
  var body = await runtime.RearmScannerAsync(ct);
  return Results.Json(body);
});

app.MapGet("/agent/control", async (HttpRequest request, BridgeRuntime runtime, CancellationToken ct) =>
{
  var agentId = request.Query["agentId"].ToString();
  _ = long.TryParse(request.Query["knownCommandId"], out var knownCommandId);
  var claimedReported = string.Equals(request.Query["claimed"], "1", StringComparison.OrdinalIgnoreCase)
    || string.Equals(request.Query["claimed"], "true", StringComparison.OrdinalIgnoreCase);
  var body = await runtime.GetAgentControlAsync(agentId, knownCommandId, claimedReported, ct);
  return Results.Json(body);
});

app.MapGet("/agent/ack", async (HttpRequest request, BridgeRuntime runtime, CancellationToken ct) =>
{
  var agentId = request.Query["agentId"].ToString();
  _ = long.TryParse(request.Query["commandId"], out var commandId);
  var claimed = string.Equals(request.Query["claimed"], "1", StringComparison.OrdinalIgnoreCase)
    || string.Equals(request.Query["claimed"], "true", StringComparison.OrdinalIgnoreCase);
  var message = request.Query["message"].ToString();
  var correlationId = request.Query["correlationId"].ToString();
  var body = await runtime.AckAgentControlAsync(agentId, commandId, claimed, message, correlationId, ct);
  return Results.Json(body);
});

// Debug helper for mock driver smoke tests.
app.MapGet("/debug/inject", async (HttpRequest request, BridgeRuntime runtime, CancellationToken ct) =>
{
  var value = request.Query["value"].ToString();
  var source = request.Query["source"].ToString();
  var owner = request.Query["owner"].ToString();
  var leaseToken = request.Query["leaseToken"].ToString();
  _ = long.TryParse(request.Query["commandId"], out var commandId);
  var correlationId = request.Query["correlationId"].ToString();
  var body = await runtime.InjectDebugScanAsync(value, source, owner, leaseToken, commandId, correlationId, ct);
  return Results.Json(body);
});

await app.RunAsync();
return 0;
