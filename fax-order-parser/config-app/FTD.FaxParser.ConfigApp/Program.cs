using System.Windows.Forms;

namespace FTD.FaxParser.ConfigApp;

internal static class Program
{
  [STAThread]
  private static void Main()
  {
    Application.EnableVisualStyles();
    Application.SetCompatibleTextRenderingDefault(false);
    Application.SetHighDpiMode(HighDpiMode.SystemAware);
    Application.Run(new MainForm());
  }
}
