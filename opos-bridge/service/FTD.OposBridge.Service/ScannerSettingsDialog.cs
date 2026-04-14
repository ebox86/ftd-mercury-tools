using System;
using System.Windows.Forms;

namespace FTD.OposBridge.Service;

public class ScannerSettingsDialog : Form
{
    private ComboBox _logicalNameBox;
    private Button _okButton;
    private Button _cancelButton;
    public string SelectedLogicalName { get; private set; }

    public ScannerSettingsDialog(string currentLogicalName)
    {
        Text = "Scanner Settings";
        StartPosition = FormStartPosition.CenterParent;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        ShowInTaskbar = false;
        ClientSize = new System.Drawing.Size(320, 80);
        AutoScaleMode = AutoScaleMode.Font;

        var layout = new TableLayoutPanel { Dock = DockStyle.Fill, RowCount = 2, ColumnCount = 2, Padding = new Padding(12) };
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50F));
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50F));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize)); // Logical Name
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100F)); // Buttons
        Controls.Add(layout);

        layout.Controls.Add(new Label { Text = "Scanner Logical Name:", Anchor = AnchorStyles.Left, AutoSize = true }, 0, 0);
        _logicalNameBox = new ComboBox { DropDownStyle = ComboBoxStyle.DropDownList, Anchor = AnchorStyles.Left, Width = 180 };
        var logicalNames = OposDeviceEnumerator.GetOposLogicalNames("Scanner");
        _logicalNameBox.Items.AddRange(logicalNames.Count > 0 ? logicalNames.ToArray() : new object[] { currentLogicalName ?? "" });
        if (!string.IsNullOrWhiteSpace(currentLogicalName) && _logicalNameBox.Items.Contains(currentLogicalName))
            _logicalNameBox.SelectedItem = currentLogicalName;
        else if (_logicalNameBox.Items.Count > 0)
            _logicalNameBox.SelectedIndex = 0;
        layout.Controls.Add(_logicalNameBox, 1, 0);

        var buttonPanel = new FlowLayoutPanel { FlowDirection = FlowDirection.RightToLeft, Dock = DockStyle.Fill, AutoSize = true };
        _okButton = new Button { Text = "OK", DialogResult = DialogResult.OK, AutoSize = true };
        _cancelButton = new Button { Text = "Cancel", DialogResult = DialogResult.Cancel, AutoSize = true };
        buttonPanel.Controls.Add(_okButton);
        buttonPanel.Controls.Add(_cancelButton);
        layout.Controls.Add(buttonPanel, 0, 1);
        layout.SetColumnSpan(buttonPanel, 2);

        AcceptButton = _okButton;
        CancelButton = _cancelButton;

        _okButton.Click += (s, e) => SaveSelection();
    }

    private void SaveSelection()
    {
        SelectedLogicalName = _logicalNameBox.SelectedItem?.ToString() ?? "";
    }

    public static string ShowDialogForLogicalName(string currentLogicalName)
    {
        using var dlg = new ScannerSettingsDialog(currentLogicalName);
        return dlg.ShowDialog() == DialogResult.OK ? dlg.SelectedLogicalName : currentLogicalName;
    }
}
