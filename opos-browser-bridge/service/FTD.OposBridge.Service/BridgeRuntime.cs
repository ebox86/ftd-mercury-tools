using System.Text;
using System.Security.Principal;
using FTD.OposBridge.Service.Scanner;

namespace FTD.OposBridge.Service;

public sealed class BridgeRuntime : BackgroundService
{
  private readonly BridgeOptions _options;
  private readonly IScannerDriver _driver;
  private readonly BridgeInstanceLock _instanceLock;
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
  private string _scannerLeaseToken = "";
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

  private long _agentCommandId;
  private bool _agentDesiredClaimed;
  private string _agentDesiredOwner = "";
  private string _agentDesiredLeaseToken = "";
  private string _agentCommandReason = "startup";
  private long _agentAckCommandId;
  private bool _agentAckClaimed;
  private string _agentAckAgentId = "";
  private string _agentAckMessage = "";
  private DateTimeOffset _agentAckAt = DateTimeOffset.MinValue;
  private DateTimeOffset _agentLastSeenAt = DateTimeOffset.MinValue;

  public BridgeRuntime(
    BridgeOptions options,
    IScannerDriver driver,
    BridgeInstanceLock instanceLock,
    BridgeObservability observability,
    ILogger<BridgeRuntime> logger)
  {
    _options = options;
    _driver = driver;
    _instanceLock = instanceLock;
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
        scannerLeaseToken = _scannerLeaseToken,
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
        scannerLeaseToken = _scannerLeaseToken,
        scannerLeaseRemainingMs = GetLeaseRemainingMsInternal(),
        scannerLeaseExpiresAt = GetLeaseRemainingMsInternal() > 0 ? _scannerLeaseUntil.ToString("o") : "",
        scannerLeaseDefaultMs = _options.DefaultLeaseMs,
        scannerLeaseMaxMs = _options.MaxLeaseMs,
        lastError = _lastError,
        lastSeq = _lastSeq,
        logFile = _observability.LogFilePath,
        eventLogEnabled = _observability.EventLogEnabled,
        eventLogSource = _observability.EventLogSourceResolved,
        instanceLock = _instanceLock.Name,
        replayGuardActive = !string.IsNullOrWhiteSpace(_replayGuardValue) && guardRemaining > 0,
        replayGuardRemainingMs = guardRemaining,
        replayGuardWindowMs = _replayGuardWindowMs,
        duplicateEmitWindowMs = _duplicateEmitWindowMs,
        agentControl = new
        {
          commandId = _agentCommandId,
          desiredClaimed = _agentDesiredClaimed,
          desiredOwner = _agentDesiredOwner,
          ackCommandId = _agentAckCommandId,
          ackClaimed = _agentAckClaimed,
          ackAgentId = _agentAckAgentId,
          ackMessage = _agentAckMessage,
          ackAt = _agentAckAt == DateTimeOffset.MinValue ? "" : _agentAckAt.ToString("o"),
          lastSeenAt = _agentLastSeenAt == DateTimeOffset.MinValue ? "" : _agentLastSeenAt.ToString("o"),
          reason = _agentCommandReason,
        },
        startedAt = _startedAt.ToString("o"),
        now = DateTimeOffset.Now.ToString("o"),
      };
    }
    finally
    {
      _gate.Release();
    }
  }

  public async Task<object> GetStartupDiagnosticsAsync(CancellationToken cancellationToken)
  {
    var scanner = await _driver.GetStartupDiagnosticsAsync(cancellationToken);
    var serviceAccount = ResolveServiceAccount();
    return new
    {
      ok = true,
      processId = _processId,
      startedAt = _startedAt.ToString("o"),
      isUserInteractive = Environment.UserInteractive,
      serviceAccount,
      scanner = new
      {
        scanner.Mode,
        scanner.LogicalName,
        scanner.Initialized,
        scanner.Claimed,
        scanner.OpenResult,
        scanner.ComProgId,
        scanner.EventSinkAttached,
        scanner.LastError,
      },
      lockInfo = new
      {
        name = _instanceLock.Name,
      },
      agentControl = new
      {
        commandId = _agentCommandId,
        desiredClaimed = _agentDesiredClaimed,
        desiredOwner = _agentDesiredOwner,
        reason = _agentCommandReason,
      },
    };
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

  public async Task<BridgeStatusSnapshot> GetStatusSnapshotAsync(CancellationToken cancellationToken)
  {
    await _gate.WaitAsync(cancellationToken);
    try
    {
      return new BridgeStatusSnapshot(
        ScannerStatus: _scannerStatus,
        ScannerClaimed: _scannerClaimed,
        LeaseOwner: _scannerLeaseOwner,
        LeaseRemainingMs: GetLeaseRemainingMsInternal(),
        LastError: _lastError,
        LastSeq: _lastSeq);
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
        // New owner sessions should never replay previously captured scans.
        ownerDeliveredSeq = _lastSeq;
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

        var latencyMs = 0;
        if (DateTimeOffset.TryParse(scan.At, out var scanAt))
        {
          latencyMs = (int)Math.Max(0, (DateTimeOffset.Now - scanAt).TotalMilliseconds);
        }

        _observability.StructuredInfo("scan_delivered", new Dictionary<string, object?>
        {
          ["owner"] = owner,
          ["seq"] = scan.Seq,
          ["source"] = scan.Source,
          ["latencyMs"] = latencyMs,
          ["valueLength"] = deliveredValue.Length,
        }, 2301);

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
      if (!string.IsNullOrWhiteSpace(_scannerLeaseOwner))
      {
        _lastDeliveredSeqByOwner[_scannerLeaseOwner] = _lastSeq;
      }
      else
      {
        _lastDeliveredSeqByOwner.Clear();
      }
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
      var now = DateTimeOffset.UtcNow;
      var hadActiveLease = GetLeaseRemainingMsInternal() > 0;
      var ownerChanged = !string.Equals(owner, _scannerLeaseOwner, StringComparison.OrdinalIgnoreCase);
      var previousLeaseToken = _scannerLeaseToken;

      var claimed = await EnsureClaimInternalAsync($"lease:{owner}", cancellationToken);
      if (claimed)
      {
        var previousOwner = _scannerLeaseOwner;
        if (!hadActiveLease || ownerChanged || string.IsNullOrWhiteSpace(_scannerLeaseToken))
        {
          _scannerLeaseToken = Guid.NewGuid().ToString("N");
        }
        var leaseTokenChanged = !string.Equals(_scannerLeaseToken, previousLeaseToken, StringComparison.Ordinal);

        _scannerLeaseOwner = owner;
        _scannerLeaseUntil = now.AddMilliseconds(leaseMs);
        if (ownerChanged)
        {
          if (!string.IsNullOrWhiteSpace(previousOwner))
          {
            _lastDeliveredSeqByOwner.Remove(previousOwner);
          }

          _lastDeliveredSeqByOwner[owner] = _lastSeq;
          _lastDeliveredSeq = _lastSeq;
        }

        // Keep heartbeats cheap: do not churn command ids on same-owner renewals.
        // Relay command updates are only needed when ownership/claim state changes.
        var shouldUpdateAgentCommand = !hadActiveLease
          || ownerChanged
          || leaseTokenChanged
          || !_agentDesiredClaimed;
        if (shouldUpdateAgentCommand)
        {
          UpdateAgentCommandInternal(true, $"lease:{owner}");
        }

        _observability.StructuredInfo("lease_acquired", new Dictionary<string, object?>
        {
          ["owner"] = owner,
          ["leaseMs"] = leaseMs,
          ["leaseToken"] = AbbreviateToken(_scannerLeaseToken),
          ["commandId"] = _agentCommandId,
          ["scannerStatus"] = _scannerStatus,
        }, 2200);
      }
      else
      {
        ClearLeaseTrackingInternal();
        UpdateAgentCommandInternal(false, $"lease-claim-failed:{owner}");
      }

      return new
      {
        ok = true,
        claimed,
        scannerClaimed = _scannerClaimed,
        scannerStatus = _scannerStatus,
        scannerLeaseOwner = _scannerLeaseOwner,
        scannerLeaseToken = _scannerLeaseToken,
        scannerLeaseRemainingMs = GetLeaseRemainingMsInternal(),
        scannerLeaseExpiresAt = GetLeaseRemainingMsInternal() > 0 ? _scannerLeaseUntil.ToString("o") : "",
        agentCommandId = _agentCommandId,
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

      // Prevent stale scan replay on next modal open after explicit release.
      if (released || force || ownerMatches)
      {
        _lastDeliveredSeq = _lastSeq;
        ClearLastScanPayloadInternal();
      }

      _observability.StructuredInfo("lease_released", new Dictionary<string, object?>
      {
        ["owner"] = owner,
        ["force"] = force,
        ["released"] = released,
        ["ownerAccepted"] = force || ownerMatches,
        ["commandId"] = _agentCommandId,
      }, 2201);

      return new
      {
        ok = true,
        released,
        ownerAccepted = force || ownerMatches,
        scannerClaimed = _scannerClaimed,
        scannerStatus = _scannerStatus,
        scannerLeaseOwner = _scannerLeaseOwner,
        scannerLeaseToken = _scannerLeaseToken,
        scannerLeaseRemainingMs = GetLeaseRemainingMsInternal(),
        agentCommandId = _agentCommandId,
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

  public async Task<object> InjectDebugScanAsync(
    string value,
    string sourceRaw,
    string ownerRaw,
    string leaseTokenRaw,
    long commandId,
    string correlationIdRaw,
    CancellationToken cancellationToken)
  {
    await _gate.WaitAsync(cancellationToken);
    try
    {
      var source = string.IsNullOrWhiteSpace(sourceRaw) ? "debug" : sourceRaw.Trim().ToLowerInvariant();
      var owner = NormalizeLeaseOwner(ownerRaw);
      var leaseToken = (leaseTokenRaw ?? "").Trim();
      var correlationId = NormalizeCorrelationId(correlationIdRaw);
      var leaseRemaining = GetLeaseRemainingMsInternal();
      var hasActiveLease = leaseRemaining > 0 && !string.IsNullOrWhiteSpace(_scannerLeaseOwner) && _scannerClaimed;
      if (!hasActiveLease)
      {
        return new
        {
          ok = false,
          injected = false,
          error = "No active scanner lease; injection ignored.",
          scannerLeaseOwner = _scannerLeaseOwner,
          scannerLeaseRemainingMs = leaseRemaining,
          scannerClaimed = _scannerClaimed,
        };
      }

      if (string.Equals(source, "agent-relay", StringComparison.OrdinalIgnoreCase))
      {
        if (_agentCommandId <= 0 || commandId != _agentCommandId)
        {
          return new
          {
            ok = false,
            injected = false,
            error = "Stale or missing command id.",
            commandId,
            expectedCommandId = _agentCommandId,
          };
        }

        var ackSynchronized = _agentAckCommandId == _agentCommandId && _agentAckClaimed;
        if (!ackSynchronized)
        {
          // Do not reject valid posts during the brief claim->ack propagation
          // window. Owner/token + command checks below still gate correctness.
          _observability.StructuredWarn("agent_scan_inject_ack_out_of_sync", new Dictionary<string, object?>
          {
            ["commandId"] = commandId,
            ["expectedCommandId"] = _agentCommandId,
            ["ackCommandId"] = _agentAckCommandId,
            ["ackClaimed"] = _agentAckClaimed,
            ["owner"] = owner,
            ["activeOwner"] = _scannerLeaseOwner,
          }, 2410);
        }

        if (!string.Equals(owner, _scannerLeaseOwner, StringComparison.OrdinalIgnoreCase))
        {
          return new
          {
            ok = false,
            injected = false,
            error = "Owner mismatch for active lease.",
            owner,
            activeOwner = _scannerLeaseOwner,
          };
        }

        if (string.IsNullOrWhiteSpace(leaseToken) || !string.Equals(leaseToken, _scannerLeaseToken, StringComparison.Ordinal))
        {
          return new
          {
            ok = false,
            injected = false,
            error = "Lease token mismatch.",
          };
        }
      }

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
      _observability.StructuredInfo("scan_injected", new Dictionary<string, object?>
      {
        ["source"] = source,
        ["owner"] = _scannerLeaseOwner,
        ["commandId"] = commandId,
        ["correlationId"] = correlationId,
        ["valueLength"] = normalized.Length,
        ["injected"] = injected,
      }, 2302);

      return new
      {
        ok = true,
        injected,
        value = normalized,
        correlationId,
      };
    }
    finally
    {
      _gate.Release();
    }
  }

  public async Task<object> GetAgentControlAsync(string agentIdRaw, long knownCommandId, bool claimedReported, CancellationToken cancellationToken)
  {
    await _gate.WaitAsync(cancellationToken);
    try
    {
      var agentId = NormalizeAgentId(agentIdRaw);
      _agentLastSeenAt = DateTimeOffset.UtcNow;

      var changed = knownCommandId != _agentCommandId;
      if (changed || claimedReported != _agentDesiredClaimed)
      {
        _observability.StructuredInfo("agent_control_polled", new Dictionary<string, object?>
        {
          ["agentId"] = agentId,
          ["knownCommandId"] = knownCommandId,
          ["commandId"] = _agentCommandId,
          ["desiredClaimed"] = _agentDesiredClaimed,
          ["claimedReported"] = claimedReported,
          ["leaseOwner"] = _agentDesiredOwner,
          ["leaseToken"] = AbbreviateToken(_agentDesiredLeaseToken),
        }, 2400);
      }

      return new
      {
        ok = true,
        agentId,
        commandId = _agentCommandId,
        changed,
        desiredClaimed = _agentDesiredClaimed,
        owner = _agentDesiredOwner,
        leaseToken = _agentDesiredLeaseToken,
        leaseRemainingMs = GetLeaseRemainingMsInternal(),
        leaseExpiresAt = GetLeaseRemainingMsInternal() > 0 ? _scannerLeaseUntil.ToString("o") : "",
        reason = _agentCommandReason,
        ack = new
        {
          commandId = _agentAckCommandId,
          claimed = _agentAckClaimed,
          agentId = _agentAckAgentId,
          at = _agentAckAt == DateTimeOffset.MinValue ? "" : _agentAckAt.ToString("o"),
          message = _agentAckMessage,
        },
      };
    }
    finally
    {
      _gate.Release();
    }
  }

  public async Task<object> AckAgentControlAsync(
    string agentIdRaw,
    long commandId,
    bool claimed,
    string messageRaw,
    string correlationIdRaw,
    CancellationToken cancellationToken)
  {
    await _gate.WaitAsync(cancellationToken);
    try
    {
      var agentId = NormalizeAgentId(agentIdRaw);
      var message = (messageRaw ?? "").Trim();
      if (message.Length > 160)
      {
        message = message[..160];
      }

      var correlationId = NormalizeCorrelationId(correlationIdRaw);
      var accepted = commandId == _agentCommandId;
      if (accepted)
      {
        _agentAckCommandId = commandId;
        _agentAckClaimed = claimed;
        _agentAckAgentId = agentId;
        _agentAckAt = DateTimeOffset.UtcNow;
        _agentAckMessage = message;
      }

      _observability.StructuredInfo("agent_control_acked", new Dictionary<string, object?>
      {
        ["agentId"] = agentId,
        ["commandId"] = commandId,
        ["expectedCommandId"] = _agentCommandId,
        ["accepted"] = accepted,
        ["claimed"] = claimed,
        ["correlationId"] = correlationId,
        ["message"] = message,
      }, accepted ? 2401 : 2402);

      return new
      {
        ok = true,
        accepted,
        commandId = _agentCommandId,
        desiredClaimed = _agentDesiredClaimed,
        owner = _agentDesiredOwner,
        leaseToken = _agentDesiredLeaseToken,
        correlationId,
      };
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
        "Bridge started (version={Version}, mode={Mode}, logicalName={LogicalName}, port={Port}, pid={Pid}).",
        _options.Version,
        _driver.Mode,
        _options.LogicalName,
        _options.Port,
        _processId);
      _observability.Info(
        $"Bridge started (version={_options.Version}, mode={_driver.Mode}, logicalName={_options.LogicalName}, port={_options.Port}, pid={_processId}).",
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
      _logger.LogInformation("Bridge stopped.");
      _observability.Info("Bridge stopped.", 1101);
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

    _observability.StructuredInfo("scan_captured", new Dictionary<string, object?>
    {
      ["seq"] = nextSeq,
      ["source"] = source,
      ["dataCount"] = dataCount,
      ["valueLength"] = value.Length,
    }, 2300);

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
      UpdateAgentCommandInternal(false, $"release-no-claim:{reason}");
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
    UpdateAgentCommandInternal(false, $"release:{reason}");
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
    _scannerLeaseToken = "";
    _scannerLeaseUntil = DateTimeOffset.MinValue;
  }

  private void UpdateAgentCommandInternal(bool desiredClaimed, string reason)
  {
    var desiredOwner = desiredClaimed ? _scannerLeaseOwner : "";
    var desiredToken = desiredClaimed ? _scannerLeaseToken : "";
    var changed = desiredClaimed != _agentDesiredClaimed
      || !string.Equals(desiredOwner, _agentDesiredOwner, StringComparison.OrdinalIgnoreCase)
      || !string.Equals(desiredToken, _agentDesiredLeaseToken, StringComparison.Ordinal);

    _agentCommandReason = string.IsNullOrWhiteSpace(reason) ? "unspecified" : reason.Trim();
    if (!changed)
    {
      return;
    }

    _agentCommandId++;
    _agentDesiredClaimed = desiredClaimed;
    _agentDesiredOwner = desiredOwner;
    _agentDesiredLeaseToken = desiredToken;
    if (!desiredClaimed)
    {
      _agentAckClaimed = false;
    }

    _observability.StructuredInfo("agent_command_updated", new Dictionary<string, object?>
    {
      ["commandId"] = _agentCommandId,
      ["desiredClaimed"] = _agentDesiredClaimed,
      ["owner"] = _agentDesiredOwner,
      ["leaseToken"] = AbbreviateToken(_agentDesiredLeaseToken),
      ["reason"] = _agentCommandReason,
    }, 2403);
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

  private static string NormalizeAgentId(string? input)
  {
    var raw = (input ?? "").Trim();
    if (string.IsNullOrWhiteSpace(raw))
    {
      return "agent";
    }

    var sb = new StringBuilder(raw.Length);
    foreach (var ch in raw)
    {
      if (char.IsLetterOrDigit(ch) || ch is '_' or '-' or '.' or ':' or '@')
      {
        sb.Append(ch);
      }
    }

    var cleaned = sb.ToString().Trim();
    if (string.IsNullOrWhiteSpace(cleaned))
    {
      return "agent";
    }

    return cleaned.Length > 80 ? cleaned[..80] : cleaned;
  }

  private static string NormalizeCorrelationId(string? input)
  {
    var raw = (input ?? "").Trim();
    if (string.IsNullOrWhiteSpace(raw))
    {
      return Guid.NewGuid().ToString("N")[..12];
    }

    var sb = new StringBuilder(raw.Length);
    foreach (var ch in raw)
    {
      if (char.IsLetterOrDigit(ch) || ch is '-' or '_')
      {
        sb.Append(ch);
      }
    }

    var cleaned = sb.ToString().Trim();
    if (string.IsNullOrWhiteSpace(cleaned))
    {
      return Guid.NewGuid().ToString("N")[..12];
    }

    return cleaned.Length > 40 ? cleaned[..40] : cleaned;
  }

  private static string AbbreviateToken(string? token)
  {
    if (string.IsNullOrWhiteSpace(token))
    {
      return "";
    }

    var trimmed = token.Trim();
    return trimmed.Length <= 8 ? trimmed : trimmed[..8];
  }

  private static string ResolveServiceAccount()
  {
    if (!OperatingSystem.IsWindows())
    {
      return Environment.UserName;
    }

    try
    {
      using var identity = WindowsIdentity.GetCurrent();
      if (!string.IsNullOrWhiteSpace(identity.Name))
      {
        return identity.Name;
      }
    }
    catch
    {
      // Fallback to process user name.
    }

    return Environment.UserName;
  }

  public sealed record BridgeStatusSnapshot(
    string ScannerStatus,
    bool ScannerClaimed,
    string LeaseOwner,
    int LeaseRemainingMs,
    string LastError,
    long LastSeq);

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
