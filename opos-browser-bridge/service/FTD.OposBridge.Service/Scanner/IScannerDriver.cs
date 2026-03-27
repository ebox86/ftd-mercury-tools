namespace FTD.OposBridge.Service.Scanner;

public interface IScannerDriver
{
  string Mode { get; }
  bool IsClaimed { get; }
  bool? DeviceEnabled { get; }
  bool? AutoDisable { get; }
  string LastError { get; }

  Task InitializeAsync(CancellationToken cancellationToken);
  Task ShutdownAsync(CancellationToken cancellationToken);
  Task<bool> EnsureClaimedAsync(int timeoutMs, string reason, CancellationToken cancellationToken);
  Task<bool> ReleaseClaimAsync(string reason, CancellationToken cancellationToken);
  Task<bool> RearmAsync(CancellationToken cancellationToken);
  Task<ScannerStartupDiagnostics> GetStartupDiagnosticsAsync(CancellationToken cancellationToken);
  Task<ScannerSnapshot?> ReadEventSnapshotAsync(CancellationToken cancellationToken);
  Task<ScannerSnapshot> ReadSnapshotAsync(CancellationToken cancellationToken);
  Task<bool> ClearInputAsync(CancellationToken cancellationToken);
}

public interface IScannerInjector
{
  bool Inject(string value);
}

public sealed record ScannerSnapshot(
  string Label,
  string Raw,
  int DataCount,
  int DataType,
  bool? DeviceEnabled,
  bool? AutoDisable);

public sealed record ScannerStartupDiagnostics(
  string Mode,
  string LogicalName,
  bool Initialized,
  bool Claimed,
  int OpenResult,
  string ComProgId,
  bool EventSinkAttached,
  string LastError);
