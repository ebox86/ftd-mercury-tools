# BloomNet / Bloomlink integration — reverse-engineering findings

Status: investigation complete (read-only + decompile). No outbound wire messages
have been sent from our own code yet. This documents the protocol Mercury's own
Bloomlink desktop client uses so we can build a coexisting headless integration
(poll for orders; reject/deny and reply from our own tooling instead of the
Bloom website).

Shop: **Oliver Flower Shop**, BloomNet shop code **X2110000**.

---

## 1. The client on this machine

- Install: `C:\Program Files (x86)\BloomNet Technologies\Bloomlink Client\7.0\`
  (BloomlinkClient.exe, v7.0.8.0, .NET Framework 4.6.1 WinForms, tray + poller).
- Runtime data / logs: `C:\ProgramData\Bloomlink Client\7.0\`
  - `Network.config` — this shop's settings (shop code, user `DIALER`, password, environment, license JWT).
  - `LogonInfo.dat` — binary logon blob.
  - `BloomNetClient.log*` — rolling log (log4net). Level is forced to `ERROR` in
    `Network.config` (`OverrideLoggingLevel`), so it normally only shows failures;
    at `INFO`/`DEBUG` it logs the full request+response XML (`Request.GetMessages`
    logs `xmlSent` then the raw response — see §6).
  - `*.trdx` — Telerik report templates for printing orders/messages (define the
    printed field set; see §5).
- Notable bundled DLLs: `SocketIoClientDotNet.dll` (real-time push, lives in the
  exe), `System.Net.Http.Formatting` + `Newtonsoft.Json`, `Route4MeSDK`
  (delivery routing), `Telerik.Reporting` (printing).

### Registry / config
- Settings root: `HKLM\SOFTWARE\BloomNet\BloomNetDesktop\`.
- `BloomlinkClient.exe.config` connection strings:
  - **Production** = `https://www.bloomlink.net`
  - Staging / QA / LocalHost = `https://blink-dev.bloomlink.net`
  - Web app servlet = `/bloomjsp/Bloomlink/DefaultServer.jsp`
  - Marketplace webhook = `https://express.bloomnet.net/WebHook/GetMarketplaceShopCodes`
  - Send-order directory = `http://directory.bloomnet.net/Directory/guest.htm`
  - Report templates = `https://bms.bloomnet.net/ReportTemplates/BloomlinkClient`

---

## 2. Two separate surfaces

1. **FSI v2** (`/fsiv2/processor`) — the machine-to-machine API the desktop client
   polls. This is what we reproduce (user chose "poll like the client"). Details below.
2. **Web app** (`/bloomjsp/Bloomlink/DefaultServer.jsp`) — the browser UI. Auth is
   `application/x-www-form-urlencoded` POST; on success it sets cookies incl.
   `FLORIST_ID`, `USER_NAME`, `ROLE` (e.g. `SystemAdmin`), `USER_SYSID`,
   `AUTOPRINT_USER`, `GUID`, `JSESSIONID`. The `AUTOPRINT_USER` / SystemAdmin role
   is tied to the "printing context shifts when the admin logs in elsewhere" issue
   the shop sees — the web session that holds `AUTOPRINT_USER=1` owns auto-print.
   We are **not** targeting this surface for the integration; it is documented only
   so we understand the printing-context conflict.

---

## 3. FSI v2 transport (authoritative — from decompiled `DataAcccessTier.Polling` + `BusinessTier`)

Every call is a single **HTTP GET** whose entire payload is a URL with the XML in
the `data` query parameter:

```
GET {Address}/fsiv2/processor?func={func}&data={XML}
```

- `Address` = base URL for the environment (`https://www.bloomlink.net` for Production).
- `func` = one of: `getmessages`, `postmessages`, `getAuditInfo`, `getMemberDirectory`.
- `data` = the request XML (the client builds it as a raw concatenated string; it
  is placed straight on the query string — see `QueryTexts.cs`). Newlines are
  encoded `%0A`/`%0D`; `&` becomes `&amp;` in message text.
- Transport = `HttpClient.GetStreamAsync(url)` using the system web proxy with
  default network credentials. **No bearer/session token** — auth is the
  `<security>` block (username/password/shopCode) inside the XML itself.
- The response is XML; the client strips CR/LF, turns `&amp;` into " and ",
  removes stray `Â`, and decodes `%0A/%0D` (`Request.CleanXml`).

### Credentials (the `<security>` block)
```xml
<security>
  <username>DIALER</username>   <!-- Network.config <User> -->
  <password>********</password> <!-- Network.config <Password> -->
  <shopCode>X2110000</shopCode> <!-- Network.config <ShopCode> -->
</security>
```
These are the desktop client's own FSI credentials (not the web-app login). Keep
them out of source control — read them from `Network.config`, the registry, or an
env var at runtime.

---

## 4. Operations (func + XML) — from `Request.cs` / `QueryTexts.cs`

| Intent | `func` | Root / element | messageType | Notes |
|---|---|---|---|---|
| **Poll for pending messages** | `getmessages` | `foreignSystemInterfaceOutboundRequest` | — | returns general + ackf + order buckets, capped by `maxNumOf*` |
| Acknowledge (consume) a received msg | `postmessages` | `messageAckf` | 24 | **the consuming step** — removes the msg from the pending queue |
| **Deny / reject a received order** | `postmessages` | `messageDeni` | 6 | carries `messageText` (reason). This is how you reject an order. |
| **Free-text reply / message** | `postmessages` | `messageMesg` | 19 | carries `messageText`; keyed by order + `bmtSeqNumberOfMessage` |
| Inquiry / Response (msg thread) | `postmessages` | `messageInqr` / `messageResp` | 1 / 2 | |
| Cancellation / Confirm cancellation | `postmessages` | `messageCanc` / `messageConf` | 3 / 11 | |
| Price change | `postmessages` | `messagePchg` | 18 | adds `<price>` |
| Delivery confirmation | `postmessages` | `messageDlcf` (or `messageGenericDlcf`) | 7 | `dateOrderDelivered`, `signature`, `deliveryDetail` |
| Delivery attempted / non-delivery | `postmessages` | `messageDlca` (or generic) | 26 | reason + redelivery details |
| Send an order out (offline) | `postmessages` | `messageOrder` | 0 | full order body |
| **Read-only history (non-consuming)** | `getAuditInfo` | `auditInterface` | — | by order number, by date, by date range; `messageDirection` = Inbound/Outbound/Both |
| Member (shop) directory lookup | `getMemberDirectory` | `memberDirectoryInterface` | — | look up a shop by code |

### Full `messageType` enum (`Entities.Definitions.MessageType`)
`Order=0, Inquiry=1, Response=2, Cancellation=3, Rejection=4, Denial=6,
Delivery_Confirmation=7, Delivery_Outbound=8, Dispute=9, Confirmation=11,
Information=12, New_Tracking_Number=13, Dispute_Confirmed=14, Dispute_Denied=15,
Dispute_Rescinded=16, Dispute_Upheld=17, Price_Change=18, Message=19,
Acknowledgement_Bloomlink=23, Acknowledgement_Fulfiller=24, Delivery_Attempted=26`

> To **reject an inbound order we send `Denial` (6)**. `Rejection` (4) is a type we
> *receive*; there is no outbound RJCT builder in the client.

Other enums: `Occasions` (Funeral=1..Other=8), `WireServiceCode`
(BMT, FTD, TEL, AFS, FFX, PNH, RED), `MessageDirection`
(Inbound, Outbound, Inbound_and_Outbound), `MessageStatus` (Read/Unread/Invalidated,
abbr R/U/I).

### Example — deny (reject) an inbound order
```
GET https://www.bloomlink.net/fsiv2/processor?func=postmessages&data=
<foreignSystemInterface ...>
  <security><username>DIALER</username><password>***</password><shopCode>X2110000</shopCode></security>
  <errors/>
  <messagesOnOrder>
    <messageCount>1</messageCount>
    <messageDeni>
      <messageType>6</messageType>
      <sendingShopCode>X2110000</sendingShopCode>      <!-- us -->
      <receivingShopCode>{original sender}</receivingShopCode>
      <fulfillingShopCode>X2110000</fulfillingShopCode>
      <systemType>GENERAL</systemType>
      <identifiers><generalIdentifiers>
        <bmtOrderNumber>{order#}</bmtOrderNumber>
        <bmtSeqNumberOfOrder>{seq}</bmtSeqNumberOfOrder>
        <externalShopMessageNumber>{...}</externalShopMessageNumber>
      </generalIdentifiers></identifiers>
      <messageCreateTimestamp>yyyyMMddHHmmss</messageCreateTimestamp>
      <messageText>{reason}</messageText>
    </messageDeni>
  </messagesOnOrder>
</foreignSystemInterface>
```
`messageMesg` (reply, 19) is the same shape but sits directly under
`foreignSystemInterface` (no `messagesOnOrder` wrapper) and keys off
`bmtOrderNumber` + `bmtSeqNumberOfMessage`.

---

## 5. Order / message data model (from the `.trdx` templates)

- **Header:** `BmtOrderNumber`, `InwireSequenceNo` (the In/OutSequence counters the
  web UI shows), `MessageType`/`MessageTypeValue`/`MessageStatus`, `OccasionCode`,
  `DeliveryDate`, `SpecialInstruction`, `OrderCardMessage`, `TotalItems`,
  `TotalCostOfMerchandise`, `Price`, `MessageCreateTimestamp(Local)`, `Signature`,
  `DateOrderDelivered`, `MessageText`.
- **Shops:** `Sending` / `Receiving` / `Fulfilling` ShopCode (+ `…Detail` names).
- **Recipient:** First/Last name, Attention, Address1/2, City, State, Zip, Country, Phone.
- **Line items (repeat):** `Units`, `ProductCode`, `ProductDescription`, `Recipe`,
  `CostOfSingleProduct`.

The full XSD-derived object model is in the decompile (see §7): `orderDetails`,
`recipient`, `deliveryDetails`, `orderProductInfoDetails`, `identifiers`,
`generalIdentifiers`, plus every `message*` type.

---

## 6. Coexistence with the running desktop client (the important part)

The desktop client's live loop is: `getmessages` → parse → **`postmessages`/`messageAckf`**
(consume). Ackf removes the message from the pending queue. Two independent
consumers of the same queue race — whoever acks first "wins" the message.

**Design rules for a coexisting integration:**
- **Ingest via `getAuditInfo`, not `getmessages`.** Audit is a read-only query (by
  date / date range / order number, direction Inbound/Outbound/Both). It does not
  consume, so the desktop client keeps receiving and printing normally while we
  observe the same orders. Poll it on an interval (client default cadence is ~10 min).
- **Never send `messageAckf` from our code** while the desktop client is the
  order-taker — that would consume messages out from under it.
- **Acting (reject/reply) is safe to send.** `messageDeni` (reject) and
  `messageMesg` (reply) are outbound messages to the sending shop keyed by the
  order's identifiers; sending them does not touch the inbound pending queue, so
  they coexist with the desktop client. (Still: live-test one real case with the
  user before wiring anything automatic — see §8.)
- Real-time: the exe uses Socket.IO for instant push. Not required for us; a poll
  loop is sufficient and simpler. (Decompile the exe later if we want push.)

---

## 7. Where the decompiled source lives

`C:\RETOOLS\decompiled_bloomlink\` (ilspycmd), three assemblies:
- `BloomNetClient.DataAcccessTier\...\Polling.cs` — the HTTP GET transport.
- `BloomNetClient.BusinessTier\...\QueryTexts.cs` — every request's raw XML (source of §4).
- `BloomNetClient.BusinessTier\...\Request.cs` — `func` codes + the getmessages/ackf/audit flow.
- `BloomNetClient.BusinessTier\...\Parse.cs`, `Action.cs` — response parsing + orchestration.
- `BloomNetClient.BusinessTier\...\.XSD\*` — the full message object model.
- `BloomNetClient.Entities\...\Definitions.cs` — enums (§4); `Parameters.cs` — env→URL; `UserSettings.cs`.

Not yet decompiled: `BloomlinkClient.exe` (GUI + `ServerPoller` + Socket.IO push),
`BloomNetClient.Global.dll` (logging/CRM), `Reports`, `FlexNet` (Revenera licensing).

---

## 8. Suggested next steps (not started)

1. **Live read test (safe):** call `getAuditInfo` for today, Inbound, and confirm we
   can see the same orders the desktop client is receiving. `fsi-client.mjs` in this
   folder does exactly this and sends nothing else.
2. Model the audit/order response into our normalized order shape (reuse the
   existing normalize pipeline where it fits).
3. **Live action test (with the user, one real case):** send a single `messageMesg`
   reply, then a single `messageDeni` on a genuinely rejectable order, watching the
   Bloom web UI + `getAuditInfo` Outbound to confirm. Only then wire reject/reply
   into the normal Messages UI (mirror the Dove refuse/reply pattern).
4. Decide whether to keep observing via audit forever, or eventually become the
   order-taker (would require taking over `getmessages`/`ackf` and stopping the
   desktop client — a deliberate cutover, like Mercury/Dove).
