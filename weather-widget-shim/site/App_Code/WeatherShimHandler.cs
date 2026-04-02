using System;
using System.Collections;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Net;
using System.Text;
using System.Web;
using System.Web.Script.Serialization;
using System.Xml;

public sealed class WeatherShimHandler : IHttpHandler
{
    private const string SearchPath = "/search/search";
    private const string LocalWeatherPrefix = "/weather/local/";

    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
    private static readonly ConcurrentDictionary<string, GeoPoint> TokenCache =
        new ConcurrentDictionary<string, GeoPoint>(StringComparer.OrdinalIgnoreCase);

    static WeatherShimHandler()
    {
        // Ensure HTTPS calls to Open-Meteo succeed on older framework defaults.
        ServicePointManager.SecurityProtocol |= (SecurityProtocolType)3072;
    }

    public bool IsReusable
    {
        get { return true; }
    }

    public void ProcessRequest(HttpContext context)
    {
        var path = context.Request.Url != null ? context.Request.Url.AbsolutePath : context.Request.Path;
        path = path ?? "/";

        context.Response.Headers["Cache-Control"] = "no-cache, no-store, must-revalidate";
        context.Response.Headers["Pragma"] = "no-cache";
        context.Response.Headers["Expires"] = "0";

        try
        {
            if (path.StartsWith(SearchPath, StringComparison.OrdinalIgnoreCase))
            {
                HandleSearch(context);
                return;
            }

            if (path.StartsWith(LocalWeatherPrefix, StringComparison.OrdinalIgnoreCase))
            {
                HandleWeather(context, path);
                return;
            }

            WriteErrorXml(context, 404, "Unsupported XOAP shim path: " + path);
        }
        catch (Exception ex)
        {
            WriteErrorXml(context, 200, "Shim exception: " + ex.Message);
        }
    }

    private static void HandleSearch(HttpContext context)
    {
        var where = (context.Request.QueryString["where"] ?? string.Empty).Trim();

        context.Response.StatusCode = 200;
        context.Response.ContentType = "text/xml";

        using (var writer = CreateXmlWriter(context.Response.OutputStream))
        {
            writer.WriteStartDocument();
            writer.WriteStartElement("search");
            writer.WriteAttributeString("ver", "3.0");

            if (!string.IsNullOrWhiteSpace(where))
            {
                var point = ResolveGeoPoint(where);
                if (point != null)
                {
                    var locationId = BuildLocationId(point);
                    TokenCache["ID:" + locationId] = point;

                    writer.WriteStartElement("loc");
                    writer.WriteAttributeString("id", locationId);
                    writer.WriteAttributeString("type", "1");
                    writer.WriteString(point.DisplayName);
                    writer.WriteEndElement();
                }
            }

            writer.WriteEndElement();
            writer.WriteEndDocument();
        }
    }

    private static void HandleWeather(HttpContext context, string path)
    {
        if (!string.IsNullOrWhiteSpace(context.Request.QueryString["link"]))
        {
            WriteLinksXml(context);
            return;
        }

        var token = path.Substring(LocalWeatherPrefix.Length).Trim('/');
        if (token.Contains("/"))
        {
            token = token.Substring(0, token.IndexOf("/", StringComparison.Ordinal));
        }

        token = HttpUtility.UrlDecode(token ?? string.Empty) ?? string.Empty;

        var metric = string.Equals(context.Request.QueryString["unit"], "m", StringComparison.OrdinalIgnoreCase);

        var point = ResolveLocationToken(token);
        if (point == null)
        {
            // Keep XOAP-compatible semantics: 200 + error XML body.
            WriteErrorXml(context, 200, "Location not found for token: " + token);
            return;
        }

        var data = LoadWeather(point, metric);
        WriteWeatherXml(context, point, BuildLocationId(point), data, metric);
    }

    private static GeoPoint ResolveLocationToken(string token)
    {
        if (string.IsNullOrWhiteSpace(token))
        {
            return ResolveGeoPoint("60515");
        }

        GeoPoint cached;
        if (TokenCache.TryGetValue("ID:" + token, out cached))
        {
            return cached;
        }

        GeoPoint decoded;
        if (TryParseLocationId(token, out decoded))
        {
            TokenCache["ID:" + token] = decoded;
            return decoded;
        }

        if (IsLikelyPostalCode(token))
        {
            return ResolveGeoPoint(token);
        }

        // Some legacy IDs are not geocodable (for example USIL0225).
        var resolved = ResolveGeoPoint(token);
        if (resolved != null)
        {
            return resolved;
        }

        return ResolveGeoPoint("60515");
    }

    private static GeoPoint ResolveGeoPoint(string query)
    {
        query = (query ?? string.Empty).Trim();
        if (query.Length == 0)
        {
            return null;
        }

        GeoPoint cached;
        var cacheKey = "Q:" + query.ToUpperInvariant();
        if (TokenCache.TryGetValue(cacheKey, out cached))
        {
            return cached;
        }

        var url = "https://geocoding-api.open-meteo.com/v1/search?count=1&language=en&format=json&countryCode=US&name=" +
                  HttpUtility.UrlEncode(query);

        var root = FetchJson(url);
        var results = GetList(root, "results");
        var point = BuildPointFromOpenMeteoResult(results, query);
        if (point == null)
        {
            point = ResolveGeoPointViaNominatim(query);
        }
        if (point == null)
        {
            return null;
        }

        TokenCache[cacheKey] = point;
        return point;
    }

    private static GeoPoint BuildPointFromOpenMeteoResult(IList results, string originalQuery)
    {
        if (results == null || results.Count == 0)
        {
            return null;
        }

        var first = results[0] as Dictionary<string, object>;
        if (first == null)
        {
            return null;
        }

        return new GeoPoint
        {
            Latitude = GetDouble(first, "latitude"),
            Longitude = GetDouble(first, "longitude"),
            City = Coalesce(GetString(first, "name"), originalQuery),
            State = Coalesce(GetString(first, "admin1"), GetString(first, "country"), "Unknown"),
            CountryCode = Coalesce(GetString(first, "country_code"), "US")
        };
    }

    private static GeoPoint ResolveGeoPointViaNominatim(string query)
    {
        var cleaned = (query ?? string.Empty).Trim();
        if (cleaned.Length == 0)
        {
            return null;
        }

        var nominatimUrl = "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=us&q=" +
                           HttpUtility.UrlEncode(cleaned);

        var request = (HttpWebRequest)WebRequest.Create(nominatimUrl);
        request.Method = "GET";
        request.Timeout = 10000;
        request.ReadWriteTimeout = 10000;
        request.UserAgent = "FTD-XOAP-Shim/1.0 (+localhost)";

        using (var response = (HttpWebResponse)request.GetResponse())
        using (var stream = response.GetResponseStream())
        using (var reader = new StreamReader(stream ?? Stream.Null))
        {
            var json = reader.ReadToEnd();
            var root = Json.DeserializeObject(json) as IList;
            if (root == null || root.Count == 0)
            {
                return null;
            }

            var first = root[0] as Dictionary<string, object>;
            if (first == null)
            {
                return null;
            }

            var lat = ParseDouble(GetString(first, "lat"));
            var lon = ParseDouble(GetString(first, "lon"));
            if (Math.Abs(lat) < 0.0001 && Math.Abs(lon) < 0.0001)
            {
                return null;
            }

            var displayName = GetString(first, "display_name");
            var city = cleaned;
            var state = "Unknown";
            if (!string.IsNullOrWhiteSpace(displayName))
            {
                var parts = displayName.Split(',');
                if (parts.Length >= 2)
                {
                    city = parts[0].Trim();
                    state = parts[1].Trim();
                }
                else
                {
                    city = displayName.Trim();
                }
            }

            return new GeoPoint
            {
                Latitude = lat,
                Longitude = lon,
                City = city,
                State = state,
                CountryCode = "US"
            };
        }
    }

    private static WeatherPayload LoadWeather(GeoPoint point, bool metric)
    {
        var tempUnit = metric ? "celsius" : "fahrenheit";
        var windUnit = metric ? "kmh" : "mph";

        var url = string.Format(
            CultureInfo.InvariantCulture,
            "https://api.open-meteo.com/v1/forecast?latitude={0}&longitude={1}&forecast_days=5&timezone=auto&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m,wind_direction_10m,is_day&daily=weather_code,temperature_2m_max,temperature_2m_min&temperature_unit={2}&wind_speed_unit={3}",
            point.Latitude,
            point.Longitude,
            tempUnit,
            windUnit);

        var root = FetchJson(url);
        var current = GetDictionary(root, "current");
        var daily = GetDictionary(root, "daily");

        var currentCode = GetInt(current, "weather_code");
        var isDay = GetInt(current, "is_day") == 1;
        var currentText = MapWeather(currentCode, isDay);

        var payload = new WeatherPayload
        {
            LastUpdated = DateTime.Now.ToString("M/d/yyyy h:mm tt", CultureInfo.InvariantCulture) + " Local Time",
            CurrentTemp = RoundToInt(GetDouble(current, "temperature_2m")),
            FeelsLike = RoundToInt(GetDouble(current, "apparent_temperature")),
            CurrentIcon = currentText.Icon,
            CurrentDescription = currentText.Description,
            WindSpeed = RoundToInt(GetDouble(current, "wind_speed_10m")),
            WindDirectionText = ToCardinal(GetDouble(current, "wind_direction_10m")),
            Forecast = new List<DailyForecast>()
        };

        var days = GetList(daily, "time");
        var dailyCodes = GetList(daily, "weather_code");
        var dailyHigh = GetList(daily, "temperature_2m_max");
        var dailyLow = GetList(daily, "temperature_2m_min");

        var limit = Math.Min(5, days.Count);
        for (var i = 0; i < limit; i++)
        {
            var dayDate = ParseDate(GetStringFromList(days, i), DateTime.Today.AddDays(i));
            var weatherCode = GetIntFromList(dailyCodes, i);
            var dayMap = MapWeather(weatherCode, true);
            var nightMap = MapWeather(weatherCode, false);

            payload.Forecast.Add(new DailyForecast
            {
                DayIndex = i,
                DayName = dayDate.ToString("ddd", CultureInfo.InvariantCulture),
                High = RoundToInt(GetDoubleFromList(dailyHigh, i)),
                Low = RoundToInt(GetDoubleFromList(dailyLow, i)),
                DayIcon = dayMap.Icon,
                DayDescription = dayMap.Description,
                NightIcon = nightMap.Icon,
                NightDescription = nightMap.Description
            });
        }

        return payload;
    }

    private static void WriteWeatherXml(HttpContext context, GeoPoint point, string locationId, WeatherPayload payload, bool metric)
    {
        context.Response.StatusCode = 200;
        context.Response.ContentType = "text/xml";

        using (var writer = CreateXmlWriter(context.Response.OutputStream))
        {
            writer.WriteStartDocument();
            writer.WriteStartElement("weather");
            writer.WriteAttributeString("ver", "2.0");

            writer.WriteStartElement("head");
            writer.WriteElementString("ut", metric ? "C" : "F");
            writer.WriteEndElement();

            writer.WriteStartElement("loc");
            writer.WriteAttributeString("id", locationId);
            writer.WriteElementString("dnam", point.DisplayName);
            writer.WriteEndElement();

            writer.WriteStartElement("cc");
            writer.WriteElementString("lsup", payload.LastUpdated);
            writer.WriteElementString("tmp", payload.CurrentTemp.ToString(CultureInfo.InvariantCulture));
            writer.WriteElementString("flik", payload.FeelsLike.ToString(CultureInfo.InvariantCulture));
            writer.WriteElementString("t", payload.CurrentDescription);
            writer.WriteElementString("icon", payload.CurrentIcon.ToString(CultureInfo.InvariantCulture));

            writer.WriteStartElement("wind");
            writer.WriteElementString("s", payload.WindSpeed.ToString(CultureInfo.InvariantCulture));
            writer.WriteElementString("t", payload.WindDirectionText);
            writer.WriteEndElement();

            writer.WriteEndElement();

            writer.WriteStartElement("dayf");
            writer.WriteElementString("lsup", payload.LastUpdated);

            foreach (var day in payload.Forecast)
            {
                writer.WriteStartElement("day");
                writer.WriteAttributeString("d", day.DayIndex.ToString(CultureInfo.InvariantCulture));
                writer.WriteAttributeString("t", day.DayName);
                writer.WriteElementString("hi", day.High.ToString(CultureInfo.InvariantCulture));
                writer.WriteElementString("low", day.Low.ToString(CultureInfo.InvariantCulture));

                writer.WriteStartElement("part");
                writer.WriteAttributeString("p", "d");
                writer.WriteElementString("icon", day.DayIcon.ToString(CultureInfo.InvariantCulture));
                writer.WriteElementString("t", day.DayDescription);
                writer.WriteElementString("bt", day.DayDescription);
                writer.WriteEndElement();

                writer.WriteStartElement("part");
                writer.WriteAttributeString("p", "n");
                writer.WriteElementString("icon", day.NightIcon.ToString(CultureInfo.InvariantCulture));
                writer.WriteElementString("t", day.NightDescription);
                writer.WriteElementString("bt", day.NightDescription);
                writer.WriteEndElement();

                writer.WriteEndElement();
            }

            writer.WriteEndElement();

            writer.WriteEndElement();
            writer.WriteEndDocument();
        }
    }

    private static void WriteLinksXml(HttpContext context)
    {
        context.Response.StatusCode = 200;
        context.Response.ContentType = "text/xml";

        using (var writer = CreateXmlWriter(context.Response.OutputStream))
        {
            writer.WriteStartDocument();
            writer.WriteStartElement("lnks");

            // Keep link list empty for maximum compatibility with legacy control rendering.
            // The control safely handles zero links.

            writer.WriteEndElement();
            writer.WriteEndDocument();
        }
    }

    private static void WriteErrorXml(HttpContext context, int statusCode, string message)
    {
        context.Response.StatusCode = statusCode;
        context.Response.ContentType = "text/xml";

        using (var writer = CreateXmlWriter(context.Response.OutputStream))
        {
            writer.WriteStartDocument();
            writer.WriteStartElement("error");
            writer.WriteElementString("err", message);
            writer.WriteEndElement();
            writer.WriteEndDocument();
        }
    }

    private static XmlWriter CreateXmlWriter(Stream stream)
    {
        return XmlWriter.Create(stream, new XmlWriterSettings
        {
            Encoding = new UTF8Encoding(false),
            Indent = false,
            OmitXmlDeclaration = false
        });
    }

    private static Dictionary<string, object> FetchJson(string url)
    {
        var request = (HttpWebRequest)WebRequest.Create(url);
        request.Method = "GET";
        request.Timeout = 10000;
        request.ReadWriteTimeout = 10000;

        using (var response = (HttpWebResponse)request.GetResponse())
        using (var stream = response.GetResponseStream())
        using (var reader = new StreamReader(stream ?? Stream.Null))
        {
            var json = reader.ReadToEnd();
            return Json.DeserializeObject(json) as Dictionary<string, object> ?? new Dictionary<string, object>();
        }
    }

    private static Dictionary<string, object> GetDictionary(Dictionary<string, object> root, string key)
    {
        if (root == null)
        {
            return new Dictionary<string, object>();
        }

        object value;
        if (!root.TryGetValue(key, out value))
        {
            return new Dictionary<string, object>();
        }

        return value as Dictionary<string, object> ?? new Dictionary<string, object>();
    }

    private static IList GetList(Dictionary<string, object> root, string key)
    {
        object value;
        if (root != null && root.TryGetValue(key, out value) && value is IList)
        {
            return (IList)value;
        }

        return new object[0];
    }

    private static string GetString(Dictionary<string, object> root, string key)
    {
        object value;
        if (root != null && root.TryGetValue(key, out value) && value != null)
        {
            return Convert.ToString(value, CultureInfo.InvariantCulture) ?? string.Empty;
        }

        return string.Empty;
    }

    private static string GetStringFromList(IList list, int index)
    {
        if (index < 0 || index >= list.Count)
        {
            return string.Empty;
        }

        var value = list[index];
        return value == null ? string.Empty : Convert.ToString(value, CultureInfo.InvariantCulture) ?? string.Empty;
    }

    private static double GetDouble(Dictionary<string, object> root, string key)
    {
        object value;
        if (root != null && root.TryGetValue(key, out value) && value != null)
        {
            double number;
            if (double.TryParse(Convert.ToString(value, CultureInfo.InvariantCulture), NumberStyles.Any, CultureInfo.InvariantCulture, out number))
            {
                return number;
            }
        }

        return 0;
    }

    private static double GetDoubleFromList(IList list, int index)
    {
        if (index < 0 || index >= list.Count)
        {
            return 0;
        }

        var value = list[index];
        double number;
        return value != null && double.TryParse(Convert.ToString(value, CultureInfo.InvariantCulture), NumberStyles.Any, CultureInfo.InvariantCulture, out number)
            ? number
            : 0;
    }

    private static int GetInt(Dictionary<string, object> root, string key)
    {
        return RoundToInt(GetDouble(root, key));
    }

    private static int GetIntFromList(IList list, int index)
    {
        return RoundToInt(GetDoubleFromList(list, index));
    }

    private static int RoundToInt(double value)
    {
        return Convert.ToInt32(Math.Round(value, MidpointRounding.AwayFromZero));
    }

    private static double ParseDouble(string value)
    {
        double parsed;
        return double.TryParse(value, NumberStyles.Any, CultureInfo.InvariantCulture, out parsed) ? parsed : 0;
    }

    private static DateTime ParseDate(string value, DateTime fallback)
    {
        DateTime parsed;
        if (DateTime.TryParse(value, CultureInfo.InvariantCulture, DateTimeStyles.AssumeLocal, out parsed))
        {
            return parsed;
        }

        return fallback;
    }

    private static bool IsLikelyPostalCode(string token)
    {
        token = (token ?? string.Empty).Trim();
        if (token.Length < 5 || token.Length > 10)
        {
            return false;
        }

        foreach (var ch in token)
        {
            if (!char.IsDigit(ch) && ch != '-')
            {
                return false;
            }
        }

        return true;
    }

    private static string BuildLocationId(GeoPoint point)
    {
        var payload = string.Format(
            CultureInfo.InvariantCulture,
            "{0}|{1}|{2}|{3}|{4}",
            point.Latitude,
            point.Longitude,
            point.City,
            point.State,
            point.CountryCode);

        var bytes = Encoding.UTF8.GetBytes(payload);
        var b64 = Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
        return "SHIM_" + b64;
    }

    private static bool TryParseLocationId(string token, out GeoPoint point)
    {
        point = null;
        if (string.IsNullOrWhiteSpace(token) || !token.StartsWith("SHIM_", StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        var encoded = token.Substring(5).Replace('-', '+').Replace('_', '/');
        while (encoded.Length % 4 != 0)
        {
            encoded += "=";
        }

        try
        {
            var raw = Encoding.UTF8.GetString(Convert.FromBase64String(encoded));
            var parts = raw.Split('|');
            if (parts.Length < 5)
            {
                return false;
            }

            double lat;
            double lon;
            if (!double.TryParse(parts[0], NumberStyles.Any, CultureInfo.InvariantCulture, out lat) ||
                !double.TryParse(parts[1], NumberStyles.Any, CultureInfo.InvariantCulture, out lon))
            {
                return false;
            }

            point = new GeoPoint
            {
                Latitude = lat,
                Longitude = lon,
                City = parts[2],
                State = parts[3],
                CountryCode = parts[4]
            };

            return true;
        }
        catch
        {
            return false;
        }
    }

    private static string ToCardinal(double degrees)
    {
        var directions = new[]
        {
            "N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
            "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"
        };

        var normalized = ((degrees % 360) + 360) % 360;
        var index = Convert.ToInt32(Math.Round(normalized / 22.5, MidpointRounding.AwayFromZero)) % 16;
        return directions[index];
    }

    private static WeatherLabel MapWeather(int code, bool isDay)
    {
        switch (code)
        {
            case 0:
                return new WeatherLabel(isDay ? 32 : 31, isDay ? "Sunny" : "Clear");
            case 1:
                return new WeatherLabel(isDay ? 34 : 33, isDay ? "Mostly Sunny" : "Mostly Clear");
            case 2:
                return new WeatherLabel(isDay ? 30 : 29, "Partly Cloudy");
            case 3:
                return new WeatherLabel(26, "Cloudy");
            case 45:
            case 48:
                return new WeatherLabel(20, "Fog");
            case 51:
            case 53:
            case 55:
                return new WeatherLabel(9, "Drizzle");
            case 56:
            case 57:
                return new WeatherLabel(8, "Freezing Drizzle");
            case 61:
            case 63:
            case 65:
                return new WeatherLabel(12, "Rain");
            case 66:
            case 67:
                return new WeatherLabel(10, "Freezing Rain");
            case 71:
            case 73:
            case 75:
            case 77:
                return new WeatherLabel(16, "Snow");
            case 80:
            case 81:
            case 82:
                return new WeatherLabel(39, "Rain Showers");
            case 85:
            case 86:
                return new WeatherLabel(41, "Snow Showers");
            case 95:
                return new WeatherLabel(4, "Thunderstorms");
            case 96:
            case 99:
                return new WeatherLabel(3, "Severe Thunderstorms");
            default:
                return new WeatherLabel(isDay ? 30 : 29, "Partly Cloudy");
        }
    }

    private static string Coalesce(params string[] values)
    {
        foreach (var value in values)
        {
            if (!string.IsNullOrWhiteSpace(value))
            {
                return value.Trim();
            }
        }

        return string.Empty;
    }

    private sealed class GeoPoint
    {
        public double Latitude;
        public double Longitude;
        public string City;
        public string State;
        public string CountryCode;

        public string DisplayName
        {
            get { return string.Format(CultureInfo.InvariantCulture, "{0}, {1}", City, State); }
        }
    }

    private sealed class WeatherPayload
    {
        public string LastUpdated;
        public int CurrentTemp;
        public int FeelsLike;
        public int CurrentIcon;
        public string CurrentDescription;
        public int WindSpeed;
        public string WindDirectionText;
        public List<DailyForecast> Forecast;
    }

    private sealed class DailyForecast
    {
        public int DayIndex;
        public string DayName;
        public int High;
        public int Low;
        public int DayIcon;
        public string DayDescription;
        public int NightIcon;
        public string NightDescription;
    }

    private sealed class WeatherLabel
    {
        public WeatherLabel(int icon, string description)
        {
            Icon = icon;
            Description = description;
        }

        public int Icon;
        public string Description;
    }
}
