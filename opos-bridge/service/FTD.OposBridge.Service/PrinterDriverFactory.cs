using Microsoft.Extensions.Logging;

namespace FTD.OposBridge.Service;

public static class PrinterDriverFactory
{
    public static IPrinterDriver Create(BridgeOptions options, ILogger logger, BridgeObservability observability)
    {
        // In the future, select driver based on options
        return new OposPrinterDriver(options, observability);
    }
}
