# Fax Order Parser

This tool extracts structured order data from scanned fax images (e.g., .TIF files) using OCR. It is designed for Node.js with TypeScript and will be used to automate order entry from faxed forms.

## Features
- OCR image-to-text extraction (using Tesseract.js)
- Fixed field parsing for common order elements (stubbed for now)
- CLI for testing with sample images

## Usage

1. Place scanned fax images in a folder (e.g., `input/`).
2. Run the parser:
   ```sh
   npm install
   npm run parse -- input/IMG_2207.TIF
   ```

## Planned Fields to Extract
- Order Number
- Customer Name
- Delivery Address
- Phone Number
- Product List
- Delivery Date
- Special Instructions

> These fields are subject to change based on your feedback.

## Windows Compatibility
- Designed to run on Windows (and cross-platform)
- Handles .TIF files from fax machines

---

**Next steps:**
- Implement OCR and stub field extraction
- Refine field list based on your input
