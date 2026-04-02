using System.Runtime.InteropServices;

namespace FTD.OposBridge.Service;

internal static class ConsoleWindow
{
  private const int SwHide = 0;

  public static void TryHide()
  {
    if (!OperatingSystem.IsWindows())
    {
      return;
    }

    try
    {
      var window = GetConsoleWindow();
      if (window != IntPtr.Zero)
      {
        _ = ShowWindow(window, SwHide);
      }
    }
    catch
    {
      // Ignore console hide failures.
    }
  }

  [DllImport("kernel32.dll")]
  private static extern IntPtr GetConsoleWindow();

  [DllImport("user32.dll")]
  private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
