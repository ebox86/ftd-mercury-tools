# MercuryHQ Delivery Barcode Lookup

Tampermonkey userscript that adds a barcode-assisted workflow to MercuryHQ Single Request entry.

![Screenshot Placeholder](/public/screenshot.png)

## What This Tool Does

- Renames the native tab to **Single Request - Manual**.
- Adds a **Single Request - Autocomplete** tab in MercuryHQ.
- Lets you enter an Order ID or scan a ticket barcode.
- Calls Mercury service endpoints to resolve ticket + recipient details.
- Auto-fills Single Request form fields from service data.
- Includes default configuration (delivery instructions, phone, pickup time, etc.).
- Applies a country fallback to **United States** when the country field is unexpectedly unset.

## Prerequisites

1. Browser with **Tampermonkey** installed.
2. Access to `https://mercuryhq.com/create-delivery-service-request*`.
3. Reachable Mercury API host for your environment (LAN/IP or hostname).

## Installation

1. Open Tampermonkey and create a new script.
2. Copy/paste contents of:
   - `mercury-hq-single-request-barcode.js`
3. Save the script.
4. Visit MercuryHQ Single Request page and refresh.

## Configuration

At the top of the script, update API target values if needed:

- `CONFIG.apiProtocol`
- `CONFIG.apiHost`
- `defaultApiHost` in the in-app **Default Request Configuration** tab (enter full host/IP, e.g. `192.168.1.50`)
- `CONFIG.apiBasePath`

Note: `@connect` metadata in Tampermonkey is static and cannot be dynamically set from JavaScript variables.

## Usage

1. Open MercuryHQ Single Request.
2. Use **Single Request - Manual** for normal entry, or click **Single Request - Autocomplete**.
3. Enter Order ID or scan ticket.
4. Review auto-filled fields and submit.

## Troubleshooting

- If lookups fail from another machine, verify API host reachability, IIS bindings, and firewall rules.
- If Country appears as "Select a country", the script attempts to auto-correct to `United States`.
