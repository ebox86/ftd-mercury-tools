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
import { appendLogEntry, readLogEntries } from './logger';
import { sendWoiEmail, getMissingRequiredFields } from './email-sender';
import { runOcr, runOcrFull, parseOrderFields, detectFieldBboxes, FaxOrderFields } from './index';
import { startSmtpServer, startPop3Server } from './local-relay';

// ── File processor ─────────────────────────────────────────────────────────────

async function renameWithRetry(src: string, dest: string, retries = 8, baseDelayMs = 500): Promise<void> {
  for (let i = 0; i < retries; i++) {
    try {
      fs.renameSync(src, dest);
      return;
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if ((code !== 'EBUSY' && code !== 'EPERM') || i === retries - 1) throw err;
      const delay = baseDelayMs * (i + 1);
      console.warn(`[FaxParser] File locked (${code}), retrying in ${delay}ms… (attempt ${i + 1}/${retries})`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

function holdSidecarPath(filePath: string): string {
  return filePath + '.hold.json';
}

function sentSidecarPath(filePath: string): string {
  return filePath + '.sent.json';
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
  const fieldMap = config.fieldMap;
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

  // Guard against double-send: if the log already shows this file was emailed
  // successfully (e.g. .sent.json was lost but email went through), skip re-sending.
  if (!fieldOverrides) {
    const prevEntry = readLogEntries().find(e => e.fileName === fileName && e.emailSent);
    if (prevEntry) {
      console.warn(`[FaxParser] SKIP double-send: ${fileName} already emailed at ${prevEntry.timestamp}. Moving file only.`);
      const processedDir = path.join(path.dirname(filePath), config.processedSubfolder);
      if (!fs.existsSync(processedDir)) fs.mkdirSync(processedDir, { recursive: true });
      try { await renameWithRetry(filePath, path.join(processedDir, fileName)); } catch { /* non-fatal */ }
      return;
    }
  }

  let emailSent = false;
  let error: string | undefined;

  try {
    await sendWoiEmail(fields, config.email, fieldMap);
    emailSent = true;
    console.log(`[FaxParser] Email sent to ${config.email.recipientAddress}`);
    // Write .sent sidecar immediately so if the move below fails and chokidar
    // re-detects the file, we skip re-sending and just retry the move.
    try { fs.writeFileSync(sentSidecarPath(filePath), JSON.stringify({ timestamp: new Date().toISOString() }), 'utf-8'); } catch { /* non-fatal */ }
  } catch (err: unknown) {
    error = err instanceof Error ? err.message : String(err);
    console.error(`[FaxParser] Email send failed: ${error}`);
  }

  try { fs.unlinkSync(holdSidecarPath(filePath)); } catch { /* not held */ }

  const processedDir = path.join(path.dirname(filePath), config.processedSubfolder);
  if (!fs.existsSync(processedDir)) fs.mkdirSync(processedDir, { recursive: true });
  const dest = path.join(processedDir, fileName);

  let movedOk = false;
  try {
    await renameWithRetry(filePath, dest);
    movedOk = true;
    console.log(`[FaxParser] Moved to: ${dest}`);
    try { fs.unlinkSync(sentSidecarPath(filePath)); } catch { /* non-fatal */ }
  } catch (moveErr: unknown) {
    const moveMsg = moveErr instanceof Error ? moveErr.message : String(moveErr);
    console.error(`[FaxParser] Move failed — will retry on next poll: ${moveMsg}`);
    if (!error) error = `Move failed (email ${emailSent ? 'was' : 'was not'} sent): ${moveMsg}`;
  }

  appendLogEntry({
    timestamp: new Date().toISOString(),
    fileName,
    orderNumber: fields.orderNumber,
    customerName: fields.customerName,
    deliveryDate: fields.deliveryDate,
    emailSent,
    error,
    fields: Object.fromEntries(
      Object.entries(fields).filter(([, v]) => v !== undefined)
    ) as Record<string, string>,
    processedFilePath: movedOk ? dest : undefined,
  });
}

// ── Folder watcher ─────────────────────────────────────────────────────────────

async function startWatcher(): Promise<void> {
  // Reload config on every file event so settings changes take effect without restart.
  const config = loadConfig();

  // Start built-in SMTP/POP3 relay if enabled
  const smtpServer = config.localRelay.enabled ? startSmtpServer(config.localRelay.smtpPort) : null;
  const pop3Server = config.localRelay.enabled ? startPop3Server(config.localRelay.pop3Port)  : null;
  if (config.localRelay.enabled)
    console.log(`[FaxParser] Local relay enabled — SMTP :${config.localRelay.smtpPort}  POP3 :${config.localRelay.pop3Port}`);

  const watchFolder = config.watchFolder;
  const pollInterval = config.pollIntervalSeconds * 1000;
  const exts = config.fileFormat === 'PDF'
    ? new Set(['.pdf'])
    : new Set(['.tif', '.tiff', '.jpg', '.jpeg']);
  const processedSubfolder = config.processedSubfolder;

  console.log(`[FaxParser] Watch folder  : ${watchFolder}`);
  console.log(`[FaxParser] File format   : ${[...exts].join(', ')}`);
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
    if (!exts.has(fileExt)) return;
    if (inFlight.has(filePath)) return;

    // Email already sent but file wasn't moved (e.g., previous EBUSY). Retry
    // the move only — do not re-OCR or re-send.
    if (fs.existsSync(sentSidecarPath(filePath))) {
      console.log(`[FaxParser] Completing deferred move: ${path.basename(filePath)}`);
      inFlight.add(filePath);
      (async () => {
        try {
          const cfg = loadConfig();
          const dir = path.join(path.dirname(filePath), cfg.processedSubfolder);
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          await renameWithRetry(filePath, path.join(dir, path.basename(filePath)));
          try { fs.unlinkSync(sentSidecarPath(filePath)); } catch { /* non-fatal */ }
          console.log(`[FaxParser] Deferred move complete.`);
        } catch (err: unknown) {
          console.warn(`[FaxParser] Deferred move still pending: ${err instanceof Error ? err.message : String(err)}`);
        }
      })().finally(() => inFlight.delete(filePath));
      return;
    }

    // Skip files quarantined for manual review
    if (fs.existsSync(holdSidecarPath(filePath))) {
      console.log(`[FaxParser] Skipping held file: ${path.basename(filePath)} (open config app to review)`);
      return;
    }

    inFlight.add(filePath);

    processFile(filePath)
      .catch((err: unknown) => {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
          // File disappeared between detection and processing (fax software moved it). Skip silently.
          console.log(`[FaxParser] Skipping ${path.basename(filePath)}: file already gone.`);
          return;
        }
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
    smtpServer?.close();
    pop3Server?.close();
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
    const { text, words } = await runOcrFull(filePath);
    const fields = parseOrderFields(text);
    const detectedBounds = detectFieldBboxes(fields, words);
    process.stdout.write(JSON.stringify({
      rawText: text,
      fields,
      detectedBounds,
      filePath: path.resolve(filePath),
    }, null, 2) + '\n');
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
