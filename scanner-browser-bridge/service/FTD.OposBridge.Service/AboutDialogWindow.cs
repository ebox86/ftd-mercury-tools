using System.Drawing;
using System.Windows.Forms;

namespace FTD.OposBridge.Service;

internal static class AboutDialogWindow
{
  public static void Show(string title, string details, string imageFileName = "about-scanner.png")
  {
    using var form = new Form
    {
      Text = title,
      StartPosition = FormStartPosition.CenterScreen,
      FormBorderStyle = FormBorderStyle.FixedDialog,
      MaximizeBox = false,
      MinimizeBox = false,
      ShowInTaskbar = false,
      ClientSize = new Size(620, 340),
      AutoScaleMode = AutoScaleMode.Font,
    };

    var root = new TableLayoutPanel
    {
      Dock = DockStyle.Fill,
      ColumnCount = 1,
      RowCount = 2,
      Padding = new Padding(12, 12, 12, 8),
    };
    root.RowStyles.Add(new RowStyle(SizeType.Percent, 100F));
    root.RowStyles.Add(new RowStyle(SizeType.AutoSize));
    form.Controls.Add(root);

    var content = new TableLayoutPanel
    {
      Dock = DockStyle.Fill,
      ColumnCount = 2,
      RowCount = 1,
      Margin = new Padding(0, 0, 0, 8),
    };
    content.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 272F));
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
      Width = 256,
      Height = 256,
      Margin = new Padding(0, 4, 0, 0),
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
      Text = details ?? string.Empty,
      Margin = new Padding(0),
    };
    detailsPanel.Controls.Add(detailsBox, 0, 1);

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
    root.Controls.Add(buttonPanel, 0, 1);
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
}
