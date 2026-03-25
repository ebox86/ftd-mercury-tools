using System.Text;
using FTD.OposBridge.Service.Scanner;

namespace FTD.OposBridge.Service;

public sealed class BridgeRuntime : BackgroundService
{
  private readonly BridgeOptions _options;
  private readonly IScannerDriver _driver;
  private readonly BridgeObservability _observability;
  private readonly ILogger<BridgeRuntime> _logger;
  private readonly SemaphoreSlim _gate = new(1, 1);

  private readonly DateTimeOffset _startedAt = DateTimeOffset.Now;
  private readonly int _processId = Environment.ProcessId;
  private readonly int _duplicateEmitWindowMs;
  private readonly int _replayGuardWindowMs;
  private readonly int _claimBaselineGuardMs;

  private string _scannerStatus = "starting";
  private bool _scannerClaimed;
  private bool? _scannerDeviceEnabled;
  private bool? _scannerAutoDisable;
  private string _scannerLeaseOwner = "";
  private DateTimeOffset _scannerLeaseUntil = DateTimeOffset.MinValue;
  private string _lastError = "";
  private string _lastDriverErrorSeen = "";

  private long _lastSeq;
  private ScanPayload _lastScan = ScanPayload.Empty(0);

  private long _lastDeliveredSeq;
  private Dictionary<string, long> _lastDeliveredSeqByOwner = new(StringComparer.OrdinalIgnoreCase);
  private string _lastDeliveredValue = "";

  private string _replayGuardValue = "";
  private DateTimeOffset _replayGuardUntil = DateTimeOffset.MinValue;

  private string _lastPolledValue = "";
  private int _lastPolledDataCount = -1;
  private DateTimeOffset _lastPolledAt = DateTimeOffset.MinValue;

  private string _lastEmittedValue = "";
  private int _lastEmittedDataCount = -1;
  private DateTimeOffset _lastEmittedAt = DateTimeOffset.MinValue;

  public BridgeRuntime(BridgeOptions options, IScannerDriver driver, BridgeObservability observability, ILogger<BridgeRuntime> logger)
  {
    _options = options;
    _driver = driver;
    _observability = observability;
    _logger = logger;
    _duplicateEmitWindowMs = Math.Max(300, _options.PollingDebounceMs);
    _replayGuardWindowMs = Math.Max(1500, _options.PollingDebounceMs * 3);
    _claimBaselineGuardMs = Math.Max(700, _options.PollingDebounceMs + 150);
  }

  public async Task<object> GetRootAsync(CancellationToken cancellationToken)
  {
    await _gate.WaitAsync(cancellationToken);
    try
    {
      return new
      {
        ok = true,
        name = "opos-scanner-bridge",
        version = _options.Version,
        startedAt = _startedAt.ToString("o"),
        processId = _processId,
        scannerLogicalName = _options.LogicalName,
        scannerStatus = _scannerStatus,
        scannerClaimed = _scannerClaimed,
        scannerLeaseOwner = _scannerLeaseOwner,
        scannerLeaseRemainingMs = GetLeaseRemainingMsInternal(),
        port = _options.Port,
      };
    }
    finally
    {
      _gate.Release();
    }
  }

  public async Task<object> GetHealthAsync(CancellationToken cancellationToken)
  {
    await _gate.WaitAsync(cancellationToken);
    try
    {
      var guardRemaining = 0;
      if (!string.IsNullOrWhiteSpace(_replayGuardValue) && _replayGuardUntil > DateTimeOffset.UtcNow)
      {
        guardRemaining = (int)Math.Max(0, (_replayGuardUntil - DateTimeOffset.UtcNow).TotalMilliseconds);
      }

      return new
      {
        ok = true,
        version = _options.Version,
        processId = _processId,
        scannerLogicalName = _options.LogicalName,
        scannerStatus = _scannerStatus,
        scannerClaimed = _scannerClaimed,
        scannerDeviceEnabled = _scannerDeviceEnabled,
        scannerAutoDisable = _scannerAutoDisable,
        scannerLeaseOwner = _scannerLeaseOwner,
        scannerLeaseRemainingMs = GetLeaseRemainingMsInternal(),
        scannerLeaseExpiresAt = GetLeaseRemainingMsInternal() > 0 ? _scannerLeaseUntil.ToString("o") : "",
        scannerLeaseDefaultMs = _options.DefaultLeaseMs,
        scannerLeaseMaxMs = _options.MaxLeaseMs,
        lastError = _lastError,
        lastSeq = _lastSeq,
        logFile = _observability.LogFilePath,
        eventLogEnabled = _observability.EventLogEnabled,
        eventLogSource = _observability.EventLogSourceResolved,
        instanceLock = "",
        replayGuardActive = !string.IsNullOrWhiteSpace(_replayGuardValue) && guardRemaining > 0,
        replayGuardRemainingMs = guardRemaining,
        replayGuardWindowMs = _replayGuardWindowMs,
        duplicateEmitWindowMs = _duplicateEmitWindowMs,
        startedAt = _startedAt.ToString("o"),
        now = DateTimeOffset.Now.ToString("o"),
      };
    }
    finally
    {
      _gate.Release();
    }
  }

  public async Task<object> GetLatestScanAsync(CancellationToken cancellationToken)
  {
    await _gate.WaitAsync(cancellationToken);
    try
    {
      return new
      {
        ok = true,
        scan = _lastScan,
        scannerStatus = _scannerStatus,
        lastError = _lastError,
      };
    }
    finally
    {
      _gate.Release();
    }
  }

  public async Task<object> GetNextScanAsync(string ownerRaw, CancellationToken cancellationToken)
  {
    await _gate.WaitAsync(cancellationToken);
    try
    {
      var owner = NormalizeLeaseOwner(ownerRaw);

      if (_lastDeliveredSeqByOwner.Count > 256 && !_lastDeliveredSeqByOwner.ContainsKey(owner))
      {
        var preserve = new Dictionary<string, long>(StringComparer.OrdinalIgnoreCase);
        if (!string.IsNullOrWhiteSpace(_scannerLeaseOwner) && _lastDeliveredSeqByOwner.TryGetValue(_scannerLeaseOwner, out var preservedSeq))
        {
          preserve[_scannerLeaseOwner] = preservedSeq;
        }

        _lastDeliveredSeqByOwner = preserve;
      }

      if (!_lastDeliveredSeqByOwner.TryGetValue(owner, out var ownerDeliveredSeq))
      {
        ownerDeliveredSeq = _lastDeliveredSeq;
        _lastDeliveredSeqByOwner[owner] = ownerDeliveredSeq;
      }

      var scan = _lastScan;
      if (scan.Seq > ownerDeliveredSeq && !string.IsNullOrWhiteSpace(scan.Value))
      {
        _lastDeliveredSeqByOwner[owner] = scan.Seq;
        if (scan.Seq > _lastDeliveredSeq)
        {
          _lastDeliveredSeq = scan.Seq;
        }

        var deliveredValue = NormalizeScanValue(scan.Value);
        _lastDeliveredValue = deliveredValue;
        if (!string.IsNullOrWhiteSpace(deliveredValue))
        {
          _replayGuardValue = deliveredValue;
          _replayGuardUntil = DateTimeOffset.UtcNow.AddMilliseconds(_replayGuardWindowMs);
        }

        return new
        {
          ok = true,
          owner,
          scan,
          scannerStatus = _scannerStatus,
          lastError = _lastError,
        };
      }

      return new
      {
        ok = true,
        owner,
        scan = ScanPayload.Empty(ownerDeliveredSeq),
        scannerStatus = _scannerStatus,
        lastError = _lastError,
      };
    }
    finally
    {
      _gate.Release();
    }
  }

  public async Task<object> ClearScanAsync(CancellationToken cancellationToken)
  {
    await _gate.WaitAsync(cancellationToken);
    try
    {
      var previousScanValue = NormalizeScanValue(_lastScan.Value);
      if (string.IsNullOrWhiteSpace(previousScanValue))
      {
        previousScanValue = NormalizeScanValue(_lastDeliveredValue);
      }

      var baseline = await DrainScannerBufferInternalAsync(10, 20, cancellationToken);
      var baselineValue = NormalizeScanValue(string.IsNullOrWhiteSpace(baseline.Label) ? baseline.Raw : baseline.Label);
      var baselineDataCount = baseline.DataCount;

      _lastPolledDataCount = baselineDataCount;
      _lastPolledValue = baselineValue;
      _lastPolledAt = DateTimeOffset.UtcNow;

      _lastEmittedDataCount = baselineDataCount;
      _lastEmittedValue = baselineValue;
      _lastEmittedAt = DateTimeOffset.UtcNow;

      if (!string.IsNullOrWhiteSpace(previousScanValue))
      {
        _replayGuardValue = previousScanValue;
        _replayGuardUntil = DateTimeOffset.UtcNow.AddMilliseconds(_replayGuardWindowMs);
        if (string.IsNullOrWhiteSpace(_lastPolledValue))
        {
          _lastPolledValue = previousScanValue;
        }
      }
      else if (_replayGuardUntil <= DateTimeOffset.UtcNow)
      {
        _replayGuardValue = "";
        _replayGuardUntil = DateTimeOffset.MinValue;
      }

      _lastDeliveredSeq = _lastSeq;
      _lastDeliveredSeqByOwner.Clear();
      ClearLastScanPayloadInternal();

      return new
      {
        ok = true,
        cleared = true,
        lastSeq = _lastSeq,
      };
    }
    finally
    {
      _gate.Release();
    }
  }

  public async Task<object> AcquireOrRenewLeaseAsync(string ownerRaw, int requestedMs, CancellationToken cancellationToken)
  {
    await _gate.WaitAsync(cancellationToken);
    try
    {
      var owner = NormalizeLeaseOwner(ownerRaw);
      var request = requestedMs > 0 ? requestedMs : _options.DefaultLeaseMs;
      var leaseMs = Math.Clamp(request, 500, _options.MaxLeaseMs);

      var claimed = await EnsureClaimInternalAsync($"lease:{owner}", cancellationToken);
      if (claimed)
      {
        _scannerLeaseOwner = owner;
        _scannerLeaseUntil = DateTimeOffset.UtcNow.AddMilliseconds(leaseMs);
      }

      return new
      {
        ok = true,
        claimed,
        scannerClaimed = _scannerClaimed,
        scannerStatus = _scannerStatus,
        scannerLeaseOwner = _scannerLeaseOwner,
        scannerLeaseRemainingMs = GetLeaseRemainingMsInternal(),
        scannerLeaseExpiresAt = GetLeaseRemainingMsInternal() > 0 ? _scannerLeaseUntil.ToString("o") : "",
        lastError = _lastError,
        lastSeq = _lastSeq,
      };
    }
    finally
    {
      _gate.Release();
    }
  }

  public async Task<object> ReleaseLeaseAsync(string ownerRaw, bool force, CancellationToken cancellationToken)
  {
    await _gate.WaitAsync(cancellationToken);
    try
    {
      var owner = NormalizeLeaseOwner(ownerRaw);
      var ownerMatches = string.IsNullOrWhiteSpace(_scannerLeaseOwner) || string.Equals(owner, _scannerLeaseOwner, StringComparison.OrdinalIgnoreCase);
      var released = false;
      if (force || ownerMatches)
      {
        released = await ReleaseClaimInternalAsync($"api-release:{owner}", cancellationToken);
      }

      if (!string.IsNullOrWhiteSpace(owner))
      {
        _lastDeliveredSeqByOwner.Remove(owner);
      }

      return new
      {
        ok = true,
        released,
        ownerAccepted = force || ownerMatches,
        scannerClaimed = _scannerClaimed,
        scannerStatus = _scannerStatus,
        scannerLeaseOwner = _scannerLeaseOwner,
        scannerLeaseRemainingMs = GetLeaseRemainingMsInternal(),
        lastError = _lastError,
        lastSeq = _lastSeq,
      };
    }
    finally
    {
      _gate.Release();
    }
  }

  public async Task<object> RearmScannerAsync(CancellationToken cancellationToken)
  {
    await _gate.WaitAsync(cancellationToken);
    try
    {
      var rearmed = false;
      if (_scannerClaimed)
      {
        rearmed = await _driver.RearmAsync(cancellationToken);
        _scannerDeviceEnabled = _driver.DeviceEnabled;
        _scannerAutoDisable = _driver.AutoDisable;
        if (rearmed)
        {
          _scannerStatus = "ready";
        }
      }

      return new
      {
        ok = true,
        rearmed,
        scannerClaimed = _scannerClaimed,
        scannerStatus = _scannerStatus,
        lastSeq = _lastSeq,
      };
    }
    finally
    {
      _gate.Release();
    }
  }

  public async Task<object> InjectDebugScanAsync(string value, CancellationToken cancellationToken)
  {
    await _gate.WaitAsync(cancellationToken);
    try
    {
      var normalized = NormalizeScanValue(value);
      if (string.IsNullOrWhiteSpace(normalized))
      {
        return new { ok = false, injected = false, error = "value query parameter is required." };
      }

      if (_driver is not IScannerInjector injector)
      {
        return new { ok = false, injected = false, error = "Scanner mode does not support injection." };
      }

      var injected = injector.Inject(normalized);
      return new { ok = true, injected, value = normalized };
    }
    finally
    {
      _gate.Release();
    }
  }

  protected override async Task ExecuteAsync(CancellationToken stoppingToken)
  {
    await _gate.WaitAsync(stoppingToken);
    try
    {
      await _driver.InitializeAsync(stoppingToken);
      _scannerStatus = "open";
      _scannerClaimed = false;
      _scannerDeviceEnabled = _driver.DeviceEnabled;
      _scannerAutoDisable = _driver.AutoDisable;
      _lastError = "";
      _lastDriverErrorSeen = "";
      _logger.LogInformation(
        "Prototype bridge started (version={Version}, mode={Mode}, logicalName={LogicalName}, port={Port}, pid={Pid}).",
        _options.Version,
        _driver.Mode,
        _options.LogicalName,
        _options.Port,
        _processId);
      _observability.Info(
        $"Prototype bridge started (version={_options.Version}, mode={_driver.Mode}, logicalName={_options.LogicalName}, port={_options.Port}, pid={_processId}).",
        1100);
    }
    catch (Exception ex)
    {
      _scannerStatus = "error";
      _lastError = ex.Message;
      _logger.LogError(ex, "Bridge startup failed.");
      _observability.Error($"Bridge startup failed: {ex.Message}", 9100);
    }
    finally
    {
      _gate.Release();
    }

    while (!stoppingToken.IsCancellationRequested)
    {
      try
      {
        await TickAsync(stoppingToken);
      }
      catch (OperationCanceledException)
      {
        break;
      }
      catch (Exception ex)
      {
        await _gate.WaitAsync(stoppingToken);
        try
        {
          _lastError = ex.Message;
        }
        finally
        {
          _gate.Release();
        }

        _logger.LogError(ex, "Bridge tick failed.");
        _observability.Error($"Bridge tick failed: {ex.Message}", 4100);
      }

      try
      {
        await Task.Delay(_options.PollIntervalMs, stoppingToken);
      }
      catch (OperationCanceledException)
      {
        break;
      }
    }
  }

  public override async Task StopAsync(CancellationToken cancellationToken)
  {
    await _gate.WaitAsync(cancellationToken);
    try
    {
      _ = await ReleaseClaimInternalAsync("shutdown", cancellationToken);
      await _driver.ShutdownAsync(cancellationToken);
      _scannerStatus = "stopped";
      _logger.LogInformation("Prototype bridge stopped.");
      _observability.Info("Prototype bridge stopped.", 1101);
    }
    catch (Exception ex)
    {
      _lastError = ex.Message;
      _logger.LogError(ex, "Bridge shutdown failed.");
      _observability.Error($"Bridge shutdown failed: {ex.Message}", 9101);
    }
    finally
    {
      _gate.Release();
    }

    await base.StopAsync(cancellationToken);
  }

  private async Task TickAsync(CancellationToken cancellationToken)
  {
    await _gate.WaitAsync(cancellationToken);
    try
    {
      if (!string.IsNullOrWhiteSpace(_driver.LastError))
      {
        _lastError = _driver.LastError;
        if (!string.Equals(_driver.LastError, _lastDriverErrorSeen, StringComparison.Ordinal))
        {
          _lastDriverErrorSeen = _driver.LastError;
          _observability.Warn(_driver.LastError, 2102);
        }
      }

      await MaintainLeaseInternalAsync(cancellationToken);
      if (!_scannerClaimed || !string.Equals(_scannerStatus, "ready", StringComparison.OrdinalIgnoreCase))
      {
        return;
      }

      await ConsumeEventSnapshotsInternalAsync(cancellationToken);

      var snapshot = await _driver.ReadSnapshotAsync(cancellationToken);
      _scannerDeviceEnabled = snapshot.DeviceEnabled;
      _scannerAutoDisable = snapshot.AutoDisable;

      if (_scannerDeviceEnabled == false)
      {
        _ = await _driver.RearmAsync(cancellationToken);
        snapshot = await _driver.ReadSnapshotAsync(cancellationToken);
        _scannerDeviceEnabled = snapshot.DeviceEnabled;
        _scannerAutoDisable = snapshot.AutoDisable;
      }

      await PollSnapshotInternalAsync(snapshot, cancellationToken);
    }
    finally
    {
      _gate.Release();
    }
  }

  private async Task MaintainLeaseInternalAsync(CancellationToken cancellationToken)
  {
    if (!_scannerClaimed)
    {
      return;
    }

    if (_scannerLeaseUntil == DateTimeOffset.MinValue)
    {
      return;
    }

    if (DateTimeOffset.UtcNow < _scannerLeaseUntil)
    {
      return;
    }

    _ = await ReleaseClaimInternalAsync("lease-expired", cancellationToken);
  }

  private async Task ConsumeEventSnapshotsInternalAsync(CancellationToken cancellationToken)
  {
    while (!cancellationToken.IsCancellationRequested)
    {
      var snapshot = await _driver.ReadEventSnapshotAsync(cancellationToken);
      if (snapshot is null)
      {
        break;
      }

      _scannerDeviceEnabled = snapshot.DeviceEnabled;
      _scannerAutoDisable = snapshot.AutoDisable;
      var value = NormalizeScanValue(string.IsNullOrWhiteSpace(snapshot.Label) ? snapshot.Raw : snapshot.Label);
      if (string.IsNullOrWhiteSpace(value))
      {
        continue;
      }

      var accepted = UpdateScanStateInternal(
        value,
        snapshot.Label,
        snapshot.Raw,
        snapshot.DataType,
        "event",
        snapshot.DataCount);

      _lastPolledValue = value;
      _lastPolledDataCount = snapshot.DataCount;
      _lastPolledAt = DateTimeOffset.UtcNow;

      if (_options.VerboseLogging)
      {
        if (accepted)
        {
          _logger.LogDebug("Event captured scan (dataCount={DataCount}, value={Value}).", snapshot.DataCount, value);
        }
        else
        {
          _logger.LogDebug("Event suppressed stale scan (dataCount={DataCount}, value={Value}).", snapshot.DataCount, value);
        }
      }
    }
  }

  private async Task<ScannerSnapshot> DrainScannerBufferInternalAsync(int maxIterations, int delayMs, CancellationToken cancellationToken)
  {
    var iterations = Math.Max(1, maxIterations);
    var delay = Math.Max(0, delayMs);
    var snapshot = await _driver.ReadSnapshotAsync(cancellationToken);

    for (var i = 0; i < iterations; i++)
    {
      var currentValue = NormalizeScanValue(string.IsNullOrWhiteSpace(snapshot.Label) ? snapshot.Raw : snapshot.Label);
      if (string.IsNullOrWhiteSpace(currentValue))
      {
        break;
      }

      _ = await _driver.ClearInputAsync(cancellationToken);
      if (delay > 0)
      {
        await Task.Delay(delay, cancellationToken);
      }

      var next = await _driver.ReadSnapshotAsync(cancellationToken);
      var nextValue = NormalizeScanValue(string.IsNullOrWhiteSpace(next.Label) ? next.Raw : next.Label);
      var sameValue = string.Equals(nextValue, currentValue, StringComparison.Ordinal);
      var sameCount = next.DataCount == snapshot.DataCount;
      snapshot = next;
      if (sameValue && sameCount)
      {
        break;
      }
    }

    return snapshot;
  }

  private async Task PollSnapshotInternalAsync(ScannerSnapshot snapshot, CancellationToken cancellationToken)
  {
    var value = NormalizeScanValue(string.IsNullOrWhiteSpace(snapshot.Label) ? snapshot.Raw : snapshot.Label);
    if (string.IsNullOrWhiteSpace(value))
    {
      _lastPolledValue = "";
      _lastPolledDataCount = snapshot.DataCount;
      _lastPolledAt = DateTimeOffset.UtcNow;
      return;
    }

    var capture = false;
    if (snapshot.DataCount >= 0)
    {
      if (snapshot.DataCount != _lastPolledDataCount || !string.Equals(value, _lastPolledValue, StringComparison.Ordinal))
      {
        capture = true;
      }
    }
    else
    {
      if (!string.Equals(value, _lastPolledValue, StringComparison.Ordinal))
      {
        capture = true;
      }
    }

    if (!capture)
    {
      return;
    }

    var accepted = UpdateScanStateInternal(
      value,
      snapshot.Label,
      snapshot.Raw,
      snapshot.DataType,
      "poll",
      snapshot.DataCount);

    _lastPolledValue = value;
    _lastPolledDataCount = snapshot.DataCount;
    _lastPolledAt = DateTimeOffset.UtcNow;

    _ = await _driver.ClearInputAsync(cancellationToken);
    if (_scannerClaimed)
    {
      _ = await _driver.RearmAsync(cancellationToken);
      _scannerDeviceEnabled = _driver.DeviceEnabled;
      _scannerAutoDisable = _driver.AutoDisable;
    }

    if (_options.VerboseLogging)
    {
      if (accepted)
      {
        _logger.LogDebug("Polling captured scan (dataCount={DataCount}, value={Value}).", snapshot.DataCount, value);
      }
      else
      {
        _logger.LogDebug("Polling suppressed stale scan (dataCount={DataCount}, value={Value}).", snapshot.DataCount, value);
      }
    }
  }

  private bool UpdateScanStateInternal(string value, string label, string raw, int dataType, string source, int dataCount)
  {
    if (string.IsNullOrWhiteSpace(value))
    {
      return false;
    }

    var now = DateTimeOffset.UtcNow;
    var sinceLastMs = _lastEmittedAt == DateTimeOffset.MinValue
      ? double.PositiveInfinity
      : (now - _lastEmittedAt).TotalMilliseconds;

    if (!string.IsNullOrWhiteSpace(_replayGuardValue))
    {
      if (string.Equals(value, _replayGuardValue, StringComparison.Ordinal) && now < _replayGuardUntil)
      {
        return false;
      }
    }

    if (string.Equals(value, _lastEmittedValue, StringComparison.Ordinal))
    {
      var withinDuplicateWindow = sinceLastMs < _duplicateEmitWindowMs;
      if (dataCount >= 0 && _lastEmittedDataCount >= 0)
      {
        if (dataCount == _lastEmittedDataCount && withinDuplicateWindow)
        {
          return false;
        }
      }
      else if (withinDuplicateWindow)
      {
        return false;
      }
    }

    var nextSeq = _lastSeq + 1;
    _lastSeq = nextSeq;
    _lastScan = new ScanPayload(
      nextSeq,
      value,
      label,
      raw,
      dataType,
      source,
      DateTimeOffset.Now.ToString("o"));

    _lastEmittedValue = value;
    _lastEmittedDataCount = dataCount;
    _lastEmittedAt = now;

    if (!string.Equals(value, _replayGuardValue, StringComparison.Ordinal))
    {
      _replayGuardValue = "";
      _replayGuardUntil = DateTimeOffset.MinValue;
    }

    return true;
  }

  private async Task<bool> EnsureClaimInternalAsync(string reason, CancellationToken cancellationToken)
  {
    if (_scannerClaimed)
    {
      _ = await _driver.RearmAsync(cancellationToken);
      _scannerDeviceEnabled = _driver.DeviceEnabled;
      _scannerAutoDisable = _driver.AutoDisable;
      _scannerStatus = "ready";
      _lastError = "";
      return true;
    }

    var claimed = await _driver.EnsureClaimedAsync(_options.ClaimTimeoutMs, reason, cancellationToken);
    if (!claimed)
    {
      _scannerClaimed = false;
      _scannerStatus = "open";
      _scannerDeviceEnabled = _driver.DeviceEnabled;
      _scannerAutoDisable = _driver.AutoDisable;
      _lastError = $"Scanner claim failed ({reason}).";
      _observability.Warn(_lastError, 2103);
      return false;
    }

    _scannerClaimed = true;
    _scannerStatus = "ready";
    _scannerDeviceEnabled = _driver.DeviceEnabled;
    _scannerAutoDisable = _driver.AutoDisable;
    _lastError = "";
    _ = await _driver.RearmAsync(cancellationToken);
    await InitializeClaimBaselineInternalAsync(cancellationToken);
    _logger.LogInformation("Scanner claim acquired (reason={Reason}).", reason);
    _observability.Info($"Scanner claim acquired (reason={reason}).", 2100);
    return true;
  }

  private async Task InitializeClaimBaselineInternalAsync(CancellationToken cancellationToken)
  {
    var baseline = await _driver.ReadSnapshotAsync(cancellationToken);
    var baselineValue = NormalizeScanValue(string.IsNullOrWhiteSpace(baseline.Label) ? baseline.Raw : baseline.Label);
    var baselineDataCount = baseline.DataCount;

    var now = DateTimeOffset.UtcNow;
    _lastPolledValue = baselineValue;
    _lastPolledDataCount = baselineDataCount;
    _lastPolledAt = now;

    if (!string.IsNullOrWhiteSpace(baselineValue))
    {
      var guardMs = Math.Max(250, _claimBaselineGuardMs);
      _replayGuardValue = baselineValue;
      _replayGuardUntil = now.AddMilliseconds(guardMs);
      if (_options.VerboseLogging)
      {
        _logger.LogDebug(
          "Claim baseline armed (value={Value}, dataCount={DataCount}, guardMs={GuardMs}).",
          baselineValue,
          baselineDataCount,
          guardMs);
      }
    }
  }

  private async Task<bool> ReleaseClaimInternalAsync(string reason, CancellationToken cancellationToken)
  {
    if (!_scannerClaimed)
    {
      _scannerClaimed = false;
      _scannerStatus = "open";
      ClearLeaseTrackingInternal();
      return false;
    }

    var released = await _driver.ReleaseClaimAsync(reason, cancellationToken);
    _scannerClaimed = false;
    _scannerStatus = "open";
    _scannerDeviceEnabled = _driver.DeviceEnabled;
    _scannerAutoDisable = _driver.AutoDisable;

    _lastPolledDataCount = -1;
    _lastPolledValue = "";
    _lastPolledAt = DateTimeOffset.MinValue;

    _lastEmittedValue = "";
    _lastEmittedDataCount = -1;
    _lastEmittedAt = DateTimeOffset.MinValue;

    _lastDeliveredValue = "";
    _replayGuardValue = "";
    _replayGuardUntil = DateTimeOffset.MinValue;
    _lastDeliveredSeqByOwner.Clear();
    ClearLeaseTrackingInternal();
    ClearLastScanPayloadInternal();

    _logger.LogInformation("Scanner claim released (reason={Reason}, released={Released}).", reason, released);
    _observability.Info($"Scanner claim released (reason={reason}, released={released}).", 2104);
    return released;
  }

  private int GetLeaseRemainingMsInternal()
  {
    if (_scannerLeaseUntil <= DateTimeOffset.UtcNow)
    {
      return 0;
    }

    return (int)Math.Max(0, (_scannerLeaseUntil - DateTimeOffset.UtcNow).TotalMilliseconds);
  }

  private void ClearLeaseTrackingInternal()
  {
    _scannerLeaseOwner = "";
    _scannerLeaseUntil = DateTimeOffset.MinValue;
  }

  private void ClearLastScanPayloadInternal()
  {
    _lastScan = ScanPayload.Empty(_lastSeq);
  }

  private static string NormalizeLeaseOwner(string? owner)
  {
    var raw = owner ?? "";
    if (string.IsNullOrWhiteSpace(raw))
    {
      return "anonymous";
    }

    var sb = new StringBuilder(raw.Length);
    foreach (var ch in raw)
    {
      if (char.IsLetterOrDigit(ch) || ch is '_' or '-' or '.' or ':')
      {
        sb.Append(ch);
      }
    }

    var cleaned = sb.ToString().Trim();
    if (string.IsNullOrWhiteSpace(cleaned))
    {
      return "anonymous";
    }

    if (cleaned.Length > 80)
    {
      return cleaned[..80];
    }

    return cleaned;
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

  public sealed record ScanPayload(
    long Seq,
    string Value,
    string Label,
    string Raw,
    int DataType,
    string Source,
    string At)
  {
    public static ScanPayload Empty(long seq) => new(seq, "", "", "", 0, "", "");
  }
}
