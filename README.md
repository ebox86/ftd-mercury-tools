# FTD Mercury Tools

Utilities and userscripts for improving workflows in MercuryHQ.

## Available Plugins

1. **MercuryHQ - Single Request Barcode**
   - Path: `mercury-hq-delivery-barcode-lookup/mercury-hq-single-request-barcode.js`
   - Type: Tampermonkey userscript
   - Purpose: Adds Order ID/barcode lookup + autofill with split workflow tabs:
     `Single Request - Manual` and `Single Request - Autocomplete`.

## Available Extensions

1. **Tampermonkey** (required to run userscripts)

## Requirements

1. **Tampermonkey** browser extension (Chrome/Edge/Firefox).
2. Access to **MercuryHQ** and permission to use the Single Request page.
3. Network access to your Mercury API host (for example, LAN IP/hostname configured in script `CONFIG`).
4. Optional: USB/Bluetooth barcode scanner configured as keyboard input.

## Repository Structure

- `README.md` - root project documentation
- `mercury-hq-delivery-barcode-lookup/` - barcode lookup userscript and tool-specific docs
- `public/` - shared static assets (if needed later)

## Quick Start

1. Install the Tampermonkey extension in your browser.
2. Open the tool-specific README for install/config details:
   - `mercury-hq-delivery-barcode-lookup/README.md`
