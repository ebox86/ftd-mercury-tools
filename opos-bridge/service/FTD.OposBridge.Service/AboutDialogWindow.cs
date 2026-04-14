using System.Drawing;
using System.Windows.Forms;

namespace FTD.OposBridge.Service;

internal static class AboutDialogWindow
{
  public static void Show(
    string title,
    string details,
    string imageFileName = "about-scanner.png",
    IReadOnlyList<string>? scannerLogicalNames = null,
    IReadOnlyList<string>? printerLogicalNames = null,
    string configuredPrinterLogicalName = "")
  {
    var detailText = details ?? string.Empty;
    var scanners = NormalizeNames(scannerLogicalNames);
    var printers = NormalizeNames(printerLogicalNames);
    var showDeviceLists = scanners.Count > 0 || printers.Count > 0;
    var (clientWidth, clientHeight) = MeasureDialogSize(title, detailText, showDeviceLists);

    using var form = new Form
    {
      Text = title,
      StartPosition = FormStartPosition.CenterScreen,
      FormBorderStyle = FormBorderStyle.FixedDialog,
      MaximizeBox = false,
      MinimizeBox = false,
      ShowInTaskbar = false,
      ClientSize = new Size(clientWidth, clientHeight),
      AutoScaleMode = AutoScaleMode.Font,
    };

    var root = new TableLayoutPanel
    {
      Dock = DockStyle.Fill,
      ColumnCount = 1,
      RowCount = showDeviceLists ? 3 : 2,
      Padding = new Padding(12, 12, 12, 8),
    };
    root.RowStyles.Add(new RowStyle(SizeType.Percent, 100F));
    if (showDeviceLists)
    {
      root.RowStyles.Add(new RowStyle(SizeType.AutoSize));
    }
    root.RowStyles.Add(new RowStyle(SizeType.AutoSize));
    form.Controls.Add(root);

    var content = new TableLayoutPanel
    {
      Dock = DockStyle.Fill,
      ColumnCount = 2,
      RowCount = 1,
      Margin = new Padding(0, 0, 0, 8),
    };
    content.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 96F));
    content.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100F));
    content.RowStyles.Add(new RowStyle(SizeType.Percent, 100F));
    root.Controls.Add(content, 0, 0);

    Image aboutImage = LoadAboutImage(imageFileName);
    var iconPanel = new Panel
    {
      Dock = DockStyle.Fill,
      Margin = new Padding(0, 0, 12, 0),
    };
    content.Controls.Add(iconPanel, 0, 0);

    var picture = new PictureBox
    {
      Dock = DockStyle.Top,
      Width = 80,
      Height = 80,
      Margin = new Padding(0, 8, 0, 8),
      SizeMode = PictureBoxSizeMode.Zoom,
      Image = aboutImage,
    };
    iconPanel.Controls.Add(picture);

    var detailsPanel = new TableLayoutPanel
    {
      Dock = DockStyle.Fill,
      ColumnCount = 1,
      RowCount = 2,
      Margin = new Padding(0),
    };
    detailsPanel.RowStyles.Add(new RowStyle(SizeType.AutoSize));
    detailsPanel.RowStyles.Add(new RowStyle(SizeType.Percent, 100F));
    content.Controls.Add(detailsPanel, 1, 0);

    var titleLabel = new Label
    {
      AutoSize = true,
      Text = title,
      Font = new Font("Segoe UI", 10F, FontStyle.Bold, GraphicsUnit.Point),
      Margin = new Padding(0, 0, 0, 8),
    };
    detailsPanel.Controls.Add(titleLabel, 0, 0);

    var detailsBox = new TextBox
    {
      Dock = DockStyle.Fill,
      ReadOnly = true,
      Multiline = true,
      ScrollBars = ScrollBars.Vertical,
      BorderStyle = BorderStyle.None,
      BackColor = SystemColors.Control,
      TabStop = false,
      Text = detailText,
      Margin = new Padding(0),
    };
    detailsPanel.Controls.Add(detailsBox, 0, 1);

    if (showDeviceLists)
    {
      var devicesPanel = new TableLayoutPanel
      {
        Dock = DockStyle.Fill,
        ColumnCount = 2,
        RowCount = 1,
        Margin = new Padding(0, 0, 0, 8),
        AutoSize = true,
        MinimumSize = new Size(0, 230),
      };
      devicesPanel.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 45F));
      devicesPanel.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 55F));
      root.Controls.Add(devicesPanel, 0, 1);

      var scannerGroup = new GroupBox
      {
        Text = "Detected OPOS Scanners",
        Dock = DockStyle.Fill,
        Padding = new Padding(8),
        Margin = new Padding(0, 0, 8, 0),
        MinimumSize = new Size(0, 220),
      };
      var scannerList = new ListBox
      {
        Dock = DockStyle.Fill,
        IntegralHeight = false,
        Height = 120,
        HorizontalScrollbar = true,
      };
      scannerList.Items.AddRange(scanners.Count == 0 ? new object[] { "None found" } : scanners.Cast<object>().ToArray());
      scannerGroup.Controls.Add(scannerList);
      devicesPanel.Controls.Add(scannerGroup, 0, 0);

      var printerGroup = new GroupBox
      {
        Text = "Detected OPOS Printers",
        Dock = DockStyle.Fill,
        Padding = new Padding(8),
        Margin = new Padding(8, 0, 0, 0),
        MinimumSize = new Size(0, 220),
      };
      var printerContainer = new TableLayoutPanel
      {
        Dock = DockStyle.Fill,
        ColumnCount = 1,
        RowCount = 3,
        Margin = new Padding(0),
      };
      printerContainer.RowStyles.Add(new RowStyle(SizeType.Absolute, 230F));
      printerContainer.RowStyles.Add(new RowStyle(SizeType.AutoSize));
      printerContainer.RowStyles.Add(new RowStyle(SizeType.AutoSize));

      var printerList = new ListBox
      {
        Dock = DockStyle.Fill,
        IntegralHeight = false,
        Height = 175,
        MinimumSize = new Size(0, 175),
        HorizontalScrollbar = true,
      };
      printerList.Items.AddRange(printers.Count == 0 ? new object[] { "None found" } : printers.Cast<object>().ToArray());
      if (!string.IsNullOrWhiteSpace(configuredPrinterLogicalName))
      {
        var configured = configuredPrinterLogicalName.Trim();
        if (printerList.Items.Contains(configured))
        {
          printerList.SelectedItem = configured;
        }
      }
      if (printerList.SelectedIndex < 0 && printers.Count > 0)
      {
        printerList.SelectedIndex = 0;
      }
      printerContainer.Controls.Add(printerList, 0, 0);

      var configuredLabel = new Label
      {
        AutoSize = true,
        Margin = new Padding(0, 6, 0, 2),
        Text = string.IsNullOrWhiteSpace(configuredPrinterLogicalName)
          ? "Configured Printer: (none)"
          : $"Configured Printer: {configuredPrinterLogicalName.Trim()}",
      };
      printerContainer.Controls.Add(configuredLabel, 0, 1);

      var setPrinterButton = new Button
      {
        AutoSize = true,
        Text = "Set Selected As Configured Printer",
        Enabled = printers.Count > 0,
        Margin = new Padding(0, 2, 0, 0),
      };
      setPrinterButton.Click += (_, _) =>
      {
        var selected = printerList.SelectedItem?.ToString() ?? "";
        if (string.IsNullOrWhiteSpace(selected) || string.Equals(selected, "None found", StringComparison.OrdinalIgnoreCase))
        {
          return;
        }

        try
        {
          var prefs = PrinterPreferences.Load();
          prefs.PrinterLogicalName = selected.Trim();
          prefs.Save();
          configuredLabel.Text = $"Configured Printer: {selected.Trim()}";
          MessageBox.Show(
            $"Configured printer logical name updated to '{selected.Trim()}'.",
            "Printer Updated",
            MessageBoxButtons.OK,
            MessageBoxIcon.Information);
        }
        catch (Exception ex)
        {
          MessageBox.Show(
            $"Unable to save printer preference: {ex.Message}",
            "Printer Update Failed",
            MessageBoxButtons.OK,
            MessageBoxIcon.Error);
        }
      };
      printerContainer.Controls.Add(setPrinterButton, 0, 2);

      printerGroup.Controls.Add(printerContainer);
      devicesPanel.Controls.Add(printerGroup, 1, 0);
    }

    var buttonPanel = new FlowLayoutPanel
    {
      Dock = DockStyle.Fill,
      FlowDirection = FlowDirection.RightToLeft,
      AutoSize = true,
      WrapContents = false,
      Margin = new Padding(0),
    };
    var okButton = new Button
    {
      Text = "OK",
      AutoSize = true,
      DialogResult = DialogResult.OK,
      Padding = new Padding(12, 4, 12, 4),
    };
    buttonPanel.Controls.Add(okButton);
    root.Controls.Add(buttonPanel, 0, showDeviceLists ? 2 : 1);
    form.AcceptButton = okButton;
    form.CancelButton = okButton;

    try
    {
      form.ShowDialog();
    }
    finally
    {
      picture.Image = null;
      aboutImage.Dispose();
    }
  }

  private static Image LoadAboutImage(string imageFileName)
  {
    var name = string.IsNullOrWhiteSpace(imageFileName) ? "about-scanner.png" : imageFileName.Trim();
    var imagePath = Path.Combine(AppContext.BaseDirectory, name);
    if (File.Exists(imagePath))
    {
      try
      {
        // If it's an .ico, load as icon and convert to bitmap
        if (Path.GetExtension(imagePath).Equals(".ico", StringComparison.OrdinalIgnoreCase))
        {
          using var icon = new Icon(imagePath, 64, 64);
          return icon.ToBitmap();
        }
        using var stream = File.OpenRead(imagePath);
        using var source = Image.FromStream(stream, useEmbeddedColorManagement: false, validateImageData: false);
        return new Bitmap(source);
      }
      catch
      {
        // Fall back to a standard icon when the configured image can't be loaded.
      }
    }

    return SystemIcons.Information.ToBitmap();
  }

  private static (int Width, int Height) MeasureDialogSize(string title, string details, bool includeDeviceLists)
  {
    using var measureBitmap = new Bitmap(1, 1);
    using var graphics = Graphics.FromImage(measureBitmap);
    using var titleFont = new Font("Segoe UI", 10F, FontStyle.Bold, GraphicsUnit.Point);
    using var detailsFont = new Font("Segoe UI", 9F, FontStyle.Regular, GraphicsUnit.Point);

    var normalizedTitle = string.IsNullOrWhiteSpace(title) ? "FTD OPOS Bridge" : title.Trim();
    var lines = (details ?? string.Empty)
      .Replace("\r\n", "\n", StringComparison.Ordinal)
      .Split('\n');

    var widestLine = TextRenderer.MeasureText(
      graphics,
      normalizedTitle,
      titleFont,
      new Size(4000, 4000),
      TextFormatFlags.NoPadding).Width;

    foreach (var line in lines)
    {
      var sample = string.IsNullOrWhiteSpace(line) ? " " : line;
      var measured = TextRenderer.MeasureText(
        graphics,
        sample,
        detailsFont,
        new Size(4000, 4000),
        TextFormatFlags.NoPadding).Width;
      if (measured > widestLine)
      {
        widestLine = measured;
      }
    }

    var lineHeight = TextRenderer.MeasureText(
      graphics,
      "Ag",
      detailsFont,
      new Size(4000, 4000),
      TextFormatFlags.NoPadding).Height;

    var visibleLineCount = Math.Max(6, lines.Length + 1);
    var detailsWidth = Math.Clamp(widestLine + 28, 280, 760);
    var detailsHeight = Math.Clamp((visibleLineCount * lineHeight) + 12, 140, 460);

    // Width: root padding + icon column + icon/details gap + detail content + frame allowance.
    var totalWidth = Math.Clamp(24 + 96 + 12 + detailsWidth + 12, 440, 920);
    var totalHeight = Math.Clamp(20 + detailsHeight + 72, 240, 680);
    if (includeDeviceLists)
    {
      totalWidth = Math.Max(totalWidth, 940);
      totalHeight = Math.Max(totalHeight, 500);
    }

    return (totalWidth, totalHeight);
  }

  private static List<string> NormalizeNames(IReadOnlyList<string>? names)
  {
    var values = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
    if (names is not null)
    {
      foreach (var name in names)
      {
        if (!string.IsNullOrWhiteSpace(name))
        {
          values.Add(name.Trim());
        }
      }
    }

    return values.OrderBy(v => v).ToList();
  }
}
