using FTD.FaxParser.ServiceHost;
using Microsoft.Extensions.Hosting.WindowsServices;

var options = FTD.FaxParser.ServiceHost.HostOptions.FromArgs(args);

// Handle service management commands (install / uninstall / start / stop / status)
var exitCode = await ServiceCommandHandler.TryHandleAsync(options, CancellationToken.None);
if (exitCode.HasValue)
{
  return exitCode.Value;
}

// Normal run: start as a hosted service
var builder = Host.CreateApplicationBuilder(args);

if (OperatingSystem.IsWindows())
{
  builder.Services.AddWindowsService(svc => svc.ServiceName = options.ServiceName);
}

builder.Services.AddSingleton(options);
builder.Services.AddHostedService<NodeProcessHostedService>();

builder.Logging.ClearProviders();
builder.Logging.AddSimpleConsole(c =>
{
  c.TimestampFormat = "yyyy-MM-dd HH:mm:ss.fff ";
  c.SingleLine = true;
});
builder.Logging.SetMinimumLevel(LogLevel.Information);

await builder.Build().RunAsync();
return 0;
