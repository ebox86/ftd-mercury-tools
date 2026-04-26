using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Windows.Forms;

namespace FTD.FaxParser.ConfigApp;

internal sealed class MainForm : Form
{
  // ── Constants ────────────────────────────────────────────────────────────────

  private static readonly Color  AccentColor   = Color.FromArgb(26, 58, 92);
  private static readonly Color  BgColor       = Color.FromArgb(240, 242, 245);
  private const string           ServiceName   = "FTD Fax Order Parser";
  private static readonly string AppRoot       = @"C:\FTDTools\FaxOrderParser";
  private static readonly string NodeExePath   = Path.Combine(@"C:\FTDTools\FaxOrderParser", "runtime", "node.exe");
  private static readonly string ServiceScript = Path.Combine(@"C:\FTDTools\FaxOrderParser", "service", "service.js");

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
  private ListBox        _pendingFilesList     = null!;
  private Label          _pendingCountLabel    = null!;

  // ── Service logs tab controls ────────────────────────────────────────────────

  private RichTextBox    _outLogBox            = null!;
  private RichTextBox    _errLogBox            = null!;
  private System.Windows.Forms.Timer? _logTailTimer;

  // ── Field map tab controls ──────────────────────────────────────────────────

  private DataGridView   _fieldMapGrid         = null!;

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
    // WinForms docking: Fill control must be added FIRST (lowest Z-order index after all adds).
    // Header/Footer (Top/Bottom) are added after so they claim their space before Fill.
    Controls.Add(BuildTabControl()); // Dock=Fill  — added first so header/footer dock before it fills
    Controls.Add(BuildFooter());     // Dock=Bottom
    Controls.Add(BuildHeader());     // Dock=Top
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
    var tc = new TabControl { Dock = DockStyle.Fill };
    tc.TabPages.Add(BuildMonitorTab());     // 0
    tc.TabPages.Add(BuildEmailTab());       // 1
    tc.TabPages.Add(BuildLogTab());         // 2
    tc.TabPages.Add(BuildServiceLogsTab()); // 3
    tc.TabPages.Add(BuildFieldMapTab());    // 4
    tc.SelectedIndexChanged += (_, _) =>
    {
      if (tc.SelectedIndex == 2) { LoadLog(); ScanPendingFiles(); }
      if (tc.SelectedIndex == 3) { LoadServiceLogs(); StartLogTailTimer(tc); }
      else StopLogTailTimer();
      if (tc.SelectedIndex == 4) LoadFieldMap();
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
    openBtn.ToolTipText = "Open in Explorer";
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

    var processPendingBtn = new Button
    {
      Text      = "▶  Process Selected",
      Width     = 134,
      Height    = 22,
      Anchor    = AnchorStyles.Top | AnchorStyles.Right,
      FlatStyle = FlatStyle.System,
    };
    pendingHeader.Layout += (_, _) =>
      processPendingBtn.Location = new Point(pendingHeader.ClientSize.Width - processPendingBtn.Width - 4, 4);
    processPendingBtn.Click += (_, _) => ProcessSelectedFiles();

    var previewBtn = new Button
    {
      Text      = "Preview Fields",
      Width     = 104,
      Height    = 22,
      Anchor    = AnchorStyles.Top | AnchorStyles.Right,
      FlatStyle = FlatStyle.System,
    };
    pendingHeader.Layout += (_, _) =>
      previewBtn.Location = new Point(pendingHeader.ClientSize.Width - processPendingBtn.Width - previewBtn.Width - 14, 4);
    previewBtn.Click += (_, _) => PreviewFileFields();

    var scanBtn = new Button
    {
      Text      = "↺  Scan",
      Width     = 72,
      Height    = 22,
      Anchor    = AnchorStyles.Top | AnchorStyles.Right,
      FlatStyle = FlatStyle.System,
    };
    pendingHeader.Layout += (_, _) =>
      scanBtn.Location = new Point(pendingHeader.ClientSize.Width - processPendingBtn.Width - previewBtn.Width - scanBtn.Width - 20, 4);
    scanBtn.Click += (_, _) => ScanPendingFiles();

    pendingHeader.Controls.AddRange(new Control[] { pendingTitle, _pendingCountLabel, scanBtn, previewBtn, processPendingBtn });

    _pendingFilesList = new ListBox
    {
      Dock          = DockStyle.Fill,
      SelectionMode = SelectionMode.MultiExtended,
      Font          = new Font("Segoe UI", 8.5f),
      BorderStyle   = BorderStyle.None,
      BackColor     = Color.White,
    };

    // Z-order: pendingHeader docks Top first, then _pendingFilesList fills remainder
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

    // AddRange z-order: index 0 docks last. Processing order: pendingPanel→separator→toolbar→_logGrid(Fill)
    page.Controls.AddRange(new Control[] { _logGrid, toolbar, separator, pendingPanel });
    return page;
  }

  // ── Service logs tab ──────────────────────────────────────────────────────────

  private TabPage BuildServiceLogsTab()
  {
    var page = new TabPage("Logs");

    // Toolbar
    var toolbar = new Panel { Dock = DockStyle.Top, Height = 34, BackColor = BgColor };

    var refreshBtn = new Button
    {
      Text      = "\u21ba  Refresh",
      Width     = 84,
      Height    = 24,
      Location  = new Point(8, 5),
      FlatStyle = FlatStyle.System,
    };
    refreshBtn.Click += (_, _) => LoadServiceLogs();

    var clearBtn = new Button
    {
      Text      = "Clear View",
      Width     = 80,
      Height    = 24,
      Location  = new Point(100, 5),
      FlatStyle = FlatStyle.System,
    };
    clearBtn.Click += (_, _) => { _outLogBox.Clear(); _errLogBox.Clear(); };

    var autoScrollChk = new CheckBox
    {
      Text      = "Auto-scroll",
      Checked   = true,
      AutoSize  = true,
      Location  = new Point(192, 8),
      Font      = new Font("Segoe UI", 8.5f),
    };

    toolbar.Controls.AddRange(new Control[] { refreshBtn, clearBtn, autoScrollChk });

    // Split: stdout (top) / stderr (bottom)
    var split = new SplitContainer
    {
      Dock        = DockStyle.Fill,
      Orientation = Orientation.Horizontal,
      SplitterDistance = 65,   // % — roughly 2/3 top, 1/3 bottom
      Panel1MinSize = 60,
      Panel2MinSize = 40,
    };

    _outLogBox = MakeLogBox(Color.FromArgb(30, 30, 30), Color.FromArgb(200, 220, 200));
    _errLogBox = MakeLogBox(Color.FromArgb(40, 20, 20), Color.FromArgb(255, 200, 200));

    var outLabel = new Label { Text = " stdout (OCR / email)", Dock = DockStyle.Top, Height = 18,
      Font = new Font("Segoe UI", 8f, FontStyle.Bold), ForeColor = Color.FromArgb(140,200,140),
      BackColor = Color.FromArgb(30,30,30), Padding = new Padding(4,2,0,0) };
    var errLabel = new Label { Text = " stderr (warnings / errors)", Dock = DockStyle.Top, Height = 18,
      Font = new Font("Segoe UI", 8f, FontStyle.Bold), ForeColor = Color.FromArgb(220,140,140),
      BackColor = Color.FromArgb(40,20,20), Padding = new Padding(4,2,0,0) };

    split.Panel1.Controls.Add(_outLogBox);
    split.Panel1.Controls.Add(outLabel);
    split.Panel2.Controls.Add(_errLogBox);
    split.Panel2.Controls.Add(errLabel);

    // Wire auto-scroll to the boxes
    _outLogBox.Tag = autoScrollChk;
    _errLogBox.Tag = autoScrollChk;

    page.Controls.Add(split);
    page.Controls.Add(toolbar);
    return page;
  }

  private static RichTextBox MakeLogBox(Color bg, Color fg) => new RichTextBox
  {
    Dock       = DockStyle.Fill,
    ReadOnly   = true,
    BackColor  = bg,
    ForeColor  = fg,
    Font       = new Font("Consolas", 8.5f),
    BorderStyle= BorderStyle.None,
    WordWrap   = false,
    ScrollBars = RichTextBoxScrollBars.Both,
  };

  // ── Field map tab ─────────────────────────────────────────────────────────────

  private TabPage BuildFieldMapTab()
  {
    var page = new TabPage("Field Map");

    // Toolbar
    var toolbar = new Panel { Dock = DockStyle.Top, Height = 38, BackColor = Color.FromArgb(245, 247, 250) };
    toolbar.Paint += (_, e) =>
      e.Graphics.DrawLine(new Pen(Color.FromArgb(208, 213, 219)), 0, toolbar.Height - 1, toolbar.Width, toolbar.Height - 1);

    var saveBtn = new Button
    {
      Text      = "\u2713  Save Mapping",
      Width     = 112,
      Height    = 26,
      Location  = new Point(8, 6),
      FlatStyle = FlatStyle.System,
    };
    saveBtn.Click += (_, _) => SaveFieldMap();

    var infoLabel = new Label
    {
      Text      = "Blue rows are remappable \u2014 click the dropdown to change the OCR source.",
      AutoSize  = true,
      Location  = new Point(130, 10),
      Font      = new Font("Segoe UI", 8.5f, FontStyle.Italic),
      ForeColor = Color.FromArgb(60, 80, 120),
    };
    toolbar.Controls.AddRange(new Control[] { saveBtn, infoLabel });

    _fieldMapGrid = new DataGridView
    {
      Dock                    = DockStyle.Fill,
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
      EditMode                = DataGridViewEditMode.EditOnEnter,
    };

    _fieldMapGrid.ColumnHeadersDefaultCellStyle.BackColor   = Color.FromArgb(26, 58, 92);
    _fieldMapGrid.ColumnHeadersDefaultCellStyle.ForeColor   = Color.White;
    _fieldMapGrid.ColumnHeadersDefaultCellStyle.Font        = new Font("Segoe UI", 8.5f, FontStyle.Bold);
    _fieldMapGrid.ColumnHeadersDefaultCellStyle.Padding     = new Padding(4, 0, 0, 0);
    _fieldMapGrid.EnableHeadersVisualStyles                 = false;
    _fieldMapGrid.ColumnHeadersHeight                       = 28;
    _fieldMapGrid.AlternatingRowsDefaultCellStyle.BackColor = Color.FromArgb(248, 249, 250);

    // Suppress DataError when non-combo rows display text not in the items list
    _fieldMapGrid.DataError += (_, e) => e.Cancel = true;

    _fieldMapGrid.Columns.AddRange(new DataGridViewColumn[]
    {
      new DataGridViewTextBoxColumn { HeaderText = "WOI Field (Fixed by Mercury)", Name = "WoiField",  FillWeight = 34, ReadOnly = true },
      new DataGridViewTextBoxColumn { HeaderText = "Extracted From OCR",           Name = "OcrSource", FillWeight = 34 },
      new DataGridViewTextBoxColumn { HeaderText = "Notes",                        Name = "Notes",     FillWeight = 32 },
    });

    var rows = new (string WoiField, string OcrSource, string Notes)[]
    {
      ("Bill Name",              "Customer Name",            ""),
      ("Bill Address1",          "Billing Street",           "Parsed from Customer Address"),
      ("Bill Address2",          "Billing Address \u2013 Line 2", "If present"),
      ("Bill City",              "Billing City",             "Parsed from Customer Address"),
      ("Bill State",             "Billing State",            "2-letter code"),
      ("Bill Zip",               "Billing ZIP",              "Parsed from Customer Address"),
      ("Bill Phone Area Code",   "Phone \u2013 Area Code",       "Digits 1\u20133"),
      ("Bill Phone Prefix",      "Phone \u2013 Prefix",          "Digits 4\u20136"),
      ("Bill Phone Number",      "Phone \u2013 Line Number",     "Last 4 digits"),
      ("Bill Phone Extension",   "Phone \u2013 Extension",       "If present"),
      ("Recipient Name",         "For the Passing Of",       ""),
      ("Recipient Address1",     "Delivery Street",          "Parsed from Delivery Location"),
      ("Recipient Address2",     "Delivery Address \u2013 Line 2", "If present"),
      ("Recipient City",         "Delivery City",            "Parsed from Delivery Location"),
      ("Recipient State",        "Delivery State",           "2-letter code"),
      ("Recipient Zip",          "Delivery ZIP",             "Parsed from Delivery Location"),
      ("Recipient Country Code", "(fixed: USA)",              "Always USA"),
      ("Delivery Month",         "Delivery Date \u2013 Month",   "Numeric MM"),
      ("Delivery Day",           "Delivery Date \u2013 Day",     "Numeric DD"),
      ("Delivery Year",          "Delivery Date \u2013 Year",    "4-digit YYYY"),
      ("Card Message",           "Card Message",             ""),
      ("Product Code 1",         "Product Item Number",      ""),
      ("Delivery Instructions",  "Delivery Time",            ""),
      ("Additional Information", "For the Passing Of",       ""),
    };

    foreach (var (woi, ocr, notes) in rows)
    {
      int rowIdx = _fieldMapGrid.Rows.Add(woi, ocr, notes);
      var row    = _fieldMapGrid.Rows[rowIdx];

      if (RemappableWoiFields.Contains(woi))
      {
        var combo = new DataGridViewComboBoxCell { FlatStyle = FlatStyle.Flat };
        foreach (var opt in OcrSourceOptions) combo.Items.Add(opt);
        combo.Value            = ocr;
        row.Cells["OcrSource"] = combo;
        row.Cells["WoiField"].Style.BackColor = Color.FromArgb(225, 236, 255);
        row.Cells["WoiField"].Style.Font      = new Font("Segoe UI", 8.5f, FontStyle.Bold);
      }
      else
      {
        row.Cells["OcrSource"].ReadOnly            = true;
        row.Cells["OcrSource"].Style.BackColor     = Color.FromArgb(242, 242, 242);
        row.Cells["OcrSource"].Style.ForeColor     = Color.Gray;
        row.Cells["Notes"].ReadOnly                = true;
      }
    }

    page.Controls.Add(_fieldMapGrid);
    page.Controls.Add(toolbar);
    return page;
  }

  private void LoadFieldMap()
  {
    var cfg = AppConfig.Load(ConfigPath);
    foreach (DataGridViewRow row in _fieldMapGrid.Rows)
    {
      if (row.IsNewRow) continue;
      var woi = row.Cells["WoiField"].Value?.ToString() ?? string.Empty;
      if (!RemappableWoiFields.Contains(woi)) continue;
      if (cfg.FieldMap.TryGetValue(woi, out var src))
        row.Cells["OcrSource"].Value = src;
    }
  }

  private void SaveFieldMap()
  {
    var cfg = AppConfig.Load(ConfigPath);
    foreach (DataGridViewRow row in _fieldMapGrid.Rows)
    {
      if (row.IsNewRow) continue;
      var woi = row.Cells["WoiField"].Value?.ToString() ?? string.Empty;
      if (!RemappableWoiFields.Contains(woi)) continue;
      cfg.FieldMap[woi] = row.Cells["OcrSource"].Value?.ToString() ?? "(none)";
    }
    cfg.Save(ConfigPath);
    SetFooterStatus("Field mappings saved.", false);
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

  // ── Service log viewer ────────────────────────────────────────────────────────

  private void LoadServiceLogs()
  {
    ReadLogInto(_outLogBox, OutLogPath);
    ReadLogInto(_errLogBox, ErrLogPath);
  }

  private static void ReadLogInto(RichTextBox box, string path)
  {
    string text;
    if (!File.Exists(path))
    {
      text = $"(log file not found: {path})";
    }
    else
    {
      try
      {
        // Open with FileShare.ReadWrite so we don't block the service writing to it
        using var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
        using var sr = new StreamReader(fs, System.Text.Encoding.UTF8);
        var all = sr.ReadToEnd();
        // Keep last 2000 lines to stay responsive
        var lines = all.Split('\n');
        text = lines.Length > 2000
          ? string.Join('\n', lines[^2000..])
          : all;
      }
      catch (Exception ex)
      {
        text = $"(error reading log: {ex.Message})";
      }
    }

    var shouldScroll = (box.Tag as CheckBox)?.Checked ?? true;
    box.Text = text;
    if (shouldScroll && box.TextLength > 0)
    {
      box.SelectionStart = box.TextLength;
      box.ScrollToCaret();
    }
  }

  private void StartLogTailTimer(TabControl tc)
  {
    if (_logTailTimer is not null) return;
    _logTailTimer = new System.Windows.Forms.Timer { Interval = 3000 };
    _logTailTimer.Tick += (_, _) =>
    {
      if (tc.SelectedIndex == 3) LoadServiceLogs();
      else StopLogTailTimer();
    };
    _logTailTimer.Start();
  }

  private void StopLogTailTimer()
  {
    _logTailTimer?.Stop();
    _logTailTimer?.Dispose();
    _logTailTimer = null;
  }

  // ── Pending files management ──────────────────────────────────────────────────

  private void ScanPendingFiles()
  {
    _pendingFilesList.Items.Clear();

    var cfg    = AppConfig.Load(ConfigPath);
    var folder = cfg.WatchFolder;
    var processed = cfg.ProcessedSubfolder;

    if (!Directory.Exists(folder))
    {
      _pendingCountLabel.Text = "(watch folder not found)";
      return;
    }

    var patterns = cfg.FileFormat == "TIF"
      ? new[] { "*.tif", "*.tiff" }
      : new[] { "*.pdf" };

    var processedPath = Path.Combine(folder, processed) + Path.DirectorySeparatorChar;

    var files = patterns
      .SelectMany(p => Directory.GetFiles(folder, p, SearchOption.TopDirectoryOnly))
      .Where(f => !f.StartsWith(processedPath, StringComparison.OrdinalIgnoreCase))
      .OrderBy(f => f)
      .ToList();

    foreach (var f in files)
      _pendingFilesList.Items.Add(f);

    _pendingCountLabel.Text = files.Count == 0
      ? "(none)"
      : $"{files.Count} file{(files.Count != 1 ? "s" : "")} waiting";
  }

  private void PreviewFileFields()
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

    // Refresh the scan first — the service may have already moved the file
    if (!File.Exists(selected))
    {
      ScanPendingFiles();
      SetFooterStatus($"File no longer in watch folder (already processed?): {Path.GetFileName(selected)}", isError: true);
      return;
    }

    SetFooterStatus($"Running OCR on {Path.GetFileName(selected)}...", isError: false);
    Application.DoEvents();

    try
    {
      var psi = new ProcessStartInfo(NodeExePath)
      {
        RedirectStandardOutput = true,
        RedirectStandardError  = true,
        UseShellExecute        = false,
        CreateNoWindow         = true,
        // WorkingDirectory must be the service folder so tesseract.js can find eng.traineddata
        WorkingDirectory       = Path.GetDirectoryName(ServiceScript)!,
      };
      psi.ArgumentList.Add(ServiceScript);
      psi.ArgumentList.Add($"--extract-only={selected}");

      using var proc = Process.Start(psi)!;
      var stdout = proc.StandardOutput.ReadToEnd();
      var stderr = proc.StandardError.ReadToEnd();
      proc.WaitForExit();

      if (proc.ExitCode != 0)
      {
        // Show full error in a dialog so it is not truncated by the footer label
        var fullError = (stderr.Trim().Length > 0 ? stderr : stdout).Trim();
        MessageBox.Show(fullError, "OCR Preview Failed", MessageBoxButtons.OK, MessageBoxIcon.Error);
        SetFooterStatus("OCR preview failed — see error dialog.", isError: true);
        return;
      }

      // Parse the envelope: { rawText: "...", fields: { ... } }
      var envelope = System.Text.Json.JsonDocument.Parse(stdout);
      var root     = envelope.RootElement;

      var rawText = root.TryGetProperty("rawText", out var rt) ? rt.GetString() ?? string.Empty : stdout;

      var fields = new Dictionary<string, string?>();
      if (root.TryGetProperty("fields", out var fObj))
        foreach (var prop in fObj.EnumerateObject())
          fields[prop.Name] = prop.Value.ValueKind == System.Text.Json.JsonValueKind.Null
            ? null : prop.Value.GetString();

      ShowFieldPreviewDialog(Path.GetFileName(selected), fields, rawText);
      SetFooterStatus(string.Empty, isError: false);
    }
    catch (Exception ex)
    {
      SetFooterStatus($"Preview failed: {ex.Message}", isError: true);
    }
  }

  private static void ShowFieldPreviewDialog(string fileName, Dictionary<string, string?> fields, string rawText)
  {
    // WOI field name → internal JSON key mapping
    var woiMap = new (string WoiLabel, string JsonKey)[]
    {
      ("Bill Name",              "customerName"),
      ("Bill Address1",          "customerAddress"),
      ("Bill Phone",             "customerPhone"),
      ("Recipient Name",         "deliveryLocation"),
      ("Delivery Date",          "deliveryDate"),
      ("Delivery Time",          "deliveryTime"),
      ("Card Message",           "cardMessage"),
      ("Product Code / Item #",  "productItemNumber"),
      ("Product Description",    "productDescription"),
      ("Product Price",          "productPrice"),
      ("Delivery Charge",        "deliveryCharge"),
      ("Total Payable",          "totalPayable"),
      ("Order Number",           "orderNumber"),
      ("Order Placed Date",      "orderPlacedDate"),
      ("Vendor Name",            "vendorName"),
      ("Vendor Tel",             "vendorTel"),
      ("Vendor Fax",             "vendorFax"),
      ("Vendor SMS",             "vendorSms"),
      ("For the Passing Of",     "forThePassingOf"),
    };

    var dlg = new Form
    {
      Text            = $"Extracted Fields \u2014 {fileName}",
      Size            = new Size(660, 600),
      MinimumSize     = new Size(500, 420),
      StartPosition   = FormStartPosition.CenterParent,
      FormBorderStyle = FormBorderStyle.Sizable,
      BackColor       = Color.White,
      Font            = new Font("Segoe UI", 9f),
    };

    var infoBar = new Label
    {
      Text      = $"OCR extraction results for: {fileName}  \u2014  values shown are what will be sent to Mercury WOI.",
      Dock      = DockStyle.Top,
      Height    = 36,
      Padding   = new Padding(10, 10, 10, 0),
      Font      = new Font("Segoe UI", 8.5f, FontStyle.Italic),
      ForeColor = Color.FromArgb(100, 80, 0),
      BackColor = Color.FromArgb(255, 251, 220),
    };

    // ── Fields tab ────────────────────────────────────────────────────────────
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
    grid.ColumnHeadersDefaultCellStyle.BackColor = Color.FromArgb(26, 58, 92);
    grid.ColumnHeadersDefaultCellStyle.ForeColor = Color.White;
    grid.ColumnHeadersDefaultCellStyle.Font      = new Font("Segoe UI", 8.5f, FontStyle.Bold);
    grid.EnableHeadersVisualStyles               = false;
    grid.ColumnHeadersHeight                     = 28;
    grid.AlternatingRowsDefaultCellStyle.BackColor = Color.FromArgb(248, 249, 250);
    grid.Columns.Add(new DataGridViewTextBoxColumn { HeaderText = "WOI Field",       Name = "Field",  FillWeight = 36 });
    grid.Columns.Add(new DataGridViewTextBoxColumn { HeaderText = "Extracted Value", Name = "Value",  FillWeight = 64 });

    foreach (var (label, key) in woiMap)
    {
      fields.TryGetValue(key, out var val);
      var rowIndex = grid.Rows.Add(label, val ?? string.Empty);
      if (string.IsNullOrWhiteSpace(val))
        grid.Rows[rowIndex].DefaultCellStyle.ForeColor = Color.Silver;
    }

    var fieldsPage = new TabPage("Mapped Fields");
    fieldsPage.Controls.Add(grid);

    // ── Raw OCR tab ───────────────────────────────────────────────────────────
    var rawBox = new TextBox
    {
      Dock        = DockStyle.Fill,
      Multiline   = true,
      ScrollBars  = ScrollBars.Both,
      ReadOnly    = true,
      Font        = new Font("Consolas", 8.5f),
      BackColor   = Color.FromArgb(30, 30, 30),
      ForeColor   = Color.FromArgb(212, 212, 212),
      BorderStyle = BorderStyle.None,
      WordWrap    = false,
      Text        = rawText,
    };
    var rawPage = new TabPage("Raw OCR Text");
    rawPage.Controls.Add(rawBox);

    var tabs = new TabControl { Dock = DockStyle.Fill };
    tabs.TabPages.Add(fieldsPage);
    tabs.TabPages.Add(rawPage);

    var closeBtn = new Button
    {
      Text      = "Close",
      Width     = 80,
      Height    = 28,
      Anchor    = AnchorStyles.Bottom | AnchorStyles.Right,
      FlatStyle = FlatStyle.System,
    };
    closeBtn.Click += (_, _) => dlg.Close();

    var btnPanel = new Panel { Dock = DockStyle.Bottom, Height = 40, BackColor = Color.White };
    btnPanel.Controls.Add(closeBtn);
    btnPanel.Layout += (_, _) =>
      closeBtn.Location = new Point(btnPanel.ClientSize.Width - closeBtn.Width - 10, 6);

    // Fill control (tabs) must be added first; header/footer dock before it fills
    dlg.Controls.Add(tabs);
    dlg.Controls.Add(infoBar);
    dlg.Controls.Add(btnPanel);
    dlg.ShowDialog();
    dlg.Dispose();
  }

  private void ProcessSelectedFiles()
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

        using var proc = Process.Start(psi)!;
        var stdout = proc.StandardOutput.ReadToEnd();
        var stderr = proc.StandardError.ReadToEnd();
        proc.WaitForExit(120_000);

        if (proc.ExitCode == 0)
        {
          ok++;
        }
        else
        {
          fail++;
          // Show the most useful error line — prefer stderr, fall back to stdout
          var errText = (stderr.Trim().Length > 0 ? stderr : stdout).Trim();
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
    // else: leave the individual failure message visible
  }

  // ── Service control ───────────────────────────────────────────────────────────

  private void RefreshServiceStatus()
  {
    var status = QueryServiceState();
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
    try
    {
      using var proc = Process.Start(new ProcessStartInfo("sc.exe", $"{command} \"{ServiceName}\"")
      {
        RedirectStandardOutput = true,
        RedirectStandardError  = true,
        UseShellExecute        = false,
        CreateNoWindow         = true,
      })!;
      var stdout = proc.StandardOutput.ReadToEnd();
      var stderr = proc.StandardError.ReadToEnd();
      proc.WaitForExit(15_000);

      if (proc.ExitCode != 0)
      {
        var detail = string.IsNullOrWhiteSpace(stderr) ? stdout : stderr;
        SetFooterStatus($"sc {command} failed (code {proc.ExitCode}): {detail.Trim()}", isError: true);
      }
    }
    catch (Exception ex)
    {
      MessageBox.Show($"Service command failed:\n{ex.Message}", "Error",
        MessageBoxButtons.OK, MessageBoxIcon.Error);
    }
    finally
    {
      System.Threading.Thread.Sleep(800);
      RefreshServiceStatus();
    }
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
