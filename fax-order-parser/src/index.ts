import { createWorker } from 'tesseract.js';
import * as fs from 'fs';
import * as path from 'path';

export interface WordInfo {
  text: string;
  bbox: { x0: number; y0: number; x1: number; y1: number };
  confidence: number;
}

export interface BoundingBox { x0: number; y0: number; x1: number; y1: number; }
export interface PolygonPoint { x: number; y: number; }

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
export function parseOrderFields(rawOcrText: string): FaxOrderFields {
  // Normalize Windows CRLF so all patterns can use \n consistently
  const ocrText = rawOcrText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  const getMatch = (regex: RegExp) => {
    const m = ocrText.match(regex);
    return m ? m[1].trim() : undefined;
  };

  // Extract fields using regex patterns
  // Allow up to 3 OCR-split tokens (e.g. "JF S1234567" or "JF 123 4567") and join them
  const orderNumber = (() => {
    const m = ocrText.match(/Order Number\s*([\w-]+(?:\s[\w-]+){0,2})/i);
    return m ? m[1].replace(/\s+/g, '').trim() : undefined;
  })();
  const orderPlacedDate = getMatch(/Placed: ([^\n]+)/i);
  const vendorName = getMatch(/Routed to: ([^\n]+)/i);
  const vendorTel = getMatch(/Vendor Tel: ([^\n]+)/i);
  const vendorFax = getMatch(/Faxed to: ([^\n]+)/i);
  const vendorSms = getMatch(/SMS Text Message: ([^\n]+)/i);
  const customerName = getMatch(/Ordered by: ([^\n]+)/i);
  const customerPhone = getMatch(/Telephone: ([^\n]+)/i);
  const customerAddress = getMatch(/Address: ([^\n]+)/i);
  const productItemNumber = getMatch(/Item #\s*([\w\d-]+)/i);
  // Retail price always carries a * suffix (e.g. $79.99*); the florist CFS price
  // immediately follows without *. Column headers between them are ignored.
  const productPrice = (() => {
    const m = ocrText.match(/\$[\d.]+\*\s+\$([\d.]+)/i);
    return m ? m[1] : undefined;
  })();
  const deliveryCharge = getMatch(/Delivery Charge\s*\$([\d.]+)/i);
  // Product description: robustly extract the bouquet name after the item and delivery charge lines
  let productDescription: string | undefined = undefined;
  // Look for lines containing "Bouquet" after "Delivery Charge"
  const prodDescParts = ocrText.split(/Delivery Charge[^\n]*\n/);
  if (prodDescParts.length > 1) {
    // Take up to the next blank line or 3 lines after Delivery Charge
    const lines = prodDescParts[1].split(/\n/).map(l => l.trim()).filter(Boolean);
    let bouquetLines: string[] = [];
    for (let i = 0; i < Math.min(lines.length, 4); i++) {
      bouquetLines.push(lines[i]);
      if (/Bouquet/i.test(lines[i])) break;
    }
    const bouquetText = bouquetLines.join(' ');
    const bouquetMatch = bouquetText.match(/([A-Za-z0-9'\- ]*Bouquet)/i);
    if (bouquetMatch) {
      productDescription = bouquetMatch[1].replace(/\s+/g, ' ').trim();
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
  const totalPayable = getMatch(/Total payable to you\s*\$([\d.]+)/i);

  // Delivery details: parse address, times, and date from the delivery block
  let deliveryLocation, deliveryTime, deliveryDate;
  // Stop at known next sections or double-newline to avoid over-capturing
  // Allow optional space before colon in case OCR splits "Delivery :"
  const deliveryBlockMatch = ocrText.match(/Delivery\s*:([\s\S]+?)(?:\n\s*\n|Total payable|$)/i);
  if (deliveryBlockMatch) {
    const deliveryBlock = deliveryBlockMatch[1].replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();

    // AM/PM token — handles "AM", "PM", "A.M.", "P.M.", "am", "pm" (both A and P branches allow optional trailing dot)
    const ampm = String.raw`(?:A\.?M\.?|P\.?M\.?)`;
    // Time token — digits/colons followed by optional AM/PM
    const time  = String.raw`[\d][\d:.]*\s*${ampm}`;
    // Full pattern: "from [time] [to [time]] on [Month D, YYYY]"
    const tdRe  = new RegExp(
      String.raw`from\s*(${time})(?:\s+to\s+(?:${time}))?\s+on\s+([A-Za-z]+\.?\s+\d{1,2},?\s*\d{4})`,
      'i'
    );
    const timeDateMatch = deliveryBlock.match(tdRe);
    if (timeDateMatch) {
      deliveryDate = timeDateMatch[2].replace(/\s+/g, ' ').trim();
      deliveryTime = `before ${timeDateMatch[1].replace(/\s+/g, ' ').trim()}`;
    }

    // Fallback 1: find any "Month D, YYYY" in the delivery block when the
    // "from…on" pattern fails (e.g. OCR garbled the time portion)
    if (!deliveryDate) {
      const MONTHS = 'January|February|March|April|May|June|July|August|September|October|November|December';
      // Allow comma, period, or no separator between day and year; allow 0–2 spaces between month and day
      const dateRe = new RegExp(String.raw`\b(${MONTHS})\s{0,2}(\d{1,2})[,.]?\s{0,2}(\d{4})\b`, 'i');
      const dm = deliveryBlock.match(dateRe);
      if (dm) deliveryDate = `${dm[1]} ${dm[2]}, ${dm[3]}`;
    }

    // Extract delivery location (everything before the "from [time] on [date]" clause)
    const locMatch = deliveryBlock.match(new RegExp(String.raw`^(.*?)\s+from\s+${time}`, 'i'));
    if (locMatch) {
      deliveryLocation = locMatch[1].replace(/^For the /i, '').replace(/,$/, '').trim();
    } else {
      deliveryLocation = deliveryBlock;
    }
  }

  // Fallback 2: scan the full OCR text for a date near "Delivery" when the
  // delivery block regex failed to capture the section at all
  if (!deliveryDate) {
    const MONTHS = 'January|February|March|April|May|June|July|August|September|October|November|December';
    const dateRe = new RegExp(String.raw`\b(${MONTHS})\s{0,2}(\d{1,2})[,.]?\s{0,2}(\d{4})\b`, 'ig');
    // Find all dates in the text and pick the one that appears closest after "Delivery"
    const deliveryIdx = ocrText.search(/Delivery\s*[:.]/i);
    let bestDate: string | undefined;
    let bestDist = Infinity;
    for (const m of ocrText.matchAll(dateRe)) {
      const dist = deliveryIdx >= 0 ? Math.abs(m.index! - deliveryIdx) : m.index!;
      if (dist < bestDist) { bestDist = dist; bestDate = `${m[1]} ${m[2]}, ${m[3]}`; }
    }
    if (bestDate) deliveryDate = bestDate;
  }

  // Derive product price from (totalPayable - deliveryCharge) when OCR can't
  // reliably read the price column. The "Total payable to you" line is always
  // clean and equals product + delivery with no tax (tax is collected by CFS).
  let effectiveProductPrice = productPrice;
  if (!effectiveProductPrice && totalPayable && deliveryCharge) {
    const t = parseFloat(totalPayable);
    const d = parseFloat(deliveryCharge);
    if (!isNaN(t) && !isNaN(d) && t > d) {
      effectiveProductPrice = (t - d).toFixed(2);
    }
  }
  // Final fallback: if delivery charge is also missing, use totalPayable as the product price
  if (!effectiveProductPrice && totalPayable) {
    effectiveProductPrice = totalPayable;
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
    productPrice: effectiveProductPrice,
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

/** Run OCR and return both text and word-level bounding boxes. */
export async function runOcrFull(filePath: string): Promise<{ text: string; words: WordInfo[] }> {
  const ext = path.extname(filePath).toLowerCase();
  const worker = await createWorker('eng');
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const extractWords = (data: any): WordInfo[] =>
      (data.words ?? []).map((w: any) => ({
        text: w.text as string,
        bbox: w.bbox as { x0: number; y0: number; x1: number; y1: number },
        confidence: w.confidence as number,
      }));

    if (ext === '.pdf') {
      const imageBuffers = await pdfToImageBuffers(filePath);
      const textParts: string[] = [];
      const allWords: WordInfo[] = [];
      for (const buf of imageBuffers) {
        const { data } = await worker.recognize(buf);
        textParts.push(data.text);
        allWords.push(...extractWords(data));
      }
      return { text: textParts.join('\n\n'), words: allWords };
    } else {
      const { data } = await worker.recognize(filePath);
      return { text: data.text, words: extractWords(data) };
    }
  } finally {
    await worker.terminate();
  }
}

function normalizeForMatch(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
}

function convexHull(pts: PolygonPoint[]): PolygonPoint[] {
  if (pts.length <= 3) return pts;
  const sorted = [...pts].sort((a, b) => a.x !== b.x ? a.x - b.x : a.y - b.y);
  const cross = (o: PolygonPoint, a: PolygonPoint, b: PolygonPoint): number =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: PolygonPoint[] = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: PolygonPoint[] = [];
  for (const p of [...sorted].reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  upper.pop(); lower.pop();
  return [...lower, ...upper];
}

function findFieldPolygon(value: string, words: WordInfo[]): PolygonPoint[] | undefined {
  if (!value || !words.length) return undefined;
  const valueTokens = normalizeForMatch(value).split(' ').filter(Boolean);
  if (!valueTokens.length) return undefined;

  for (let i = 0; i <= words.length - valueTokens.length; i++) {
    const window = words.slice(i, i + valueTokens.length);
    const windowNorm = window.map(w => normalizeForMatch(w.text)).join(' ');
    if (windowNorm === valueTokens.join(' ')) {
      const corners: PolygonPoint[] = [];
      for (const w of window) {
        corners.push({ x: w.bbox.x0, y: w.bbox.y0 });
        corners.push({ x: w.bbox.x1, y: w.bbox.y0 });
        corners.push({ x: w.bbox.x1, y: w.bbox.y1 });
        corners.push({ x: w.bbox.x0, y: w.bbox.y1 });
      }
      return convexHull(corners);
    }
  }
  return undefined;
}

export function detectFieldBboxes(fields: FaxOrderFields, words: WordInfo[]): Record<string, PolygonPoint[]> {
  const result: Record<string, PolygonPoint[]> = {};
  const targets: Array<[string, string | undefined]> = [
    ['customerName',       fields.customerName],
    ['customerPhone',      fields.customerPhone],
    ['customerAddress',    fields.customerAddress],
    ['orderNumber',        fields.orderNumber],
    ['productItemNumber',  fields.productItemNumber],
    ['productPrice',       fields.productPrice],
    ['deliveryCharge',     fields.deliveryCharge],
    ['totalPayable',       fields.totalPayable],
    ['deliveryDate',       fields.deliveryDate],
    ['forThePassingOf',    fields.forThePassingOf],
    ['productDescription', fields.productDescription],
    ['vendorName',         fields.vendorName],
    ['cardMessage',        fields.cardMessage?.slice(0, 20)],
  ];
  for (const [key, value] of targets) {
    if (!value) continue;
    const poly = findFieldPolygon(value, words);
    if (poly) result[key] = poly;
  }
  return result;
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
