namespace FTD.OposBridge.Service.Scanner;

public static class ScannerDriverFactory
{
  public static IScannerDriver Create(BridgeOptions options, ILogger logger)
  {
    var mode = (options.ScannerMode ?? "").Trim().ToLowerInvariant();
    if (mode == "mock")
    {
      return new MockScannerDriver(logger);
    }

    return new OposComScannerDriver(options, logger);
  }
}
