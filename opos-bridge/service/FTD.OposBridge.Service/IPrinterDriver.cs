namespace FTD.OposBridge.Service;

public interface IPrinterDriver
{
    Task<bool> PrintAsync(string data, PrinterPreferences prefs, CancellationToken cancellationToken);
    Task<bool> PrintTestAsync(PrinterPreferences prefs, CancellationToken cancellationToken);
    string LastError { get; }
}
