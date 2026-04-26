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
import { loadConfig } from './config';
import { appendLogEntry } from './logger';
import { sendWoiEmail } from './email-sender';
import { runOcr, parseOrderFields } from './index';

// ── File processor ─────────────────────────────────────────────────────────────

async function processFile(filePath: string): Promise<void> {
  const config = loadConfig();
  const fileName = path.basename(filePath);

  console.log(`[FaxParser] Processing: ${fileName}`);

  const ocrText = await runOcr(filePath);
  const fields = parseOrderFields(ocrText);

  console.log('[FaxParser] Parsed order #', fields.orderNumber ?? '(unknown)');

  let emailSent = false;
  let error: string | undefined;

  if (!config.email.senderPassword) {
    error = 'Email not sent: sender password not configured. Open the config app to set it.';
    console.warn(`[FaxParser] ${error}`);
  } else {
    try {
      await sendWoiEmail(fields, config.email, config.fieldMap);
      emailSent = true;
      console.log(`[FaxParser] Email sent to ${config.email.recipientAddress}`);
    } catch (err: unknown) {
      error = err instanceof Error ? err.message : String(err);
      console.error(`[FaxParser] Email send failed: ${error}`);
    }
  }

  // Move processed file to the configured subfolder
  const processedDir = path.join(path.dirname(filePath), config.processedSubfolder);
  if (!fs.existsSync(processedDir)) {
    fs.mkdirSync(processedDir, { recursive: true });
  }
  // Avoid collision if the destination already exists (e.g. file was re-queued)
  let dest = path.join(processedDir, fileName);
  if (fs.existsSync(dest)) {
    const ext  = path.extname(fileName);
    const base = path.basename(fileName, ext);
    const ts   = Date.now();
    dest = path.join(processedDir, `${base}_${ts}${ext}`);
  }
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

// One-shot mode: invoked by the config app to manually process a specific file.
// Usage: node service.js --process-file=<path>
const processFileArg = process.argv.slice(2).find((a: string) => a.startsWith('--process-file='));

// Extract-only mode: runs OCR + field extraction, prints JSON to stdout, no email / no file move.
// Usage: node service.js --extract-only=<path>
const extractOnlyArg = process.argv.slice(2).find((a: string) => a.startsWith('--extract-only='));

if (extractOnlyArg) {
  const filePath = extractOnlyArg.slice('--extract-only='.length);
  (async () => {
    const ocrText = await runOcr(filePath);
    const fields = parseOrderFields(ocrText);
    // Write a JSON envelope with both raw OCR and parsed fields so the config
    // app can show a "Raw OCR" debug tab alongside the field mapping.
    process.stdout.write(JSON.stringify({ rawText: ocrText, fields }, null, 2) + '\n');
    process.exit(0);
  })().catch((err: unknown) => {
    process.stderr.write('[FaxParser] extract-only failed: ' + (err instanceof Error ? err.message : String(err)) + '\n');
    process.exit(1);
  });
} else if (processFileArg) {
  const filePath = processFileArg.slice('--process-file='.length);
  if (!fs.existsSync(filePath)) {
    console.log('[FaxParser] File already handled (not found at original path), skipping.');
    process.exit(0);
  }
  processFile(filePath)
    .then(() => {
      console.log('[FaxParser] Done.');
      process.exit(0);
    })
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
