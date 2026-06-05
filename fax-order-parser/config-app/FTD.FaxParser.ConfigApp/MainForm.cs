using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.ComponentModel;
using System.Security.Principal;
using System.Windows.Forms;

namespace FTD.FaxParser.ConfigApp;

internal sealed class MainForm : Form
{
  // ── Constants ────────────────────────────────────────────────────────────────

  private static readonly Color  AccentColor   = Color.FromArgb(26, 58, 92);
  private static readonly Color  BgColor       = Color.FromArgb(240, 242, 245);
  private const string           ServiceName   = "FTD Fax Order Parser";
  private static readonly string InstalledAppRoot = @"C:\FTDTools\FaxOrderParser";
  private static readonly string? DevProjectRoot = FindDevProjectRoot();
  private const string           LocalRelayHost = "127.0.0.1";
  private const string           LocalRelaySenderAddress = "faxparser@localhost.local";
  private const string           LocalRelayRecipientAddress = "order@localhost.local";

  private static string AppRoot => Environment.GetEnvironmentVariable("FAX_PARSER_APP_ROOT")
    ?? DevProjectRoot
    ?? InstalledAppRoot;

  private static string NodeExePath => ResolveNodeExePath();
  private static string ServiceScript => Environment.GetEnvironmentVariable("FAX_PARSER_SERVICE_SCRIPT")
    ?? (DevProjectRoot is not null
      ? Path.Combine(DevProjectRoot, "dist", "service.js")
      : Path.Combine(AppRoot, "service", "service.js"));

  private static string ConfigPath => Path.Combine(
    Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
    "FTD", "FaxOrderParser", "config.json");

  private static string LogPath => Path.Combine(
    Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
    "FTD", "FaxOrderParser", "orders-log.json");

  private static readonly string ServiceLogDir = Path.Combine(
    Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
    "FTD", "FaxOrderParser", "logs");
  private static string OutLogPath => Path.Combine(ServiceLogDir, "fax-parser.out.log");
  private static string ErrLogPath => Path.Combine(ServiceLogDir, "fax-parser.err.log");

  private static string? FindDevProjectRoot()
  {
    var dir = new DirectoryInfo(AppContext.BaseDirectory);
    while (dir is not null)
    {
      if (File.Exists(Path.Combine(dir.FullName, "package.json")) &&
          File.Exists(Path.Combine(dir.FullName, "src", "service.ts")) &&
          Directory.Exists(Path.Combine(dir.FullName, "config-app")))
        return dir.FullName;

      dir = dir.Parent;
    }

    return null;
  }

  private static string ResolveNodeExePath()
  {
    var configured = Environment.GetEnvironmentVariable("FAX_PARSER_NODE_EXE");
    if (!string.IsNullOrWhiteSpace(configured) && File.Exists(configured))
      return configured;

    var bundled = Path.Combine(AppRoot, "runtime", "node.exe");
    if (File.Exists(bundled)) return bundled;

    var pathEnv = Environment.GetEnvironmentVariable("PATH") ?? string.Empty;
    foreach (var dir in pathEnv.Split(Path.PathSeparator))
    {
      if (string.IsNullOrWhiteSpace(dir)) continue;
      try
      {
        var candidate = Path.Combine(dir.Trim('"'), "node.exe");
        if (File.Exists(candidate)) return candidate;
      }
      catch { /* ignore malformed PATH entry */ }
    }

    return bundled;
  }

  // ── Monitor tab controls ──────────────────────────────────────────────────────

  private TextBox        _watchFolderBox       = null!;
  private NumericUpDown  _pollIntervalSpinner  = null!;
  private ComboBox       _fileFormatCombo      = null!;
  private TextBox        _processedSubfolderBox = null!;
  private CheckBox       _usePlacedDateFallbackCheck = null!;

  // ── Local relay controls ──────────────────────────────────────────────────────

  private CheckBox       _relayEnabledCheck    = null!;
  private NumericUpDown  _relaySmtpPortSpinner = null!;
  private NumericUpDown  _relayPop3PortSpinner = null!;

  // ── Email tab controls ────────────────────────────────────────────────────────

  private TextBox        _senderAddressBox     = null!;
  private TextBox        _senderPasswordBox    = null!;
  private TextBox        _smtpUsernameBox      = null!;
  private TextBox        _recipientAddressBox  = null!;
  private TextBox        _subjectLineBox       = null!;
  private TextBox        _smtpHostBox          = null!;
  private NumericUpDown  _smtpPortSpinner      = null!;

  // ── Log tab controls ──────────────────────────────────────────────────────────

  private DataGridView   _logGrid              = null!;
  private Label          _logCountLabel        = null!;
  private ListBox        _pendingFilesList     = null!;
  private Label          _pendingCountLabel    = null!;
  private Panel          _tabContentHost       = null!;
  private Button         _monitorTabButton     = null!;
  private Button         _emailTabButton       = null!;
  private Button         _logTabButton         = null!;
  private Control        _monitorTabPage       = null!;
  private Control        _emailTabPage         = null!;
  private Control        _logTabPage           = null!;

  // ── Email tab — encryption controls ──────────────────────────────────────────

  private TextBox        _encryptionPasswordBox = null!;
  private ComboBox       _encryptionAlgorithmCombo = null!;

  // ── Pending files / Process Selected ─────────────────────────────────────────

  private Button         _processSelectedBtn   = null!;
  private readonly ToolTip _toolTip            = new ToolTip();
  private readonly HashSet<string> _heldFiles  = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

  private static readonly string[] RequiredWoiMappingFields =
  [
    "Bill Name", "Recipient Name", "Product Code 1",
  ];

  private static readonly string[] OcrSourceOptions =
  [
    "(none)", "Customer Name", "For the Passing Of", "Delivery Location",
    "Card Message", "Order Number", "Customer Phone", "Customer Address",
    "Product Item Number", "Product Description", "Product Price",
    "Delivery Charge", "Delivery Date", "Delivery Time", "Total Payable", "Vendor Name",
  ];

  private static readonly HashSet<string> RemappableWoiFields =
  [
    "Bill Name", "Recipient Name", "Card Message",
    "Product Code 1", "Delivery Instructions", "Additional Information",
  ];

  // ── Status ───────────────────────────────────────────────────────────────────

  private Label          _serviceBadge         = null!;
  private Label          _footerStatusLabel    = null!;
  private System.Windows.Forms.Timer? _statusClearTimer;
  private bool           _loadingConfig;

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
      UpdateProcessSelectedState();
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
    var root = new TableLayoutPanel
    {
      Dock        = DockStyle.Fill,
      ColumnCount = 1,
      RowCount    = 4,
      Margin      = Padding.Empty,
      Padding     = Padding.Empty,
    };
    root.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100f));
    root.RowStyles.Add(new RowStyle(SizeType.Absolute, 44f));
    root.RowStyles.Add(new RowStyle(SizeType.Absolute, 36f));
    root.RowStyles.Add(new RowStyle(SizeType.Percent, 100f));
    root.RowStyles.Add(new RowStyle(SizeType.Absolute, 48f));

    _tabContentHost = new Panel
    {
      Dock      = DockStyle.Fill,
      BackColor = BgColor,
      Margin    = Padding.Empty,
    };

    _monitorTabPage = BuildMonitorTab();
    _emailTabPage   = BuildEmailTab();
    _logTabPage     = BuildLogTab();

    root.Controls.Add(PrepareLayoutPanel(BuildHeader()), 0, 0);
    root.Controls.Add(PrepareLayoutPanel(BuildTabBar()), 0, 1);
    root.Controls.Add(_tabContentHost, 0, 2);
    root.Controls.Add(PrepareLayoutPanel(BuildFooter()), 0, 3);

    Controls.Add(root);
    SelectTab("monitor");
  }

  private static T PrepareLayoutPanel<T>(T control) where T : Control
  {
    control.Dock = DockStyle.Fill;
    control.Margin = Padding.Empty;
    return control;
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

  // ── Tabs ──────────────────────────────────────────────────────────────────────

  private Panel BuildTabBar()
  {
    var tabBar = new Panel
    {
      Dock      = DockStyle.Fill,
      BackColor = Color.FromArgb(226, 230, 235),
      Margin    = Padding.Empty,
    };
    tabBar.Paint += (_, e) =>
    {
      using var pen = new Pen(Color.FromArgb(198, 204, 212));
      e.Graphics.DrawLine(pen, 0, tabBar.Height - 1, tabBar.Width, tabBar.Height - 1);
    };

    _monitorTabButton = CreateTabButton("Monitor", 0);
    _emailTabButton   = CreateTabButton("Email", 120);
    _logTabButton     = CreateTabButton("Order Log", 240);

    _monitorTabButton.Click += (_, _) => SelectTab("monitor");
    _emailTabButton.Click   += (_, _) => SelectTab("email");
    _logTabButton.Click     += (_, _) => SelectTab("log");

    tabBar.Controls.AddRange(new Control[] { _monitorTabButton, _emailTabButton, _logTabButton });
    return tabBar;
  }

  private Button CreateTabButton(string text, int left) => new Button
  {
    Text      = text,
    Width     = 120,
    Height    = 35,
    Location  = new Point(left, 1),
    FlatStyle = FlatStyle.Flat,
    BackColor = Color.FromArgb(226, 230, 235),
    ForeColor = Color.FromArgb(51, 51, 51),
    Font      = new Font("Segoe UI", 9f, FontStyle.Regular),
    TabStop   = false,
  };

  private void SelectTab(string key)
  {
    _tabContentHost.SuspendLayout();
    _tabContentHost.Controls.Clear();

    var selectedPage = key switch
    {
      "email" => _emailTabPage,
      "log"   => _logTabPage,
      _       => _monitorTabPage,
    };
    selectedPage.Dock = DockStyle.Fill;
    _tabContentHost.Controls.Add(selectedPage);
    _tabContentHost.ResumeLayout();

    SetTabButtonState(_monitorTabButton, key == "monitor");
    SetTabButtonState(_emailTabButton,   key == "email");
    SetTabButtonState(_logTabButton,     key == "log");

    if (key == "log") { LoadLog(); ScanPendingFiles(); }
  }

  private void SetTabButtonState(Button button, bool selected)
  {
    button.BackColor = selected ? Color.White : Color.FromArgb(226, 230, 235);
    button.ForeColor = selected ? AccentColor : Color.FromArgb(51, 51, 51);
    button.Font = new Font("Segoe UI", 9f, selected ? FontStyle.Bold : FontStyle.Regular);
    button.FlatAppearance.BorderSize = selected ? 1 : 0;
    button.FlatAppearance.BorderColor = selected ? Color.FromArgb(198, 204, 212) : Color.FromArgb(226, 230, 235);
  }

  // ── Monitor tab ───────────────────────────────────────────────────────────────

  private Panel BuildMonitorTab()
  {
    var page = new Panel { BackColor = BgColor };

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
    _fileFormatCombo.Items.AddRange(new object[] { "PDF", "JPG / TIFF" });
    _fileFormatCombo.SelectedIndex = 0;
    panel.Controls.Add(FieldLabel("Incoming File Format"));
    panel.Controls.Add(_fileFormatCombo);

    // Processed subfolder
    _processedSubfolderBox = new TextBox { Width = 250, Text = "processed" };
    panel.Controls.Add(FieldLabel("Processed Subfolder Name"));
    panel.Controls.Add(_processedSubfolderBox);
    panel.Controls.Add(HintLabel("Processed files are moved here (relative to the watch folder)."));

    _usePlacedDateFallbackCheck = new CheckBox
    {
      Text     = "Use order placed date when delivery date is missing",
      AutoSize = true,
      Checked  = true,
      Margin   = new Padding(0, 10, 0, 0),
      Font     = new Font("Segoe UI", 9f, FontStyle.Bold),
    };
    panel.Controls.Add(_usePlacedDateFallbackCheck);
    panel.Controls.Add(HintLabel("If a CFS fax has no delivery date line, the parser uses the Placed date instead of holding the order."));

    // Local relay group
    var relayGroup = new GroupBox
    {
      Text   = "Built-in Local Mail Relay  (replaces hMailServer)",
      Width  = 600,
      Height = 130,
      Margin = new Padding(0, 14, 0, 0),
    };

    _relayEnabledCheck = new CheckBox
    {
      Text     = "Enable built-in SMTP / POP3 relay",
      AutoSize = true,
      Location = new Point(10, 22),
      Font     = new Font("Segoe UI", 9f, FontStyle.Bold),
    };

    _relaySmtpPortSpinner = new NumericUpDown
    {
      Minimum  = 1, Maximum = 65535, Value = 2525,
      Width    = 75, Location = new Point(160, 50),
    };
    _relayPop3PortSpinner = new NumericUpDown
    {
      Minimum  = 1, Maximum = 65535, Value = 1110,
      Width    = 75, Location = new Point(310, 50),
    };

    var smtpPortLabel = new Label { Text = "SMTP port:",  AutoSize = true, Location = new Point(10,  54) };
    var pop3PortLabel = new Label { Text = "POP3 port:",  AutoSize = true, Location = new Point(164, 54) };

    var relayHint = new Label
    {
      Text      = "When enabled: set email SMTP host → 127.0.0.1 and port → SMTP port above.\r\n" +
                  "In Mercury Administration → WOI: set POP3 host → 127.0.0.1 and port → POP3 port above.",
      AutoSize  = false,
      Width     = 570,
      Height    = 34,
      Location  = new Point(10, 88),
      Font      = new Font("Segoe UI", 7.5f),
      ForeColor = Color.Gray,
    };

    relayGroup.Controls.AddRange(new Control[]
    {
      _relayEnabledCheck,
      smtpPortLabel, _relaySmtpPortSpinner,
      pop3PortLabel, _relayPop3PortSpinner,
      relayHint,
    });

    _relayEnabledCheck.CheckedChanged += (_, _) =>
    {
      var on = _relayEnabledCheck.Checked;
      _relaySmtpPortSpinner.Enabled = on;
      _relayPop3PortSpinner.Enabled = on;
      if (on && !_loadingConfig) ApplyLocalRelayEmailDefaults();
    };
    _relaySmtpPortSpinner.ValueChanged += (_, _) =>
    {
      if (_relayEnabledCheck.Checked && !_loadingConfig)
        _smtpPortSpinner.Value = _relaySmtpPortSpinner.Value;
    };

    panel.Controls.Add(relayGroup);

    page.Controls.Add(panel);
    return page;
  }

  // ── Email tab ─────────────────────────────────────────────────────────────────

  private Panel BuildEmailTab()
  {
    var page = new Panel { BackColor = BgColor };

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
    _smtpUsernameBox     = new TextBox { Width = 420 };
    _recipientAddressBox = new TextBox { Width = 420 };
    _subjectLineBox      = new TextBox { Width = 360 };

    panel.Controls.Add(FieldLabel("Sender Email Address (From)"));
    panel.Controls.Add(_senderAddressBox);

    panel.Controls.Add(FieldLabel("SMTP Username (if different from sender)"));
    panel.Controls.Add(_smtpUsernameBox);
    panel.Controls.Add(HintLabel("For Brevo: use the login shown on the SMTP & API page (e.g. ac294d001@smtp-brevo.com). Leave blank to use Sender Address."));

    panel.Controls.Add(FieldLabel("Sender Password / App Password"));
    panel.Controls.Add(_senderPasswordBox);
    panel.Controls.Add(HintLabel("For Gmail: Google Account → Security → App passwords (requires 2-Step Verification)."));

    panel.Controls.Add(FieldLabel("Recipient Email Address (WOI inbox)"));
    panel.Controls.Add(_recipientAddressBox);

    panel.Controls.Add(FieldLabel("Email Subject Line"));
    panel.Controls.Add(_subjectLineBox);
    panel.Controls.Add(HintLabel("Must match the subject line configured in Mercury Administration → Web Order Interface."));

    // WOI body encryption group
    var encryptGroup = new GroupBox
    {
      Text   = "WOI Body Encryption",
      Width  = 560,
      Height = 116,
      Margin = new Padding(0, 10, 0, 0),
    };

    _encryptionPasswordBox = new TextBox { Width = 280, UseSystemPasswordChar = true, Location = new Point(160, 24) };
    _encryptionAlgorithmCombo = new ComboBox
    {
      DropDownStyle = ComboBoxStyle.DropDownList,
      Width         = 200,
      Location      = new Point(160, 60),
    };
    _encryptionAlgorithmCombo.Items.AddRange(new object[] { "None", "TripleDES", "DES", "RC2", "Rijndael" });
    _encryptionAlgorithmCombo.SelectedIndex = 0;

    encryptGroup.Controls.AddRange(new Control[]
    {
      new Label { Text = "Encryption Password:", AutoSize = true, Location = new Point(10, 27) },
      _encryptionPasswordBox,
      new Label { Text = "Encryption Algorithm:", AutoSize = true, Location = new Point(10, 63) },
      _encryptionAlgorithmCombo,
      new Label
      {
        Text      = "Leave password blank to send plain text. Cipher: CBC / PKCS7.",
        AutoSize  = true,
        Location  = new Point(10, 92),
        Font      = new Font("Segoe UI", 7.5f),
        ForeColor = Color.Gray,
      },
    });

    panel.Controls.Add(encryptGroup);

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
      Minimum  = 1, Maximum = 65535, Value = 2525,
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

  private Panel BuildLogTab()
  {
    var page = new Panel { BackColor = Color.White };

    // ── Pending files panel (docked Top) ──────────────────────────────────────
    var pendingPanel = new Panel { Dock = DockStyle.Top, Height = 158, BackColor = Color.White };

    var pendingHeader = new Panel { Dock = DockStyle.Top, Height = 30, BackColor = Color.FromArgb(240, 242, 245) };

    var pendingTitle = new Label
    {
      Text      = "Pending Files",
      Font      = new Font("Segoe UI", 8.5f, FontStyle.Bold),
      ForeColor = AccentColor,
      AutoSize  = true,
      Location  = new Point(10, 8),
    };

    _pendingCountLabel = new Label
    {
      Text      = string.Empty,
      AutoSize  = true,
      ForeColor = Color.Gray,
      Font      = new Font("Segoe UI", 8f),
      Location  = new Point(120, 10),
    };

    _processSelectedBtn = new Button
    {
      Text      = "▶  Process Selected",
      Width     = 134,
      Height    = 22,
      Anchor    = AnchorStyles.Top | AnchorStyles.Right,
      FlatStyle = FlatStyle.System,
    };
    pendingHeader.Layout += (_, _) =>
      _processSelectedBtn.Location = new Point(pendingHeader.ClientSize.Width - _processSelectedBtn.Width - 4, 4);
    _processSelectedBtn.Click += async (_, _) => { _processSelectedBtn.Enabled = false; try { await ProcessSelectedFilesAsync(); } finally { _processSelectedBtn.Enabled = true; } };

    var previewBtn = new Button
    {
      Text      = "Preview Fields",
      Width     = 104,
      Height    = 22,
      Anchor    = AnchorStyles.Top | AnchorStyles.Right,
      FlatStyle = FlatStyle.System,
    };
    pendingHeader.Layout += (_, _) =>
      previewBtn.Location = new Point(pendingHeader.ClientSize.Width - _processSelectedBtn.Width - previewBtn.Width - 14, 4);
    previewBtn.Click += async (_, _) => { previewBtn.Enabled = false; try { await PreviewFileFieldsAsync(); } finally { previewBtn.Enabled = true; } };

    var scanBtn = new Button
    {
      Text      = "↺  Scan",
      Width     = 72,
      Height    = 22,
      Anchor    = AnchorStyles.Top | AnchorStyles.Right,
      FlatStyle = FlatStyle.System,
    };
    pendingHeader.Layout += (_, _) =>
      scanBtn.Location = new Point(pendingHeader.ClientSize.Width - _processSelectedBtn.Width - previewBtn.Width - scanBtn.Width - 20, 4);
    scanBtn.Click += (_, _) => ScanPendingFiles();

    pendingHeader.Controls.AddRange(new Control[] { pendingTitle, _pendingCountLabel, scanBtn, previewBtn, _processSelectedBtn });

    _pendingFilesList = new ListBox
    {
      Dock          = DockStyle.Fill,
      SelectionMode = SelectionMode.MultiExtended,
      DrawMode      = DrawMode.OwnerDrawFixed,
      ItemHeight    = 20,
      Font          = new Font("Segoe UI", 8.5f),
      BorderStyle   = BorderStyle.None,
      BackColor     = Color.White,
    };

    _pendingFilesList.DrawItem += (_, e) =>
    {
      if (e.Index < 0) return;
      var itemPath = (string)_pendingFilesList.Items[e.Index];
      var isHeld   = _heldFiles.Contains(itemPath);
      var selected = (e.State & DrawItemState.Selected) != 0;

      var bg = isHeld   ? Color.FromArgb(255, 243, 205)
             : selected ? SystemColors.Highlight
             : (e.Index % 2 == 0 ? Color.White : Color.FromArgb(248, 249, 250));
      var fg = isHeld   ? Color.FromArgb(160, 80, 0)
             : selected ? SystemColors.HighlightText
             : Color.FromArgb(30, 30, 30);

      using var bgBrush = new SolidBrush(bg);
      e.Graphics.FillRectangle(bgBrush, e.Bounds);

      var display = isHeld
        ? $"⚠ HOLD: {Path.GetFileName(itemPath)}"
        : Path.GetFileName(itemPath);
      var font = isHeld ? new Font(e.Font!, FontStyle.Bold) : e.Font!;
      TextRenderer.DrawText(e.Graphics, display, font, e.Bounds, fg,
        TextFormatFlags.Left | TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis);
    };

    pendingPanel.Controls.AddRange(new Control[] { _pendingFilesList, pendingHeader });

    // ── Separator ─────────────────────────────────────────────────────────────
    var separator = new Panel { Dock = DockStyle.Top, Height = 1, BackColor = Color.FromArgb(208, 213, 219) };

    // ── Log toolbar ───────────────────────────────────────────────────────────
    var toolbar = new Panel { Dock = DockStyle.Top, Height = 36, BackColor = BgColor };
    var refreshBtn = new Button
    {
      Text      = "↺  Refresh Log",
      Width     = 104,
      Height    = 26,
      Location  = new Point(10, 5),
      FlatStyle = FlatStyle.System,
    };
    refreshBtn.Click += (_, _) => LoadLog();

    _logCountLabel = new Label
    {
      AutoSize  = true,
      Location  = new Point(126, 10),
      ForeColor = Color.Gray,
      Font      = new Font("Segoe UI", 8.5f),
    };
    toolbar.Controls.AddRange(new Control[] { refreshBtn, _logCountLabel });

    // ── Log grid ──────────────────────────────────────────────────────────────
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

    _logGrid.ColumnHeadersDefaultCellStyle.BackColor   = AccentColor;
    _logGrid.ColumnHeadersDefaultCellStyle.ForeColor   = Color.White;
    _logGrid.ColumnHeadersDefaultCellStyle.Font        = new Font("Segoe UI", 8.5f, FontStyle.Bold);
    _logGrid.ColumnHeadersDefaultCellStyle.Padding     = new Padding(4, 0, 0, 0);
    _logGrid.EnableHeadersVisualStyles                 = false;
    _logGrid.ColumnHeadersHeight                       = 28;
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

    _logGrid.CellDoubleClick += (_, e) =>
    {
      if (e.RowIndex < 0 || e.RowIndex >= _logGrid.Rows.Count) return;
      if (_logGrid.Rows[e.RowIndex].Tag is OrderLogEntry entry)
        ShowOrderDetailDialog(entry);
    };

    // AddRange z-order: items dock in reverse — grid fills, toolbar docks top, separator docks top, pendingPanel docks top
    page.Controls.AddRange(new Control[] { _logGrid, toolbar, separator, pendingPanel });
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

    _loadingConfig = true;
    try
    {
      _watchFolderBox.Text        = cfg.WatchFolder;
      _pollIntervalSpinner.Value  = Math.Clamp(cfg.PollIntervalSeconds, 1, 3600);
      _fileFormatCombo.SelectedIndex = cfg.FileFormat == "TIF" ? 1 : 0;
      _processedSubfolderBox.Text = cfg.ProcessedSubfolder;
      _usePlacedDateFallbackCheck.Checked = cfg.Processing.UseOrderPlacedDateWhenDeliveryDateMissing;

      _senderAddressBox.Text    = cfg.Email.SenderAddress;
      _senderPasswordBox.Text   = cfg.Email.SenderPassword;
      _smtpUsernameBox.Text     = cfg.Email.SmtpUsername;
      _recipientAddressBox.Text = cfg.Email.RecipientAddress;
      _subjectLineBox.Text      = cfg.Email.SubjectLine;
      _smtpHostBox.Text         = cfg.Email.SmtpHost;
      _smtpPortSpinner.Value    = Math.Clamp(cfg.Email.SmtpPort, 1, 65535);

      _encryptionPasswordBox.Text = cfg.Email.EncryptionPassword;
      var algoIndex = _encryptionAlgorithmCombo.Items.IndexOf(cfg.Email.EncryptionAlgorithm);
      _encryptionAlgorithmCombo.SelectedIndex = algoIndex >= 0 ? algoIndex : 0;

      _relaySmtpPortSpinner.Value   = Math.Clamp(cfg.LocalRelay.SmtpPort, 1, 65535);
      _relayPop3PortSpinner.Value   = Math.Clamp(cfg.LocalRelay.Pop3Port,  1, 65535);
      _relayEnabledCheck.Checked    = cfg.LocalRelay.Enabled;
      _relaySmtpPortSpinner.Enabled = cfg.LocalRelay.Enabled;
      _relayPop3PortSpinner.Enabled = cfg.LocalRelay.Enabled;
    }
    finally
    {
      _loadingConfig = false;
    }

    if (_relayEnabledCheck.Checked) ApplyLocalRelayEmailDefaults();
  }

  private void ApplyLocalRelayEmailDefaults()
  {
    _senderAddressBox.Text = LocalRelaySenderAddress;
    _senderPasswordBox.Clear();
    _smtpUsernameBox.Clear();
    _recipientAddressBox.Text = LocalRelayRecipientAddress;
    _smtpHostBox.Text = LocalRelayHost;
    _smtpPortSpinner.Value = _relaySmtpPortSpinner.Value;
    _encryptionPasswordBox.Clear();

    var noneIndex = _encryptionAlgorithmCombo.Items.IndexOf("None");
    if (noneIndex >= 0) _encryptionAlgorithmCombo.SelectedIndex = noneIndex;
  }

  private void SaveConfig()
  {
    if (_relayEnabledCheck.Checked) ApplyLocalRelayEmailDefaults();

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
        SmtpUsername     = _smtpUsernameBox.Text.Trim(),
        RecipientAddress = _recipientAddressBox.Text.Trim(),
        SubjectLine      = _subjectLineBox.Text.Trim(),
        SmtpHost         = _smtpHostBox.Text.Trim(),
        SmtpPort         = (int)_smtpPortSpinner.Value,
        EncryptionPassword  = _encryptionPasswordBox.Text,
        EncryptionAlgorithm = _encryptionAlgorithmCombo.SelectedItem?.ToString() ?? "None",
      },
      LocalRelay = new LocalRelayConfig
      {
        Enabled  = _relayEnabledCheck.Checked,
        SmtpPort = (int)_relaySmtpPortSpinner.Value,
        Pop3Port = (int)_relayPop3PortSpinner.Value,
      },
      Processing = new ProcessingConfig
      {
        UseOrderPlacedDateWhenDeliveryDateMissing = _usePlacedDateFallbackCheck.Checked,
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

      if (string.IsNullOrEmpty(note) && !string.IsNullOrEmpty(e.Note))
        note = e.Note.Length > 60 ? e.Note[..60] + "..." : e.Note;

      var rowIndex = _logGrid.Rows.Add(
        ts, e.FileName, e.OrderNumber ?? string.Empty,
        e.CustomerName ?? string.Empty, e.DeliveryDate ?? string.Empty,
        e.EmailSent ? "✓ Sent" : "✗ Not sent",
        note);

      var emailCell = _logGrid.Rows[rowIndex].Cells["Email"];
      emailCell.Style.ForeColor = e.EmailSent ? Color.ForestGreen : Color.Firebrick;
      emailCell.Style.Font      = new Font("Segoe UI", 8.5f, FontStyle.Bold);
      _logGrid.Rows[rowIndex].Tag = e;
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

  // ── Pending files management ──────────────────────────────────────────────────

  private void ScanPendingFiles()
  {
    _pendingFilesList.Items.Clear();

    var cfg       = AppConfig.Load(ConfigPath);
    var folder    = cfg.WatchFolder;
    var processed = cfg.ProcessedSubfolder;

    if (!Directory.Exists(folder))
    {
      _pendingCountLabel.Text = "(watch folder not found)";
      return;
    }

    var patterns = cfg.FileFormat == "TIF"
      ? new[] { "*.tif", "*.tiff", "*.jpg", "*.jpeg" }
      : new[] { "*.pdf" };

    var processedPath = Path.Combine(folder, processed) + Path.DirectorySeparatorChar;

    _heldFiles.Clear();

    var files = patterns
      .SelectMany(p => Directory.GetFiles(folder, p, SearchOption.TopDirectoryOnly))
      .Where(f => !f.StartsWith(processedPath, StringComparison.OrdinalIgnoreCase))
      .OrderBy(f => f)
      .ToList();

    foreach (var f in files)
    {
      if (File.Exists(f + ".hold.json")) _heldFiles.Add(f);
      _pendingFilesList.Items.Add(f);
    }

    var heldCount    = _heldFiles.Count;
    var pendingCount = files.Count - heldCount;
    _pendingCountLabel.Text = files.Count == 0
      ? "(none)"
      : heldCount > 0
        ? $"{pendingCount} waiting, {heldCount} held (review required)"
        : $"{files.Count} file{(files.Count != 1 ? "s" : "")} waiting";
  }

  // ── Field definitions for visual editor ──────────────────────────────────────

  private static readonly (string Key, string Label, Color Color)[] FieldDefs =
  [
    ("customerName",       "Bill Name",          Color.FromArgb(220, 50,  50)),
    ("customerPhone",      "Bill Phone",         Color.FromArgb(230, 120, 30)),
    ("customerAddress",    "Bill Address",       Color.FromArgb(180, 160, 0)),
    ("orderNumber",        "Order #",            Color.FromArgb(40,  160, 40)),
    ("productItemNumber",  "Product Code",       Color.FromArgb(0,   160, 100)),
    ("productPrice",       "Product Price",      Color.FromArgb(0,   120, 210)),
    ("deliveryCharge",     "Delivery Charge",    Color.FromArgb(80,  80,  210)),
    ("totalPayable",       "Total Amount",       Color.FromArgb(140, 60,  200)),
    ("deliveryDate",       "Delivery Date",      Color.FromArgb(200, 60,  140)),
    ("forThePassingOf",    "For the Passing Of", Color.FromArgb(180, 100, 0)),
    ("cardMessage",        "Card Message",       Color.FromArgb(0,   170, 170)),
    ("productDescription", "Product Desc.",      Color.FromArgb(100, 100, 100)),
  ];

  // ── Image bounds panel ────────────────────────────────────────────────────────

  private sealed class ImageBoundsPanel : Panel
  {
    private Image? _image;
    private int _imgW, _imgH;

    private readonly Dictionary<string, PointF[]>   _boxes  = new();
    private readonly Dictionary<string, Color>      _colors = new();
    private readonly List<string>                   _order  = new();
    private readonly Dictionary<string, string>     _labels = new();

    public string? SelectedField { get; set; }
    public event EventHandler? BoxesChanged;
    public event EventHandler? ZoomChanged;
    public event EventHandler? HistoryChanged;
    public event EventHandler? SelectionChanged;

    public enum Tool { Select, Pan }
    public Tool ActiveTool { get; set; } = Tool.Select;
    public float ZoomLevel  => _zoom;
    public bool  CanUndo    => _undoStack.Count > 0;
    public bool  CanRedo    => _redoStack.Count > 0;

    private enum DragHandle { None, Body, Drawing, N, NE, E, SE, S, SW, W, NW }
    private DragHandle _drag       = DragHandle.None;
    private Point      _dragPt;
    private PointF[]   _dragPoly   = [];
    private RectangleF _dragBounds;

    private float _zoom = 1f;
    private float _panX, _panY;
    private bool  _isPanning;
    private Point _panStart;
    private float _panStartX, _panStartY;

    private readonly Stack<Dictionary<string, PointF[]>> _undoStack = new();
    private readonly Stack<Dictionary<string, PointF[]>> _redoStack = new();

    private const int HR         = 5;   // handle radius in panel pixels
    private const int MaxHistory = 50;

    public ImageBoundsPanel()
    {
      DoubleBuffered = true;
      BackColor      = Color.FromArgb(45, 45, 45);
      TabStop        = true;
      MouseEnter    += (_, _) => { if (!Focused) Focus(); };
    }

    public void LoadImage(string filePath)
    {
      try
      {
        var img = Image.FromFile(filePath);
        // For multi-frame TIFF, select first frame
        if (img.FrameDimensionsList.Length > 0)
        {
          var fd = new System.Drawing.Imaging.FrameDimension(img.FrameDimensionsList[0]);
          img.SelectActiveFrame(fd, 0);
        }
        _image?.Dispose();
        _image = img;
        _imgW  = img.Width;
        _imgH  = img.Height;
        Invalidate();
      }
      catch { /* image format not supported */ }
    }

    public void SetBoxes(Dictionary<string, PointF[]> boxes, Dictionary<string, Color> colors, List<string> order, Dictionary<string, string>? labels = null)
    {
      _boxes.Clear();  foreach (var kv in boxes)  _boxes[kv.Key]  = kv.Value;
      _colors.Clear(); foreach (var kv in colors) _colors[kv.Key] = kv.Value;
      _order.Clear();  _order.AddRange(order);
      _labels.Clear(); if (labels != null) foreach (var kv in labels) _labels[kv.Key] = kv.Value;
      Invalidate();
    }

    public Dictionary<string, PointF[]> GetBoxes() =>
      _boxes.ToDictionary(kv => kv.Key, kv => kv.Value.ToArray());

    // ── Zoom / pan ─────────────────────────────────────────────────────────────

    private void ZoomAt(float factor, Point anchor)
    {
      if (_image == null) return;
      var imgPt = ToImg(anchor);
      _zoom = Math.Clamp(_zoom * factor, 0.05f, 32f);
      float scale = GetBaseScale() * _zoom;
      _panX = anchor.X - (ClientSize.Width  - _imgW * scale) / 2f - imgPt.X * scale;
      _panY = anchor.Y - (ClientSize.Height - _imgH * scale) / 2f - imgPt.Y * scale;
      ZoomChanged?.Invoke(this, EventArgs.Empty);
      Invalidate();
    }

    public void ZoomIn()    => ZoomAt(1.25f, new Point(ClientSize.Width / 2, ClientSize.Height / 2));
    public void ZoomOut()   => ZoomAt(0.80f, new Point(ClientSize.Width / 2, ClientSize.Height / 2));
    public void ResetZoom() { _zoom = 1f; _panX = 0f; _panY = 0f; ZoomChanged?.Invoke(this, EventArgs.Empty); Invalidate(); }

    // ── Undo / redo ────────────────────────────────────────────────────────────

    public bool HasBox(string key) => _boxes.ContainsKey(key);

    public void ClearSelection()
    {
      SelectedField = null;
      SelectionChanged?.Invoke(this, EventArgs.Empty);
      Invalidate();
    }

    private void PushUndoState()
    {
      if (_undoStack.Count >= MaxHistory)
      {
        var arr = _undoStack.ToArray();
        _undoStack.Clear();
        for (int i = arr.Length - 2; i >= 0; i--) _undoStack.Push(arr[i]);
      }
      _undoStack.Push(_boxes.ToDictionary(kv => kv.Key, kv => kv.Value.ToArray()));
      _redoStack.Clear();
      HistoryChanged?.Invoke(this, EventArgs.Empty);
    }

    public void Undo()
    {
      if (_undoStack.Count == 0) return;
      _redoStack.Push(_boxes.ToDictionary(kv => kv.Key, kv => kv.Value.ToArray()));
      var prev = _undoStack.Pop();
      _boxes.Clear(); foreach (var kv in prev) _boxes[kv.Key] = kv.Value;
      HistoryChanged?.Invoke(this, EventArgs.Empty);
      BoxesChanged?.Invoke(this, EventArgs.Empty);
      Invalidate();
    }

    public void Redo()
    {
      if (_redoStack.Count == 0) return;
      _undoStack.Push(_boxes.ToDictionary(kv => kv.Key, kv => kv.Value.ToArray()));
      var next = _redoStack.Pop();
      _boxes.Clear(); foreach (var kv in next) _boxes[kv.Key] = kv.Value;
      HistoryChanged?.Invoke(this, EventArgs.Empty);
      BoxesChanged?.Invoke(this, EventArgs.Empty);
      Invalidate();
    }

    protected override void OnKeyDown(KeyEventArgs e)
    {
      if (e.Control && !e.Shift && e.KeyCode == Keys.Z) { Undo(); e.Handled = true; }
      else if (e.Control && (e.KeyCode == Keys.Y || (e.Shift && e.KeyCode == Keys.Z))) { Redo(); e.Handled = true; }
      base.OnKeyDown(e);
    }

    protected override bool IsInputKey(Keys keyData)
    {
      return (keyData & ~Keys.Modifiers) is Keys.Z or Keys.Y || base.IsInputKey(keyData);
    }

    // ── Coordinate transforms ──────────────────────────────────────────────────

    private float GetBaseScale() =>
      _image == null ? 1f :
      Math.Min((float)ClientSize.Width / _imgW, (float)ClientSize.Height / _imgH);

    private RectangleF DispRect()
    {
      if (_image == null) return RectangleF.Empty;
      float s = GetBaseScale() * _zoom;
      float w = _imgW * s, h = _imgH * s;
      return new RectangleF((ClientSize.Width - w) / 2f + _panX, (ClientSize.Height - h) / 2f + _panY, w, h);
    }

    private PointF[] ToDispPoly(PointF[] pts)
    {
      var d = DispRect(); if (d.IsEmpty) return pts;
      float sx = d.Width / _imgW, sy = d.Height / _imgH;
      var out2 = new PointF[pts.Length];
      for (int i = 0; i < pts.Length; i++)
        out2[i] = new PointF(d.X + pts[i].X * sx, d.Y + pts[i].Y * sy);
      return out2;
    }

    private PointF ToImg(Point p)
    {
      var d = DispRect(); if (d.IsEmpty) return PointF.Empty;
      return new PointF((p.X - d.X) * _imgW / d.Width, (p.Y - d.Y) * _imgH / d.Height);
    }

    private PointF[] MakeImgPoly(PointF a, PointF b)
    {
      float x = Math.Max(0, Math.Min(a.X, b.X));
      float y = Math.Max(0, Math.Min(a.Y, b.Y));
      float w = Math.Max(4, Math.Abs(b.X - a.X));
      float h = Math.Max(4, Math.Abs(b.Y - a.Y));
      w = Math.Min(w, _imgW - x); h = Math.Min(h, _imgH - y);
      return [new(x, y), new(x + w, y), new(x + w, y + h), new(x, y + h)];
    }

    // ── Polygon helpers ────────────────────────────────────────────────────────

    internal static RectangleF PolygonBounds(PointF[] pts)
    {
      if (pts.Length == 0) return RectangleF.Empty;
      float x0 = pts[0].X, y0 = pts[0].Y, x1 = pts[0].X, y1 = pts[0].Y;
      foreach (var p in pts) { x0 = Math.Min(x0, p.X); y0 = Math.Min(y0, p.Y); x1 = Math.Max(x1, p.X); y1 = Math.Max(y1, p.Y); }
      return RectangleF.FromLTRB(x0, y0, x1, y1);
    }

    private static bool PolygonContains(PointF[] poly, PointF pt)
    {
      bool inside = false;
      int n = poly.Length;
      for (int i = 0, j = n - 1; i < n; j = i++)
      {
        var a = poly[i]; var b = poly[j];
        if ((a.Y > pt.Y) != (b.Y > pt.Y) &&
            pt.X < (b.X - a.X) * (pt.Y - a.Y) / (b.Y - a.Y) + a.X)
          inside = !inside;
      }
      return inside;
    }

    private static PointF[] TranslatePoly(PointF[] pts, float dx, float dy)
    {
      var out2 = new PointF[pts.Length];
      for (int i = 0; i < pts.Length; i++) out2[i] = new PointF(pts[i].X + dx, pts[i].Y + dy);
      return out2;
    }

    private static PointF[] ScalePoly(PointF[] pts, RectangleF from, RectangleF to)
    {
      if (from.Width < 1 || from.Height < 1) return (PointF[])pts.Clone();
      var out2 = new PointF[pts.Length];
      for (int i = 0; i < pts.Length; i++)
        out2[i] = new PointF(
          to.X + (pts[i].X - from.X) / from.Width  * to.Width,
          to.Y + (pts[i].Y - from.Y) / from.Height * to.Height);
      return out2;
    }

    // ── Hit testing ────────────────────────────────────────────────────────────

    private static PointF[] Handles(RectangleF r) =>
    [
      new(r.Left + r.Width / 2, r.Top),    // N
      new(r.Right, r.Top),                  // NE
      new(r.Right, r.Top + r.Height / 2),  // E
      new(r.Right, r.Bottom),              // SE
      new(r.Left + r.Width / 2, r.Bottom), // S
      new(r.Left, r.Bottom),              // SW
      new(r.Left, r.Top + r.Height / 2),  // W
      new(r.Left, r.Top),                  // NW
    ];

    private static readonly DragHandle[] HandleMap =
      [DragHandle.N, DragHandle.NE, DragHandle.E, DragHandle.SE, DragHandle.S, DragHandle.SW, DragHandle.W, DragHandle.NW];

    private (string? field, DragHandle h) HitTest(Point p)
    {
      var pt = new PointF(p.X, p.Y);
      for (int fi = _order.Count - 1; fi >= 0; fi--)
      {
        var f = _order[fi];
        if (!_boxes.TryGetValue(f, out var imgPts) || imgPts.Length == 0) continue;
        var disp = ToDispPoly(imgPts);
        var db   = PolygonBounds(disp); if (db.IsEmpty) continue;

        var hpts = Handles(db);
        for (int hi = 0; hi < hpts.Length; hi++)
          if (Math.Abs(p.X - hpts[hi].X) <= HR + 2 && Math.Abs(p.Y - hpts[hi].Y) <= HR + 2)
            return (f, HandleMap[hi]);

        if (disp.Length >= 3 ? PolygonContains(disp, pt) : db.Contains(pt))
          return (f, DragHandle.Body);
      }
      return (null, DragHandle.None);
    }

    // ── Mouse ──────────────────────────────────────────────────────────────────

    protected override void OnMouseDown(MouseEventArgs e)
    {
      if (e.Button != MouseButtons.Left || _image == null) { base.OnMouseDown(e); return; }

      if (ActiveTool == Tool.Pan)
      {
        _isPanning = true;
        _panStart  = e.Location;
        _panStartX = _panX;
        _panStartY = _panY;
        Cursor     = Cursors.SizeAll;
        base.OnMouseDown(e);
        return;
      }

      var (field, h) = HitTest(e.Location);
      _dragPt = e.Location;
      if (h != DragHandle.None)
      {
        PushUndoState();
        SelectedField = field;
        _drag       = h;
        _dragPoly   = _boxes.TryGetValue(field!, out var dpts) ? dpts.ToArray() : [];
        _dragBounds = PolygonBounds(_dragPoly);
      }
      else if (SelectedField != null)
      {
        PushUndoState();
        _drag     = DragHandle.Drawing;
        _dragPoly = [];
      }
      Invalidate();
      base.OnMouseDown(e);
    }

    protected override void OnMouseMove(MouseEventArgs e)
    {
      if (ActiveTool == Tool.Pan)
      {
        Cursor = _isPanning ? Cursors.SizeAll : Cursors.Hand;
        if (_isPanning)
        {
          _panX = _panStartX + (e.X - _panStart.X);
          _panY = _panStartY + (e.Y - _panStart.Y);
          Invalidate();
        }
        base.OnMouseMove(e);
        return;
      }

      if (_drag == DragHandle.None)
      {
        Cursor = HitTest(e.Location).h switch
        {
          DragHandle.Body              => Cursors.SizeAll,
          DragHandle.N or DragHandle.S    => Cursors.SizeNS,
          DragHandle.E or DragHandle.W    => Cursors.SizeWE,
          DragHandle.NE or DragHandle.SW  => Cursors.SizeNESW,
          DragHandle.NW or DragHandle.SE  => Cursors.SizeNWSE,
          _                       => Cursors.Cross,
        };
        base.OnMouseMove(e); return;
      }

      var d   = DispRect();
      float dxi = (e.X - _dragPt.X) * _imgW / d.Width;
      float dyi = (e.Y - _dragPt.Y) * _imgH / d.Height;

      PointF[]? nb = null;
      if (_drag == DragHandle.Drawing)
      {
        nb = MakeImgPoly(ToImg(_dragPt), ToImg(e.Location));
      }
      else if (_drag == DragHandle.Body)
      {
        var bnd = _dragBounds;
        float cx = Math.Max(-bnd.X, Math.Min(_imgW - bnd.Right,  dxi));
        float cy = Math.Max(-bnd.Y, Math.Min(_imgH - bnd.Bottom, dyi));
        nb = TranslatePoly(_dragPoly, cx, cy);
      }
      else
      {
        float x = _dragBounds.Left, y = _dragBounds.Top, r = _dragBounds.Right, b = _dragBounds.Bottom;
        if (_drag is DragHandle.N  or DragHandle.NW or DragHandle.NE) y = Math.Min(b - 4, y + dyi);
        if (_drag is DragHandle.S  or DragHandle.SW or DragHandle.SE) b = Math.Max(y + 4, b + dyi);
        if (_drag is DragHandle.W  or DragHandle.NW or DragHandle.SW) x = Math.Min(r - 4, x + dxi);
        if (_drag is DragHandle.E  or DragHandle.NE or DragHandle.SE) r = Math.Max(x + 4, r + dxi);
        x = Math.Max(0, x); y = Math.Max(0, y);
        r = Math.Min(_imgW, r); b = Math.Min(_imgH, b);
        nb = ScalePoly(_dragPoly, _dragBounds, RectangleF.FromLTRB(x, y, r, b));
      }

      if (SelectedField != null && nb != null)
      { _boxes[SelectedField] = nb; Invalidate(); }

      base.OnMouseMove(e);
    }

    protected override void OnMouseUp(MouseEventArgs e)
    {
      if (_isPanning) { _isPanning = false; Cursor = Cursors.Hand; }
      if (_drag != DragHandle.None) { _drag = DragHandle.None; BoxesChanged?.Invoke(this, EventArgs.Empty); }
      base.OnMouseUp(e);
    }

    protected override void OnMouseWheel(MouseEventArgs e)
    {
      ZoomAt(e.Delta > 0 ? 1.2f : 1f / 1.2f, e.Location);
      base.OnMouseWheel(e);
    }

    // ── Paint ──────────────────────────────────────────────────────────────────

    protected override void OnPaint(PaintEventArgs e)
    {
      base.OnPaint(e);
      var g = e.Graphics;

      if (_image == null)
      {
        using var sb = new SolidBrush(Color.Gray);
        g.DrawString("No image — PDF preview not supported; use TIF or JPG.", Font, sb, new PointF(10, 10));
        return;
      }

      g.DrawImage(_image, DispRect());

      foreach (var field in _order)
      {
        if (!_boxes.TryGetValue(field, out var imgPts) || imgPts.Length == 0) continue;
        var disp = ToDispPoly(imgPts);
        var db   = PolygonBounds(disp); if (db.IsEmpty) continue;
        bool sel = field == SelectedField;
        var col = _colors.TryGetValue(field, out var c) ? c : Color.Red;

        using (var fb = new SolidBrush(Color.FromArgb(sel ? 55 : 25, col)))
        {
          if (disp.Length >= 3) g.FillPolygon(fb, disp);
          else g.FillRectangle(fb, db);
        }

        using var pen = new Pen(col, sel ? 2.5f : 1.5f);
        if (!sel) pen.DashStyle = System.Drawing.Drawing2D.DashStyle.Dash;
        if (disp.Length >= 3) g.DrawPolygon(pen, disp);
        else g.DrawRectangle(pen, db.X, db.Y, db.Width, db.Height);

        if (sel)
          foreach (var hp in Handles(db))
          {
            var hr = new RectangleF(hp.X - HR, hp.Y - HR, HR * 2, HR * 2);
            using var hf = new SolidBrush(Color.White); g.FillEllipse(hf, hr);
            using var hb = new Pen(col, 1.5f);          g.DrawEllipse(hb, hr);
          }

        var lbl  = _labels.TryGetValue(field, out var lb) ? lb : field;
        var lsz  = g.MeasureString(lbl, Font);
        float lx = db.X + 2, ly = db.Y - lsz.Height - 1;
        if (ly < 0) ly = db.Y + 2;
        using var bg = new SolidBrush(Color.FromArgb(170, Color.Black));
        g.FillRectangle(bg, lx - 1, ly - 1, lsz.Width + 2, lsz.Height + 2);
        using var lc = new SolidBrush(col);
        g.DrawString(lbl, Font, lc, lx, ly);
      }
    }
  }

  // ── Visual fields tab builder ─────────────────────────────────────────────────

  private TabPage BuildVisualFieldsTab(
    string imagePath,
    Dictionary<string, PointF[]> detectedBounds,
    Dictionary<string, FieldBoundsConfig> savedBounds)
  {
    var tab = new TabPage("Visual Fields");

    var imgPanel = new ImageBoundsPanel { Dock = DockStyle.Fill };

    // Try loading the image (TIF / JPG supported; PDF will show the fallback message)
    var ext = System.IO.Path.GetExtension(imagePath).ToLowerInvariant();
    if (ext is ".tif" or ".tiff" or ".jpg" or ".jpeg" or ".png")
      imgPanel.LoadImage(imagePath);

    // Build initial box set: saved bounds take priority over detected
    var colors = new Dictionary<string, Color>();
    var order  = new List<string>();
    var boxes  = new Dictionary<string, PointF[]>();
    int? imgW = null, imgH = null;

    // Get image dims for normalised → pixel conversion
    try
    {
      if (ext is ".tif" or ".tiff" or ".jpg" or ".jpeg" or ".png")
        using (var tmp = Image.FromFile(imagePath)) { imgW = tmp.Width; imgH = tmp.Height; }
    }
    catch { /* ignore */ }

    foreach (var (key, label, col) in FieldDefs)
    {
      colors[key] = col;
      order.Add(key);

      if (savedBounds.TryGetValue(key, out var sb) && imgW.HasValue && imgH.HasValue)
      {
        var pts = sb.GetPoints();
        boxes[key] = pts.Select(p => new PointF((float)(p.X * imgW.Value), (float)(p.Y * imgH.Value))).ToArray();
      }
      else if (detectedBounds.TryGetValue(key, out var db))
      {
        boxes[key] = db;
      }
    }

    var labels = FieldDefs.ToDictionary(fd => fd.Key, fd => fd.Label);
    imgPanel.SetBoxes(boxes, colors, order, labels);

    // Left sidebar: field selector
    var sidebar = new Panel { Width = 180, Dock = DockStyle.Left, BackColor = Color.FromArgb(35, 35, 35) };

    var fieldList = new ListBox
    {
      Dock            = DockStyle.Fill,
      BackColor       = Color.FromArgb(35, 35, 35),
      ForeColor       = Color.White,
      BorderStyle     = BorderStyle.None,
      DrawMode        = DrawMode.OwnerDrawFixed,
      ItemHeight      = 22,
      Font            = new Font("Segoe UI", 8.5f),
      SelectionMode   = SelectionMode.One,
    };
    foreach (var (key, label, _) in FieldDefs) fieldList.Items.Add((key, label));

    fieldList.DrawItem += (_, e) =>
    {
      if (e.Index < 0) return;
      var (key, label) = ((string, string))fieldList.Items[e.Index];
      var  col    = colors.TryGetValue(key, out var c) ? c : Color.Gray;
      bool sel    = (e.State & DrawItemState.Selected) != 0;
      bool mapped = imgPanel.HasBox(key);

      var bgColor = sel    ? Color.FromArgb(55, 55, 55)
                  : mapped ? Color.FromArgb(35, 35, 35)
                  :          Color.FromArgb(52, 36, 16); // warm amber tint for unmapped

      using var bg = new SolidBrush(bgColor);
      e.Graphics.FillRectangle(bg, e.Bounds);

      if (mapped)
      {
        using var dot = new SolidBrush(col);
        e.Graphics.FillEllipse(dot, e.Bounds.Left + 6, e.Bounds.Top + 7, 8, 8);
        using var txt = new SolidBrush(Color.White);
        e.Graphics.DrawString(label, e.Font!, txt, e.Bounds.Left + 20, e.Bounds.Top + 4);
      }
      else
      {
        // Hollow dot + amber text + "!" prefix to indicate needs mapping
        using var dotPen = new Pen(Color.FromArgb(255, 175, 50), 1.5f);
        e.Graphics.DrawEllipse(dotPen, e.Bounds.Left + 6, e.Bounds.Top + 7, 8, 8);
        using var txt = new SolidBrush(Color.FromArgb(255, 175, 50));
        e.Graphics.DrawString($"! {label}", e.Font!, txt, e.Bounds.Left + 20, e.Bounds.Top + 4);
      }
    };

    fieldList.SelectedIndexChanged += (_, _) =>
    {
      if (fieldList.SelectedItem is (string key, string))
      {
        imgPanel.SelectedField = key;
        imgPanel.Invalidate();
      }
    };

    imgPanel.BoxesChanged      += (_, _) => fieldList.Invalidate();
    imgPanel.SelectionChanged  += (_, _) => fieldList.SelectedIndex = -1;

    var saveBtn = new Button
    {
      Text      = "Save Field Bounds",
      Dock      = DockStyle.Bottom,
      Height    = 30,
      FlatStyle = FlatStyle.System,
      Font      = new Font("Segoe UI", 8.5f, FontStyle.Bold),
    };

    saveBtn.Click += (_, _) =>
    {
      try
      {
        var currentBoxes = imgPanel.GetBoxes();
        var cfg = AppConfig.Load(ConfigPath);
        cfg.FieldBounds ??= new();

        if (imgW.HasValue && imgH.HasValue)
        {
          foreach (var (key, pts) in currentBoxes)
          {
            if (pts.Length == 0) continue;
            var b = ImageBoundsPanel.PolygonBounds(pts);
            if (b.Width < 4 || b.Height < 4) continue;
            cfg.FieldBounds[key] = new FieldBoundsConfig
            {
              Points = pts.Select(p => new PointConfig
              {
                X = Math.Round(p.X / imgW.Value, 5),
                Y = Math.Round(p.Y / imgH.Value, 5),
              }).ToList()
            };
          }
          cfg.Save(ConfigPath);
          MessageBox.Show("Field bounds saved.", "Saved", MessageBoxButtons.OK, MessageBoxIcon.Information);
        }
        else
        {
          MessageBox.Show("Cannot save — image dimensions unknown.", "Error", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
      }
      catch (Exception ex)
      {
        MessageBox.Show($"Save failed: {ex.Message}", "Error", MessageBoxButtons.OK, MessageBoxIcon.Error);
      }
    };

    var hintLabel = new Label
    {
      Text      = "Select a field → drag/resize its box on the image.",
      Dock      = DockStyle.Top,
      Height    = 22,
      Font      = new Font("Segoe UI", 7.5f, FontStyle.Italic),
      ForeColor = Color.Silver,
      TextAlign = ContentAlignment.MiddleCenter,
      BackColor = Color.FromArgb(35, 35, 35),
    };

    sidebar.Controls.Add(fieldList);
    sidebar.Controls.Add(saveBtn);
    sidebar.Controls.Add(hintLabel);

    var toolbar  = BuildImageToolbar(imgPanel);
    var rightPane = new Panel { Dock = DockStyle.Fill };
    rightPane.Controls.Add(imgPanel);   // Fill — added first
    rightPane.Controls.Add(toolbar);    // Top  — docked above

    tab.Controls.Add(rightPane);
    tab.Controls.Add(sidebar);
    return tab;
  }

  // ── Image toolbox ─────────────────────────────────────────────────────────────

  private static Panel BuildImageToolbar(ImageBoundsPanel target)
  {
    const int H = 26, Y = 4;

    var tb = new Panel
    {
      Dock      = DockStyle.Top,
      Height    = H + Y * 2,
      BackColor = Color.FromArgb(28, 28, 28),
    };

    tb.Paint += (_, e) =>
    {
      using var pen = new Pen(Color.FromArgb(60, 60, 60));
      e.Graphics.DrawLine(pen, 0, tb.Height - 1, tb.Width, tb.Height - 1);
    };

    Color activeClr   = Color.FromArgb(31, 97, 141);
    Color inactiveClr = Color.FromArgb(55, 55, 55);
    Color disabledClr = Color.FromArgb(42, 42, 42);
    Color borderClr   = Color.FromArgb(75, 75, 75);

    Button Btn(string text, int x, int w) => new Button
    {
      Text      = text,
      Width     = w,
      Height    = H,
      Location  = new Point(x, Y),
      FlatStyle = FlatStyle.Flat,
      BackColor = inactiveClr,
      ForeColor = Color.White,
      Font      = new Font("Segoe UI", 8.5f),
      Cursor    = Cursors.Hand,
      FlatAppearance = { BorderColor = borderClr, BorderSize = 1 },
    };

    Panel Sep(int x) => new Panel
    {
      Width     = 1,
      Height    = H,
      Location  = new Point(x, Y),
      BackColor = Color.FromArgb(75, 75, 75),
    };

    // ── Tool buttons ──────────────────────────────────────────────────────────
    var selectBtn = Btn("Select",  8,  54);   // no icon — just clear text
    var panBtn    = Btn("✋ Pan",  66,  54);

    // ── History buttons ───────────────────────────────────────────────────────
    var undoBtn = Btn("↩ Undo", 128, 62);
    var redoBtn = Btn("↪ Redo", 194, 62);

    // ── Zoom buttons ──────────────────────────────────────────────────────────
    var zoomInBtn  = Btn("+",   264, 28);
    var zoomOutBtn = Btn("−",   296, 28);
    var fitBtn     = Btn("Fit", 328, 38);

    // ── Done button ───────────────────────────────────────────────────────────
    var doneBtn = Btn("✓ Done", 374, 68);
    doneBtn.BackColor = Color.FromArgb(30, 90, 50);
    doneBtn.FlatAppearance.BorderColor = Color.FromArgb(45, 120, 70);

    // ── Zoom label ────────────────────────────────────────────────────────────
    var zoomLabel = new Label
    {
      Text      = "100%",
      Width     = 48,
      Height    = H,
      Location  = new Point(446, Y),
      ForeColor = Color.FromArgb(160, 160, 160),
      Font      = new Font("Segoe UI", 8f),
      TextAlign = ContentAlignment.MiddleLeft,
      BackColor = Color.Transparent,
    };

    // ── Separators ────────────────────────────────────────────────────────────
    var sep1 = Sep(124);
    var sep2 = Sep(260);
    var sep3 = Sep(370);

    // ── Logic ─────────────────────────────────────────────────────────────────

    void RefreshToolButtons()
    {
      selectBtn.BackColor = target.ActiveTool == ImageBoundsPanel.Tool.Select ? activeClr : inactiveClr;
      panBtn.BackColor    = target.ActiveTool == ImageBoundsPanel.Tool.Pan    ? activeClr : inactiveClr;
    }

    void RefreshHistoryButtons()
    {
      undoBtn.Enabled   = target.CanUndo;
      redoBtn.Enabled   = target.CanRedo;
      undoBtn.BackColor = target.CanUndo ? inactiveClr : disabledClr;
      redoBtn.BackColor = target.CanRedo ? inactiveClr : disabledClr;
    }

    void RefreshZoomLabel() =>
      zoomLabel.Text = $"{(int)Math.Round(target.ZoomLevel * 100)}%";

    selectBtn.Click += (_, _) => { target.ActiveTool = ImageBoundsPanel.Tool.Select; RefreshToolButtons(); };
    panBtn.Click    += (_, _) => { target.ActiveTool = ImageBoundsPanel.Tool.Pan;    RefreshToolButtons(); };

    undoBtn.Click += (_, _) => target.Undo();
    redoBtn.Click += (_, _) => target.Redo();

    zoomInBtn.Click  += (_, _) => target.ZoomIn();
    zoomOutBtn.Click += (_, _) => target.ZoomOut();
    fitBtn.Click     += (_, _) => target.ResetZoom();

    doneBtn.Click += (_, _) => target.ClearSelection();

    target.ZoomChanged    += (_, _) => RefreshZoomLabel();
    target.HistoryChanged += (_, _) => RefreshHistoryButtons();

    RefreshToolButtons();
    RefreshHistoryButtons();
    RefreshZoomLabel();

    tb.Controls.AddRange(new Control[]
    {
      selectBtn, panBtn, sep1,
      undoBtn, redoBtn, sep2,
      zoomInBtn, zoomOutBtn, fitBtn, sep3,
      doneBtn, zoomLabel,
    });
    return tb;
  }

  private async Task PreviewFileFieldsAsync()
  {
    if (!File.Exists(NodeExePath))
    {
      SetFooterStatus($"node.exe not found: {NodeExePath}", isError: true);
      return;
    }
    if (!File.Exists(ServiceScript))
    {
      SetFooterStatus($"service.js not found: {ServiceScript}", isError: true);
      return;
    }

    var selected = _pendingFilesList.SelectedItems.Cast<string>().FirstOrDefault();
    if (selected is null)
    {
      SetFooterStatus("Select a file from the Pending list to preview.", isError: false);
      return;
    }

    if (!File.Exists(selected))
    {
      ScanPendingFiles();
      SetFooterStatus($"File no longer in watch folder: {Path.GetFileName(selected)}", isError: true);
      return;
    }

    SetFooterStatus($"Running OCR on {Path.GetFileName(selected)}… (this may take 20–40 seconds)", isError: false);

    try
    {
      var psi = new ProcessStartInfo(NodeExePath)
      {
        RedirectStandardOutput = true,
        RedirectStandardError  = true,
        UseShellExecute        = false,
        CreateNoWindow         = true,
        WorkingDirectory       = Path.GetDirectoryName(ServiceScript)!,
      };
      psi.ArgumentList.Add(ServiceScript);
      psi.ArgumentList.Add($"--extract-only={selected}");

      using var proc = Process.Start(psi)!;
      // Read stdout and stderr concurrently — avoids deadlock if either buffer fills
      var stdoutTask = proc.StandardOutput.ReadToEndAsync();
      var stderrTask = proc.StandardError.ReadToEndAsync();
      await proc.WaitForExitAsync();
      var stdout = await stdoutTask;
      var stderr = await stderrTask;

      if (proc.ExitCode != 0)
      {
        var fullError = (stderr.Trim().Length > 0 ? stderr : stdout).Trim();
        MessageBox.Show(fullError, "OCR Preview Failed", MessageBoxButtons.OK, MessageBoxIcon.Error);
        SetFooterStatus("OCR preview failed — see error dialog.", isError: true);
        return;
      }

      System.Text.Json.JsonDocument envelope;
      try
      {
        // Strip any leading non-JSON text (e.g. Node startup messages) before the first '{'
        var jsonStart = stdout.IndexOf('{');
        var jsonText  = jsonStart >= 0 ? stdout[jsonStart..] : stdout;
        envelope = System.Text.Json.JsonDocument.Parse(jsonText);
      }
      catch (Exception parseEx)
      {
        MessageBox.Show($"Could not parse OCR output:\n{parseEx.Message}\n\nRaw output:\n{stdout[..Math.Min(500, stdout.Length)]}",
          "OCR Parse Error", MessageBoxButtons.OK, MessageBoxIcon.Error);
        SetFooterStatus("OCR output parse failed — see error dialog.", isError: true);
        return;
      }

      var root    = envelope.RootElement;
      var rawText = root.TryGetProperty("rawText", out var rt) ? rt.GetString() ?? string.Empty : stdout;

      var fields = new Dictionary<string, string?>();
      if (root.TryGetProperty("fields", out var fObj))
        foreach (var prop in fObj.EnumerateObject())
          fields[prop.Name] = prop.Value.ValueKind == System.Text.Json.JsonValueKind.Null
            ? null : prop.Value.GetString();

      var detectedBounds = new Dictionary<string, PointF[]>();
      if (root.TryGetProperty("detectedBounds", out var dbObj))
        foreach (var prop in dbObj.EnumerateObject())
        {
          var pts = new List<PointF>();
          foreach (var ptEl in prop.Value.EnumerateArray())
            if (ptEl.TryGetProperty("x", out var px) && ptEl.TryGetProperty("y", out var py))
              pts.Add(new PointF(px.GetSingle(), py.GetSingle()));
          if (pts.Count > 0) detectedBounds[prop.Name] = pts.ToArray();
        }

      var imagePath = root.TryGetProperty("filePath", out var fp) ? fp.GetString() ?? selected : selected;

      await ShowFieldPreviewDialogAsync(Path.GetFileName(selected), imagePath, fields, rawText, detectedBounds);
      SetFooterStatus(string.Empty, isError: false);
    }
    catch (Exception ex)
    {
      SetFooterStatus($"Preview failed: {ex.Message}", isError: true);
    }
  }

  private async Task ShowFieldPreviewDialogAsync(
    string fileName, string filePath,
    Dictionary<string, string?> fields, string rawText,
    Dictionary<string, PointF[]>? detectedBounds = null)
  {
    var woiMap = WoiFieldMap;

    var hasEmptyRequired = woiMap
      .Where(m => m.Required)
      .Any(m => string.IsNullOrWhiteSpace(fields.GetValueOrDefault(m.JsonKey)));

    var dlg = new Form
    {
      Text            = $"Extracted Fields — {fileName}",
      Size            = new Size(680, 640),
      MinimumSize     = new Size(500, 460),
      StartPosition   = FormStartPosition.CenterParent,
      FormBorderStyle = FormBorderStyle.Sizable,
      BackColor       = Color.White,
      Font            = new Font("Segoe UI", 9f),
    };

    var infoBar = new Label
    {
      Text      = hasEmptyRequired
        ? "One or more required fields are empty (highlighted in red). Edit values below, then click \"Process with These Values\"."
        : $"OCR results for: {fileName}  —  edit any value below before processing.",
      Dock      = DockStyle.Top,
      Height    = 40,
      Padding   = new Padding(10, 11, 10, 0),
      Font      = new Font("Segoe UI", 8.5f, FontStyle.Italic),
      ForeColor = hasEmptyRequired ? Color.FromArgb(180, 30, 30) : Color.FromArgb(100, 80, 0),
      BackColor = hasEmptyRequired ? Color.FromArgb(255, 235, 235) : Color.FromArgb(255, 251, 220),
    };

    var grid = new DataGridView
    {
      Dock                    = DockStyle.Fill,
      ReadOnly                = false,
      AllowUserToAddRows      = false,
      AllowUserToDeleteRows   = false,
      AllowUserToResizeRows   = false,
      RowHeadersVisible       = false,
      BackgroundColor         = Color.White,
      BorderStyle             = BorderStyle.None,
      AutoSizeColumnsMode     = DataGridViewAutoSizeColumnsMode.Fill,
      SelectionMode           = DataGridViewSelectionMode.FullRowSelect,
      Font                    = new Font("Segoe UI", 9f),
      GridColor               = Color.FromArgb(224, 228, 232),
      CellBorderStyle         = DataGridViewCellBorderStyle.SingleHorizontal,
      EditMode                = DataGridViewEditMode.EditOnEnter,
    };
    grid.ColumnHeadersDefaultCellStyle.BackColor = AccentColor;
    grid.ColumnHeadersDefaultCellStyle.ForeColor = Color.White;
    grid.ColumnHeadersDefaultCellStyle.Font      = new Font("Segoe UI", 8.5f, FontStyle.Bold);
    grid.EnableHeadersVisualStyles               = false;
    grid.ColumnHeadersHeight                     = 28;
    grid.AlternatingRowsDefaultCellStyle.BackColor = Color.FromArgb(248, 249, 250);
    grid.Columns.Add(new DataGridViewTextBoxColumn { HeaderText = "WOI Field",                  Name = "Field",   FillWeight = 34, ReadOnly = true });
    grid.Columns.Add(new DataGridViewTextBoxColumn { HeaderText = "Extracted Value (editable)", Name = "Value",   FillWeight = 66 });
    grid.Columns.Add(new DataGridViewTextBoxColumn { Name = "JsonKey", Visible = false });

    foreach (var (label, key, required) in woiMap)
    {
      fields.TryGetValue(key, out var val);
      var rowIndex = grid.Rows.Add(label, val ?? string.Empty, key);
      var row      = grid.Rows[rowIndex];
      row.Cells["Field"].Style.BackColor = Color.FromArgb(240, 242, 245);
      row.Cells["Field"].Style.ForeColor = Color.FromArgb(60, 60, 60);
      row.Cells["Field"].Style.Font      = new Font("Segoe UI", 8.5f, FontStyle.Bold);
      if (required && string.IsNullOrWhiteSpace(val))
      {
        row.Cells["Field"].Style.BackColor  = Color.FromArgb(255, 200, 200);
        row.Cells["Field"].Style.ForeColor  = Color.Firebrick;
        row.Cells["Value"].Style.BackColor  = Color.FromArgb(255, 230, 230);
      }
      else if (string.IsNullOrWhiteSpace(val))
      {
        row.Cells["Value"].Style.ForeColor = Color.Silver;
      }
    }

    var fieldsPage = new TabPage("Mapped Fields");
    fieldsPage.Controls.Add(grid);

    var rawBox = new TextBox
    {
      Dock        = DockStyle.Fill,
      Multiline   = true,
      ScrollBars  = ScrollBars.Vertical,
      ReadOnly    = true,
      Font        = new Font("Consolas", 8.5f),
      BackColor   = Color.FromArgb(30, 30, 30),
      ForeColor   = Color.FromArgb(212, 212, 212),
      BorderStyle = BorderStyle.None,
      WordWrap    = true,
      Text        = rawText,
    };
    var rawPage = new TabPage("Raw OCR Text");
    rawPage.Controls.Add(rawBox);

    var savedBounds = AppConfig.Load(ConfigPath).FieldBounds ?? new();
    var visualTab   = BuildVisualFieldsTab(filePath, detectedBounds ?? new(), savedBounds);

    var tabs = new TabControl { Dock = DockStyle.Fill };
    tabs.TabPages.Add(fieldsPage);
    tabs.TabPages.Add(rawPage);
    tabs.TabPages.Add(visualTab);

    string? overridesFilePath = null;

    var processBtn = new Button
    {
      Text      = "Process with These Values",
      Width     = 186,
      Height    = 28,
      FlatStyle = FlatStyle.System,
      Font      = new Font("Segoe UI", 9f, FontStyle.Bold),
    };
    processBtn.Click += (_, _) =>
    {
      var overrides = new Dictionary<string, string?>();
      foreach (DataGridViewRow r in grid.Rows)
      {
        if (r.IsNewRow) continue;
        var jsonKey = r.Cells["JsonKey"].Value?.ToString();
        var val     = r.Cells["Value"].Value?.ToString();
        if (!string.IsNullOrEmpty(jsonKey)) overrides[jsonKey] = val;
      }

      var stillEmpty = woiMap
        .Where(m => m.Required && string.IsNullOrWhiteSpace(overrides.GetValueOrDefault(m.JsonKey)))
        .Select(m => m.WoiLabel)
        .ToList();
      if (stillEmpty.Count > 0)
      {
        MessageBox.Show(
          $"The following required WOI fields are still empty:\n\n{string.Join("\n", stillEmpty.Select(f => "  • " + f))}\n\nPlease fill in these values before processing.",
          "Required Fields Missing",
          MessageBoxButtons.OK,
          MessageBoxIcon.Warning);
        return;
      }

      try
      {
        var tmp = Path.ChangeExtension(Path.GetTempFileName(), ".json");
        File.WriteAllText(tmp, System.Text.Json.JsonSerializer.Serialize(overrides));
        overridesFilePath = tmp;
      }
      catch (Exception ex)
      {
        MessageBox.Show($"Failed to write field overrides: {ex.Message}", "Error",
          MessageBoxButtons.OK, MessageBoxIcon.Error);
        return;
      }

      dlg.DialogResult = DialogResult.OK;
      dlg.Close();
    };

    var closeBtn = new Button { Text = "Close", Width = 80, Height = 28, FlatStyle = FlatStyle.System };
    closeBtn.Click += (_, _) => dlg.Close();

    var btnPanel = new Panel { Dock = DockStyle.Bottom, Height = 44, BackColor = Color.White };
    btnPanel.Paint += (_, e) =>
      e.Graphics.DrawLine(new Pen(Color.FromArgb(208, 213, 219)), 0, 0, btnPanel.Width, 0);
    btnPanel.Controls.Add(closeBtn);
    btnPanel.Controls.Add(processBtn);
    btnPanel.Layout += (_, _) =>
    {
      closeBtn.Location   = new Point(btnPanel.ClientSize.Width - closeBtn.Width - 10, 8);
      processBtn.Location = new Point(btnPanel.ClientSize.Width - closeBtn.Width - processBtn.Width - 20, 8);
    };

    dlg.Controls.Add(tabs);
    dlg.Controls.Add(infoBar);
    dlg.Controls.Add(btnPanel);
    dlg.ShowDialog();
    dlg.Dispose();

    if (overridesFilePath is not null)
    {
      await ProcessFileWithOverridesAsync(filePath, overridesFilePath);
      try { File.Delete(overridesFilePath); } catch { /* non-fatal */ }
    }
  }

  // ── Order detail dialog (double-click on log row) ────────────────────────────

  private static readonly (string WoiLabel, string JsonKey, bool Required)[] WoiFieldMap =
  [
    ("Bill Name",             "customerName",       false),  // always FREYVOGEL WEBSITE
    ("Bill Address",          "customerAddress",    false),
    ("Bill Phone",            "customerPhone",      false),
    ("For the Passing Of",    "forThePassingOf",    true),
    ("Delivery Location",     "deliveryLocation",   false),
    ("Delivery Date",         "deliveryDate",       true),
    ("Delivery Time",         "deliveryTime",       false),
    ("Card Message",          "cardMessage",        false),
    ("Product Code / Item #", "productItemNumber",  true),
    ("Product Description",   "productDescription", false),
    ("Product Price",         "productPrice",       false),
    ("Delivery Charge",       "deliveryCharge",     false),
    ("Total Payable",         "totalPayable",       false),
    ("Order Number",          "orderNumber",        false),
    ("Order Placed Date",     "orderPlacedDate",    false),
    ("Vendor Name",           "vendorName",         false),
    ("Vendor Tel",            "vendorTel",          false),
    ("Vendor Fax",            "vendorFax",          false),
    ("Vendor SMS",            "vendorSms",          false),
  ];

  private void ShowOrderDetailDialog(OrderLogEntry entry)
  {
    var ts = DateTimeOffset.TryParse(entry.Timestamp, out var dto)
      ? dto.LocalDateTime.ToString("f")
      : entry.Timestamp;

    var dlg = new Form
    {
      Text            = $"Order Detail — {entry.FileName}",
      Size            = new Size(620, 580),
      MinimumSize     = new Size(480, 420),
      StartPosition   = FormStartPosition.CenterParent,
      FormBorderStyle = FormBorderStyle.Sizable,
      BackColor       = Color.White,
      Font            = new Font("Segoe UI", 9f),
    };

    // ── Info bar ──────────────────────────────────────────────────────────────
    var statusColor = entry.EmailSent
      ? Color.FromArgb(220, 245, 228) : Color.FromArgb(255, 235, 235);
    var statusFg = entry.EmailSent
      ? Color.FromArgb(30, 120, 60) : Color.FromArgb(160, 30, 30);
    var statusText = entry.EmailSent ? "✓  Email sent" : "✗  Email not sent";
    if (!string.IsNullOrWhiteSpace(entry.Error))
      statusText += $"  —  {entry.Error}";

    if (string.IsNullOrWhiteSpace(entry.Error) && !string.IsNullOrWhiteSpace(entry.Note))
      statusText += $"  -  {entry.Note}";

    var infoBar = new Label
    {
      Text      = $"{ts}   ·   {entry.FileName}   ·   {statusText}",
      Dock      = DockStyle.Top,
      Height    = 36,
      Padding   = new Padding(10, 10, 10, 0),
      Font      = new Font("Segoe UI", 8.5f, FontStyle.Regular),
      ForeColor = statusFg,
      BackColor = statusColor,
    };

    // ── Fields grid ───────────────────────────────────────────────────────────
    var grid = new DataGridView
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
      Font                    = new Font("Segoe UI", 9f),
      GridColor               = Color.FromArgb(224, 228, 232),
      CellBorderStyle         = DataGridViewCellBorderStyle.SingleHorizontal,
    };
    grid.ColumnHeadersDefaultCellStyle.BackColor = AccentColor;
    grid.ColumnHeadersDefaultCellStyle.ForeColor = Color.White;
    grid.ColumnHeadersDefaultCellStyle.Font      = new Font("Segoe UI", 8.5f, FontStyle.Bold);
    grid.EnableHeadersVisualStyles               = false;
    grid.ColumnHeadersHeight                     = 28;
    grid.AlternatingRowsDefaultCellStyle.BackColor = Color.FromArgb(248, 249, 250);
    grid.Columns.Add(new DataGridViewTextBoxColumn { HeaderText = "WOI Field",     Name = "Field", FillWeight = 36, ReadOnly = true });
    grid.Columns.Add(new DataGridViewTextBoxColumn { HeaderText = "Parsed Value",  Name = "Value", FillWeight = 64 });

    var storedFields = entry.Fields ?? new Dictionary<string, string>();

    foreach (var (label, key, required) in WoiFieldMap)
    {
      storedFields.TryGetValue(key, out var val);
      var rowIndex = grid.Rows.Add(label, val ?? string.Empty);
      var row = grid.Rows[rowIndex];
      row.Cells["Field"].Style.BackColor = Color.FromArgb(240, 242, 245);
      row.Cells["Field"].Style.ForeColor = Color.FromArgb(60, 60, 60);
      row.Cells["Field"].Style.Font      = new Font("Segoe UI", 8.5f, FontStyle.Bold);
      if (required && string.IsNullOrWhiteSpace(val))
      {
        row.Cells["Field"].Style.BackColor = Color.FromArgb(255, 200, 200);
        row.Cells["Field"].Style.ForeColor = Color.Firebrick;
        row.Cells["Value"].Style.ForeColor = Color.Silver;
      }
      else if (string.IsNullOrWhiteSpace(val))
      {
        row.Cells["Value"].Style.ForeColor = Color.Silver;
      }
    }

    var hint = new Label
    {
      Text      = "Double-click any value to copy it. To edit and resend, use \"Reprocess\".",
      Dock      = DockStyle.Top,
      Height    = 22,
      Padding   = new Padding(8, 4, 0, 0),
      Font      = new Font("Segoe UI", 8f, FontStyle.Italic),
      ForeColor = Color.Gray,
      BackColor = Color.White,
    };

    grid.CellDoubleClick += (_, ce) =>
    {
      if (ce.RowIndex < 0 || ce.ColumnIndex < 0) return;
      var val = grid.Rows[ce.RowIndex].Cells[ce.ColumnIndex].Value?.ToString() ?? string.Empty;
      if (!string.IsNullOrEmpty(val))
        Clipboard.SetText(val);
    };

    // ── Button panel ──────────────────────────────────────────────────────────
    var btnPanel = new Panel { Dock = DockStyle.Bottom, Height = 44, BackColor = Color.White };
    btnPanel.Paint += (_, e) =>
      e.Graphics.DrawLine(new Pen(Color.FromArgb(208, 213, 219)), 0, 0, btnPanel.Width, 0);

    var closeBtn = new Button { Text = "Close", Width = 80, Height = 28, FlatStyle = FlatStyle.System };
    closeBtn.Click += (_, _) => dlg.Close();

    var canReprocess = !string.IsNullOrEmpty(entry.ProcessedFilePath) &&
                       File.Exists(entry.ProcessedFilePath);
    var reprocessBtn = new Button
    {
      Text      = canReprocess ? "Reprocess Order" : "File Not Found",
      Width     = 130,
      Height    = 28,
      FlatStyle = FlatStyle.System,
      Font      = new Font("Segoe UI", 9f, FontStyle.Bold),
      Enabled   = canReprocess,
    };
    reprocessBtn.Click += (_, _) =>
    {
      dlg.Close();
      ReprocessLoggedOrder(entry);
    };

    btnPanel.Controls.AddRange(new Control[] { closeBtn, reprocessBtn });
    btnPanel.Layout += (_, _) =>
    {
      closeBtn.Location     = new Point(btnPanel.ClientSize.Width - closeBtn.Width - 10, 8);
      reprocessBtn.Location = new Point(btnPanel.ClientSize.Width - closeBtn.Width - reprocessBtn.Width - 20, 8);
    };

    dlg.Controls.Add(grid);
    dlg.Controls.Add(hint);
    dlg.Controls.Add(infoBar);
    dlg.Controls.Add(btnPanel);
    dlg.ShowDialog(this);
    dlg.Dispose();
  }

  private void ReprocessLoggedOrder(OrderLogEntry entry)
  {
    if (string.IsNullOrEmpty(entry.ProcessedFilePath) || !File.Exists(entry.ProcessedFilePath))
    {
      SetFooterStatus("Reprocess failed — processed file not found.", isError: true);
      return;
    }

    if (!File.Exists(NodeExePath) || !File.Exists(ServiceScript))
    {
      SetFooterStatus("node.exe or service.js not found.", isError: true);
      return;
    }

    var cfg = AppConfig.Load(ConfigPath);
    var fileName   = Path.GetFileName(entry.ProcessedFilePath);
    var destInWatch = Path.Combine(cfg.WatchFolder, fileName);
    var suffix = 0;

    // If a file with the same name already exists in the watch folder, append a counter
    while (File.Exists(destInWatch))
    {
      suffix++;
      var name = Path.GetFileNameWithoutExtension(fileName);
      var ext  = Path.GetExtension(fileName);
      destInWatch = Path.Combine(cfg.WatchFolder, $"{name}_r{suffix}{ext}");
    }

    try
    {
      Directory.CreateDirectory(cfg.WatchFolder);
      File.Copy(entry.ProcessedFilePath, destInWatch);
    }
    catch (Exception ex)
    {
      SetFooterStatus($"Failed to copy file for reprocessing: {ex.Message}", isError: true);
      return;
    }

    string? overridesFilePath = null;
    if (entry.Fields is { Count: > 0 })
    {
      try
      {
        var tmp = Path.ChangeExtension(Path.GetTempFileName(), ".json");
        File.WriteAllText(tmp, System.Text.Json.JsonSerializer.Serialize(entry.Fields));
        overridesFilePath = tmp;
      }
      catch { /* proceed without overrides */ }
    }

    SetFooterStatus($"Reprocessing {Path.GetFileName(destInWatch)}…", isError: false);
    Application.DoEvents();

    try
    {
      var psi = new ProcessStartInfo(NodeExePath)
      {
        UseShellExecute        = false,
        RedirectStandardOutput = true,
        RedirectStandardError  = true,
        CreateNoWindow         = true,
        WorkingDirectory       = Path.GetDirectoryName(ServiceScript)!,
      };
      psi.ArgumentList.Add(ServiceScript);
      psi.ArgumentList.Add($"--process-file={destInWatch}");
      psi.ArgumentList.Add("--force-send");
      if (overridesFilePath != null)
        psi.ArgumentList.Add($"--field-overrides-file={overridesFilePath}");

      using var proc = Process.Start(psi)!;
      var stdout = proc.StandardOutput.ReadToEnd();
      var stderr = proc.StandardError.ReadToEnd();
      proc.WaitForExit(120_000);

      if (proc.ExitCode == 0)
        SetFooterStatus($"✓ Reprocessed {fileName} successfully.", isError: false);
      else
      {
        var errText   = (stderr.Trim().Length > 0 ? stderr : stdout).Trim();
        var firstLine = errText.Split('\n').FirstOrDefault(l => l.Trim().Length > 0) ?? "unknown error";
        SetFooterStatus($"Reprocess failed: {firstLine}", isError: true);
        // Clean up the copy if processing failed
        try { File.Delete(destInWatch); } catch { /* non-fatal */ }
      }
    }
    catch (Exception ex)
    {
      SetFooterStatus($"Error: {ex.Message}", isError: true);
      try { File.Delete(destInWatch); } catch { /* non-fatal */ }
    }
    finally
    {
      if (overridesFilePath != null)
        try { File.Delete(overridesFilePath); } catch { /* non-fatal */ }
    }

    ScanPendingFiles();
    LoadLog();
  }

  private async Task ProcessSelectedFilesAsync()
  {
    if (!File.Exists(NodeExePath))
    {
      SetFooterStatus($"node.exe not found: {NodeExePath}", isError: true);
      return;
    }
    if (!File.Exists(ServiceScript))
    {
      SetFooterStatus($"service.js not found: {ServiceScript}", isError: true);
      return;
    }

    var selected = _pendingFilesList.SelectedItems.Cast<string>().ToList();
    if (selected.Count == 0)
    {
      SetFooterStatus("Select one or more files from the Pending list first.", isError: false);
      return;
    }

    var ok   = 0;
    var fail = 0;

    foreach (var filePath in selected)
    {
      if (!File.Exists(filePath))
      {
        fail++;
        SetFooterStatus($"Skipped (already processed): {Path.GetFileName(filePath)}", isError: true);
        continue;
      }

      SetFooterStatus($"Processing {Path.GetFileName(filePath)}…", isError: false);
      Application.DoEvents();

      try
      {
        var psi = new ProcessStartInfo(NodeExePath)
        {
          UseShellExecute        = false,
          RedirectStandardOutput = true,
          RedirectStandardError  = true,
          CreateNoWindow         = true,
          WorkingDirectory       = Path.GetDirectoryName(ServiceScript)!,
        };
        psi.ArgumentList.Add(ServiceScript);
        psi.ArgumentList.Add($"--process-file={filePath}");
        psi.ArgumentList.Add("--force-send");

        using var proc = Process.Start(psi)!;
        var stdoutTask = proc.StandardOutput.ReadToEndAsync();
        var stderrTask = proc.StandardError.ReadToEndAsync();
        await proc.WaitForExitAsync();
        var stdout = await stdoutTask;
        var stderr = await stderrTask;

        if (proc.ExitCode == 0)
        {
          ok++;
        }
        else
        {
          fail++;
          var errText   = (stderr.Trim().Length > 0 ? stderr : stdout).Trim();
          var firstLine = errText.Split('\n').FirstOrDefault(l => l.Trim().Length > 0) ?? "unknown error";
          SetFooterStatus($"Failed ({Path.GetFileName(filePath)}): {firstLine}", isError: true);
        }
      }
      catch (Exception ex)
      {
        fail++;
        SetFooterStatus($"Error: {ex.Message}", isError: true);
      }
    }

    ScanPendingFiles();
    LoadLog();

    if (fail == 0)
      SetFooterStatus($"Processed {ok} file{(ok != 1 ? "s" : "")} successfully.", isError: false);
    else if (ok > 0)
      SetFooterStatus($"Processed {ok} ok, {fail} failed — see error above.", isError: true);
  }

  private async Task ProcessFileWithOverridesAsync(string filePath, string overridesFilePath)
  {
    if (!File.Exists(NodeExePath))
    {
      SetFooterStatus($"node.exe not found: {NodeExePath}", isError: true);
      return;
    }
    if (!File.Exists(ServiceScript))
    {
      SetFooterStatus($"service.js not found: {ServiceScript}", isError: true);
      return;
    }
    if (!File.Exists(filePath))
    {
      SetFooterStatus($"File no longer exists: {Path.GetFileName(filePath)}", isError: true);
      return;
    }

    SetFooterStatus($"Processing {Path.GetFileName(filePath)} with edited values…", isError: false);

    try
    {
      var psi = new ProcessStartInfo(NodeExePath)
      {
        UseShellExecute        = false,
        RedirectStandardOutput = true,
        RedirectStandardError  = true,
        CreateNoWindow         = true,
        WorkingDirectory       = Path.GetDirectoryName(ServiceScript)!,
      };
      psi.ArgumentList.Add(ServiceScript);
      psi.ArgumentList.Add($"--process-file={filePath}");
      psi.ArgumentList.Add("--force-send");
      psi.ArgumentList.Add($"--field-overrides-file={overridesFilePath}");

      using var proc = Process.Start(psi)!;
      var stdoutTask = proc.StandardOutput.ReadToEndAsync();
      var stderrTask = proc.StandardError.ReadToEndAsync();
      await proc.WaitForExitAsync();
      var stdout = await stdoutTask;
      var stderr = await stderrTask;

      if (proc.ExitCode == 0)
        SetFooterStatus($"✓ Processed {Path.GetFileName(filePath)} successfully.", isError: false);
      else
      {
        var errText   = (stderr.Trim().Length > 0 ? stderr : stdout).Trim();
        var firstLine = errText.Split('\n').FirstOrDefault(l => l.Trim().Length > 0) ?? "unknown error";
        SetFooterStatus($"Failed: {firstLine}", isError: true);
      }
    }
    catch (Exception ex)
    {
      SetFooterStatus($"Error: {ex.Message}", isError: true);
    }

    ScanPendingFiles();
    LoadLog();
  }

  // ── Field mapping validation ──────────────────────────────────────────────────

  private void UpdateProcessSelectedState()
  {
    AppConfig? cfg = null;
    try { cfg = AppConfig.Load(ConfigPath); } catch { }

    var missing = RequiredWoiMappingFields
      .Where(f => cfg is null ||
                  !cfg.FieldMap.TryGetValue(f, out var src) ||
                  src == "(none)")
      .ToList();

    _processSelectedBtn.Enabled = missing.Count == 0;
    _toolTip.SetToolTip(_processSelectedBtn,
      missing.Count > 0
        ? $"Disabled: required WOI fields have no OCR source mapped:\n{string.Join(", ", missing)}\n\nOpen the Field Map tab to fix."
        : string.Empty);
  }

  // ── Config change log ─────────────────────────────────────────────────────────

  private void AppendConfigLog(string message)
  {
    try
    {
      Directory.CreateDirectory(ServiceLogDir);
      File.AppendAllText(OutLogPath,
        $"[Config {DateTime.Now:yyyy-MM-dd HH:mm:ss}] {message}{Environment.NewLine}");
    }
    catch { /* non-fatal */ }
  }

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
