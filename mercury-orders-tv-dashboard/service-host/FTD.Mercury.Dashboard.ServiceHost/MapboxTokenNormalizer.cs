using System.Text.RegularExpressions;

namespace FTD.Mercury.Dashboard.ServiceHost;

internal static class MapboxTokenNormalizer
{
  public static string Normalize(string rawToken)
  {
    var token = (rawToken ?? string.Empty).Trim();
    if (token.Length == 0)
    {
      return string.Empty;
    }

    var assignmentMatch = Regex.Match(
      token,
      @"^(?:MAPBOX_TOKEN|MAPBOX_ACCESS_TOKEN)\s*=\s*(.*)$",
      RegexOptions.IgnoreCase);
    if (assignmentMatch.Success)
    {
      token = assignmentMatch.Groups[1].Value.Trim();
    }

    if (token.Length >= 2
      && ((token.StartsWith('"') && token.EndsWith('"')) || (token.StartsWith('\'') && token.EndsWith('\''))))
    {
      token = token[1..^1].Trim();
    }

    var embeddedMatch = Regex.Match(token, @"\b(?:pk|sk)\.[A-Za-z0-9._-]+");
    if (embeddedMatch.Success)
    {
      token = embeddedMatch.Value.Trim();
    }

    return token;
  }
}
