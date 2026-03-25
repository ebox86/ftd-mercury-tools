using FTD.OposBridge.Service;
using FTD.OposBridge.Service.Scanner;
using Microsoft.Extensions.Hosting.WindowsServices;

var options = BridgeOptions.FromArgs(args);
var serviceCommandExit = await ServiceCommandHandler.TryHandleAsync(args, options, CancellationToken.None);
if (serviceCommandExit.HasValue)
{
  return serviceCommandExit.Value;
}

if (options.ScannerSpike)
{
  return await ScannerSpikeRunner.RunAsync(options);
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

builder.Logging.ClearProviders();
builder.Logging.AddSimpleConsole(console =>
{
  console.TimestampFormat = "yyyy-MM-dd HH:mm:ss.fff ";
  console.SingleLine = true;
});

builder.Services.AddSingleton(options);
builder.Services.AddSingleton<BridgeObservability>();
builder.Services.AddSingleton<IScannerDriver>(sp =>
{
  var logger = sp.GetRequiredService<ILoggerFactory>().CreateLogger("ScannerDriver");
  return ScannerDriverFactory.Create(options, logger);
});
builder.Services.AddSingleton<BridgeRuntime>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<BridgeRuntime>());

var app = builder.Build();

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

// Prototype-only helper for mock driver smoke tests.
app.MapGet("/debug/inject", async (HttpRequest request, BridgeRuntime runtime, CancellationToken ct) =>
{
  var value = request.Query["value"].ToString();
  var body = await runtime.InjectDebugScanAsync(value, ct);
  return Results.Json(body);
});

await app.RunAsync();
return 0;
