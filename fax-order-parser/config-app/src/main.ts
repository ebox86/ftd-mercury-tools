import { app, BrowserWindow, ipcMain, shell } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { execFile, exec } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

// ── Config file paths (must match fax-order-parser/src/config.ts) ────────────

const CONFIG_DIR = path.join(
  process.env['PROGRAMDATA'] ?? 'C:\\ProgramData',
  'FTD', 'FaxOrderParser'
);
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
const LOG_PATH = path.join(CONFIG_DIR, 'orders-log.json');

const SERVICE_NAME = 'FTD Fax Order Parser';

// ── Default config (mirrors DEFAULT_CONFIG in config.ts) ─────────────────────

const DEFAULT_CONFIG = {
  watchFolder: 'C:\\received_faxes',
  pollIntervalSeconds: 10,
  fileFormat: 'PDF',
  processedSubfolder: 'processed',
  email: {
    senderAddress: 'oliverflowershop71440@gmail.com',
    senderPassword: '',
    recipientAddress: 'ftdpos71440@oliverflowers.com',
    smtpHost: 'smtp.gmail.com',
    smtpPort: 587,
    subjectLine: 'Online Order',
  },
};

// ── IPC handlers ──────────────────────────────────────────────────────────────

ipcMain.handle('config:load', () => {
  if (!fs.existsSync(CONFIG_PATH)) return DEFAULT_CONFIG;
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_CONFIG, ...parsed, email: { ...DEFAULT_CONFIG.email, ...(parsed.email ?? {}) } };
  } catch {
    return DEFAULT_CONFIG;
  }
});

ipcMain.handle('config:save', (_event, config: unknown) => {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
  return { ok: true };
});

ipcMain.handle('log:read', () => {
  if (!fs.existsSync(LOG_PATH)) return [];
  try {
    return JSON.parse(fs.readFileSync(LOG_PATH, 'utf-8'));
  } catch {
    return [];
  }
});

ipcMain.handle('service:status', async () => {
  try {
    const { stdout } = await execAsync(`sc query "${SERVICE_NAME}"`);
    if (stdout.includes('RUNNING')) return 'running';
    if (stdout.includes('STOPPED')) return 'stopped';
    return 'unknown';
  } catch {
    return 'not-installed';
  }
});

ipcMain.handle('service:start', async () => {
  try {
    await execAsync(`sc start "${SERVICE_NAME}"`);
    return { ok: true };
  } catch (err: unknown) {
    return { ok: false, error: String(err) };
  }
});

ipcMain.handle('service:stop', async () => {
  try {
    await execAsync(`sc stop "${SERVICE_NAME}"`);
    return { ok: true };
  } catch (err: unknown) {
    return { ok: false, error: String(err) };
  }
});

ipcMain.handle('shell:openFolder', (_event, folderPath: string) => {
  shell.openPath(folderPath);
});

// ── Window creation ───────────────────────────────────────────────────────────

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 780,
    height: 600,
    resizable: false,
    title: 'FTD Fax Order Parser — Configuration',
    icon: path.join(__dirname, '..', 'assets', 'fax-parser.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.setMenu(null);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  return win;
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
