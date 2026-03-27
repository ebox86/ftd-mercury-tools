using System.Globalization;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Collections.Concurrent;

namespace FTD.OposBridge.Service.Scanner;

public sealed class OposComScannerDriver : IScannerDriver
{
  private delegate void DataEventComHandler(int status);
  private delegate void ErrorEventComHandler(int resultCode, int resultCodeExtended, int errorLocus, ref int errorResponse);

  private const int DataEventDispId = 1;
  private const int ErrorEventDispId = 3;
  private static readonly Guid ScannerEventsGuid = new("CCB90183-B81E-11D2-AB74-0040054C3719");

  private readonly BridgeOptions _options;
  private readonly ILogger _logger;
  private readonly StaTaskDispatcher _dispatcher = new("FTD.OPOS.STA");
  private readonly ConcurrentQueue<ScannerSnapshot> _eventSnapshots = new();
  private object? _scanner;
  private bool _started;
  private bool _claimed;
  private bool? _deviceEnabled;
  private bool? _autoDisable;
  private string _lastError = "";
  private int _lastOpenResult = -1;
  private string _comProgId = "";
  private bool _eventSinkAttached;
  private DataEventComHandler? _dataEventSink;
  private ErrorEventComHandler? _errorEventSink;

  public OposComScannerDriver(BridgeOptions options, ILogger logger)
  {
    _options = options;
    _logger = logger;
  }

  public string Mode => "opos";
  public bool IsClaimed => _claimed;
  public bool? DeviceEnabled => _deviceEnabled;
  public bool? AutoDisable => _autoDisable;
  public string LastError => _lastError;

  public Task InitializeAsync(CancellationToken cancellationToken)
  {
    return _dispatcher.RunAsync(() =>
    {
      if (_started)
      {
        return;
      }

      _scanner = CreateScannerComObjectUnsafe();
      var openResult = InvokeIntUnsafe("Open", _options.LogicalName);
      _lastOpenResult = openResult;
      if (openResult != 0)
      {
        throw new InvalidOperationException($"Open({_options.LogicalName}) failed with OPOS result {openResult}");
      }

      _started = true;
      _claimed = false;
      _deviceEnabled = TryGetBoolUnsafe("DeviceEnabled");
      _autoDisable = TryGetBoolUnsafe("AutoDisable");
      _lastError = "";
      AttachEventSinksUnsafe();
      _logger.LogInformation("OPOS scanner opened (logicalName={LogicalName}).", _options.LogicalName);
    }, cancellationToken);
  }

  public async Task ShutdownAsync(CancellationToken cancellationToken)
  {
    await _dispatcher.RunAsync(() =>
    {
      if (_scanner is null)
      {
        _started = false;
        _claimed = false;
        _deviceEnabled = false;
        _lastError = "";
        while (_eventSnapshots.TryDequeue(out _)) { }
        return;
      }

      DetachEventSinksUnsafe();

      if (_claimed)
      {
        TrySetPropertyUnsafe("DataEventEnabled", false);
        TrySetPropertyUnsafe("DeviceEnabled", false);
        TryInvokeUnsafe("ReleaseDevice");
        _claimed = false;
      }

      TryInvokeUnsafe("Close");
      if (Marshal.IsComObject(_scanner))
      {
        try
        {
          Marshal.FinalReleaseComObject(_scanner);
        }
        catch
        {
          // Ignore COM final release failures during shutdown.
        }
      }

      _scanner = null;
      _started = false;
      _claimed = false;
      _deviceEnabled = false;
      _autoDisable = false;
      _lastError = "";
      _lastOpenResult = -1;
      _eventSinkAttached = false;
      _comProgId = "";
      while (_eventSnapshots.TryDequeue(out _)) { }
    }, cancellationToken);

    await _dispatcher.DisposeAsync();
  }

  public Task<bool> EnsureClaimedAsync(int timeoutMs, string reason, CancellationToken cancellationToken)
  {
    return _dispatcher.InvokeAsync(() =>
    {
      EnsureStartedUnsafe();

      if (_claimed)
      {
        ApplyRuntimeSettingsUnsafe();
        _deviceEnabled = TryGetBoolUnsafe("DeviceEnabled");
        _autoDisable = TryGetBoolUnsafe("AutoDisable");
        return true;
      }

      var claimResult = InvokeIntUnsafe("ClaimDevice", Math.Max(100, timeoutMs));
      if (claimResult != 0)
      {
        _logger.LogWarning("ClaimDevice failed (reason={Reason}, result={Result}).", reason, claimResult);
        _lastError = $"ClaimDevice failed ({reason}) with OPOS result {claimResult}.";
        _claimed = false;
        _deviceEnabled = false;
        return false;
      }

      _claimed = true;
      _lastError = "";
      ApplyRuntimeSettingsUnsafe();
      _deviceEnabled = TryGetBoolUnsafe("DeviceEnabled");
      _autoDisable = TryGetBoolUnsafe("AutoDisable");
      return true;
    }, cancellationToken);
  }

  public Task<bool> ReleaseClaimAsync(string reason, CancellationToken cancellationToken)
  {
    return _dispatcher.InvokeAsync(() =>
    {
      if (!_started || _scanner is null)
      {
        _claimed = false;
        _deviceEnabled = false;
        return false;
      }

      if (!_claimed)
      {
        _deviceEnabled = TryGetBoolUnsafe("DeviceEnabled");
        _autoDisable = TryGetBoolUnsafe("AutoDisable");
        return false;
      }

      TrySetPropertyUnsafe("DataEventEnabled", false);
      TrySetPropertyUnsafe("DeviceEnabled", false);
      TryInvokeUnsafe("ReleaseDevice");
      _claimed = false;
      _deviceEnabled = false;
      _autoDisable = TryGetBoolUnsafe("AutoDisable");
      _logger.LogInformation("OPOS claim released (reason={Reason}).", reason);
      return true;
    }, cancellationToken);
  }

  public Task<bool> RearmAsync(CancellationToken cancellationToken)
  {
    return _dispatcher.InvokeAsync(() =>
    {
      if (!_started || _scanner is null || !_claimed)
      {
        return false;
      }

      ApplyRuntimeSettingsUnsafe();
      _deviceEnabled = TryGetBoolUnsafe("DeviceEnabled");
      _autoDisable = TryGetBoolUnsafe("AutoDisable");
      return true;
    }, cancellationToken);
  }

  public Task<ScannerStartupDiagnostics> GetStartupDiagnosticsAsync(CancellationToken cancellationToken)
  {
    return _dispatcher.InvokeAsync(() =>
    {
      return new ScannerStartupDiagnostics(
        Mode: "opos",
        LogicalName: _options.LogicalName,
        Initialized: _started,
        Claimed: _claimed,
        OpenResult: _lastOpenResult,
        ComProgId: _comProgId,
        EventSinkAttached: _eventSinkAttached,
        LastError: _lastError);
    }, cancellationToken);
  }

  public Task<ScannerSnapshot?> ReadEventSnapshotAsync(CancellationToken cancellationToken)
  {
    return _dispatcher.InvokeAsync(() =>
    {
      if (!_started || _scanner is null)
      {
        return null;
      }

      if (_eventSnapshots.TryDequeue(out var snapshot))
      {
        return snapshot;
      }

      return null;
    }, cancellationToken);
  }

  public Task<ScannerSnapshot> ReadSnapshotAsync(CancellationToken cancellationToken)
  {
    return _dispatcher.InvokeAsync(() =>
    {
      if (!_started || _scanner is null)
      {
        return new ScannerSnapshot("", "", -1, 0, false, false);
      }

      var label = TryGetStringUnsafe("ScanDataLabel");
      var raw = TryGetStringUnsafe("ScanData");
      var dataCount = TryGetIntUnsafe("DataCount", -1);
      var dataType = TryGetIntUnsafe("ScanDataType", 0);
      _deviceEnabled = TryGetBoolUnsafe("DeviceEnabled");
      _autoDisable = TryGetBoolUnsafe("AutoDisable");

      return new ScannerSnapshot(label, raw, dataCount, dataType, _deviceEnabled, _autoDisable);
    }, cancellationToken);
  }

  public Task<bool> ClearInputAsync(CancellationToken cancellationToken)
  {
    return _dispatcher.InvokeAsync(() =>
    {
      if (!_started || _scanner is null)
      {
        return false;
      }

      TryInvokeUnsafe("ClearInput");
      return true;
    }, cancellationToken);
  }

  private object CreateScannerComObjectUnsafe()
  {
    foreach (var progId in new[] { "OPOS.Scanner", "OposScanner_1_9_Lib.OPOSScannerClass" })
    {
      try
      {
        var type = Type.GetTypeFromProgID(progId, throwOnError: false);
        if (type is null)
        {
          continue;
        }

        var instance = Activator.CreateInstance(type);
        if (instance is not null)
        {
          _logger.LogInformation("Created OPOS scanner COM object via ProgID {ProgId}.", progId);
          _comProgId = progId;
          return instance;
        }
      }
      catch
      {
        // Try next candidate.
      }
    }

    if (File.Exists(_options.InteropDllPath))
    {
      try
      {
        var assembly = Assembly.LoadFrom(_options.InteropDllPath);
        var type = assembly.GetType("OposScanner_1_9_Lib.OPOSScannerClass", throwOnError: false);
        if (type is not null)
        {
          var instance = Activator.CreateInstance(type);
          if (instance is not null)
          {
            _logger.LogInformation("Created OPOS scanner object from interop DLL {InteropDllPath}.", _options.InteropDllPath);
            _comProgId = "interop-dll";
            return instance;
          }
        }
      }
      catch (Exception ex)
      {
        _logger.LogWarning(ex, "Failed to load scanner interop assembly at {InteropDllPath}.", _options.InteropDllPath);
      }
    }

    throw new InvalidOperationException("Unable to create OPOS scanner COM object.");
  }

  private void EnsureStartedUnsafe()
  {
    if (!_started || _scanner is null)
    {
      throw new InvalidOperationException("Scanner is not initialized.");
    }
  }

  private void EnsureScannerObjectUnsafe()
  {
    if (_scanner is null)
    {
      throw new InvalidOperationException("Scanner COM object is not available.");
    }
  }

  private void ApplyRuntimeSettingsUnsafe()
  {
    TrySetPropertyUnsafe("FreezeEvents", false);
    TrySetPropertyUnsafe("AutoDisable", false);
    TrySetPropertyUnsafe("DecodeData", true);
    TrySetPropertyUnsafe("DeviceEnabled", true);
    TrySetPropertyUnsafe("DataEventEnabled", true);
  }

  private void AttachEventSinksUnsafe()
  {
    if (_scanner is null)
    {
      return;
    }

    try
    {
      if (_dataEventSink is null)
      {
        _dataEventSink = OnComDataEvent;
        ComEventsHelper.Combine(_scanner, ScannerEventsGuid, DataEventDispId, _dataEventSink);
      }

      if (_errorEventSink is null)
      {
        _errorEventSink = OnComErrorEvent;
        ComEventsHelper.Combine(_scanner, ScannerEventsGuid, ErrorEventDispId, _errorEventSink);
      }

      _eventSinkAttached = _dataEventSink is not null && _errorEventSink is not null;
    }
    catch (Exception ex)
    {
      _lastError = $"Failed to attach COM event sinks: {ex.Message}";
      _eventSinkAttached = false;
      _logger.LogWarning(ex, "OPOS COM event sink attach failed.");
    }
  }

  private void DetachEventSinksUnsafe()
  {
    if (_scanner is null)
    {
      return;
    }

    try
    {
      if (_dataEventSink is not null)
      {
        ComEventsHelper.Remove(_scanner, ScannerEventsGuid, DataEventDispId, _dataEventSink);
        _dataEventSink = null;
      }
    }
    catch
    {
      // Ignore sink detach failures on shutdown.
    }

    try
    {
      if (_errorEventSink is not null)
      {
        ComEventsHelper.Remove(_scanner, ScannerEventsGuid, ErrorEventDispId, _errorEventSink);
        _errorEventSink = null;
      }
    }
    catch
    {
      // Ignore sink detach failures on shutdown.
    }

    _eventSinkAttached = false;
  }

  private void OnComDataEvent(int status)
  {
    try
    {
      if (!_started || _scanner is null || !_claimed)
      {
        return;
      }

      var label = TryGetStringUnsafe("ScanDataLabel");
      var raw = TryGetStringUnsafe("ScanData");
      var dataCount = TryGetIntUnsafe("DataCount", -1);
      var dataType = TryGetIntUnsafe("ScanDataType", 0);
      _deviceEnabled = TryGetBoolUnsafe("DeviceEnabled");
      _autoDisable = TryGetBoolUnsafe("AutoDisable");

      _eventSnapshots.Enqueue(new ScannerSnapshot(label, raw, dataCount, dataType, _deviceEnabled, _autoDisable));
      TryInvokeUnsafe("ClearInput");
      ApplyRuntimeSettingsUnsafe();
      _deviceEnabled = TryGetBoolUnsafe("DeviceEnabled");
      _autoDisable = TryGetBoolUnsafe("AutoDisable");
      _lastError = "";
    }
    catch (Exception ex)
    {
      _lastError = $"DataEvent handler error: {ex.Message}";
      _logger.LogError(ex, "OPOS DataEvent handler failed.");
      if (_claimed)
      {
        ApplyRuntimeSettingsUnsafe();
      }
    }
  }

  private void OnComErrorEvent(int resultCode, int resultCodeExtended, int errorLocus, ref int errorResponse)
  {
    try
    {
      _lastError = $"Scanner ErrorEvent result={resultCode} ext={resultCodeExtended} locus={errorLocus}";
      _logger.LogWarning(
        "OPOS ErrorEvent received (resultCode={ResultCode}, resultCodeExtended={ResultCodeExtended}, errorLocus={ErrorLocus}).",
        resultCode,
        resultCodeExtended,
        errorLocus);
      if (_claimed)
      {
        ApplyRuntimeSettingsUnsafe();
      }
    }
    catch (Exception ex)
    {
      _lastError = $"ErrorEvent handler failure: {ex.Message}";
      _logger.LogError(ex, "OPOS ErrorEvent handler failed.");
    }
  }

  private int InvokeIntUnsafe(string methodName, params object?[] args)
  {
    var result = InvokeUnsafe(methodName, args);
    try
    {
      return Convert.ToInt32(result, CultureInfo.InvariantCulture);
    }
    catch
    {
      return -1;
    }
  }

  private object? InvokeUnsafe(string methodName, params object?[] args)
  {
    EnsureScannerObjectUnsafe();
    return _scanner!.GetType().InvokeMember(
      methodName,
      BindingFlags.Public | BindingFlags.Instance | BindingFlags.InvokeMethod,
      binder: null,
      target: _scanner,
      args: args);
  }

  private void TryInvokeUnsafe(string methodName, params object?[] args)
  {
    try
    {
      _ = InvokeUnsafe(methodName, args);
    }
    catch
    {
      // Ignore transient method invocation issues in bridge runtime.
    }
  }

  private string TryGetStringUnsafe(string propertyName)
  {
    try
    {
      EnsureScannerObjectUnsafe();
      var value = _scanner!.GetType().InvokeMember(
        propertyName,
        BindingFlags.Public | BindingFlags.Instance | BindingFlags.GetProperty,
        binder: null,
        target: _scanner,
        args: null);
      return Convert.ToString(value, CultureInfo.InvariantCulture) ?? "";
    }
    catch
    {
      return "";
    }
  }

  private int TryGetIntUnsafe(string propertyName, int fallback)
  {
    try
    {
      EnsureScannerObjectUnsafe();
      var value = _scanner!.GetType().InvokeMember(
        propertyName,
        BindingFlags.Public | BindingFlags.Instance | BindingFlags.GetProperty,
        binder: null,
        target: _scanner,
        args: null);
      return Convert.ToInt32(value, CultureInfo.InvariantCulture);
    }
    catch
    {
      return fallback;
    }
  }

  private bool? TryGetBoolUnsafe(string propertyName)
  {
    try
    {
      EnsureScannerObjectUnsafe();
      var value = _scanner!.GetType().InvokeMember(
        propertyName,
        BindingFlags.Public | BindingFlags.Instance | BindingFlags.GetProperty,
        binder: null,
        target: _scanner,
        args: null);
      return Convert.ToBoolean(value, CultureInfo.InvariantCulture);
    }
    catch
    {
      return null;
    }
  }

  private void TrySetPropertyUnsafe(string propertyName, object? value)
  {
    try
    {
      EnsureScannerObjectUnsafe();
      _scanner!.GetType().InvokeMember(
        propertyName,
        BindingFlags.Public | BindingFlags.Instance | BindingFlags.SetProperty,
        binder: null,
        target: _scanner,
        args: new[] { value });
    }
    catch
    {
      // Ignore transient property set failures during runtime rearm.
    }
  }
}
