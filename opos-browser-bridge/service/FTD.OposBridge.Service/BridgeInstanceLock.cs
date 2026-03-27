using System.Threading;

namespace FTD.OposBridge.Service;

public sealed class BridgeInstanceLock : IDisposable
{
  private readonly Mutex _mutex;
  private bool _released;

  private BridgeInstanceLock(Mutex mutex, string name)
  {
    _mutex = mutex;
    Name = name;
  }

  public string Name { get; }

  public static BridgeInstanceLock Acquire(int port)
  {
    var baseName = $"FTD.OposBridge.Port{port}";
    foreach (var scope in new[] { "Global", "Local" })
    {
      var createdNew = false;
      var mutexName = $"{scope}\\{baseName}";
      Mutex? candidate = null;
      try
      {
        candidate = new Mutex(initiallyOwned: true, name: mutexName, createdNew: out createdNew);
      }
      catch
      {
        if (scope == "Global")
        {
          continue;
        }

        throw;
      }

      if (!createdNew)
      {
        candidate.Dispose();
        throw new InvalidOperationException($"Another bridge instance already holds mutex '{mutexName}'.");
      }

      return new BridgeInstanceLock(candidate, mutexName);
    }

    throw new InvalidOperationException($"Failed to acquire single-instance lock for port {port}.");
  }

  public void Dispose()
  {
    if (_released)
    {
      return;
    }

    _released = true;
    try
    {
      _mutex.ReleaseMutex();
    }
    catch
    {
      // Ignore mutex release races during shutdown.
    }

    _mutex.Dispose();
  }
}

