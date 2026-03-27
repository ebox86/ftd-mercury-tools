using System.Collections.Concurrent;
using System.Threading;

namespace FTD.OposBridge.Service.Scanner;

internal sealed class StaTaskDispatcher : IAsyncDisposable
{
  private readonly BlockingCollection<Action> _queue = new();
  private readonly Thread _thread;

  public StaTaskDispatcher(string threadName)
  {
    _thread = new Thread(RunLoop)
    {
      IsBackground = true,
      Name = threadName,
    };
    _thread.SetApartmentState(ApartmentState.STA);
    _thread.Start();
  }

  public Task RunAsync(Action action, CancellationToken cancellationToken = default)
  {
    return InvokeAsync(() =>
    {
      action();
      return true;
    }, cancellationToken);
  }

  public Task<T> InvokeAsync<T>(Func<T> action, CancellationToken cancellationToken = default)
  {
    var tcs = new TaskCompletionSource<T>(TaskCreationOptions.RunContinuationsAsynchronously);

    Action work = () =>
    {
      if (cancellationToken.IsCancellationRequested)
      {
        tcs.TrySetCanceled(cancellationToken);
        return;
      }

      try
      {
        var result = action();
        tcs.TrySetResult(result);
      }
      catch (Exception ex)
      {
        tcs.TrySetException(ex);
      }
    };

    try
    {
      _queue.Add(work, cancellationToken);
    }
    catch (OperationCanceledException)
    {
      tcs.TrySetCanceled(cancellationToken);
    }
    catch (InvalidOperationException ex)
    {
      tcs.TrySetException(ex);
    }

    return tcs.Task;
  }

  public async ValueTask DisposeAsync()
  {
    _queue.CompleteAdding();
    await Task.Run(() => _thread.Join(TimeSpan.FromSeconds(3)));
    _queue.Dispose();
  }

  private void RunLoop()
  {
    foreach (var work in _queue.GetConsumingEnumerable())
    {
      work();
    }
  }
}
