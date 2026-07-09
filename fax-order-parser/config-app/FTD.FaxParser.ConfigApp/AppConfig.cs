using System.Collections.Generic;
using System.IO;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace FTD.FaxParser.ConfigApp;

internal sealed class AppConfig
{
  [JsonPropertyName("watchFolder")]
  public string WatchFolder { get; set; } = @"C:\received_faxes";

  [JsonPropertyName("pollIntervalSeconds")]
  public int PollIntervalSeconds { get; set; } = 10;

  [JsonPropertyName("fileFormat")]
  public string FileFormat { get; set; } = "PDF";

  [JsonPropertyName("processedSubfolder")]
  public string ProcessedSubfolder { get; set; } = "processed";

  [JsonPropertyName("email")]
  public EmailConfig Email { get; set; } = new();

  [JsonPropertyName("fieldBounds")]
  public Dictionary<string, FieldBoundsConfig> FieldBounds { get; set; } = new();

  [JsonPropertyName("localRelay")]
  public LocalRelayConfig LocalRelay { get; set; } = new();

  [JsonPropertyName("mailGateway")]
  public MailGatewayConfig MailGateway { get; set; } = new();

  [JsonPropertyName("processing")]
  public ProcessingConfig Processing { get; set; } = new();

  [JsonPropertyName("fieldMap")]
  public Dictionary<string, string> FieldMap { get; set; } = new()
  {
    ["Bill Name"]              = "Customer Name",
    ["Recipient Name"]         = "For the Passing Of",
    ["Card Message"]           = "Card Message",
    ["Product Code 1"]         = "Product Item Number",
    ["Delivery Instructions"]  = "Delivery Time",
    ["Additional Information"] = "For the Passing Of",
    ["Delivery Date"]          = "Delivery Date",
  };

  private static readonly JsonSerializerOptions SerializerOptions = new()
  {
    WriteIndented = true,
    PropertyNameCaseInsensitive = true,
  };

  public static AppConfig Load(string path)
  {
    if (!File.Exists(path)) return new AppConfig();
    try
    {
      var json = File.ReadAllText(path);
      return JsonSerializer.Deserialize<AppConfig>(json, SerializerOptions) ?? new AppConfig();
    }
    catch
    {
      return new AppConfig();
    }
  }

  public void Save(string path)
  {
    var dir = Path.GetDirectoryName(path)!;
    Directory.CreateDirectory(dir);
    File.WriteAllText(path, JsonSerializer.Serialize(this, SerializerOptions));
  }
}

internal sealed class LocalRelayConfig
{
  [JsonPropertyName("enabled")]
  public bool Enabled { get; set; } = true;

  [JsonPropertyName("smtpPort")]
  public int SmtpPort { get; set; } = 2525;

  [JsonPropertyName("pop3Port")]
  public int Pop3Port { get; set; } = 1110;
}

internal sealed class MailGatewayConfig
{
  [JsonPropertyName("enabled")]
  public bool Enabled { get; set; } = true;

  [JsonPropertyName("mode")]
  public string Mode { get; set; } = "built-in-relay";

  [JsonPropertyName("bindAddress")]
  public string BindAddress { get; set; } = "127.0.0.1";

  [JsonPropertyName("smtpPort")]
  public int SmtpPort { get; set; } = 2525;

  [JsonPropertyName("pop3Port")]
  public int Pop3Port { get; set; } = 1110;

  [JsonPropertyName("forwardEnabled")]
  public bool ForwardEnabled { get; set; } = true;

  [JsonPropertyName("forwardToAddress")]
  public string ForwardToAddress { get; set; } = "your-gmail-address@gmail.com";

  [JsonPropertyName("forwardSmtpHost")]
  public string ForwardSmtpHost { get; set; } = "smtp.gmail.com";

  [JsonPropertyName("forwardSmtpPort")]
  public int ForwardSmtpPort { get; set; } = 587;

  [JsonPropertyName("forwardUsername")]
  public string ForwardUsername { get; set; } = "your-gmail-address@gmail.com";

  [JsonPropertyName("forwardPassword")]
  public string ForwardPassword { get; set; } = string.Empty;
}

internal sealed class ProcessingConfig
{
  [JsonPropertyName("useOrderPlacedDateWhenDeliveryDateMissing")]
  public bool UseOrderPlacedDateWhenDeliveryDateMissing { get; set; } = true;
}

internal sealed class FieldBoundsConfig
{
  // Polygon points, each normalized to 0–1 of image width/height
  [JsonPropertyName("points")]
  public List<PointConfig>? Points { get; set; }

  // Legacy rectangle fields kept for backward-compat deserialization
  [JsonPropertyName("x")] public double? X { get; set; }
  [JsonPropertyName("y")] public double? Y { get; set; }
  [JsonPropertyName("w")] public double? W { get; set; }
  [JsonPropertyName("h")] public double? H { get; set; }

  public List<PointConfig> GetPoints()
  {
    if (Points is { Count: > 0 }) return Points;
    if (X.HasValue && Y.HasValue && W.HasValue && H.HasValue)
      return
      [
        new() { X = X.Value,            Y = Y.Value },
        new() { X = X.Value + W.Value,  Y = Y.Value },
        new() { X = X.Value + W.Value,  Y = Y.Value + H.Value },
        new() { X = X.Value,            Y = Y.Value + H.Value },
      ];
    return [];
  }
}

internal sealed class PointConfig
{
  [JsonPropertyName("x")] public double X { get; set; }
  [JsonPropertyName("y")] public double Y { get; set; }
}

internal sealed class EmailConfig
{
  [JsonPropertyName("senderAddress")]
  public string SenderAddress { get; set; } = "faxparser@localhost.local";

  [JsonPropertyName("senderPassword")]
  public string SenderPassword { get; set; } = string.Empty;

  [JsonPropertyName("smtpUsername")]
  public string SmtpUsername { get; set; } = string.Empty;

  [JsonPropertyName("recipientAddress")]
  public string RecipientAddress { get; set; } = "order@localhost.local";

  [JsonPropertyName("errorRecipientAddress")]
  public string ErrorRecipientAddress { get; set; } = "order-error@localhost.local";

  [JsonPropertyName("subjectLine")]
  public string SubjectLine { get; set; } = "Online Order";

  [JsonPropertyName("smtpHost")]
  public string SmtpHost { get; set; } = "127.0.0.1";

  [JsonPropertyName("smtpPort")]
  public int SmtpPort { get; set; } = 2525;

  [JsonPropertyName("encryptionPassword")]
  public string EncryptionPassword { get; set; } = string.Empty;

  [JsonPropertyName("encryptionAlgorithm")]
  public string EncryptionAlgorithm { get; set; } = "None";
}

internal sealed class OrderLogEntry
{
  [JsonPropertyName("timestamp")]
  public string Timestamp { get; set; } = string.Empty;

  [JsonPropertyName("fileName")]
  public string FileName { get; set; } = string.Empty;

  [JsonPropertyName("orderNumber")]
  public string? OrderNumber { get; set; }

  [JsonPropertyName("customerName")]
  public string? CustomerName { get; set; }

  [JsonPropertyName("deliveryDate")]
  public string? DeliveryDate { get; set; }

  [JsonPropertyName("emailSent")]
  public bool EmailSent { get; set; }

  [JsonPropertyName("error")]
  public string? Error { get; set; }

  [JsonPropertyName("note")]
  public string? Note { get; set; }

  [JsonPropertyName("fields")]
  public Dictionary<string, string>? Fields { get; set; }

  [JsonPropertyName("processedFilePath")]
  public string? ProcessedFilePath { get; set; }

  private static readonly JsonSerializerOptions SerializerOptions = new()
  {
    PropertyNameCaseInsensitive = true,
  };

  public static List<OrderLogEntry> LoadAll(string path)
  {
    if (!File.Exists(path)) return new List<OrderLogEntry>();
    try
    {
      var json = File.ReadAllText(path);
      return JsonSerializer.Deserialize<List<OrderLogEntry>>(json, SerializerOptions) ?? new List<OrderLogEntry>();
    }
    catch
    {
      return new List<OrderLogEntry>();
    }
  }
}
