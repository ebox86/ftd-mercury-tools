using System.Text.Json;

namespace FTD.OposBridge.Service;

public class PrinterPreferences
{
    public int PaperWidthMm { get; set; } = 80;
    public int PrintDensity { get; set; } = 100;
    public string? CustomSetting { get; set; }
    /// <summary>
    /// Logical name of the OPOS printer device
    /// </summary>
    public string? PrinterLogicalName { get; set; } = "FTD_PRINTER";

    public static string GetConfigPath()
    {
        var dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "FTD", "OposBridge");
        Directory.CreateDirectory(dir);
        return Path.Combine(dir, "printer-preferences.json");
    }

    public static PrinterPreferences Load()
    {
        var path = GetConfigPath();
        if (File.Exists(path))
        {
            try
            {
                var json = File.ReadAllText(path);
                return JsonSerializer.Deserialize<PrinterPreferences>(json) ?? new PrinterPreferences();
            }
            catch { }
        }
        return new PrinterPreferences();
    }

    public void Save()
    {
        var path = GetConfigPath();
        var json = JsonSerializer.Serialize(this, new JsonSerializerOptions { WriteIndented = true });
        File.WriteAllText(path, json);
    }
}
