import * as fs from 'fs';
import * as path from 'path';
import { getConfigDir } from './config';

export interface OrderLogEntry {
  timestamp: string;
  fileName: string;
  orderNumber?: string;
  customerName?: string;
  deliveryDate?: string;
  emailSent: boolean;
  error?: string;
}

export function getLogPath(): string {
  return path.join(getConfigDir(), 'orders-log.json');
}

export function appendLogEntry(entry: OrderLogEntry): void {
  const logPath = getLogPath();
  let entries: OrderLogEntry[] = [];

  if (fs.existsSync(logPath)) {
    try {
      entries = JSON.parse(fs.readFileSync(logPath, 'utf-8')) as OrderLogEntry[];
    } catch {
      entries = [];
    }
  }

  entries.push(entry);
  // Keep only the last 1000 entries
  if (entries.length > 1000) {
    entries = entries.slice(entries.length - 1000);
  }

  const dir = path.dirname(logPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(logPath, JSON.stringify(entries, null, 2), 'utf-8');
}

export function readLogEntries(): OrderLogEntry[] {
  const logPath = getLogPath();
  if (!fs.existsSync(logPath)) return [];
  try {
    return JSON.parse(fs.readFileSync(logPath, 'utf-8')) as OrderLogEntry[];
  } catch {
    return [];
  }
}
