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

  [JsonPropertyName("fieldMap")]
  public Dictionary<string, string> FieldMap { get; set; } = new()
  {
    ["Bill Name"]              = "Customer Name",
    ["Recipient Name"]         = "For the Passing Of",
    ["Card Message"]           = "Card Message",
    ["Product Code 1"]         = "Product Item Number",
    ["Delivery Instructions"]  = "Delivery Time",
    ["Additional Information"] = "For the Passing Of",
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

internal sealed class EmailConfig
{
  [JsonPropertyName("senderAddress")]
  public string SenderAddress { get; set; } = "oliverflowershop71440@gmail.com";

  [JsonPropertyName("senderPassword")]
  public string SenderPassword { get; set; } = string.Empty;

  [JsonPropertyName("recipientAddress")]
  public string RecipientAddress { get; set; } = "ftdpos71440@oliverflowers.com";

  [JsonPropertyName("subjectLine")]
  public string SubjectLine { get; set; } = "Online Order";

  [JsonPropertyName("smtpHost")]
  public string SmtpHost { get; set; } = "smtp.gmail.com";

  [JsonPropertyName("smtpPort")]
  public int SmtpPort { get; set; } = 587;

  [JsonPropertyName("woiEncryption")]
  public WoiEncryptionConfig WoiEncryption { get; set; } = new();
}

internal sealed class WoiEncryptionConfig
{
  [JsonPropertyName("algorithm")]
  public string Algorithm { get; set; } = "None";

  [JsonPropertyName("password")]
  public string Password { get; set; } = string.Empty;
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
