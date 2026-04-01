namespace FTD.Mercury.Dashboard.ServiceHost;

internal sealed class ArgumentParser
{
  private readonly Dictionary<string, string> _values = new(StringComparer.OrdinalIgnoreCase);
  private readonly HashSet<string> _flags = new(StringComparer.OrdinalIgnoreCase);

  public static ArgumentParser Parse(string[] args)
  {
    var parser = new ArgumentParser();
    foreach (var raw in args)
    {
      var arg = (raw ?? string.Empty).Trim();
      if (!arg.StartsWith("--", StringComparison.Ordinal))
      {
        continue;
      }

      var equalsIndex = arg.IndexOf('=');
      if (equalsIndex < 0)
      {
        parser._flags.Add(arg[2..]);
        continue;
      }

      var key = arg[2..equalsIndex].Trim();
      var value = arg[(equalsIndex + 1)..].Trim();
      if (key.Length == 0)
      {
        continue;
      }

      parser._values[key] = value;
    }

    return parser;
  }

  public bool HasFlag(string key)
  {
    return _flags.Contains(key);
  }

  public string Get(string key, string fallback = "")
  {
    if (_values.TryGetValue(key, out var value))
    {
      return value;
    }

    return fallback;
  }

  public int GetInt(string key, int fallback, int min, int max)
  {
    if (!int.TryParse(Get(key), out var value))
    {
      return Math.Clamp(fallback, min, max);
    }

    return Math.Clamp(value, min, max);
  }

  public bool GetBool(string key, bool fallback)
  {
    var raw = Get(key, string.Empty).Trim();
    if (raw.Length == 0)
    {
      return fallback;
    }

    return raw.Equals("1", StringComparison.OrdinalIgnoreCase)
      || raw.Equals("true", StringComparison.OrdinalIgnoreCase)
      || raw.Equals("yes", StringComparison.OrdinalIgnoreCase)
      || raw.Equals("on", StringComparison.OrdinalIgnoreCase);
  }
}