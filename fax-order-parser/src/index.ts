import { createWorker } from 'tesseract.js';
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
function parseOrderFields(ocrText: string): FaxOrderFields {
  const getMatch = (regex: RegExp) => {
    const m = ocrText.match(regex);
    return m ? m[1].trim() : undefined;
  };

  // Extract fields using regex patterns
  const orderNumber = getMatch(/Order Number\s*([\w-]+)/i);
  const orderPlacedDate = getMatch(/Placed: ([^\n]+)/i);
  const vendorName = getMatch(/Routed to: ([^\n]+)/i);
  const vendorTel = getMatch(/Vendor Tel: ([^\n]+)/i);
  const vendorFax = getMatch(/Faxed to: ([^\n]+)/i);
  const vendorSms = getMatch(/SMS Text Message: ([^\n]+)/i);
  const customerName = getMatch(/Ordered by: ([^\n]+)/i);
  const customerPhone = getMatch(/Telephone: ([^\n]+)/i);
  const customerAddress = getMatch(/Address: ([^\n]+)/i);
  const productItemNumber = getMatch(/Item # ([\w\d]+)/i);
  const productPrice = getMatch(/Item # [\w\d]+ \$[\d.]+\*?\s*\$([\d.]+)/i);
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
  const totalPayable = getMatch(/Total payable to you \$([\d.]+)/i);

  // Delivery details: parse address, times, and date from the delivery line
  let deliveryLocation, deliveryTime, deliveryDate;
  // Extract the full delivery block, allowing for line wraps in OCR output
  const deliveryBlockMatch = ocrText.match(/Delivery:([\s\S]+?)(?:\n\n|$)/i);
  if (deliveryBlockMatch) {
    // Join lines and normalize spaces
    const deliveryBlock = deliveryBlockMatch[1].replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
    console.log('DEBUG: Delivery block:', deliveryBlock);
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

async function main() {
  const imagePath = process.argv[2];
  if (!imagePath) {
    console.error('Usage: npm run parse -- <image-path>');
    process.exit(1);
  }

  const worker = await createWorker('eng');
  console.log(`Running OCR on: ${imagePath}`);
  const { data: { text } } = await worker.recognize(imagePath);
  await worker.terminate();

  console.log('--- OCR Output ---');
  console.log(text);

  const fields = parseOrderFields(text);
  console.log('\n--- Parsed Fields (stub) ---');
  console.log(fields);
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
