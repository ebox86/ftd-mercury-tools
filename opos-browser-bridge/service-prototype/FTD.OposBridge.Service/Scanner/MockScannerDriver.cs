using System.Collections.Concurrent;

namespace FTD.OposBridge.Service.Scanner;

public sealed class MockScannerDriver(ILogger logger) : IScannerDriver, IScannerInjector
{
  private readonly ConcurrentQueue<string> _pending = new();
  private bool _started;
  private bool _claimed;
  private bool _deviceEnabled;
  private bool _autoDisable;
  private int _dataCount = -1;
  private string _currentValue = "";

  public string Mode => "mock";
  public bool IsClaimed => _claimed;
  public bool? DeviceEnabled => _deviceEnabled;
  public bool? AutoDisable => _autoDisable;
  public string LastError => "";

  public Task InitializeAsync(CancellationToken cancellationToken)
  {
    _started = true;
    _claimed = false;
    _deviceEnabled = false;
    _autoDisable = false;
    logger.LogInformation("Mock scanner initialized.");
    return Task.CompletedTask;
  }

  public Task ShutdownAsync(CancellationToken cancellationToken)
  {
    _started = false;
    _claimed = false;
    _deviceEnabled = false;
    _currentValue = "";
    while (_pending.TryDequeue(out _)) { }
    logger.LogInformation("Mock scanner shutdown.");
    return Task.CompletedTask;
  }

  public Task<bool> EnsureClaimedAsync(int timeoutMs, string reason, CancellationToken cancellationToken)
  {
    if (!_started)
    {
      return Task.FromResult(false);
    }

    _claimed = true;
    _deviceEnabled = true;
    logger.LogInformation("Mock scanner claimed (reason={Reason}).", reason);
    return Task.FromResult(true);
  }

  public Task<bool> ReleaseClaimAsync(string reason, CancellationToken cancellationToken)
  {
    if (!_claimed)
    {
      return Task.FromResult(false);
    }

    _claimed = false;
    _deviceEnabled = false;
    _currentValue = "";
    logger.LogInformation("Mock scanner released (reason={Reason}).", reason);
    return Task.FromResult(true);
  }

  public Task<bool> RearmAsync(CancellationToken cancellationToken)
  {
    if (!_claimed)
    {
      return Task.FromResult(false);
    }

    _deviceEnabled = true;
    _autoDisable = false;
    return Task.FromResult(true);
  }

  public Task<ScannerSnapshot?> ReadEventSnapshotAsync(CancellationToken cancellationToken)
  {
    return Task.FromResult<ScannerSnapshot?>(null);
  }

  public Task<ScannerSnapshot> ReadSnapshotAsync(CancellationToken cancellationToken)
  {
    if (!_claimed)
    {
      return Task.FromResult(new ScannerSnapshot("", "", -1, 0, false, _autoDisable));
    }

    if (string.IsNullOrWhiteSpace(_currentValue) && _pending.TryDequeue(out var next))
    {
      _currentValue = next;
      _dataCount = Math.Max(0, _dataCount + 1);
    }

    return Task.FromResult(new ScannerSnapshot(_currentValue, _currentValue, _dataCount, 0, _deviceEnabled, _autoDisable));
  }

  public Task<bool> ClearInputAsync(CancellationToken cancellationToken)
  {
    _currentValue = "";
    return Task.FromResult(true);
  }

  public bool Inject(string value)
  {
    if (string.IsNullOrWhiteSpace(value))
    {
      return false;
    }

    _pending.Enqueue(value.Trim());
    return true;
  }
}
