using System;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using FTD.OposBridge.Service.Scanner;

namespace FTD.OposBridge.Service;

public class OposPrinterDriver : IPrinterDriver
{
    private const int PtrStationReceipt = 2;
    private const int OposSuccess = 0;
    private const int OposEDisabled = 105;
    private const int OposEOffline = 108;
    private const int OposENoHardware = 107;
    private static readonly StaTaskDispatcher StaDispatcher = new("FTD.OposBridge.OposPrinterDriver.STA");
    private readonly BridgeOptions _options;
    private readonly BridgeObservability _log;

    public string LastError { get; private set; } = string.Empty;

    public OposPrinterDriver(BridgeOptions options, BridgeObservability log)
    {
        _options = options;
        _log = log;
    }

    public static string BuildPrintRelayPipeName(int port)
    {
        var normalizedPort = Math.Clamp(port, 1024, 65535);
        return $"FTD.OposBridge.PrintRelay.{normalizedPort}";
    }

    public async Task<bool> PrintAsync(string data, PrinterPreferences prefs, CancellationToken cancellationToken)
    {
        _log.Info($"Printer job requested. Data: {TruncateForLog(data)}");

        try
        {
            if (!Environment.UserInteractive)
            {
                return await TryPrintViaUserSessionRelayAsync(data, prefs, cancellationToken);
            }

            return await StaDispatcher.InvokeAsync(() => PrintInternal(data, prefs, cancellationToken), cancellationToken);
        }
        catch (OperationCanceledException)
        {
            LastError = "Printer operation was canceled.";
            _log.Warn(LastError);
            return false;
        }
        catch (Exception ex)
        {
            LastError = ex.Message;
            _log.Error($"Printer exception: {LastError}");
            return false;
        }
    }

    public Task<bool> PrintTestAsync(PrinterPreferences prefs, CancellationToken cancellationToken)
    {
        return PrintAsync("*** TEST PRINT ***", prefs, cancellationToken);
    }

    private async Task<bool> TryPrintViaUserSessionRelayAsync(string data, PrinterPreferences prefs, CancellationToken cancellationToken)
    {
        var request = new PrintRelayRequest
        {
            Data = data ?? string.Empty,
            LogicalName = ResolveLogicalName(prefs),
        };

        var pipeName = BuildPrintRelayPipeName(_options.Port);
        try
        {
            using var pipe = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut, PipeOptions.Asynchronous);
            using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeoutCts.CancelAfter(TimeSpan.FromSeconds(20));

            await pipe.ConnectAsync(5000, timeoutCts.Token);

            using var writer = new StreamWriter(pipe, System.Text.Encoding.UTF8, 1024, leaveOpen: true)
            {
                AutoFlush = true
            };
            using var reader = new StreamReader(pipe, System.Text.Encoding.UTF8, detectEncodingFromByteOrderMarks: true, bufferSize: 1024, leaveOpen: true);

            var requestJson = JsonSerializer.Serialize(request);
            await writer.WriteLineAsync(requestJson);

            var responseJson = await reader.ReadLineAsync(timeoutCts.Token);
            var response = string.IsNullOrWhiteSpace(responseJson)
                ? null
                : JsonSerializer.Deserialize<PrintRelayResponse>(responseJson);
            if (response is not null && response.Ok)
            {
                LastError = string.Empty;
                return true;
            }

            LastError = string.IsNullOrWhiteSpace(response?.Error)
                ? "Tray print relay returned failure without details."
                : response!.Error;
            return false;
        }
        catch (TimeoutException)
        {
            LastError = "Timed out waiting for tray print relay. Ensure tray is running in the logged-in session.";
            return false;
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception ex)
        {
            LastError = $"Unable to reach tray print relay '{pipeName}': {ex.Message}";
            return false;
        }
    }

    private bool PrintInternal(string data, PrinterPreferences prefs, CancellationToken cancellationToken)
    {
        dynamic? opos = null;
        try
        {
            cancellationToken.ThrowIfCancellationRequested();

            var logicalName = ResolveLogicalName(prefs);
            var oposType = Type.GetTypeFromProgID("OPOS.POSPrinter");
            if (oposType == null)
            {
                LastError = "OPOS.POSPrinter COM object not found. Is the OPOS POSPrinter driver installed?";
                return false;
            }

            opos = Activator.CreateInstance(oposType);
            if (opos == null)
            {
                LastError = "Failed to create OPOS.POSPrinter COM instance.";
                return false;
            }

            var openRc = InvokeResultCode(() => opos.Open(logicalName));
            if (openRc != OposSuccess)
            {
                LastError = BuildOposFailure("Open", openRc, opos, logicalName);
                return false;
            }

            var claimRc = InvokeResultCode(() => opos.ClaimDevice(3000));
            if (claimRc != OposSuccess)
            {
                LastError = BuildOposFailure("ClaimDevice", claimRc, opos, logicalName);
                return false;
            }

            bool observedEnabled;
            var enabled = TrySetDeviceEnabledWithWait(opos, true, TimeSpan.FromSeconds(4), out observedEnabled);
            if (!enabled)
            {
                _log.Warn(
                    $"DeviceEnabled did not flip true for printer '{logicalName}' (observed={observedEnabled}). Continuing with print attempt.");
            }

            var printPayload = EnsureTrailingNewline(data);
            var printRc = InvokeResultCode(() => opos.PrintNormal(PtrStationReceipt, printPayload));
            if (printRc is OposEDisabled or OposEOffline or OposENoHardware)
            {
                _log.Warn($"PrintNormal returned {MapOposResultCode(printRc)} ({printRc}); attempting re-enable/retry.");
                bool observedDisabled;
                TrySetDeviceEnabledWithWait(opos, false, TimeSpan.FromSeconds(1), out observedDisabled);
                Thread.Sleep(120);
                bool observedEnabledRetry;
                TrySetDeviceEnabledWithWait(opos, true, TimeSpan.FromSeconds(3), out observedEnabledRetry);
                Thread.Sleep(120);
                printRc = InvokeResultCode(() => opos.PrintNormal(PtrStationReceipt, printPayload));

                if (printRc != OposSuccess)
                {
                    string reopenError;
                    if (TryReopenClaimAndEnable(opos, logicalName, out reopenError))
                    {
                        printRc = InvokeResultCode(() => opos.PrintNormal(PtrStationReceipt, printPayload));
                    }
                    else if (!string.IsNullOrWhiteSpace(reopenError))
                    {
                        _log.Warn(reopenError);
                    }
                }
            }

            if (printRc != OposSuccess)
            {
                LastError = BuildOposFailure("PrintNormal", printRc, opos, logicalName);
                return false;
            }

            LastError = string.Empty;
            _log.Info("Printer job completed successfully.");
            return true;
        }
        catch (COMException comEx)
        {
            LastError = $"Printer COM exception (0x{comEx.HResult:X8}): {comEx.Message}";
            return false;
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception ex)
        {
            LastError = ex.Message;
            return false;
        }
        finally
        {
            CleanupOpos(opos);
        }
    }

    private static string ResolveLogicalName(PrinterPreferences prefs)
    {
        var logicalName = prefs.PrinterLogicalName;
        if (string.IsNullOrWhiteSpace(logicalName))
        {
            logicalName = "POSPrinter";
        }

        return logicalName.Trim();
    }

    private static int InvokeResultCode(Func<int> action)
    {
        return action();
    }

    private bool TryReopenClaimAndEnable(dynamic opos, string logicalName, out string error)
    {
        error = string.Empty;
        try
        {
            try
            {
                opos.ReleaseDevice();
            }
            catch
            {
                // Best effort only.
            }

            try
            {
                opos.Close();
            }
            catch
            {
                // Best effort only.
            }

            var openRc = InvokeResultCode(() => opos.Open(logicalName));
            if (openRc != OposSuccess)
            {
                error = BuildOposFailure("Open(recover)", openRc, opos, logicalName);
                return false;
            }

            var claimRc = InvokeResultCode(() => opos.ClaimDevice(3000));
            if (claimRc != OposSuccess)
            {
                error = BuildOposFailure("ClaimDevice(recover)", claimRc, opos, logicalName);
                return false;
            }

            bool observedEnabled;
            if (!TrySetDeviceEnabledWithWait(opos, true, TimeSpan.FromSeconds(4), out observedEnabled))
            {
                error =
                    $"Unable to enable OPOS printer device after recover-open for '{logicalName}' (DeviceEnabled={observedEnabled}, resultCode={TryGetIntProperty(opos, "ResultCode")}, resultCodeExtended={TryGetIntProperty(opos, "ResultCodeExtended")}).";
                return false;
            }

            return true;
        }
        catch (Exception ex)
        {
            error = $"Recover-open attempt failed for '{logicalName}': {ex.Message}";
            return false;
        }
    }

    private static bool TrySetDeviceEnabledWithWait(dynamic opos, bool enabled, TimeSpan timeout, out bool observedState)
    {
        observedState = !enabled;

        try
        {
            opos.DeviceEnabled = enabled;
        }
        catch
        {
            return false;
        }

        var deadline = DateTime.UtcNow.Add(timeout <= TimeSpan.Zero ? TimeSpan.FromMilliseconds(500) : timeout);
        while (DateTime.UtcNow <= deadline)
        {
            bool state;
            if (TryGetBoolProperty(opos, "DeviceEnabled", out state))
            {
                observedState = state;
                if (state == enabled)
                {
                    return true;
                }
            }

            Thread.Sleep(120);
        }

        return false;
    }

    private static bool TryGetBoolProperty(dynamic opos, string propertyName, out bool value)
    {
        value = false;
        try
        {
            var raw = propertyName switch
            {
                "DeviceEnabled" => opos.DeviceEnabled,
                _ => false,
            };

            value = Convert.ToBoolean(raw);
            return true;
        }
        catch
        {
            value = false;
            return false;
        }
    }

    private static int TryGetIntProperty(dynamic opos, string propertyName)
    {
        try
        {
            var raw = propertyName switch
            {
                "ResultCode" => opos.ResultCode,
                "ResultCodeExtended" => opos.ResultCodeExtended,
                _ => 0,
            };

            return Convert.ToInt32(raw);
        }
        catch
        {
            return 0;
        }
    }

    private static string BuildOposFailure(string operation, int resultCode, dynamic opos, string logicalName)
    {
        var codeName = MapOposResultCode(resultCode);
        var ext = TryGetIntProperty(opos, "ResultCodeExtended");
        var rcProperty = TryGetIntProperty(opos, "ResultCode");
        bool enabledValue;
        var enabled = TryGetBoolProperty(opos, "DeviceEnabled", out enabledValue) && enabledValue;
        return
            $"{operation} failed for logical printer '{logicalName}': {codeName} ({resultCode}), resultCode={rcProperty}, resultCodeExtended={ext}, deviceEnabled={enabled}.";
    }

    private static string MapOposResultCode(int resultCode)
    {
        return resultCode switch
        {
            0 => "OPOS_SUCCESS",
            101 => "OPOS_E_CLOSED",
            102 => "OPOS_E_CLAIMED",
            103 => "OPOS_E_NOTCLAIMED",
            104 => "OPOS_E_NOSERVICE",
            105 => "OPOS_E_DISABLED",
            106 => "OPOS_E_ILLEGAL",
            107 => "OPOS_E_NOHARDWARE",
            108 => "OPOS_E_OFFLINE",
            109 => "OPOS_E_NOEXIST",
            110 => "OPOS_E_EXISTS",
            111 => "OPOS_E_FAILURE",
            112 => "OPOS_E_TIMEOUT",
            113 => "OPOS_E_BUSY",
            114 => "OPOS_E_EXTENDED",
            _ => "OPOS_E_UNKNOWN",
        };
    }

    private static string EnsureTrailingNewline(string data)
    {
        var value = data ?? string.Empty;
        if (value.EndsWith("\r\n", StringComparison.Ordinal) || value.EndsWith("\n", StringComparison.Ordinal))
        {
            return value;
        }

        return value + "\r\n";
    }

    private static void CleanupOpos(dynamic? opos)
    {
        if (opos == null)
        {
            return;
        }

        try
        {
            bool observedDisabled;
            TrySetDeviceEnabledWithWait(opos, false, TimeSpan.FromMilliseconds(300), out observedDisabled);
        }
        catch
        {
            // Best-effort cleanup only.
        }

        try
        {
            opos.ReleaseDevice();
        }
        catch
        {
            // Best-effort cleanup only.
        }

        try
        {
            opos.Close();
        }
        catch
        {
            // Best-effort cleanup only.
        }

        try
        {
            if (Marshal.IsComObject(opos))
            {
                Marshal.FinalReleaseComObject(opos);
            }
        }
        catch
        {
            // Best-effort cleanup only.
        }
    }

    private static string TruncateForLog(string? data, int maxLen = 256)
    {
        if (string.IsNullOrEmpty(data))
        {
            return "<empty>";
        }

        if (data.Length <= maxLen)
        {
            return data.Replace("\r", "").Replace("\n", " ");
        }

        return data.Substring(0, maxLen).Replace("\r", "").Replace("\n", " ") + "... [truncated]";
    }

    private sealed class PrintRelayRequest
    {
        public string Data { get; set; } = "";
        public string LogicalName { get; set; } = "";
    }

    private sealed class PrintRelayResponse
    {
        public bool Ok { get; set; }
        public string Error { get; set; } = "";
    }
}
