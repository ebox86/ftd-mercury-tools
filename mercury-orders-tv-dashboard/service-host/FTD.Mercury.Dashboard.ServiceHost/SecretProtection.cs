using System.Security.Cryptography;
using System.Text;

namespace FTD.Mercury.Dashboard.ServiceHost;

internal static class SecretProtection
{
  private static readonly byte[] AdditionalEntropy = Encoding.UTF8.GetBytes("FTD.Mercury.Dashboard.ServiceHost.MapboxToken.v1");

  public static string ProtectForLocalMachine(string value)
  {
    var input = (value ?? string.Empty).Trim();
    if (input.Length == 0)
    {
      return string.Empty;
    }

    if (!OperatingSystem.IsWindows())
    {
      return input;
    }

    var plainBytes = Encoding.UTF8.GetBytes(input);
    var protectedBytes = ProtectedData.Protect(plainBytes, AdditionalEntropy, DataProtectionScope.LocalMachine);
    return Convert.ToBase64String(protectedBytes);
  }

  public static string UnprotectForLocalMachine(string protectedValue)
  {
    var input = (protectedValue ?? string.Empty).Trim();
    if (input.Length == 0)
    {
      return string.Empty;
    }

    if (!OperatingSystem.IsWindows())
    {
      return input;
    }

    try
    {
      var protectedBytes = Convert.FromBase64String(input);
      var plainBytes = ProtectedData.Unprotect(protectedBytes, AdditionalEntropy, DataProtectionScope.LocalMachine);
      return Encoding.UTF8.GetString(plainBytes);
    }
    catch (Exception ex)
    {
      throw new InvalidOperationException("Failed to decrypt protected Mapbox token.", ex);
    }
  }
}
