import crypto from 'crypto';
import * as nodemailer from 'nodemailer';
import { FaxOrderFields } from './index';
import { EmailConfig } from './config';

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
  // "123 Main St, Anytown, IL 60515" or "123 Main St, Anytown IL 60515"
  const m = addr.match(/^(.+?),\s*(.+?),?\s*([A-Z]{2})\s*(\d{5}(?:-\d{4})?)\s*$/i);
  if (m) {
    return { address1: m[1].trim(), address2: '', city: m[2].trim(), state: m[3].toUpperCase(), zip: m[4] };
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

function parseRecipient(location: string | undefined): ParsedRecipient {
  const empty: ParsedRecipient = { name: '', address1: '', address2: '', city: '', state: '', zip: '', company: '' };
  if (!location) return empty;

  // "John Smith at 123 Main St, City, ST 12345"
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
    case 'DES': return { cipherName: 'des-cbc', keyLength: 8, ivLength: 8 };
    case 'RC2': return { cipherName: 'rc2-cbc', keyLength: 16, ivLength: 8 };
    case 'Rijndael': return { cipherName: 'aes-256-cbc', keyLength: 32, ivLength: 16 };
    case 'TripleDES': return { cipherName: 'des-ede3-cbc', keyLength: 24, ivLength: 8 };
    default: return { cipherName: 'des-ede3-cbc', keyLength: 24, ivLength: 8 };
  }
}

function encryptWoiBody(body: string, password: string, algorithm: EmailConfig['encryptionAlgorithm'] = 'TripleDES'): string {
  const { cipherName, keyLength, ivLength } = getCipherOptions(algorithm);
  const key = normalizePassword(password, keyLength);
  const iv = normalizePassword(password, ivLength);

  const runCipher = (name: string, keyBuffer: Buffer, ivBuffer: Buffer) => {
    const cipher = crypto.createCipheriv(name, keyBuffer, ivBuffer);
    return Buffer.concat([cipher.update(Buffer.from(body, 'utf8')), cipher.final()]);
  };

  try {
    const encrypted = runCipher(cipherName, key, iv);
    return encrypted.toString('base64');
  } catch (err) {
    if (algorithm === 'TripleDES') {
      const fallbackKey = normalizePassword(password, 8);
      const fallbackIv = normalizePassword(password, 8);
      const encrypted = runCipher('des-cbc', fallbackKey, fallbackIv);
      return encrypted.toString('base64');
    }
    throw err;
  }
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
export function formatWoiEmail(fields: FaxOrderFields): string {
  const billPhone = parsePhone(fields.customerPhone);
  const billAddr = parseAddress(fields.customerAddress);
  const recipient = parseRecipient(fields.deliveryLocation);
  const delDate = parseDate(fields.deliveryDate);

  // Occasion code: 1 = Sympathy when "for the passing of" is present, else 0
  const occasionCode = fields.forThePassingOf ? '1' : '0';

  const lines = [
    `Bill Name: ${fields.customerName ?? ''}`,
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
    `Bill Phone2 Extension: `,
    `Bill Phone2 Number: `,
    `Bill Phone2 Prefix: `,
    `Bill Fax Area Code: `,
    `Bill Fax Prefix: `,
    `Bill Fax Number: `,
    `Recipient Name: ${recipient.name || (fields.customerName ?? '')}`,
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
    `Delivery Instructions: ${fields.deliveryTime ?? ''}`,
    `Delivery (Month): ${delDate.month}`,
    `Delivery (Day): ${delDate.day}`,
    `Delivery (Year): ${delDate.year}`,
    `Card Message: ${fields.cardMessage ?? ''}`,
    `Occasion Code: ${occasionCode}`,
    `Product Code1: ${fields.productItemNumber ?? ''}`,
    `Product Description1: ${fields.productDescription ?? fields.productItemNumber ?? ''}`,
    `Product Amount1: ${fields.productPrice ?? ''}`,
    `Product Qty1: 1`,
    `Delivery Charge: ${fields.deliveryCharge ?? ''}`,
    `Relay Charge: `,
    `Retrans Charge: `,
    `Service Charge: `,
    `Tax Amount: `,
    `Discount Amount: `,
    `Total Order Amount: ${fields.totalPayable ?? ''}`,
    `Additional Information: ${fields.forThePassingOf ?? ''}`,
    `CC Cardholder: `,
    `CC Company: `,
    `CC Number: `,
    `CC Expiration (Month): `,
    `CC Expiration (Year): `,
    `CC CVV Code: `,
  ];

  return lines.join('\n');
}

// ── Email sender ───────────────────────────────────────────────────────────────
export async function sendWoiEmail(
  fields: FaxOrderFields,
  emailConfig: EmailConfig,
  fieldMap: Record<string, string> = DEFAULT_FIELD_MAP,
): Promise<void> {
  let body = formatWoiEmail(fields, fieldMap);
  if (emailConfig.encryptionPassword?.trim()) {
    body = encryptWoiBody(
      body,
      emailConfig.encryptionPassword,
      emailConfig.encryptionAlgorithm ?? 'TripleDES',
    );
  }

  const transport = nodemailer.createTransport({
    host: emailConfig.smtpHost,
    port: emailConfig.smtpPort,
    secure: false,
    auth: {
      user: emailConfig.senderAddress,
      pass: emailConfig.senderPassword,
    },
  });

  await transport.sendMail({
    from: emailConfig.senderAddress,
    to: emailConfig.recipientAddress,
    subject: emailConfig.subjectLine,
    text: body,
  });
}
