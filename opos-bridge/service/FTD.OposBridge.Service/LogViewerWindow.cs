using System.Drawing;
using System.Globalization;
using System.Text;
using System.Windows.Forms;

namespace FTD.OposBridge.Service;

public sealed class LogViewerWindow : Form
{
  private string _logFilePath;
  private readonly TextBox _logText;
  private readonly TextBox _filterText;
  private readonly Button _wordWrapButton;
  private readonly CheckBox _autoRefreshToggle;
  private readonly CheckBox _showLatestToggle;
  private readonly Label _statusLabel;
  private readonly System.Windows.Forms.Timer _refreshTimer;
  private long _lastLength = -1;
  private DateTime _lastWriteUtc = DateTime.MinValue;
  private string _rawLogText = "";
  private string _statusPrefix = "Loading logs...";
  private bool _wordWrapEnabled;
  private bool _autoRefreshEnabled = true;
  private bool _showLatestEnabled = true;

  public LogViewerWindow(string logFilePath, string title)
  {
    _logFilePath = logFilePath;
    Text = title;
    Width = 980;
    Height = 640;
    StartPosition = FormStartPosition.CenterScreen;
    MinimumSize = new Size(640, 420);

    var topPanel = new FlowLayoutPanel
    {
      Dock = DockStyle.Top,
      Height = 40,
      Padding = new Padding(8, 6, 8, 4),
      AutoSize = false,
      FlowDirection = FlowDirection.LeftToRight,
      WrapContents = false,
    };
    var refreshButton = new Button
    {
      Text = "Refresh",
      AutoSize = true,
      AutoSizeMode = AutoSizeMode.GrowAndShrink,
    };
    refreshButton.Click += (_, _) => RefreshFromFile(force: true);
    topPanel.Controls.Add(refreshButton);

    _autoRefreshToggle = new CheckBox
    {
      Text = "Auto Refresh",
      AutoSize = true,
      Checked = true,
      Margin = new Padding(10, 8, 0, 0),
    };
    _autoRefreshToggle.CheckedChanged += (_, _) =>
    {
      _autoRefreshEnabled = _autoRefreshToggle.Checked;
      if (_autoRefreshEnabled)
      {
        RefreshFromFile(force: true);
      }
    };
    topPanel.Controls.Add(_autoRefreshToggle);

    _showLatestToggle = new CheckBox
    {
      Text = "Show Latest",
      AutoSize = true,
      Checked = true,
      Margin = new Padding(10, 8, 0, 0),
    };
    _showLatestToggle.CheckedChanged += (_, _) =>
    {
      _showLatestEnabled = _showLatestToggle.Checked;
      if (_showLatestEnabled)
      {
        ScrollToLatest();
      }
    };
    topPanel.Controls.Add(_showLatestToggle);

    _wordWrapButton = new Button
    {
      Text = "Word Wrap: Off",
      AutoSize = true,
      AutoSizeMode = AutoSizeMode.GrowAndShrink,
      Margin = new Padding(8, 0, 0, 0),
    };
    _wordWrapButton.Click += (_, _) => ToggleWordWrap();
    topPanel.Controls.Add(_wordWrapButton);

    var filterLabel = new Label
    {
      Text = "Filter:",
      AutoSize = true,
      TextAlign = ContentAlignment.MiddleLeft,
      Margin = new Padding(14, 8, 4, 0),
    };
    topPanel.Controls.Add(filterLabel);

    _filterText = new TextBox
    {
      Width = 420,
      Margin = new Padding(0, 4, 0, 0),
    };
    _filterText.TextChanged += (_, _) => ApplyFilterToView(scrollToEnd: false);
    topPanel.Controls.Add(_filterText);

    _statusLabel = new Label
    {
      Dock = DockStyle.Bottom,
      Height = 24,
      TextAlign = ContentAlignment.MiddleLeft,
      Padding = new Padding(8, 0, 8, 0),
      ForeColor = Color.FromArgb(76, 86, 97),
      Text = "Loading logs...",
    };

    _logText = new TextBox
    {
      Dock = DockStyle.Fill,
      Multiline = true,
      ReadOnly = true,
      ScrollBars = ScrollBars.Both,
      WordWrap = false,
      Font = new Font("Consolas", 9f, FontStyle.Regular, GraphicsUnit.Point),
      BackColor = Color.White,
      ForeColor = Color.FromArgb(30, 36, 42),
    };

    Controls.Add(_logText);
    Controls.Add(_statusLabel);
    Controls.Add(topPanel);

    _refreshTimer = new System.Windows.Forms.Timer
    {
      Interval = 1200,
    };
    _refreshTimer.Tick += (_, _) =>
    {
      if (!_autoRefreshEnabled)
      {
        return;
      }

      RefreshFromFile();
    };
    _refreshTimer.Start();

    Shown += (_, _) => RefreshFromFile(force: true);
    FormClosed += (_, _) =>
    {
      _refreshTimer.Stop();
      _refreshTimer.Dispose();
    };
  }

  public static LogViewerWindow ShowOrFocus(
    LogViewerWindow? existing,
    string logFilePath,
    string title)
  {
    if (existing is { IsDisposed: false })
    {
      existing.SetLogFilePath(logFilePath);
      existing.RefreshFromFile(force: true);
      if (!existing.Visible)
      {
        existing.Show();
      }

      if (existing.WindowState == FormWindowState.Minimized)
      {
        existing.WindowState = FormWindowState.Normal;
      }

      existing.Activate();
      return existing;
    }

    var window = new LogViewerWindow(logFilePath, title);
    window.Show();
    window.Activate();
    return window;
  }

  public void SetLogFilePath(string logFilePath)
  {
    var nextPath = (logFilePath ?? "").Trim();
    if (string.IsNullOrWhiteSpace(nextPath))
    {
      return;
    }

    if (string.Equals(_logFilePath, nextPath, StringComparison.OrdinalIgnoreCase))
    {
      return;
    }

    _logFilePath = nextPath;
    _lastLength = -1;
    _lastWriteUtc = DateTime.MinValue;
    _rawLogText = "";
    _statusPrefix = $"Loading logs from: {_logFilePath}";
  }

  public void RefreshFromFile(bool force = false)
  {
    try
    {
      if (!File.Exists(_logFilePath))
      {
        _rawLogText = "";
        _statusPrefix = $"Log file not found yet: {_logFilePath}";
        ApplyFilterToView(scrollToEnd: false);
        _lastLength = -1;
        _lastWriteUtc = DateTime.MinValue;
        return;
      }

      var fileInfo = new FileInfo(_logFilePath);
      var length = fileInfo.Length;
      var writeUtc = fileInfo.LastWriteTimeUtc;
      if (!force && length == _lastLength && writeUtc == _lastWriteUtc)
      {
        return;
      }

      _rawLogText = ReadAllTextShared(_logFilePath);
      _statusPrefix = $"File: {_logFilePath}  |  {length:N0} bytes  |  Updated {fileInfo.LastWriteTime:g}";
      ApplyFilterToView(scrollToEnd: true);

      _lastLength = length;
      _lastWriteUtc = writeUtc;
    }
    catch (Exception ex)
    {
      _statusPrefix = $"Unable to load logs: {ex.Message}";
      _rawLogText = "";
      ApplyFilterToView(scrollToEnd: false);
    }
  }

  private void ToggleWordWrap()
  {
    _wordWrapEnabled = !_wordWrapEnabled;
    _logText.WordWrap = _wordWrapEnabled;
    _logText.ScrollBars = _wordWrapEnabled ? ScrollBars.Vertical : ScrollBars.Both;
    _wordWrapButton.Text = _wordWrapEnabled ? "Word Wrap: On" : "Word Wrap: Off";
  }

  private void ApplyFilterToView(bool scrollToEnd)
  {
    var filter = (_filterText.Text ?? "").Trim();
    var content = BuildFilteredContent(_rawLogText, filter, out var totalLines, out var matchedLines);
    _logText.Text = content;
    if (scrollToEnd && _showLatestEnabled)
    {
      ScrollToLatest();
    }

    if (string.IsNullOrWhiteSpace(filter))
    {
      _statusLabel.Text = $"{_statusPrefix}  |  Lines: {totalLines.ToString("N0", CultureInfo.InvariantCulture)}";
      return;
    }

    _statusLabel.Text = $"{_statusPrefix}  |  Filter: \"{filter}\"  |  Matches: {matchedLines.ToString("N0", CultureInfo.InvariantCulture)}/{totalLines.ToString("N0", CultureInfo.InvariantCulture)}";
  }

  private static string BuildFilteredContent(
    string source,
    string filter,
    out int totalLines,
    out int matchedLines)
  {
    totalLines = 0;
    matchedLines = 0;
    if (string.IsNullOrEmpty(source))
    {
      return "";
    }

    var hasFilter = !string.IsNullOrWhiteSpace(filter);
    var sb = new StringBuilder(source.Length);
    using var reader = new StringReader(source);
    string? line;
    while ((line = reader.ReadLine()) is not null)
    {
      totalLines++;
      if (hasFilter && line.IndexOf(filter, StringComparison.OrdinalIgnoreCase) < 0)
      {
        continue;
      }

      matchedLines++;
      if (sb.Length > 0)
      {
        sb.AppendLine();
      }

      sb.Append(line);
    }

    if (!hasFilter)
    {
      matchedLines = totalLines;
    }

    return sb.ToString();
  }

  private static string ReadAllTextShared(string path)
  {
    using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
    using var reader = new StreamReader(stream, Encoding.UTF8, detectEncodingFromByteOrderMarks: true);
    return reader.ReadToEnd();
  }

  private void ScrollToLatest()
  {
    if (IsDisposed || !_showLatestEnabled)
    {
      return;
    }

    void Scroll()
    {
      if (IsDisposed)
      {
        return;
      }

      _logText.SelectionStart = _logText.TextLength;
      _logText.SelectionLength = 0;
      _logText.ScrollToCaret();
    }

    if (InvokeRequired)
    {
      BeginInvoke((Action)Scroll);
      return;
    }

    Scroll();
    BeginInvoke((Action)Scroll);
  }
}
