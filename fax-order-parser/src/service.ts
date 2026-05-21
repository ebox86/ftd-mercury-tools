/**
 * FaxOrderParser background service.
 * Watches a configured folder for incoming fax files (PDF or TIF),
 * runs OCR, parses order fields, sends a WOI-formatted email, and
 * logs the result.
 *
 * Entry point for the Windows service managed by FTD.FaxParser.ServiceHost.exe.
 */

import * as fs from 'fs';
import * as path from 'path';
import chokidar from 'chokidar';
import { loadConfig, DEFAULT_FIELD_MAP } from './config';
import { appendLogEntry } from './logger';
import { sendWoiEmail, getMissingRequiredFields } from './email-sender';
import { runOcr, parseOrderFields, FaxOrderFields } from './index';

// ── File processor ─────────────────────────────────────────────────────────────

function holdSidecarPath(filePath: string): string {
  return filePath + '.hold.json';
}

async function processFile(filePath: string, fieldOverrides?: Partial<FaxOrderFields>): Promise<void> {
  const config = loadConfig();
  const fileName = path.basename(filePath);

  console.log(`[FaxParser] Processing: ${fileName}`);

  const ocrText = await runOcr(filePath);
  const fields = parseOrderFields(ocrText);

  if (fieldOverrides && Object.keys(fieldOverrides).length > 0) {
    Object.assign(fields, fieldOverrides);
    console.log('[FaxParser] Applied manual field overrides from config app.');
  }

  // Quarantine the file if required WOI fields are missing after OCR
  const fieldMap = (config as any).fieldMap ?? DEFAULT_FIELD_MAP;
  const missing = getMissingRequiredFields(fields, fieldMap);
  if (missing.length > 0 && !fieldOverrides) {
    const sidecar = holdSidecarPath(filePath);
    const detail  = missing.join(', ');
    console.warn(`[FaxParser] HOLD ${fileName}: required WOI fields missing: ${detail}`);
    try { fs.writeFileSync(sidecar, JSON.stringify({ missing, timestamp: new Date().toISOString() }), 'utf-8'); } catch { /* non-fatal */ }
    appendLogEntry({ timestamp: new Date().toISOString(), fileName, orderNumber: fields.orderNumber, customerName: fields.customerName, deliveryDate: fields.deliveryDate, emailSent: false, error: `HOLD: required fields missing: ${detail}` });
    return;
  }

  console.log('[FaxParser] Parsed order #', fields.orderNumber ?? '(unknown)');

  let emailSent = false;
  let error: string | undefined;

  if (!config.email.senderPassword) {
    error = 'Email not sent: sender password not configured. Open the config app to set it.';
    console.warn(`[FaxParser] ${error}`);
  } else {
    try {
      await sendWoiEmail(fields, config.email, fieldMap);
      emailSent = true;
      console.log(`[FaxParser] Email sent to ${config.email.recipientAddress}`);
    } catch (err: unknown) {
      error = err instanceof Error ? err.message : String(err);
      console.error(`[FaxParser] Email send failed: ${error}`);
    }
  }

  // Remove hold sidecar if present
  try { fs.unlinkSync(holdSidecarPath(filePath)); } catch { /* not held, ignore */ }

  // Move processed file to the configured subfolder
  const processedDir = path.join(path.dirname(filePath), config.processedSubfolder);
  if (!fs.existsSync(processedDir)) {
    fs.mkdirSync(processedDir, { recursive: true });
  }
  const dest = path.join(processedDir, fileName);
  fs.renameSync(filePath, dest);
  console.log(`[FaxParser] Moved to: ${dest}`);

  appendLogEntry({
    timestamp: new Date().toISOString(),
    fileName,
    orderNumber: fields.orderNumber,
    customerName: fields.customerName,
    deliveryDate: fields.deliveryDate,
    emailSent,
    error,
  });
}

// ── Folder watcher ─────────────────────────────────────────────────────────────

async function startWatcher(): Promise<void> {
  // Reload config on every file event so settings changes take effect without restart.
  const config = loadConfig();
  const watchFolder = config.watchFolder;
  const pollInterval = config.pollIntervalSeconds * 1000;
  const ext = config.fileFormat === 'PDF' ? '.pdf' : '.tif';
  const processedSubfolder = config.processedSubfolder;

  console.log(`[FaxParser] Watch folder  : ${watchFolder}`);
  console.log(`[FaxParser] File format   : ${ext}`);
  console.log(`[FaxParser] Poll interval : ${config.pollIntervalSeconds}s`);

  if (!fs.existsSync(watchFolder)) {
    fs.mkdirSync(watchFolder, { recursive: true });
    console.log(`[FaxParser] Created watch folder.`);
  }

  // Files currently being processed (to prevent duplicate processing)
  const inFlight = new Set<string>();

  const watcher = chokidar.watch(watchFolder, {
    ignored: [
      /(^|[/\\])\./,                                                    // dotfiles
      new RegExp(`[/\\\\]${processedSubfolder.replace(/\\/g, '\\\\')}[/\\\\]`), // processed subfolder
    ],
    persistent: true,
    usePolling: true,
    interval: pollInterval,
    awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 500 },
  });

  watcher.on('add', (filePath: string) => {
    const fileExt = path.extname(filePath).toLowerCase();
    if (fileExt !== ext) return;
    if (inFlight.has(filePath)) return;

    // Skip files quarantined for manual review
    if (fs.existsSync(holdSidecarPath(filePath))) {
      console.log(`[FaxParser] Skipping held file: ${path.basename(filePath)} (open config app to review)`);
      return;
    }

    inFlight.add(filePath);

    processFile(filePath)
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[FaxParser] Error processing ${path.basename(filePath)}: ${msg}`);
        appendLogEntry({
          timestamp: new Date().toISOString(),
          fileName: path.basename(filePath),
          emailSent: false,
          error: msg,
        });
      })
      .finally(() => {
        inFlight.delete(filePath);
      });
  });

  watcher.on('error', (watchErr: Error) => {
    console.error(`[FaxParser] Watcher error: ${watchErr.message}`);
  });

  console.log('[FaxParser] Service started. Waiting for incoming fax files...');

  // Graceful shutdown handlers
  const shutdown = () => {
    console.log('[FaxParser] Shutting down...');
    watcher.close().finally(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

// ── CLI argument dispatch ─────────────────────────────────────────────────────
// These one-shot modes are invoked by the config app; anything else starts the watcher.

const extractOnlyArg = process.argv.slice(2).find((a: string) => a.startsWith('--extract-only='));
const processFileArg = process.argv.slice(2).find((a: string) => a.startsWith('--process-file='));

if (extractOnlyArg) {
  // OCR + field extraction only — no email, no file move, no log write.
  const filePath = extractOnlyArg.slice('--extract-only='.length);
  (async () => {
    const ocrText = await runOcr(filePath);
    const fields = parseOrderFields(ocrText);
    process.stdout.write(JSON.stringify({ rawText: ocrText, fields }, null, 2) + '\n');
    process.exit(0);
  })().catch((err: unknown) => {
    process.stderr.write('[FaxParser] extract-only failed: ' + (err instanceof Error ? err.message : String(err)) + '\n');
    process.exit(1);
  });
} else if (processFileArg) {
  // One-shot processing of a specific file (triggered manually from the config app).
  const filePath = processFileArg.slice('--process-file='.length);
  if (!fs.existsSync(filePath)) {
    console.log('[FaxParser] File already handled (not found at original path), skipping.');
    process.exit(0);
  }

  let fieldOverrides: Partial<FaxOrderFields> | undefined;
  const fieldOverridesArg = process.argv.slice(2).find((a: string) => a.startsWith('--field-overrides-file='));
  if (fieldOverridesArg) {
    const overridesPath = fieldOverridesArg.slice('--field-overrides-file='.length);
    try {
      fieldOverrides = JSON.parse(fs.readFileSync(overridesPath, 'utf-8')) as Partial<FaxOrderFields>;
    } catch (err: unknown) {
      console.error('[FaxParser] Warning: failed to load field overrides:', err instanceof Error ? err.message : String(err));
    }
  }

  processFile(filePath, fieldOverrides)
    .then(() => { console.log('[FaxParser] Done.'); process.exit(0); })
    .catch((err: unknown) => {
      console.error('[FaxParser] Failed:', err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
} else {
  startWatcher().catch((err: unknown) => {
    console.error('[FaxParser] Fatal error:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
