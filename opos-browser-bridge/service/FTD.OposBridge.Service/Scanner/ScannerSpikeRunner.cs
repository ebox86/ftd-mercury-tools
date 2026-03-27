using System.Text;

namespace FTD.OposBridge.Service.Scanner;

public static class ScannerSpikeRunner
{
  public static async Task<int> RunAsync(BridgeOptions options)
  {
    using var loggerFactory = LoggerFactory.Create(logging =>
    {
      logging.ClearProviders();
      logging.AddSimpleConsole(console =>
      {
        console.TimestampFormat = "yyyy-MM-dd HH:mm:ss.fff ";
        console.SingleLine = true;
      });
    });

    var logger = loggerFactory.CreateLogger("ScannerSpike");
    var scannerLogger = loggerFactory.CreateLogger("ScannerDriver");
    var driver = ScannerDriverFactory.Create(options, scannerLogger);

    using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(options.SpikeTimeoutSeconds + 10));
    try
    {
      logger.LogInformation("Starting scanner spike (mode={Mode}, logicalName={LogicalName}).", options.ScannerMode, options.LogicalName);
      await driver.InitializeAsync(cts.Token);

      var claimed = await driver.EnsureClaimedAsync(options.ClaimTimeoutMs, "scanner-spike", cts.Token);
      if (!claimed)
      {
        logger.LogError("Could not claim OPOS scanner for spike.");
        return 2;
      }

      logger.LogInformation("Scanner claimed. Scan a ticket within {Seconds}s...", options.SpikeTimeoutSeconds);
      var until = DateTimeOffset.UtcNow.AddSeconds(options.SpikeTimeoutSeconds);
      while (DateTimeOffset.UtcNow < until)
      {
        cts.Token.ThrowIfCancellationRequested();
        var snapshot = await driver.ReadSnapshotAsync(cts.Token);
        var value = NormalizeScanValue(string.IsNullOrWhiteSpace(snapshot.Label) ? snapshot.Raw : snapshot.Label);
        if (!string.IsNullOrWhiteSpace(value))
        {
          logger.LogInformation(
            "Spike captured scan value='{Value}' dataCount={DataCount} dataType={DataType} deviceEnabled={DeviceEnabled}",
            value,
            snapshot.DataCount,
            snapshot.DataType,
            snapshot.DeviceEnabled);
          await driver.ClearInputAsync(cts.Token);
          return 0;
        }

        await Task.Delay(75, cts.Token);
      }

      logger.LogWarning("No scan captured during spike timeout.");
      return 3;
    }
    catch (OperationCanceledException)
    {
      logger.LogWarning("Scanner spike canceled or timed out.");
      return 4;
    }
    catch (Exception ex)
    {
      logger.LogError(ex, "Scanner spike failed.");
      return 1;
    }
    finally
    {
      try
      {
        await driver.ReleaseClaimAsync("scanner-spike-finish", CancellationToken.None);
      }
      catch
      {
        // Ignore release failures during spike cleanup.
      }

      try
      {
        await driver.ShutdownAsync(CancellationToken.None);
      }
      catch
      {
        // Ignore shutdown failures during spike cleanup.
      }
    }
  }

  private static string NormalizeScanValue(string? input)
  {
    if (string.IsNullOrWhiteSpace(input))
    {
      return "";
    }

    var sb = new StringBuilder(input.Length);
    foreach (var ch in input)
    {
      if (ch >= 0x20 && ch <= 0x7E)
      {
        sb.Append(ch);
      }
    }

    return sb.ToString().Trim();
  }
}
