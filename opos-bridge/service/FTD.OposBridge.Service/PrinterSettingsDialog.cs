using System;
using System.Text.Json;
using System.Windows.Forms;

namespace FTD.OposBridge.Service;

public class PrinterSettingsDialog : Form
{
    private NumericUpDown _paperWidth;
    private NumericUpDown _printDensity;
    private ComboBox _logicalNameBox;
    private Button _okButton;
    private Button _cancelButton;
    private Button _testPrintButton;
    private readonly string _bridgeBaseUrl;
    public PrinterPreferences Preferences { get; private set; }

    public PrinterSettingsDialog(PrinterPreferences prefs, string bridgeBaseUrl = "http://127.0.0.1:17331")
    {
        _bridgeBaseUrl = string.IsNullOrWhiteSpace(bridgeBaseUrl) ? "http://127.0.0.1:17331" : bridgeBaseUrl.Trim().TrimEnd('/');
        Preferences = prefs;
        Text = "Printer Settings";
        StartPosition = FormStartPosition.CenterParent;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        ShowInTaskbar = false;
        ClientSize = new System.Drawing.Size(320, 160);
        AutoScaleMode = AutoScaleMode.Font;

        var layout = new TableLayoutPanel { Dock = DockStyle.Fill, RowCount = 4, ColumnCount = 2, Padding = new Padding(12) };
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50F));
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50F));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize)); // Logical Name
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize)); // Paper Width
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize)); // Print Density
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100F)); // Buttons
        Controls.Add(layout);

        layout.Controls.Add(new Label { Text = "Printer Logical Name:", Anchor = AnchorStyles.Left, AutoSize = true }, 0, 0);
        _logicalNameBox = new ComboBox { DropDownStyle = ComboBoxStyle.DropDownList, Anchor = AnchorStyles.Left, Width = 180 };
        var logicalNames = OposDeviceEnumerator.GetOposLogicalNames("POSPrinter");
        _logicalNameBox.Items.AddRange(logicalNames.Count > 0 ? logicalNames.ToArray() : new object[] { prefs.PrinterLogicalName ?? "" });
        if (!string.IsNullOrWhiteSpace(prefs.PrinterLogicalName) && _logicalNameBox.Items.Contains(prefs.PrinterLogicalName))
            _logicalNameBox.SelectedItem = prefs.PrinterLogicalName;
        else if (_logicalNameBox.Items.Count > 0)
            _logicalNameBox.SelectedIndex = 0;
        layout.Controls.Add(_logicalNameBox, 1, 0);

        layout.Controls.Add(new Label { Text = "Paper Width (mm):", Anchor = AnchorStyles.Left, AutoSize = true }, 0, 1);
        _paperWidth = new NumericUpDown { Minimum = 50, Maximum = 120, Value = prefs.PaperWidthMm, Anchor = AnchorStyles.Left };
        layout.Controls.Add(_paperWidth, 1, 1);

        layout.Controls.Add(new Label { Text = "Print Density (%):", Anchor = AnchorStyles.Left, AutoSize = true }, 0, 2);
        _printDensity = new NumericUpDown { Minimum = 50, Maximum = 200, Value = prefs.PrintDensity, Anchor = AnchorStyles.Left };
        layout.Controls.Add(_printDensity, 1, 2);

        var buttonPanel = new FlowLayoutPanel { FlowDirection = FlowDirection.RightToLeft, Dock = DockStyle.Fill, AutoSize = true };
        _okButton = new Button { Text = "OK", DialogResult = DialogResult.OK, AutoSize = true };
        _cancelButton = new Button { Text = "Cancel", DialogResult = DialogResult.Cancel, AutoSize = true };
        _testPrintButton = new Button { Text = "Test Print", AutoSize = true };
        buttonPanel.Controls.Add(_okButton);
        buttonPanel.Controls.Add(_cancelButton);
        buttonPanel.Controls.Add(_testPrintButton);
        layout.Controls.Add(buttonPanel, 0, 3);
        layout.SetColumnSpan(buttonPanel, 2);

        AcceptButton = _okButton;
        CancelButton = _cancelButton;

        _okButton.Click += (s, e) => SavePrefs();
        _testPrintButton.Click += async (s, e) => await TestPrintAsync();
    }


    private void SavePrefs()
    {
        Preferences.PrinterLogicalName = _logicalNameBox.SelectedItem?.ToString() ?? "";
        Preferences.PaperWidthMm = (int)_paperWidth.Value;
        Preferences.PrintDensity = (int)_printDensity.Value;
        Preferences.Save();
    }

    private async Task TestPrintAsync()
    {
        try
        {
            using var client = new System.Net.Http.HttpClient();
            var selectedLogicalName = _logicalNameBox.SelectedItem?.ToString() ?? "";
            var url = _bridgeBaseUrl + "/api/print-test-star?logicalName=" + Uri.EscapeDataString(selectedLogicalName);
            var response = await client.GetAsync(url);
            var bodyText = await response.Content.ReadAsStringAsync();
            var (ok, error, logicalName) = ParsePrintResponse(bodyText);

            if (response.IsSuccessStatusCode && ok)
            {
                var nameText = string.IsNullOrWhiteSpace(logicalName) ? selectedLogicalName : logicalName;
                MessageBox.Show(
                    $"Test print sent successfully to '{nameText}'.",
                    "Test Print",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Information);
            }
            else
            {
                var detail = string.IsNullOrWhiteSpace(error)
                    ? $"HTTP {(int)response.StatusCode} {response.StatusCode}"
                    : error;
                MessageBox.Show(
                    $"Test print failed.\r\n{detail}",
                    "Test Print",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error);
            }
        }
        catch (Exception ex)
        {
            MessageBox.Show($"Test print error: {ex.Message}", "Test Print", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    private static (bool Ok, string Error, string LogicalName) ParsePrintResponse(string bodyText)
    {
        if (string.IsNullOrWhiteSpace(bodyText))
        {
            return (false, "", "");
        }

        try
        {
            using var doc = JsonDocument.Parse(bodyText);
            var root = doc.RootElement;
            var ok = root.TryGetProperty("ok", out var okProp) &&
                     okProp.ValueKind == JsonValueKind.True;

            var error = root.TryGetProperty("error", out var errProp) && errProp.ValueKind == JsonValueKind.String
                ? errProp.GetString() ?? ""
                : "";

            var logicalName = root.TryGetProperty("logicalName", out var logicalProp) && logicalProp.ValueKind == JsonValueKind.String
                ? logicalProp.GetString() ?? ""
                : "";

            return (ok, error, logicalName);
        }
        catch
        {
            return (false, bodyText, "");
        }
    }

    public static void ShowDialogForPrefs(string bridgeBaseUrl = "http://127.0.0.1:17331")
    {
        var prefs = PrinterPreferences.Load();
        using var dlg = new PrinterSettingsDialog(prefs, bridgeBaseUrl);
        if (dlg.ShowDialog() == DialogResult.OK)
        {
            // Preferences are saved in SavePrefs()
        }
    }
}
