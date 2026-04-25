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
    `Recipient Name: ${recipient.name || (fields.customerName ?? '')}`,`
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
export async function sendWoiEmail(fields: FaxOrderFields, emailConfig: EmailConfig): Promise<void> {
  const body = formatWoiEmail(fields);

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
