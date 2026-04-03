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

Utilities, services, and userscripts for improving workflows in FTD Mercury and MercuryHQ.

## Latest Updates

1. **Root cleanup + SOAP reference organization**
   - XML/WSDL reference files are now grouped under:
     - `mercury-orders-tv-dashboard/reference/soap/`
2. **Dashboard audio alerts + config UX**
   - Toggleable audio alerts on the TV dashboard
   - Default alert cadence:
     - DoorDash/UberEats events: `3` dings
     - New order for today: `1` ding
   - Config page supports:
     - Save/Cancel workflow
     - Grouped **Audio Alert Settings** (ding counts + gap + sound selection/upload)
     - Debug/test sound trigger
     - Shop logo upload with a wider/taller logo display area
3. **Release version matrix (as of 2026-04-03)**
   - Mercury Orders TV Dashboard installer: `1.1.0` (`mercury-dashboard-v1.1.0`)
   - Scanner Browser Bridge installer: `1.0.1` (`opos-bridge-v1.0.1`)
   - Scanner Browser Bridge unified installer: `1.0.0` (`opos-bridge-unified-v1.0.0`)
   - Weather Widget Shim installer: `1.0.0` (`weather-xoap-shim-v1.0.0`)
   - MercuryHQ Single Request Barcode userscript: `0.4.33`

## Components

1. **MercuryHQ Single Request Barcode (userscript)**
   - Path: `mercury-hq-delivery-barcode-lookup/`
   - Type: Tampermonkey userscript
   - README: `mercury-hq-delivery-barcode-lookup/README.md`
2. **Scanner Browser Bridge**
   - Path: `scanner-browser-bridge/`
   - Type: Local OPOS-to-browser bridge service + installers
   - README: `scanner-browser-bridge/README.md`
3. **Weather Widget Shim (XOAP compatibility)**
   - Path: `weather-widget-shim/`
   - Type: IIS-hosted ASP.NET compatibility layer
   - README: `weather-widget-shim/README.md`
4. **Mercury Orders TV Dashboard**
   - Path: `mercury-orders-tv-dashboard/`
   - Type: Live workflow bridge + React kiosk dashboard + Windows installer flow
   - README: `mercury-orders-tv-dashboard/README.md`

## Quick Start (Dashboard Live Mode)

```powershell
cd .\mercury-orders-tv-dashboard
$env:MERCURY_BASE_URL='http://localhost/WsMercuryWebAPI'
.\start-live-mvp.ps1
```

Then open `http://127.0.0.1:5173`.

## Requirements

1. **Tampermonkey** browser extension (for userscripts).
2. Access to **MercuryHQ** and/or Mercury SOAP/API hosts.
3. Network access to your Mercury environment.
4. Optional: OPOS scanner hardware and device profile.

## Repository Structure

- `README.md` - root documentation
- `public/` - shared assets/screenshots
- `mercury-hq-delivery-barcode-lookup/` - userscript tooling
- `scanner-browser-bridge/` - OPOS bridge service + installers
- `weather-widget-shim/` - weather compatibility shim + installers
- `mercury-orders-tv-dashboard/` - TV dashboard, workflow bridge, installers, SOAP references

## Legal Disclaimer

> **Disclaimer**
> This is a personal project. I am not affiliated with, associated with, authorized by, endorsed by, or in any way officially connected with FTD.
> Use this project at your own risk. You are solely responsible for any changes, outcomes, or impacts in your environment.
