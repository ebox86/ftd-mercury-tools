using Microsoft.Extensions.Hosting.WindowsServices;

namespace FTD.Mercury.Dashboard.ServiceHost;

internal static class Program
{
  public static async Task<int> Main(string[] args)
  {
    var options = HostOptions.FromArgs(args);

    var serviceCommandExit = await ServiceCommandHandler.TryHandleAsync(options, CancellationToken.None);
    if (serviceCommandExit.HasValue)
    {
      return serviceCommandExit.Value;
    }

    var builder = Host.CreateApplicationBuilder(args);
    if (OperatingSystem.IsWindows())
    {
      builder.Services.AddWindowsService(service =>
      {
        service.ServiceName = options.ServiceName;
      });
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
