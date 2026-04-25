namespace FTD.FaxParser.ServiceHost;

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
        continue;

      var eq = arg.IndexOf('=');
      if (eq < 0)
      {
        parser._flags.Add(arg[2..]);
        continue;
      }

      var key = arg[2..eq].Trim();
      var value = arg[(eq + 1)..].Trim();
      if (key.Length > 0)
        parser._values[key] = value;
    }
    return parser;
  }

  public bool HasFlag(string key) => _flags.Contains(key);

  public string Get(string key, string fallback = "") =>
    _values.TryGetValue(key, out var v) ? v : fallback;

  public bool GetBool(string key, bool fallback)
  {
    var raw = Get(key).Trim();
    if (raw.Length == 0) return fallback;
    return raw is "1" or "true" or "yes" or "on";
  }
}
