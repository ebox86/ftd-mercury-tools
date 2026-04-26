import { createWorker } from 'tesseract.js';
import * as fs from 'fs';
import * as path from 'path';

export interface FaxOrderFields {
  orderNumber?: string;
  orderPlacedDate?: string;
  vendorName?: string;
  vendorTel?: string;
  vendorFax?: string;
  vendorSms?: string;
  customerName?: string;
  customerPhone?: string;
  customerAddress?: string;
  productItemNumber?: string;
    productPrice?: string;
  deliveryCharge?: string;
  productDescription?: string;
  deliveryDate?: string;
  deliveryTime?: string;
  deliveryLocation?: string;
  forThePassingOf?: string;
  cardMessage?: string;
  totalPayable?: string;
}

// Regex-based parser for extracting fields from OCR text
export function parseOrderFields(ocrText: string): FaxOrderFields {
  const getMatch = (regex: RegExp) => {
    const m = ocrText.match(regex);
    return m ? m[1].trim() : undefined;
  };

  // orderNumber: capture the whole line after the label, then strip the
  // " - Item X of X" suffix that FTD appends on the same line.
  const rawOrderLine = getMatch(/Order Number[:\s]+([^\n]+)/i);
  const orderNumber = rawOrderLine ? rawOrderLine.replace(/\s+-\s+.*$/, '').trim() : undefined;
  const orderPlacedDate = getMatch(/Placed[:\s]+([^\n]+)/i);
  const vendorName = getMatch(/Routed to[:\s]+([^\n]+)/i);
  const vendorTel = getMatch(/(?:Vendor Tel|Tel)[:\s]+([^\n]+)/i);
  const vendorFax = getMatch(/Faxed to[:\s]+([^\n]+)/i);
  const vendorSms = getMatch(/SMS Text Message[:\s]+([^\n]+)/i);
  // customerName: OCR sometimes wraps the last name onto the next line.
  // Capture up to two non-blank lines after "Ordered by:".
  let customerName: string | undefined;
  const cnMatch = ocrText.match(/Ordered by[:\s]+([^\n]+)(?:\n([^\n]+))?/i);
  if (cnMatch) {
    const line1 = cnMatch[1].trim();
    const line2 = cnMatch[2]?.trim() ?? '';
    // Only append line2 if it looks like a continuation (no colon = not a new label)
    customerName = (line2 && !line2.includes(':')) ? `${line1} ${line2}` : line1;
  }
  const customerPhone = getMatch(/Telephone: ([^\n]+)/i);
  const customerAddress = getMatch(/Address: ([^\n]+)/i);
  const productItemNumber = getMatch(/Item # ([\w\d]+)/i);
  // Retail price is the CFS/shop price (second $ on the Item line).
  // OCR renders the asterisk as % sometimes, so allow any non-digit between the two prices.
  const productPrice = getMatch(/Item # [\w\d]+ \$[\d.]+[^\d\s]?\s*\$([\d.]+)/i);
  const deliveryCharge = getMatch(/Delivery Charge\s*\$([\d.]+)/i);
  // Product description: robustly extract the bouquet name after the item and delivery charge lines
  let productDescription: string | undefined = undefined;
  // Product description: first clean title line immediately after the Delivery Charge row.
  // Works for any product name ("Designer's Choice Bouquet", "Peaceful White Tribute", etc.).
  const prodDescParts = ocrText.split(/Delivery Charge[^\n]*\n/);
  if (prodDescParts.length > 1) {
    const lines = prodDescParts[1].split(/\n/).map((l: string) => l.trim()).filter(Boolean);
    const titleLine = lines.find((l: string) => /^[A-Z][A-Za-z0-9' -]{3,}$/.test(l));
    if (titleLine) {
      // Stop at a product-type keyword to avoid capturing OCR garbage that follows
      const stopMatch = titleLine.match(/^(.+?(?:Bouquet|Tribute|Arrangement|Wreath|Basket|Display|Spray|Centerpiece|Planter|Plant|Vase|Collection|Garden))/i);
      productDescription = stopMatch ? stopMatch[1].trim() : titleLine;
    } else if (lines.length > 0) {
      productDescription = lines[0].replace(/[^A-Za-z0-9' -]/g, ' ').replace(/\s+/g, ' ').trim();
    }
  }
  // Delivery details will be parsed below
  const forThePassingOf = getMatch(/For the passing of ([^\n]+)/i);
  // Card message: dynamically capture multiline content until a blank line or a new section (e.g., Delivery:)
  let cardMessage: string | undefined = undefined;
  const cardMsgMatch = ocrText.match(/Card message:([\s\S]+?)(?:\n\s*\w+:|\n\n|$)/i);
  if (cardMsgMatch) {
    // Clean up leading/trailing whitespace and join lines
    cardMessage = cardMsgMatch[1].replace(/^\s+|\s+$/g, '').replace(/\n+/g, ' ').replace(/\s{2,}/g, ' ');
  }
  const totalPayable = getMatch(/Total payable to you \$([\d.]+)/i);

  // Delivery details: parse address, times, and date from the delivery line
  let deliveryLocation, deliveryTime, deliveryDate;
  // Extract the full delivery block, allowing for line wraps in OCR output
  const deliveryBlockMatch = ocrText.match(/Delivery:([\s\S]+?)(?:\n\n|$)/i);
  if (deliveryBlockMatch) {
    // Join lines and normalize spaces
    const deliveryBlock = deliveryBlockMatch[1].replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
    // Extract date and times from the end of the block
    const timeDateMatch = deliveryBlock.match(/from\s*([\d:]+\s*[APM]{2})(?:\s*to\s*([\d:]+\s*[APM]{2}))?\s*on\s*([A-Za-z]+ \d{1,2}, \d{4})/i);
    if (timeDateMatch) {
      deliveryDate = timeDateMatch[3].trim();
      if (timeDateMatch[1]) {
        deliveryTime = `before ${timeDateMatch[1].trim()}`;
      }
    }
    // Extract location (before 'from')
    const locMatch = deliveryBlock.match(/^(.*) from [\d:]+\s*[APM]{2}(?: to [\d:]+\s*[APM]{2})? on [A-Za-z]+ \d{1,2}, \d{4}/i);
    if (locMatch) {
      deliveryLocation = locMatch[1].replace(/^For the /i, '').replace(/,$/, '').trim();
    } else {
      deliveryLocation = deliveryBlock;
    }
  }

  // Fallback: if customerName is a single word (no last name in "Ordered by:"),
  // search the card message for a signature line containing "FirstName LastName".
  if (customerName && !customerName.includes(' ') && cardMessage) {
    const escaped = customerName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const sigMatch = cardMessage.match(new RegExp(`\\b${escaped}\\s+([A-Za-z][A-Za-z'-]+)\\b`, 'i'));
    if (sigMatch) {
      customerName = `${customerName} ${sigMatch[1]}`;
    }
  }

  return {
    orderNumber,
    orderPlacedDate,
    vendorName,
    vendorTel,
    vendorFax,
    vendorSms,
    customerName,
    customerPhone,
    customerAddress,
    productItemNumber,
    productPrice,
    deliveryCharge,
    productDescription,
    deliveryDate,
    deliveryTime,
    deliveryLocation,
    forThePassingOf,
    cardMessage,
    totalPayable,
  };
}

/** Convert a PDF file into per-page PNG Buffers using mupdf (WASM, no native deps). */
export async function pdfToImageBuffers(pdfPath: string): Promise<Buffer[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mupdf = await import('mupdf') as any;
  const data: Buffer = fs.readFileSync(pdfPath);
  const doc = mupdf.Document.openDocument(data, 'application/pdf');
  const pageCount: number = doc.countPages();
  const buffers: Buffer[] = [];

  for (let i = 0; i < pageCount; i++) {
    const page = doc.loadPage(i);
    // Scale 2× for better OCR resolution
    const matrix = [2, 0, 0, 2, 0, 0];
    const pixmap = page.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB, false, true);
    buffers.push(Buffer.from(pixmap.asPNG() as Uint8Array));
    pixmap.destroy();
    page.destroy();
  }

  doc.destroy();
  return buffers;
}

/**
 * Run OCR on a TIFF or PDF file and return the extracted text.
 * For PDF files, all pages are concatenated with a blank line separator.
 */
export async function runOcr(filePath: string): Promise<string> {
  const ext = path.extname(filePath).toLowerCase();
  const worker = await createWorker('eng');

  try {
    if (ext === '.pdf') {
      const imageBuffers = await pdfToImageBuffers(filePath);
      const textParts: string[] = [];
      for (const buf of imageBuffers) {
        const { data: { text } } = await worker.recognize(buf);
        textParts.push(text);
      }
      return textParts.join('\n\n');
    } else {
      const { data: { text } } = await worker.recognize(filePath);
      return text;
    }
  } finally {
    await worker.terminate();
  }
}

async function main() {
  const imagePath = process.argv[2];
  if (!imagePath) {
    console.error('Usage: npm run parse -- <image-path>');
    process.exit(1);
  }

  console.log(`Running OCR on: ${imagePath}`);
  const text = await runOcr(imagePath);

  console.log('--- OCR Output ---');
  console.log(text);

  const fields = parseOrderFields(text);
  console.log('\n--- Parsed Fields ---');
  console.log(fields);
}

if (require.main === module) {
  main().catch(err => {
    console.error('Error:', err);
    process.exit(1);
  });
}
