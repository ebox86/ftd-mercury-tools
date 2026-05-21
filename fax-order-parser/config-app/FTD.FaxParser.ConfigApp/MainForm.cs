using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.ComponentModel;
using System.Security.Principal;
using System.Windows.Forms;

namespace FTD.FaxParser.ConfigApp;

internal sealed class MainForm : Form
{
  // ── Constants ────────────────────────────────────────────────────────────────

  private static readonly Color AccentColor   = Color.FromArgb(26, 58, 92);
  private static readonly Color BgColor       = Color.FromArgb(240, 242, 245);
  private const string          ServiceName   = "FTD Fax Order Parser";

  private static string ConfigPath => Path.Combine(
    Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
    "FTD", "FaxOrderParser", "config.json");

  private static string LogPath => Path.Combine(
    Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
    "FTD", "FaxOrderParser", "orders-log.json");

  // ── Monitor tab controls ──────────────────────────────────────────────────────

  private TextBox        _watchFolderBox       = null!;
  private NumericUpDown  _pollIntervalSpinner  = null!;
  private ComboBox       _fileFormatCombo      = null!;
  private TextBox        _processedSubfolderBox = null!;

  // ── Email tab controls ────────────────────────────────────────────────────────

  private TextBox        _senderAddressBox     = null!;
  private TextBox        _senderPasswordBox    = null!;
  private TextBox        _recipientAddressBox  = null!;
  private TextBox        _subjectLineBox       = null!;
  private TextBox        _smtpHostBox          = null!;
  private NumericUpDown  _smtpPortSpinner      = null!;

  // ── Log tab controls ──────────────────────────────────────────────────────────

  private DataGridView   _logGrid              = null!;
  private Label          _logCountLabel        = null!;

  // ── Status ───────────────────────────────────────────────────────────────────

  private Label          _serviceBadge         = null!;
  private Label          _footerStatusLabel    = null!;
  private System.Windows.Forms.Timer? _statusClearTimer;

  // ── Constructor ───────────────────────────────────────────────────────────────

  public MainForm()
  {
    SuspendLayout();

    Text            = "FTD Fax Order Parser — Configuration";
    ClientSize      = new Size(780, 600);
    FormBorderStyle = FormBorderStyle.FixedSingle;
    MaximizeBox     = false;
    StartPosition   = FormStartPosition.CenterScreen;
    BackColor       = BgColor;
    Font            = new Font("Segoe UI", 9f, FontStyle.Regular, GraphicsUnit.Point);

    TryLoadIcon();
    BuildUi();

    ResumeLayout(performLayout: true);

    Shown += (_, _) =>
    {
      LoadConfig();
      RefreshServiceStatus();
    };
  }

  // ── Icon ──────────────────────────────────────────────────────────────────────

  private void TryLoadIcon()
  {
    try
    {
      var p = Path.Combine(AppContext.BaseDirectory, "app-icon.ico");
      if (File.Exists(p)) Icon = new Icon(p);
    }
    catch { /* non-fatal */ }
  }

  // ── UI builder ────────────────────────────────────────────────────────────────

  private void BuildUi()
  {
    Controls.Add(BuildFooter());   // Dock=Bottom — add first so TabControl fills correctly
    Controls.Add(BuildHeader());   // Dock=Top
    Controls.Add(BuildTabControl()); // Dock=Fill
  }

  // ── Header ────────────────────────────────────────────────────────────────────

  private Panel BuildHeader()
  {
    var header = new Panel
    {
      Dock      = DockStyle.Top,
      Height    = 44,
      BackColor = AccentColor,
    };

    var titleLabel = new Label
    {
      Text      = "FTD Fax Order Parser",
      ForeColor = Color.White,
      Font      = new Font("Segoe UI", 10.5f, FontStyle.Bold),
      AutoSize  = true,
      Location  = new Point(14, 12),
    };

    _serviceBadge = new Label
    {
      Text      = "Service: checking…",
      ForeColor = Color.White,
      BackColor = Color.FromArgb(149, 165, 166),
      Font      = new Font("Segoe UI", 8f, FontStyle.Bold),
      AutoSize  = true,
      Padding   = new Padding(8, 3, 8, 3),
      Anchor    = AnchorStyles.Top | AnchorStyles.Right,
    };

    // Position badge after layout so AutoSize has resolved
    header.Layout += (_, _) =>
    {
      _serviceBadge.Location = new Point(
        header.ClientSize.Width - _serviceBadge.Width - 14,
        (header.ClientSize.Height - _serviceBadge.Height) / 2);
    };

    header.Controls.AddRange(new Control[] { titleLabel, _serviceBadge });
    return header;
  }

  // ── Tab control ───────────────────────────────────────────────────────────────

  private TabControl BuildTabControl()
  {
    var tc = new TabControl
    {
      Dock      = DockStyle.Fill,
      Alignment = TabAlignment.Top,
      SizeMode  = TabSizeMode.Fixed,
      ItemSize  = new Size(120, 30),
    };
    tc.TabPages.Add(BuildMonitorTab());
    tc.TabPages.Add(BuildEmailTab());
    tc.TabPages.Add(BuildLogTab());
    tc.SelectedIndexChanged += (_, _) =>
    {
      if (tc.SelectedIndex == 2) LoadLog();
    };
    return tc;
  }

  // ── Monitor tab ───────────────────────────────────────────────────────────────

  private TabPage BuildMonitorTab()
  {
    var page = new TabPage("Monitor");

    var panel = new FlowLayoutPanel
    {
      Dock          = DockStyle.Fill,
      FlowDirection = FlowDirection.TopDown,
      WrapContents  = false,
      Padding       = new Padding(14, 10, 14, 0),
      AutoScroll    = true,
    };

    // Watch folder row
    _watchFolderBox = new TextBox { Width = 520 };
    var openBtn = SmallButton("📂");
    openBtn.Button.Click += (_, _) =>
    {
      var f = _watchFolderBox.Text.Trim();
      if (!string.IsNullOrEmpty(f) && Directory.Exists(f))
        Process.Start("explorer.exe", f);
    };
    var folderRow = new FlowLayoutPanel
    {
      AutoSize      = true,
      FlowDirection = FlowDirection.LeftToRight,
      Margin        = Padding.Empty,
    };
    folderRow.Controls.AddRange(new Control[] { _watchFolderBox, openBtn.Button });

    panel.Controls.Add(FieldLabel("Incoming Fax Folder"));
    panel.Controls.Add(folderRow);
    panel.Controls.Add(HintLabel(@"Files placed here are automatically scanned. Default: C:\received_faxes"));

    // Poll interval
    _pollIntervalSpinner = new NumericUpDown
    {
      Minimum = 1, Maximum = 3600, Value = 10,
      Width   = 90, Margin = new Padding(0, 0, 0, 2),
    };
    panel.Controls.Add(FieldLabel("Poll Interval (seconds)"));
    panel.Controls.Add(_pollIntervalSpinner);

    // File format
    _fileFormatCombo = new ComboBox { DropDownStyle = ComboBoxStyle.DropDownList, Width = 130 };
    _fileFormatCombo.Items.AddRange(new object[] { "PDF", "TIF / TIFF" });
    _fileFormatCombo.SelectedIndex = 0;
    panel.Controls.Add(FieldLabel("Incoming File Format"));
    panel.Controls.Add(_fileFormatCombo);

    // Processed subfolder
    _processedSubfolderBox = new TextBox { Width = 250, Text = "processed" };
    panel.Controls.Add(FieldLabel("Processed Subfolder Name"));
    panel.Controls.Add(_processedSubfolderBox);
    panel.Controls.Add(HintLabel("Processed files are moved here (relative to the watch folder)."));

    page.Controls.Add(panel);
    return page;
  }

  // ── Email tab ─────────────────────────────────────────────────────────────────

  private TabPage BuildEmailTab()
  {
    var page = new TabPage("Email");

    var panel = new FlowLayoutPanel
    {
      Dock          = DockStyle.Fill,
      FlowDirection = FlowDirection.TopDown,
      WrapContents  = false,
      Padding       = new Padding(14, 10, 14, 0),
      AutoScroll    = true,
    };

    _senderAddressBox    = new TextBox { Width = 420 };
    _senderPasswordBox   = new TextBox { Width = 320, UseSystemPasswordChar = true };
    _recipientAddressBox = new TextBox { Width = 420 };
    _subjectLineBox      = new TextBox { Width = 360 };

    panel.Controls.Add(FieldLabel("Sender Email Address"));
    panel.Controls.Add(_senderAddressBox);

    panel.Controls.Add(FieldLabel("Sender Password / App Password"));
    panel.Controls.Add(_senderPasswordBox);
    panel.Controls.Add(HintLabel("For Gmail: Google Account → Security → App passwords (requires 2-Step Verification)."));

    panel.Controls.Add(FieldLabel("Recipient Email Address (WOI inbox)"));
    panel.Controls.Add(_recipientAddressBox);

    panel.Controls.Add(FieldLabel("Email Subject Line"));
    panel.Controls.Add(_subjectLineBox);
    panel.Controls.Add(HintLabel("Must match the subject line configured in Mercury Administration → Web Order Interface."));

    // Advanced SMTP group
    var smtpGroup = new GroupBox
    {
      Text   = "Advanced SMTP Settings",
      Width  = 560,
      Height = 108,
      Margin = new Padding(0, 10, 0, 0),
    };

    _smtpHostBox = new TextBox { Width = 280, Location = new Point(130, 24) };
    _smtpPortSpinner = new NumericUpDown
    {
      Minimum  = 1, Maximum = 65535, Value = 587,
      Width    = 90, Location = new Point(130, 60),
    };
    smtpGroup.Controls.AddRange(new Control[]
    {
      new Label { Text = "SMTP Host:",  AutoSize = true, Location = new Point(10, 27) },
      _smtpHostBox,
      new Label { Text = "SMTP Port:",  AutoSize = true, Location = new Point(10, 63) },
      _smtpPortSpinner,
    });

    panel.Controls.Add(smtpGroup);

    page.Controls.Add(panel);
    return page;
  }

  // ── Log tab ───────────────────────────────────────────────────────────────────

  private TabPage BuildLogTab()
  {
    var page = new TabPage("Order Log");

    // Toolbar
    var toolbar = new Panel { Dock = DockStyle.Top, Height = 36, BackColor = BgColor };
    var refreshBtn = new Button
    {
      Text     = "↺  Refresh",
      Width    = 90,
      Height   = 26,
      Location = new Point(10, 5),
      FlatStyle = FlatStyle.System,
    };
    refreshBtn.Click += (_, _) => LoadLog();

    _logCountLabel = new Label
    {
      AutoSize  = true,
      Location  = new Point(112, 10),
      ForeColor = Color.Gray,
      Font      = new Font("Segoe UI", 8.5f),
    };
    toolbar.Controls.AddRange(new Control[] { refreshBtn, _logCountLabel });

    // Grid
    _logGrid = new DataGridView
    {
      Dock                    = DockStyle.Fill,
      ReadOnly                = true,
      AllowUserToAddRows      = false,
      AllowUserToDeleteRows   = false,
      AllowUserToResizeRows   = false,
      RowHeadersVisible       = false,
      BackgroundColor         = Color.White,
      BorderStyle             = BorderStyle.None,
      AutoSizeColumnsMode     = DataGridViewAutoSizeColumnsMode.Fill,
      SelectionMode           = DataGridViewSelectionMode.FullRowSelect,
      Font                    = new Font("Segoe UI", 8.5f),
      GridColor               = Color.FromArgb(224, 228, 232),
      CellBorderStyle         = DataGridViewCellBorderStyle.SingleHorizontal,
    };

    _logGrid.ColumnHeadersDefaultCellStyle.BackColor  = AccentColor;
    _logGrid.ColumnHeadersDefaultCellStyle.ForeColor  = Color.White;
    _logGrid.ColumnHeadersDefaultCellStyle.Font       = new Font("Segoe UI", 8.5f, FontStyle.Bold);
    _logGrid.ColumnHeadersDefaultCellStyle.Padding    = new Padding(4, 0, 0, 0);
    _logGrid.EnableHeadersVisualStyles                = false;
    _logGrid.ColumnHeadersHeight                      = 28;
    _logGrid.AlternatingRowsDefaultCellStyle.BackColor = Color.FromArgb(248, 249, 250);

    _logGrid.Columns.AddRange(new DataGridViewColumn[]
    {
      new DataGridViewTextBoxColumn { HeaderText = "Timestamp", Name = "Timestamp", FillWeight = 17 },
      new DataGridViewTextBoxColumn { HeaderText = "File",      Name = "File",      FillWeight = 16 },
      new DataGridViewTextBoxColumn { HeaderText = "Order #",   Name = "Order",     FillWeight = 10 },
      new DataGridViewTextBoxColumn { HeaderText = "Customer",  Name = "Customer",  FillWeight = 16 },
      new DataGridViewTextBoxColumn { HeaderText = "Delivery",  Name = "Delivery",  FillWeight = 12 },
      new DataGridViewTextBoxColumn { HeaderText = "Email",     Name = "Email",     FillWeight = 10 },
      new DataGridViewTextBoxColumn { HeaderText = "Note",      Name = "Note",      FillWeight = 19 },
    });

    page.Controls.AddRange(new Control[] { _logGrid, toolbar });
    return page;
  }

  // ── Footer ────────────────────────────────────────────────────────────────────

  private Panel BuildFooter()
  {
    var footer = new Panel
    {
      Dock      = DockStyle.Bottom,
      Height    = 48,
      BackColor = Color.White,
    };

    // Separator line at the top of the footer
    footer.Paint += (_, e) =>
    {
      e.Graphics.DrawLine(
        new Pen(Color.FromArgb(208, 213, 219)),
        0, 0, footer.Width, 0);
    };

    var btnStart = new Button { Text = "▶  Start Service",  Width = 114, Height = 28, Location = new Point(12, 10) };
    var btnStop  = new Button { Text = "■  Stop Service",   Width = 114, Height = 28, Location = new Point(134, 10) };
    btnStart.Click += (_, _) => RunServiceCommand("start");
    btnStop.Click  += (_, _) => RunServiceCommand("stop");

    _footerStatusLabel = new Label
    {
      AutoSize  = false,
      Width     = 300,
      Height    = 20,
      Location  = new Point(262, 14),
      ForeColor = Color.FromArgb(80, 80, 80),
      Font      = new Font("Segoe UI", 8.5f),
    };

    var btnSave = new Button
    {
      Text      = "Save Settings",
      Width     = 122,
      Height    = 28,
      Location  = new Point(644, 10),
      BackColor = AccentColor,
      ForeColor = Color.White,
      FlatStyle = FlatStyle.Flat,
      Font      = new Font("Segoe UI", 9f, FontStyle.Bold),
    };
    btnSave.FlatAppearance.BorderSize = 0;
    btnSave.Click += (_, _) => SaveConfig();

    footer.Controls.AddRange(new Control[] { btnStart, btnStop, _footerStatusLabel, btnSave });
    return footer;
  }

  // ── Control factory helpers ───────────────────────────────────────────────────

  private static Label FieldLabel(string text) => new Label
  {
    Text      = text,
    AutoSize  = true,
    Font      = new Font("Segoe UI", 9f, FontStyle.Bold),
    ForeColor = Color.FromArgb(51, 51, 51),
    Margin    = new Padding(0, 10, 0, 3),
  };

  private static Label HintLabel(string text) => new Label
  {
    Text      = text,
    AutoSize  = false,
    Width     = 640,
    Height    = 18,
    Font      = new Font("Segoe UI", 8f),
    ForeColor = Color.Gray,
    Margin    = new Padding(0, 1, 0, 6),
  };

  private static (Button Button, string ToolTipText) SmallButton(string text)
  {
    var btn = new Button
    {
      Text      = text,
      Width     = 30,
      Height    = 24,
      Margin    = new Padding(4, 0, 0, 0),
      FlatStyle = FlatStyle.System,
    };
    return (btn, string.Empty);
  }

  // Convenience overload used in monitor tab
  private static (Button Button, string ToolTipText) SmallButton(string text, string tip) =>
    (SmallButton(text).Button, tip) switch { var t => t };

  // ── Config I/O ────────────────────────────────────────────────────────────────

  private void LoadConfig()
  {
    var cfg = AppConfig.Load(ConfigPath);

    _watchFolderBox.Text        = cfg.WatchFolder;
    _pollIntervalSpinner.Value  = Math.Clamp(cfg.PollIntervalSeconds, 1, 3600);
    _fileFormatCombo.SelectedIndex = cfg.FileFormat == "TIF" ? 1 : 0;
    _processedSubfolderBox.Text = cfg.ProcessedSubfolder;

    _senderAddressBox.Text    = cfg.Email.SenderAddress;
    _senderPasswordBox.Text   = cfg.Email.SenderPassword;
    _recipientAddressBox.Text = cfg.Email.RecipientAddress;
    _subjectLineBox.Text      = cfg.Email.SubjectLine;
    _smtpHostBox.Text         = cfg.Email.SmtpHost;
    _smtpPortSpinner.Value    = Math.Clamp(cfg.Email.SmtpPort, 1, 65535);
  }

  private void SaveConfig()
  {
    var cfg = new AppConfig
    {
      WatchFolder         = _watchFolderBox.Text.Trim(),
      PollIntervalSeconds = (int)_pollIntervalSpinner.Value,
      FileFormat          = _fileFormatCombo.SelectedIndex == 1 ? "TIF" : "PDF",
      ProcessedSubfolder  = _processedSubfolderBox.Text.Trim().TrimEnd('\\').TrimEnd('/'),
      Email = new EmailConfig
      {
        SenderAddress    = _senderAddressBox.Text.Trim(),
        SenderPassword   = _senderPasswordBox.Text,
        RecipientAddress = _recipientAddressBox.Text.Trim(),
        SubjectLine      = _subjectLineBox.Text.Trim(),
        SmtpHost         = _smtpHostBox.Text.Trim(),
        SmtpPort         = (int)_smtpPortSpinner.Value,
      },
    };

    try
    {
      cfg.Save(ConfigPath);
      SetFooterStatus("✓  Settings saved.", isError: false);
    }
    catch (Exception ex)
    {
      SetFooterStatus($"⚠  Failed to save: {ex.Message}", isError: true);
    }
  }

  // ── Order log ─────────────────────────────────────────────────────────────────

  private void LoadLog()
  {
    _logGrid.Rows.Clear();

    List<OrderLogEntry> entries;
    try { entries = OrderLogEntry.LoadAll(LogPath); }
    catch { entries = new List<OrderLogEntry>(); }

    _logCountLabel.Text = $"{entries.Count} record{(entries.Count != 1 ? "s" : "")}";

    for (var i = entries.Count - 1; i >= 0; i--)
    {
      var e   = entries[i];
      var ts  = DateTimeOffset.TryParse(e.Timestamp, out var dto)
        ? dto.LocalDateTime.ToString("g")
        : e.Timestamp;
      var note = e.Error is { Length: > 60 } err ? err[..60] + "…" : e.Error ?? string.Empty;

      var rowIndex = _logGrid.Rows.Add(
        ts, e.FileName, e.OrderNumber ?? string.Empty,
        e.CustomerName ?? string.Empty, e.DeliveryDate ?? string.Empty,
        e.EmailSent ? "✓ Sent" : "✗ Not sent",
        note);

      var emailCell = _logGrid.Rows[rowIndex].Cells["Email"];
      emailCell.Style.ForeColor = e.EmailSent ? Color.ForestGreen : Color.Firebrick;
      emailCell.Style.Font      = new Font("Segoe UI", 8.5f, FontStyle.Bold);
    }
  }

  // ── Service control ───────────────────────────────────────────────────────────

  private string RefreshServiceStatus()
  {
    var status = QueryServiceState();
    SetServiceBadgeStatus(status);
    return status;
  }

  private void SetServiceBadgeStatus(string status)
  {
    _serviceBadge.Text = $"Service: {status}";
    _serviceBadge.BackColor = status switch
    {
      "running"       => Color.FromArgb(46, 204, 113),
      "stopped"       => Color.FromArgb(231, 76, 60),
      "not installed" => Color.FromArgb(231, 76, 60),
      _               => Color.FromArgb(149, 165, 166),
    };
    // Re-trigger header layout so badge repositions
    _serviceBadge.Parent?.PerformLayout();
  }

  private static string QueryServiceState()
  {
    try
    {
      using var proc = Process.Start(new ProcessStartInfo("sc.exe", $"query \"{ServiceName}\"")
      {
        RedirectStandardOutput = true,
        UseShellExecute        = false,
        CreateNoWindow         = true,
      })!;
      var output = proc.StandardOutput.ReadToEnd();
      proc.WaitForExit();

      if (proc.ExitCode == 1060)                                         return "not installed";
      if (output.Contains("RUNNING", StringComparison.OrdinalIgnoreCase)) return "running";
      if (output.Contains("STOPPED", StringComparison.OrdinalIgnoreCase)) return "stopped";
      return "unknown";
    }
    catch
    {
      return "unknown";
    }
  }

  private void RunServiceCommand(string command)
  {
    var refreshed = false;

    try
    {
      var result = RunScServiceCommand(command, elevated: !IsElevated());
      var expectedStatus = command.Equals("start", StringComparison.OrdinalIgnoreCase)
        ? "running"
        : "stopped";

      var status = WaitForServiceState(expectedStatus, TimeSpan.FromSeconds(8));
      SetServiceBadgeStatus(status);
      refreshed = true;

      if (!IsExpectedServiceCommandExit(command, result.ExitCode))
      {
        var details = string.IsNullOrWhiteSpace(result.Output)
          ? $"sc.exe exited with code {result.ExitCode}."
          : result.Output.Trim();

        SetFooterStatus($"Service {command} failed.", isError: true);
        MessageBox.Show(
          $"Could not {command} the service.\n\n{details}",
          "Service command failed",
          MessageBoxButtons.OK,
          MessageBoxIcon.Error);
      }
      else if (!status.Equals(expectedStatus, StringComparison.OrdinalIgnoreCase))
      {
        SetFooterStatus($"Service is still {status}.", isError: true);
        MessageBox.Show(
          $"Windows accepted the {command} request, but the service is now {status}.",
          "Service did not reach expected state",
          MessageBoxButtons.OK,
          MessageBoxIcon.Warning);
      }
      else
      {
        SetFooterStatus($"Service {ServiceCommandPastTense(command)}.", isError: false);
      }
    }
    catch (Win32Exception ex) when (ex.NativeErrorCode == 1223)
    {
      SetFooterStatus("Service command canceled.", isError: true);
    }
    catch (Exception ex)
    {
      MessageBox.Show($"Service command failed:\n{ex.Message}", "Error",
        MessageBoxButtons.OK, MessageBoxIcon.Error);
    }
    finally
    {
      // Brief wait for Windows to settle before querying state
      if (!refreshed)
      {
        System.Threading.Thread.Sleep(800);
        RefreshServiceStatus();
      }
    }
  }

  private static string WaitForServiceState(string expectedStatus, TimeSpan timeout)
  {
    var deadline = DateTimeOffset.UtcNow.Add(timeout);
    var status = QueryServiceState();

    while (!status.Equals(expectedStatus, StringComparison.OrdinalIgnoreCase) &&
           DateTimeOffset.UtcNow < deadline)
    {
      System.Threading.Thread.Sleep(300);
      status = QueryServiceState();
    }

    return status;
  }

  private static ServiceCommandResult RunScServiceCommand(string command, bool elevated)
  {
    var outputPath = Path.Combine(Path.GetTempPath(), "ftd-fax-parser-service-command.log");
    try { if (File.Exists(outputPath)) File.Delete(outputPath); } catch { /* non-fatal */ }

    var psi = new ProcessStartInfo("cmd.exe",
      $"/c sc.exe {command} \"{ServiceName}\" > \"{outputPath}\" 2>&1")
    {
      UseShellExecute = elevated,
      CreateNoWindow = !elevated,
      WindowStyle = ProcessWindowStyle.Hidden,
    };

    if (elevated)
      psi.Verb = "runas";

    using var proc = Process.Start(psi)
      ?? throw new InvalidOperationException("Could not launch sc.exe.");

    if (!proc.WaitForExit(30_000))
    {
      try { proc.Kill(entireProcessTree: true); } catch { /* non-fatal */ }
      return new ServiceCommandResult(-1, "Timed out waiting for sc.exe.");
    }

    var output = string.Empty;
    try { if (File.Exists(outputPath)) output = File.ReadAllText(outputPath); } catch { /* non-fatal */ }
    return new ServiceCommandResult(proc.ExitCode, output);
  }

  private static bool IsExpectedServiceCommandExit(string command, int exitCode) =>
    exitCode == 0 ||
    (command.Equals("start", StringComparison.OrdinalIgnoreCase) && exitCode == 1056) ||
    (command.Equals("stop", StringComparison.OrdinalIgnoreCase) && exitCode == 1062);

  private static string ServiceCommandPastTense(string command) =>
    command.Equals("start", StringComparison.OrdinalIgnoreCase) ? "started" : "stopped";

  private static bool IsElevated()
  {
    using var identity = WindowsIdentity.GetCurrent();
    return new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator);
  }

  private sealed record ServiceCommandResult(int ExitCode, string Output);

  // ── Footer status message ─────────────────────────────────────────────────────

  private void SetFooterStatus(string message, bool isError)
  {
    _footerStatusLabel.ForeColor = isError ? Color.Firebrick : Color.FromArgb(39, 174, 96);
    _footerStatusLabel.Text      = message;

    _statusClearTimer?.Stop();
    _statusClearTimer = new System.Windows.Forms.Timer { Interval = 4000 };
    _statusClearTimer.Tick += (_, _) =>
    {
      _footerStatusLabel.Text = string.Empty;
      _statusClearTimer.Stop();
    };
    _statusClearTimer.Start();
  }
}
