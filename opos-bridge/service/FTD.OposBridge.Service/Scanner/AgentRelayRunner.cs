using System.Net;
using System.Text.Json;
using FTD.OposBridge.Service;

namespace FTD.OposBridge.Service.Scanner;

public static class AgentRelayRunner
{
  private const int ControlFailureReleaseThreshold = 3;
  private const int DuplicateSuppressionWindowMs = 1200;
  private const int ClaimWarmupDrainIterations = 10;
  private const int ClaimWarmupGuardMs = 1200;
  private const int ClaimBaselineSuppressMs = 600;
  // Do not blanket-suppress scans after claim. Real operators often scan
  // immediately after modal open, and even a short global suppression window
  // can drop that first scan.
  private const int ClaimWarmupSuppressAllMs = 0;

  public static async Task<int> RunAsync(BridgeOptions options)
  {
    using var loggerFactory = LoggerFactory.Create(builder =>
    {
      builder.ClearProviders();
      builder.AddSimpleConsole(console =>
      {
        console.TimestampFormat = "yyyy-MM-dd HH:mm:ss.fff ";
        console.SingleLine = true;
      });
      builder.SetMinimumLevel(options.MinimumLogLevel);
    });

    var logger = loggerFactory.CreateLogger("AgentRelay");
    var observability = new BridgeObservability(options);
    using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(2) };
    var cts = new CancellationTokenSource();
    Console.CancelKeyPress += (_, e) =>
    {
      e.Cancel = true;
      cts.Cancel();
    };

    var driver = new OposComScannerDriver(options, loggerFactory.CreateLogger("OposAgentDriver"));
    var agentId = BuildAgentId();
    var postState = new RelayPostState("", DateTimeOffset.MinValue);

    var claimed = false;
    var activeOwner = "";
    var activeLeaseToken = "";
    var appliedCommandId = -1L;
    var knownCommandId = -1L;
    var controlFailureCount = 0;

    var lastPolledValue = "";
    var lastPolledDataCount = -1;
    var lastAcceptedValue = "";
    var lastAcceptedDataCount = -1;
    var lastAcceptedAt = DateTimeOffset.MinValue;
    var claimWarmupValue = "";
    var claimWarmupUntil = DateTimeOffset.MinValue;
    var claimReadyAt = DateTimeOffset.MinValue;
    var claimBaselineValue = "";
    var claimBaselineDataCount = -1;
    var claimBaselineUntil = DateTimeOffset.MinValue;

    observability.StructuredInfo("agent_relay_started", new Dictionary<string, object?>
    {
      ["agentId"] = agentId,
      ["bridgeBaseUrl"] = options.BridgeBaseUrl,
      ["logicalName"] = options.LogicalName,
      ["mode"] = options.ScannerMode,
    }, 2500);

    try
    {
      logger.LogInformation("Starting OPOS agent relay (agentId={AgentId}, logicalName={LogicalName}, bridgeBaseUrl={BridgeBaseUrl})...", agentId, options.LogicalName, options.BridgeBaseUrl);
      await driver.InitializeAsync(cts.Token);

      while (!cts.Token.IsCancellationRequested)
      {
        var control = await FetchControlAsync(http, options.BridgeBaseUrl, agentId, knownCommandId, claimed, cts.Token);
        if (control is null)
        {
          controlFailureCount++;
          if (claimed && controlFailureCount >= ControlFailureReleaseThreshold)
          {
            _ = await driver.ReleaseClaimAsync("agent-control-timeout", cts.Token);
            claimed = false;
            activeOwner = "";
            activeLeaseToken = "";
            observability.StructuredWarn("agent_control_timeout_release", new Dictionary<string, object?>
            {
              ["agentId"] = agentId,
              ["failures"] = controlFailureCount,
            }, 2501);
          }

          await Task.Delay(options.AgentPollIntervalMs, cts.Token);
          continue;
        }

        controlFailureCount = 0;
        knownCommandId = control.CommandId;
        var commandChanged = control.CommandId != appliedCommandId;
        var ownershipChanged = !string.Equals(activeOwner, control.Owner, StringComparison.OrdinalIgnoreCase)
          || !string.Equals(activeLeaseToken, control.LeaseToken, StringComparison.Ordinal);
        var requiresApply = commandChanged || claimed != control.DesiredClaimed || (claimed && ownershipChanged);
        if (requiresApply)
        {
          var sessionChanged = commandChanged || ownershipChanged;
          if (sessionChanged)
          {
            // New modal ownership session: reset duplicate guards so the first
            // real scan is never suppressed as an old duplicate.
            lastAcceptedValue = "";
            lastAcceptedDataCount = -1;
            lastAcceptedAt = DateTimeOffset.MinValue;
            postState.LastPostedValue = "";
            postState.LastPostedAt = DateTimeOffset.MinValue;
            claimWarmupValue = "";
            claimWarmupUntil = DateTimeOffset.MinValue;
            claimReadyAt = DateTimeOffset.MinValue;
            claimBaselineValue = "";
            claimBaselineDataCount = -1;
            claimBaselineUntil = DateTimeOffset.MinValue;
          }

          var corr = NewCorrelationId();
          var ackMessage = "";
          var ackSent = false;
          if (control.DesiredClaimed)
          {
            var claimOk = await driver.EnsureClaimedAsync(options.ClaimTimeoutMs, $"agent-relay:{control.CommandId}", cts.Token);
            claimed = claimOk;
            appliedCommandId = control.CommandId;
            if (claimOk)
            {
              activeOwner = control.Owner;
              activeLeaseToken = control.LeaseToken;
              logger.LogInformation("Agent claimed scanner (commandId={CommandId}, owner={Owner}).", control.CommandId, activeOwner);
              observability.StructuredInfo("agent_command_applied", new Dictionary<string, object?>
              {
                ["agentId"] = agentId,
                ["commandId"] = control.CommandId,
                ["desiredClaimed"] = true,
                ["owner"] = activeOwner,
                ["leaseToken"] = AbbreviateToken(activeLeaseToken),
                ["reason"] = control.Reason,
              }, 2502);

              // Ack claim before attempting any scan posts so the service
              // will accept the first scan after modal open.
              await AckControlAsync(http, options.BridgeBaseUrl, agentId, appliedCommandId, true, "claimed", corr, cts.Token);
              ackSent = true;

              var baseline = await driver.ReadSnapshotAsync(cts.Token);
              lastPolledValue = NormalizeValue(string.IsNullOrWhiteSpace(baseline.Label) ? baseline.Raw : baseline.Label);
              lastPolledDataCount = baseline.DataCount;
              claimBaselineValue = lastPolledValue;
              claimBaselineDataCount = baseline.DataCount;
              claimBaselineUntil = string.IsNullOrWhiteSpace(claimBaselineValue)
                ? DateTimeOffset.MinValue
                : DateTimeOffset.UtcNow.AddMilliseconds(ClaimBaselineSuppressMs);

              // Flush any pre-claim residual input so the next scan reflects
              // only post-claim user activity for this modal session.
              if (!string.IsNullOrWhiteSpace(lastPolledValue))
              {
                _ = await driver.ClearInputAsync(cts.Token);
                _ = await driver.RearmAsync(cts.Token);
              }

              // Drain pending OPOS DataEvents from the previous ownership
              // session; otherwise the first "scan" after claim can be stale.
              var drainedValue = await DrainPendingEventValueAsync(driver, cts.Token);
              // Only guard against values actually drained from pending events.
              // Do not use claim baseline value as a suppression guard: users
              // commonly re-scan the same ticket across modal opens.
              var guardValue = drainedValue;
              if (!string.IsNullOrWhiteSpace(guardValue))
              {
                claimWarmupValue = guardValue;
                claimWarmupUntil = DateTimeOffset.UtcNow.AddMilliseconds(ClaimWarmupGuardMs);
              }

              // Hard warmup: suppress all candidate posts briefly after claim
              // to absorb OPOS residuals emitted right at ownership switch.
              claimReadyAt = DateTimeOffset.UtcNow.AddMilliseconds(ClaimWarmupSuppressAllMs);
            }
            else
            {
              activeOwner = "";
              activeLeaseToken = "";
              ackMessage = "claim-failed";
              observability.StructuredWarn("agent_command_claim_failed", new Dictionary<string, object?>
              {
                ["agentId"] = agentId,
                ["commandId"] = control.CommandId,
                ["owner"] = control.Owner,
              }, 2503);
            }
          }
          else
          {
            if (claimed)
            {
              _ = await driver.ReleaseClaimAsync($"agent-command-release:{control.CommandId}", cts.Token);
            }

            claimed = false;
            appliedCommandId = control.CommandId;
            activeOwner = "";
            activeLeaseToken = "";
            lastPolledValue = "";
            lastPolledDataCount = -1;
            lastAcceptedValue = "";
            lastAcceptedDataCount = -1;
            lastAcceptedAt = DateTimeOffset.MinValue;
            postState.LastPostedValue = "";
            postState.LastPostedAt = DateTimeOffset.MinValue;
            claimWarmupValue = "";
            claimWarmupUntil = DateTimeOffset.MinValue;
            claimReadyAt = DateTimeOffset.MinValue;
            claimBaselineValue = "";
            claimBaselineDataCount = -1;
            claimBaselineUntil = DateTimeOffset.MinValue;
            ackMessage = "released";
            logger.LogInformation("Agent released scanner (commandId={CommandId}).", control.CommandId);
            observability.StructuredInfo("agent_command_applied", new Dictionary<string, object?>
            {
              ["agentId"] = agentId,
              ["commandId"] = control.CommandId,
              ["desiredClaimed"] = false,
                ["reason"] = control.Reason,
              }, 2504);
          }

          if (!ackSent)
          {
            await AckControlAsync(http, options.BridgeBaseUrl, agentId, appliedCommandId, claimed, ackMessage, corr, cts.Token);
          }
        }

        var ackSynchronized = control.AckCommandId == appliedCommandId && control.AckClaimed;
        if (claimed && control.DesiredClaimed && appliedCommandId == control.CommandId)
        {
          var ackOutOfSync = !ackSynchronized;
          if (ackOutOfSync)
          {
            await AckControlAsync(http, options.BridgeBaseUrl, agentId, appliedCommandId, true, "ack-resync", NewCorrelationId(), cts.Token);
          }
        }

        if (claimed && control.DesiredClaimed && appliedCommandId == control.CommandId)
        {
          while (true)
          {
            var evt = await driver.ReadEventSnapshotAsync(cts.Token);
            if (evt is null)
            {
              break;
            }

            var eventValue = NormalizeValue(string.IsNullOrWhiteSpace(evt.Label) ? evt.Raw : evt.Label);
            if (DateTimeOffset.UtcNow < claimReadyAt)
            {
              if (!string.IsNullOrWhiteSpace(eventValue))
              {
                _ = await driver.ClearInputAsync(cts.Token);
                _ = await driver.RearmAsync(cts.Token);
              }

              continue;
            }

            if (IsClaimWarmupSuppressed(eventValue, claimWarmupValue, claimWarmupUntil))
            {
              if (!string.IsNullOrWhiteSpace(eventValue))
              {
                _ = await driver.ClearInputAsync(cts.Token);
                _ = await driver.RearmAsync(cts.Token);
              }
              continue;
            }
            if (IsClaimBaselineReplay(eventValue, evt.DataCount, claimBaselineValue, claimBaselineDataCount, claimBaselineUntil))
            {
              if (!string.IsNullOrWhiteSpace(eventValue))
              {
                _ = await driver.ClearInputAsync(cts.Token);
                _ = await driver.RearmAsync(cts.Token);
              }
              continue;
            }
            if (!IsNewCandidate(eventValue, evt.DataCount, lastAcceptedValue, lastAcceptedDataCount, lastAcceptedAt))
            {
              if (!string.IsNullOrWhiteSpace(eventValue))
              {
                _ = await driver.ClearInputAsync(cts.Token);
                _ = await driver.RearmAsync(cts.Token);
              }
              continue;
            }

            var posted = await TryPostScanAsync(http, options.BridgeBaseUrl, eventValue, activeOwner, activeLeaseToken, appliedCommandId, postState, observability, cts.Token);
            if (posted)
            {
              lastAcceptedValue = eventValue;
              lastAcceptedDataCount = evt.DataCount;
              lastAcceptedAt = DateTimeOffset.UtcNow;
              _ = await driver.ClearInputAsync(cts.Token);
              _ = await driver.RearmAsync(cts.Token);
            }
            else if (!string.IsNullOrWhiteSpace(eventValue))
            {
              // Keep scanner event flow armed even when a candidate post fails.
              _ = await driver.ClearInputAsync(cts.Token);
              _ = await driver.RearmAsync(cts.Token);
            }
          }

          var snap = await driver.ReadSnapshotAsync(cts.Token);
          var polledValue = NormalizeValue(string.IsNullOrWhiteSpace(snap.Label) ? snap.Raw : snap.Label);
          if (DateTimeOffset.UtcNow < claimReadyAt)
          {
            if (!string.IsNullOrWhiteSpace(polledValue))
            {
              _ = await driver.ClearInputAsync(cts.Token);
              _ = await driver.RearmAsync(cts.Token);
            }

            lastPolledValue = "";
            lastPolledDataCount = -1;
            await Task.Delay(options.AgentPollIntervalMs, cts.Token);
            continue;
          }

          if (IsClaimWarmupSuppressed(polledValue, claimWarmupValue, claimWarmupUntil))
          {
            if (!string.IsNullOrWhiteSpace(polledValue))
            {
              _ = await driver.ClearInputAsync(cts.Token);
              _ = await driver.RearmAsync(cts.Token);
            }
            lastPolledValue = polledValue;
            lastPolledDataCount = snap.DataCount;
            await Task.Delay(options.AgentPollIntervalMs, cts.Token);
            continue;
          }
          if (IsClaimBaselineReplay(polledValue, snap.DataCount, claimBaselineValue, claimBaselineDataCount, claimBaselineUntil))
          {
            if (!string.IsNullOrWhiteSpace(polledValue))
            {
              _ = await driver.ClearInputAsync(cts.Token);
              _ = await driver.RearmAsync(cts.Token);
            }
            lastPolledValue = polledValue;
            lastPolledDataCount = snap.DataCount;
            await Task.Delay(options.AgentPollIntervalMs, cts.Token);
            continue;
          }
          var changed = false;
          if (!string.IsNullOrWhiteSpace(polledValue))
          {
            if (snap.DataCount >= 0)
            {
              changed = snap.DataCount != lastPolledDataCount || !string.Equals(polledValue, lastPolledValue, StringComparison.Ordinal);
            }
            else
            {
              changed = !string.Equals(polledValue, lastPolledValue, StringComparison.Ordinal);
            }
          }

          if (changed && IsNewCandidate(polledValue, snap.DataCount, lastAcceptedValue, lastAcceptedDataCount, lastAcceptedAt))
          {
            var posted = await TryPostScanAsync(http, options.BridgeBaseUrl, polledValue, activeOwner, activeLeaseToken, appliedCommandId, postState, observability, cts.Token);
            if (posted)
            {
              lastAcceptedValue = polledValue;
              lastAcceptedDataCount = snap.DataCount;
              lastAcceptedAt = DateTimeOffset.UtcNow;
              _ = await driver.ClearInputAsync(cts.Token);
              _ = await driver.RearmAsync(cts.Token);
            }
            else if (!string.IsNullOrWhiteSpace(polledValue))
            {
              // Mirror script behavior: after handling a candidate snapshot,
              // clear/rearm so AutoDisable stacks are ready for the next scan.
              _ = await driver.ClearInputAsync(cts.Token);
              _ = await driver.RearmAsync(cts.Token);
            }
          }
          else if (changed && !string.IsNullOrWhiteSpace(polledValue))
          {
            _ = await driver.ClearInputAsync(cts.Token);
            _ = await driver.RearmAsync(cts.Token);
          }

          lastPolledValue = polledValue;
          lastPolledDataCount = snap.DataCount;
        }

        await Task.Delay(options.AgentPollIntervalMs, cts.Token);
      }

      return 0;
    }
    catch (OperationCanceledException)
    {
      return 0;
    }
    catch (Exception ex)
    {
      logger.LogError(ex, "Agent relay failed.");
      observability.StructuredError("agent_relay_failed", new Dictionary<string, object?>
      {
        ["agentId"] = agentId,
        ["error"] = ex.Message,
      }, 9500);
      return 1;
    }
    finally
    {
      try
      {
        if (claimed)
        {
          _ = await driver.ReleaseClaimAsync("agent-shutdown", CancellationToken.None);
        }
      }
      catch
      {
        // Ignore shutdown release errors.
      }

      try
      {
        await driver.ShutdownAsync(CancellationToken.None);
      }
      catch
      {
        // Ignore shutdown errors.
      }

      observability.StructuredInfo("agent_relay_stopped", new Dictionary<string, object?>
      {
        ["agentId"] = agentId,
      }, 2505);
    }
  }

  private static async Task<AgentControl?> FetchControlAsync(
    HttpClient http,
    string baseUrl,
    string agentId,
    long knownCommandId,
    bool claimed,
    CancellationToken cancellationToken)
  {
    try
    {
      var url = $"{baseUrl.TrimEnd('/')}/agent/control?agentId={Uri.EscapeDataString(agentId)}&knownCommandId={knownCommandId}&claimed={(claimed ? 1 : 0)}";
      using var response = await http.GetAsync(url, cancellationToken);
      if (!response.IsSuccessStatusCode)
      {
        return null;
      }

      var payload = await response.Content.ReadAsStringAsync(cancellationToken);
      using var doc = JsonDocument.Parse(payload);
      var root = doc.RootElement;
      if (!root.TryGetProperty("ok", out var okProp) || !okProp.GetBoolean())
      {
        return null;
      }

      var commandId = root.TryGetProperty("commandId", out var commandIdProp) && commandIdProp.TryGetInt64(out var parsedCommandId) ? parsedCommandId : -1L;
      var desiredClaimed = root.TryGetProperty("desiredClaimed", out var desiredProp) && desiredProp.GetBoolean();
      var owner = root.TryGetProperty("owner", out var ownerProp) ? (ownerProp.GetString() ?? "") : "";
      var leaseToken = root.TryGetProperty("leaseToken", out var tokenProp) ? (tokenProp.GetString() ?? "") : "";
      var reason = root.TryGetProperty("reason", out var reasonProp) ? (reasonProp.GetString() ?? "") : "";
      var leaseRemainingMs = root.TryGetProperty("leaseRemainingMs", out var remainingProp) && remainingProp.TryGetInt32(out var parsedRemaining)
        ? parsedRemaining
        : 0;
      var ackCommandId = -1L;
      var ackClaimed = false;
      if (root.TryGetProperty("ack", out var ackProp))
      {
        if (ackProp.TryGetProperty("commandId", out var ackCmdProp) && ackCmdProp.TryGetInt64(out var parsedAckCmd))
        {
          ackCommandId = parsedAckCmd;
        }

        if (ackProp.TryGetProperty("claimed", out var ackClaimedProp) && ackClaimedProp.ValueKind is JsonValueKind.True or JsonValueKind.False)
        {
          ackClaimed = ackClaimedProp.GetBoolean();
        }
      }

      return new AgentControl(commandId, desiredClaimed, owner, leaseToken, reason, leaseRemainingMs, ackCommandId, ackClaimed);
    }
    catch
    {
      return null;
    }
  }

  private static async Task AckControlAsync(
    HttpClient http,
    string baseUrl,
    string agentId,
    long commandId,
    bool claimed,
    string message,
    string correlationId,
    CancellationToken cancellationToken)
  {
    try
    {
      var safeMessage = string.IsNullOrWhiteSpace(message) ? "ok" : message.Trim();
      var url = $"{baseUrl.TrimEnd('/')}/agent/ack?agentId={Uri.EscapeDataString(agentId)}&commandId={commandId}&claimed={(claimed ? 1 : 0)}&message={Uri.EscapeDataString(safeMessage)}&correlationId={Uri.EscapeDataString(correlationId)}";
      using var _ = await http.GetAsync(url, cancellationToken);
    }
    catch
    {
      // Ack failures are transient; next poll retries.
    }
  }

  private static async Task<bool> TryPostScanAsync(
    HttpClient http,
    string baseUrl,
    string value,
    string owner,
    string leaseToken,
    long commandId,
    RelayPostState postState,
    BridgeObservability observability,
    CancellationToken cancellationToken)
  {
    if (string.IsNullOrWhiteSpace(value) || string.IsNullOrWhiteSpace(owner) || string.IsNullOrWhiteSpace(leaseToken) || commandId <= 0)
    {
      return false;
    }

    var now = DateTimeOffset.UtcNow;
    if (string.Equals(value, postState.LastPostedValue, StringComparison.Ordinal) && (now - postState.LastPostedAt).TotalMilliseconds < 700)
    {
      return false;
    }

    var correlationId = NewCorrelationId();
    var injectUrl = $"{baseUrl.TrimEnd('/')}/debug/inject?value={Uri.EscapeDataString(value)}&source=agent-relay&owner={Uri.EscapeDataString(owner)}&leaseToken={Uri.EscapeDataString(leaseToken)}&commandId={commandId}&correlationId={Uri.EscapeDataString(correlationId)}";
    try
    {
      using var response = await http.GetAsync(injectUrl, cancellationToken);
      var payload = await response.Content.ReadAsStringAsync(cancellationToken);
      var injected = false;
      var ok = false;
      var error = "";
      if (response.StatusCode == HttpStatusCode.OK)
      {
        using var doc = JsonDocument.Parse(payload);
        var root = doc.RootElement;
        ok = root.TryGetProperty("ok", out var okProp) && okProp.GetBoolean();
        injected = root.TryGetProperty("injected", out var injectedProp) && injectedProp.GetBoolean();
        if (root.TryGetProperty("error", out var errorProp))
        {
          if (errorProp.ValueKind == JsonValueKind.String)
          {
            error = errorProp.GetString() ?? "";
          }
          else
          {
            error = errorProp.ToString();
          }
        }
      }
      else
      {
        error = $"HTTP {(int)response.StatusCode}";
      }

      observability.StructuredInfo("agent_scan_post", new Dictionary<string, object?>
      {
        ["correlationId"] = correlationId,
        ["commandId"] = commandId,
        ["owner"] = owner,
        ["leaseToken"] = AbbreviateToken(leaseToken),
        ["valueLength"] = value.Length,
        ["statusCode"] = (int)response.StatusCode,
        ["ok"] = ok,
        ["injected"] = injected,
        ["error"] = error,
      }, 2506);

      if (ok && injected)
      {
        postState.LastPostedValue = value;
        postState.LastPostedAt = now;
        return true;
      }

      return false;
    }
    catch (Exception ex)
    {
      observability.StructuredWarn("agent_scan_post_failed", new Dictionary<string, object?>
      {
        ["correlationId"] = correlationId,
        ["commandId"] = commandId,
        ["owner"] = owner,
        ["leaseToken"] = AbbreviateToken(leaseToken),
        ["valueLength"] = value.Length,
        ["error"] = ex.Message,
      }, 2507);
      return false;
    }
  }

  private static bool IsClaimWarmupSuppressed(
    string value,
    string guardValue,
    DateTimeOffset guardUntil)
  {
    if (string.IsNullOrWhiteSpace(value) || string.IsNullOrWhiteSpace(guardValue))
    {
      return false;
    }

    if (DateTimeOffset.UtcNow >= guardUntil)
    {
      return false;
    }

    return string.Equals(value, guardValue, StringComparison.Ordinal);
  }

  private static bool IsClaimBaselineReplay(
    string value,
    int dataCount,
    string baselineValue,
    int baselineDataCount,
    DateTimeOffset suppressUntil)
  {
    if (string.IsNullOrWhiteSpace(value) || string.IsNullOrWhiteSpace(baselineValue))
    {
      return false;
    }

    if (DateTimeOffset.UtcNow >= suppressUntil)
    {
      return false;
    }

    if (!string.Equals(value, baselineValue, StringComparison.Ordinal))
    {
      return false;
    }

    if (baselineDataCount >= 0 && dataCount >= 0 && dataCount != baselineDataCount)
    {
      return false;
    }

    return true;
  }

  private static async Task<string> DrainPendingEventValueAsync(
    IScannerDriver driver,
    CancellationToken cancellationToken)
  {
    var lastValue = "";
    for (var i = 0; i < ClaimWarmupDrainIterations; i++)
    {
      var evt = await driver.ReadEventSnapshotAsync(cancellationToken);
      if (evt is null)
      {
        break;
      }

      var value = NormalizeValue(string.IsNullOrWhiteSpace(evt.Label) ? evt.Raw : evt.Label);
      if (!string.IsNullOrWhiteSpace(value))
      {
        lastValue = value;
      }
    }

    return lastValue;
  }

  private static bool IsNewCandidate(
    string value,
    int dataCount,
    string lastValue,
    int lastDataCount,
    DateTimeOffset lastAcceptedAt)
  {
    if (string.IsNullOrWhiteSpace(value))
    {
      return false;
    }

    var sameValue = string.Equals(value, lastValue, StringComparison.Ordinal);
    var duplicateAgeMs = lastAcceptedAt == DateTimeOffset.MinValue
      ? double.PositiveInfinity
      : (DateTimeOffset.UtcNow - lastAcceptedAt).TotalMilliseconds;
    var duplicateExpired = duplicateAgeMs >= DuplicateSuppressionWindowMs;

    if (dataCount >= 0 && lastDataCount >= 0)
    {
      if (dataCount != lastDataCount) return true;
      if (!sameValue) return true;
      return duplicateExpired;
    }

    if (!sameValue) return true;
    return duplicateExpired;
  }

  private static string NormalizeValue(string? raw)
  {
    var value = (raw ?? "").Trim();
    if (string.IsNullOrWhiteSpace(value))
    {
      return "";
    }

    var sb = new System.Text.StringBuilder(value.Length);
    foreach (var ch in value)
    {
      if (!char.IsControl(ch))
      {
        sb.Append(ch);
      }
    }

    return sb.ToString().Trim();
  }

  private static string BuildAgentId()
  {
    var user = Environment.UserName;
    var machine = Environment.MachineName;
    var pid = Environment.ProcessId;
    return $"{user}@{machine}:{pid}";
  }

  private static string NewCorrelationId()
  {
    return Guid.NewGuid().ToString("N")[..12];
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

  private sealed class RelayPostState(string value, DateTimeOffset at)
  {
    public string LastPostedValue { get; set; } = value;
    public DateTimeOffset LastPostedAt { get; set; } = at;
  }

  private sealed record AgentControl(
    long CommandId,
    bool DesiredClaimed,
    string Owner,
    string LeaseToken,
    string Reason,
    int LeaseRemainingMs,
    long AckCommandId,
    bool AckClaimed);
}
