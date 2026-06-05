import * as forge from 'node-forge';
import * as nodemailer from 'nodemailer';
import { FaxOrderFields } from './index';
import { EmailConfig, DEFAULT_FIELD_MAP } from './config';

// ── OCR field resolution ───────────────────────────────────────────────────────

/** Maps human-readable OCR source labels to FaxOrderFields property names. */
const SOURCE_TO_KEY: Record<string, keyof FaxOrderFields> = {
  'Customer Name':       'customerName',
  'For the Passing Of':  'forThePassingOf',
  'Delivery Location':   'deliveryLocation',
  'Card Message':        'cardMessage',
  'Order Number':        'orderNumber',
  'Customer Phone':      'customerPhone',
  'Customer Address':    'customerAddress',
  'Product Item Number': 'productItemNumber',
  'Product Description': 'productDescription',
  'Product Price':       'productPrice',
  'Delivery Charge':     'deliveryCharge',
  'Delivery Date':       'deliveryDate',
  'Delivery Time':       'deliveryTime',
  'Total Payable':       'totalPayable',
  'Vendor Name':         'vendorName',
};

/**
 * WOI fields that must have an OCR value for Mercury to accept the order.
 * If any are missing after OCR (and no manual override fills them), the file
 * is quarantined in the pending queue for human review.
 */
// Bill Name is always hardcoded to FREYVOGEL WEBSITE so it is never missing.
export const REQUIRED_WOI_FIELDS = ['Recipient Name', 'Product Code 1', 'Delivery Date'] as const;

/** Returns the names of required WOI fields that have no resolved OCR value. */
export function getMissingRequiredFields(
  fields: FaxOrderFields,
  fieldMap: Record<string, string>,
): string[] {
  return (REQUIRED_WOI_FIELDS as readonly string[]).filter(woiField => {
    const val = resolveField(woiField, fields, fieldMap);
    return !val || val.trim() === '';
  });
}

function resolveField(
  woiField: string,
  fields: FaxOrderFields,
  fieldMap: Record<string, string>,
): string {
  const label = fieldMap[woiField];
  if (!label || label === '(none)') return '';
  const key = SOURCE_TO_KEY[label];
  if (!key) return '';
  return (fields[key] as string | undefined) ?? '';
}

// ── Phone parsing ──────────────────────────────────────────────────────────────
interface ParsedPhone { areaCode: string; prefix: string; number: string; extension: string; }

function parsePhone(phone: string | undefined): ParsedPhone {
  const empty: ParsedPhone = { areaCode: '', prefix: '', number: '', extension: '' };
  if (!phone) return empty;
  const m = phone.match(/^\(?(\d{3})\)?[\s.\-]?(\d{3})[\s.\-]?(\d{4})(?:\s*(?:x|ext\.?)\s*(\d+))?/i);
  if (m) {
    return { areaCode: m[1], prefix: m[2], number: m[3], extension: m[4] ?? '' };
  }
  // No area-code match — return whole string as number field
  return { areaCode: '', prefix: '', number: phone.replace(/\D/g, '').slice(0, 20), extension: '' };
}

// ── Address parsing ────────────────────────────────────────────────────────────
interface ParsedAddress { address1: string; address2: string; city: string; state: string; zip: string; }

function parseAddress(addr: string | undefined): ParsedAddress {
  const empty: ParsedAddress = { address1: '', address2: '', city: '', state: '', zip: '' };
  if (!addr) return empty;

  // Pattern 1: standard "123 Main St, Anytown, IL 60515" or "123 Main St, Anytown IL 60515"
  const mComma = addr.match(/^(.+?),\s*(.+?),?\s*([A-Z]{2})\s*(\d{5}(?:-\d{4})?)\s*$/i);
  if (mComma) {
    return { address1: mComma[1].trim(), address2: '', city: mComma[2].trim(), state: mComma[3].toUpperCase(), zip: mComma[4] };
  }

  // Pattern 2: OCR period instead of comma between street and city.
  // "2615 Carriage House Drive. Allison Park, PA 15101"
  // Extract state+zip from the end, then split the remainder at its last separator.
  const mEnd = addr.match(/^(.+?)[.,]\s*([A-Za-z]{2})\s*(\d{5}(?:-\d{4})?)\s*$/i);
  if (mEnd) {
    const streetCity = mEnd[1];
    const splitAt = Math.max(streetCity.lastIndexOf('.'), streetCity.lastIndexOf(','));
    if (splitAt > 0) {
      return {
        address1: streetCity.slice(0, splitAt).trim(),
        address2: '',
        city: streetCity.slice(splitAt + 1).trim(),
        state: mEnd[2].toUpperCase(),
        zip: mEnd[3],
      };
    }
  }

  // Best-effort fallback
  return { address1: addr.trim(), address2: '', city: '', state: '', zip: '' };
}

// ── Date parsing ───────────────────────────────────────────────────────────────
interface ParsedDate { month: string; day: string; year: string; }

function parseDate(dateStr: string | undefined): ParsedDate {
  const empty: ParsedDate = { month: '', day: '', year: '' };
  if (!dateStr) return empty;

  const MONTHS: Record<string, string> = {
    jan: '01', feb: '02', mar: '03', apr: '04',
    jun: '06', jul: '07', aug: '08', sep: '09',
    sept: '09', oct: '10', nov: '11', dec: '12',
    january: '01', february: '02', march: '03', april: '04',
    may: '05', june: '06', july: '07', august: '08',
    september: '09', october: '10', november: '11', december: '12',
  };

  // "April 14, 2026" or "Apr 14, 2026"
  const mLong = dateStr.match(/([A-Za-z]+)\s+(\d{1,2}),?\s*(\d{4})/);
  if (mLong) {
    const mon = MONTHS[mLong[1].toLowerCase()] ?? mLong[1];
    return { month: mon, day: mLong[2].padStart(2, '0'), year: mLong[3] };
  }

  // "04/14/2026"
  const mShort = dateStr.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (mShort) {
    return { month: mShort[1].padStart(2, '0'), day: mShort[2].padStart(2, '0'), year: mShort[3] };
  }

  return empty;
}

// ── Recipient address parsing ──────────────────────────────────────────────────
interface ParsedRecipient extends ParsedAddress { name: string; company: string; }

// Words that indicate an occasion/service type rather than a person's name.
// When these appear at the start of a delivery location, the real destination
// is the venue that follows "at", not a personal delivery address.
const OCCASION_WORDS = /^(?:For the |At the |the )?(Visitation|Reception|Service|Funeral|Wake|Mass|Memorial Service|Graveside Service)\s+at\s+/i;

function parseRecipient(location: string | undefined): ParsedRecipient {
  const empty: ParsedRecipient = { name: '', address1: '', address2: '', city: '', state: '', zip: '', company: '' };
  if (!location) return empty;

  // Venue/occasion delivery: "Visitation at John A Freyvogel Sons, Inc (Centre Ave, Main St), ..."
  // Extract the venue as Recipient Company and the intersection/street from parentheses as Address1.
  const occasionMatch = location.match(OCCASION_WORDS);
  if (occasionMatch) {
    const rest = location.replace(OCCASION_WORDS, '');
    // Company = text before first '(' or before a standalone comma (strip leading "the")
    // Include ", Inc", ", LLC", ", Ltd" etc. as part of the company name
    const companyMatch = rest.match(/^(?:the\s+)?([^(]+?(?:,\s*(?:Inc|LLC|Ltd|Corp|Co)\.?)?)(?:\s*\(|,(?!\s*(?:Inc|LLC|Ltd|Corp|Co))|$)/i);
    const company = companyMatch ? companyMatch[1].trim() : rest.trim();
    // Address1 = content inside parentheses, if present (usually an intersection)
    const parenMatch = rest.match(/\(([^)]+)\)/);
    const address1 = parenMatch ? parenMatch[1].trim() : '';
    return { name: '', company, address1, address2: '', city: '', state: '', zip: '' };
  }

  // Personal delivery: "John Smith at 123 Main St, City, ST 12345"
  const atMatch = location.match(/^(.+?)\s+at\s+(.+)$/i);
  if (atMatch) {
    const addr = parseAddress(atMatch[2]);
    return { name: atMatch[1].trim(), company: '', ...addr };
  }

  // Otherwise treat the whole string as an address
  return { name: '', company: '', ...parseAddress(location) };
}

// ── WOI field sanitization ────────────────────────────────────────────────────

/**
 * The WOI spec forbids special characters in field values (# $ % ^ &).
 * Amounts are handled separately (the spec explicitly allows $ and decimal there).
 * Multi-line values are also collapsed to a single line.
 */
function sanitizeWoiText(value: string, maxLength: number): string {
  return value
    .replace(/\/n/g, ' ')        // strip OCR "/n" artifact (misread newline)
    .replace(/[#$%^&]/g, '')     // remove spec-prohibited chars
    .replace(/[\r\n]+/g, ' ')    // flatten multi-line to single line
    .replace(/\s{2,}/g, ' ')     // collapse multiple spaces
    .trim()
    .slice(0, maxLength);
}

/**
 * Normalize a user-supplied password into a fixed-length key or IV.
 * If the password is too long, it is truncated; if too short, it is right-padded with '*'.
 */
function normalizePassword(password: string, length: number): Buffer {
  const raw = Buffer.from(password, 'utf8');
  if (raw.length >= length) {
    return raw.slice(0, length);
  }
  const result = Buffer.alloc(length, '*');
  raw.copy(result, 0, 0, raw.length);
  return result;
}

function getCipherOptions(algorithm: EmailConfig['encryptionAlgorithm'] = 'TripleDES') {
  switch (algorithm) {
    case 'DES':      return { forgeName: 'DES-CBC',  keyLength: 8,  ivLength: 8  };
    case 'RC2':      return { forgeName: 'RC2-CBC',  keyLength: 16, ivLength: 8  };
    case 'Rijndael': return { forgeName: 'AES-CBC',  keyLength: 32, ivLength: 16 };
    case 'TripleDES':
    default:         return { forgeName: '3DES-CBC', keyLength: 24, ivLength: 8  };
  }
}

function wrapBase64(b64: string, lineLen = 76): string {
  return b64.match(new RegExp(`.{1,${lineLen}}`, 'g'))?.join('\r\n') ?? b64;
}

function encryptWoiBody(body: string, password: string, algorithm: EmailConfig['encryptionAlgorithm'] = 'TripleDES'): string {
  const { forgeName, keyLength, ivLength } = getCipherOptions(algorithm);
  const keyBuf = forge.util.createBuffer(normalizePassword(password, keyLength).toString('binary'));
  const ivBuf  = forge.util.createBuffer(normalizePassword(password, ivLength).toString('binary'));

  const cipher = forge.cipher.createCipher(forgeName as forge.cipher.Algorithm, keyBuf);
  cipher.start({ iv: ivBuf });
  cipher.update(forge.util.createBuffer(Buffer.from(body, 'utf8').toString('binary')));
  cipher.finish();

  return wrapBase64(forge.util.encode64(cipher.output.getBytes()));
}

/**
 * Heuristic: returns true when a string looks like OCR noise rather than real text.
 * A description is considered garbage when fewer than 40% of its tokens are
 * purely alphabetic words of 4+ characters.
 */
function isGarbageText(text: string): boolean {
  const words = text.trim().split(/\s+/);
  if (words.length === 0) return true;
  const goodWords = words.filter(w => /^[A-Za-z]{4,}$/.test(w));
  return goodWords.length / words.length < 0.4;
}

// ── WOI email body formatter ───────────────────────────────────────────────────
export function formatWoiEmail(
  fields: FaxOrderFields,
  fieldMap: Record<string, string> = DEFAULT_FIELD_MAP,
): string {
  const billPhone = parsePhone(fields.customerPhone);
  const billAddr = parseAddress(fields.customerAddress);
  const recipient = parseRecipient(fields.deliveryLocation);
  const delDate = parseDate(fields.deliveryDate);

  // Occasion code: 1 = Sympathy when "for the passing of" is present, else 0
  const occasionCode = fields.forThePassingOf ? '1' : '0';

  // Bill Name is always this shop's WOI identifier — never the fax customer name.
  const billName    = 'FREYVOGEL WEBSITE';
  const recipName   = sanitizeWoiText(resolveField('Recipient Name', fields, fieldMap), 70);
  const cardMsg     = sanitizeWoiText(resolveField('Card Message', fields, fieldMap), 600);
  const delivInstr  = sanitizeWoiText(resolveField('Delivery Instructions', fields, fieldMap), 250);
  const addlInfo    = sanitizeWoiText(resolveField('Additional Information', fields, fieldMap), 1000);
  const prodCode    = sanitizeWoiText(resolveField('Product Code 1', fields, fieldMap), 10);
  const rawDesc     = fields.productDescription ?? '';
  // Spec: if description field is unused or looks like OCR garbage, use the product code in both fields
  const prodDesc    = (rawDesc && !isGarbageText(rawDesc))
    ? sanitizeWoiText(rawDesc, 350) || prodCode
    : prodCode;

  const lines = [
    `Bill Name: ${billName}`,
    `Bill Address1: ${billAddr.address1}`,
    `Bill Address2: ${billAddr.address2}`,
    `Bill City: ${billAddr.city}`,
    `Bill State: ${billAddr.state}`,
    `Bill Country: USA`,
    `Bill Zip Code: ${billAddr.zip}`,
    `Bill Phone Area Code: ${billPhone.areaCode}`,
    `Bill Phone Prefix: ${billPhone.prefix}`,
    `Bill Phone Number: ${billPhone.number}`,
    `Bill Phone Extension: ${billPhone.extension}`,
    `Bill Phone2 Area Code: `,
    `Bill Phone2 Prefix: `,
    `Bill Phone2 Number: `,
    `Bill Phone2 Extension: `,
    `Bill Fax Area Code: `,
    `Bill Fax Prefix: `,
    `Bill Fax Number: `,
    `Recipient Name: ${recipName}`,
    `Recipient Address1: ${recipient.address1}`,
    `Recipient Address2: ${recipient.address2}`,
    `Recipient City: ${recipient.city}`,
    `Recipient State: ${recipient.state}`,
    `Recipient Country Code: USA`,
    `Recipient Zip Code: ${recipient.zip}`,
    `Recipient Phone Area Code: `,
    `Recipient Phone Prefix: `,
    `Recipient Phone Number: `,
    `Recipient Phone Extension: `,
    `Recipient Company: ${recipient.company}`,
    `E-mail Address: `,
    `Delivery Instructions: ${delivInstr}`,
    `Delivery (Month): ${delDate.month}`,
    `Delivery (Day): ${delDate.day}`,
    `Delivery (Year): ${delDate.year}`,
    `Card Message: ${cardMsg}`,
    `Occasion Code: ${occasionCode}`,
    `Product Code 1: ${prodCode}`,
    `Product Description 1: ${prodDesc}`,
    `Product Amount 1: ${fields.productPrice ?? ''}`,
    `Product Qty 1: 1`,
    `Delivery Charge: ${fields.deliveryCharge ?? ''}`,
    `Relay Charge: `,
    `Retrans Charge: `,
    `Service Charge: `,
    `Tax Amount: 0.00`,
    `Discount Amount: `,
    `Total Order Amount: ${fields.totalPayable ?? ''}`,
    `Additional Information: ${addlInfo}`,
  ];

  // Trim trailing whitespace from every line — prevents quoted-printable encoding
  // of trailing spaces as =20, which Mercury's WOI parser may not decode.
  return lines.map(l => l.trimEnd()).join('\r\n');
}

// ── Email sender ───────────────────────────────────────────────────────────────
export async function sendWoiEmail(
  fields: FaxOrderFields,
  emailConfig: EmailConfig,
  fieldMap: Record<string, string> = DEFAULT_FIELD_MAP,
): Promise<void> {
  let body = formatWoiEmail(fields, fieldMap);
  const algo = emailConfig.encryptionAlgorithm ?? 'TripleDES';
  if (emailConfig.encryptionPassword?.trim() && (algo as string) !== 'None') {
    body = encryptWoiBody(body, emailConfig.encryptionPassword, algo);
  }

  const transport = nodemailer.createTransport({
    host: emailConfig.smtpHost,
    port: emailConfig.smtpPort,
    secure: false,
    ...(emailConfig.senderPassword?.trim() ? {
      auth: {
        user: emailConfig.smtpUsername || emailConfig.senderAddress,
        pass: emailConfig.senderPassword,
      },
    } : {}),
  });

  // Build a raw 7-bit email to avoid quoted-printable encoding.
  // Mercury's WOI parser does key: value line parsing on the raw body;
  // QP-encoded trailing spaces (=20) and soft line-breaks (=\n) in the
  // card message break that parsing.
  const rawMessage = [
    `From: <${emailConfig.senderAddress}>`,
    `To: <${emailConfig.recipientAddress}>`,
    `Subject: ${emailConfig.subjectLine}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=us-ascii`,
    `Content-Transfer-Encoding: 7bit`,
    ``,
    body,
  ].join('\r\n');

  await transport.sendMail({
    envelope: {
      from: emailConfig.senderAddress,
      to:   emailConfig.recipientAddress,
    },
    raw: rawMessage,
  });
}
