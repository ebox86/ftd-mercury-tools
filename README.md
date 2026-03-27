<table>
  <tr>
    <td>
      <img src="public/ftd.png" alt="FTD logo" width="120" />
    </td>
    <td>
      <h1>FTD Mercury Tools</h1>
    </td>
  </tr>
</table>

Utilities and userscripts for improving workflows in FTD's Mercury client and MercuryHQ webApp.

## Available Plugins

1. **MercuryHQ - Single Request Barcode**
   - Path: `mercury-hq-delivery-barcode-lookup/mercury-hq-single-request-barcode.js`
   - Type: Tampermonkey userscript
   - Purpose: Adds Order ID/barcode lookup + autofill with split workflow tabs:
     `Single Request - Manual` and `Single Request - Autocomplete`.

## Available Extensions

1. **Tampermonkey** (required to run userscripts)

## Available Services

1. **Weather XOAP Compatibility Shim**
   - Path: `weather-xoap-shim/`
   - Type: IIS-hosted ASP.NET compatibility layer
   - Purpose: Emulates legacy `xoap.weather.com` XML endpoints for Mercury dashboard weather gadget on localhost.
2. **Pi Kiosk Dashboard Starter**
   - Path: `pi-kiosk-dashboard-starter/`
   - Type: Reference + mock-data + local Node mock server
   - Purpose: Jumpstart Raspberry Pi workflow dashboard frontend prototyping against Mercury job-stage APIs and Mercury-like contracts.

## Requirements

1. **Tampermonkey** browser extension (Chrome/Edge/Firefox).
2. Access to **MercuryHQ** and permission to use the Single Request page.
3. Network access to your Mercury API host (for example, LAN IP/hostname configured in script `CONFIG`).
4. Optional: USB/Bluetooth barcode scanner configured as keyboard input.

## Repository Structure

- `README.md` - root project documentation
- `mercury-hq-delivery-barcode-lookup/` - barcode lookup userscript and tool-specific docs
- `weather-xoap-shim/` - local XOAP weather compatibility shim + install scripts
- `pi-kiosk-dashboard-starter/` - Mercury workflow API snapshots and bogus mock objects for kiosk UI development
- `public/` - shared static assets (if needed later)

## Quick Start

1. Install the Tampermonkey extension in your browser.
2. Open the tool-specific README for install/config details:
   - `mercury-hq-delivery-barcode-lookup/README.md`

## Legal Disclaimer

> **Disclaimer**
> This is a personal project. I am not affiliated with, associated with, authorized by, endorsed by, or in any way officially connected with FTD.
> Use this project at your own risk. You are solely responsible for any changes, outcomes, or impacts in your environment.
