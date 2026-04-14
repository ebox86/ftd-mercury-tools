using System;
using Microsoft.Win32;
using System.Collections.Generic;
using System.Linq;

namespace FTD.OposBridge.Service;

public static class OposDeviceEnumerator
{
    public static List<string> GetOposLogicalNames(string deviceCategory)
    {
        // deviceCategory: e.g. "POSPrinter", "Scanner"
        var logicalNames = new HashSet<string>(System.StringComparer.OrdinalIgnoreCase);
        var requireServiceBinding = string.Equals(deviceCategory, "POSPrinter", StringComparison.OrdinalIgnoreCase);
        var paths = new[]
        {
            $"SOFTWARE\\OLEforRetail\\ServiceOPOS\\{deviceCategory}",
            $"SOFTWARE\\WOW6432Node\\OLEforRetail\\ServiceOPOS\\{deviceCategory}",
        };

        foreach (var path in paths)
        {
            try
            {
                using var key = Registry.LocalMachine.OpenSubKey(path);
                if (key == null)
                {
                    continue;
                }

                foreach (var name in key.GetSubKeyNames())
                {
                    if (!string.IsNullOrWhiteSpace(name))
                    {
                        if (requireServiceBinding)
                        {
                            using var logicalKey = key.OpenSubKey(name);
                            if (logicalKey == null)
                            {
                                continue;
                            }

                            var defaultValue = Convert.ToString(logicalKey.GetValue(null))?.Trim();
                            var serviceValue = Convert.ToString(logicalKey.GetValue("Service"))?.Trim();
                            if (string.IsNullOrWhiteSpace(defaultValue) && string.IsNullOrWhiteSpace(serviceValue))
                            {
                                // Skip malformed OPOS logical entries that cannot be opened by service object.
                                continue;
                            }
                        }

                        logicalNames.Add(name.Trim());
                    }
                }
            }
            catch
            {
                // Ignore registry access failures and continue with remaining hives.
            }
        }

        return logicalNames.OrderBy(v => v).ToList();
    }
}
