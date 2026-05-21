import * as fs from 'fs';
import * as path from 'path';

export type EmailEncryptionAlgorithm = 'DES' | 'RC2' | 'Rijndael' | 'TripleDES';

export interface EmailConfig {
  senderAddress: string;
  senderPassword: string;
  recipientAddress: string;
  smtpHost: string;
  smtpPort: number;
  subjectLine: string;
  encryptionPassword?: string;
  encryptionAlgorithm?: EmailEncryptionAlgorithm;
}

export interface FaxParserConfig {
  watchFolder: string;
  pollIntervalSeconds: number;
  fileFormat: 'PDF' | 'TIF';
  processedSubfolder: string;
  email: EmailConfig;
}

export function getConfigDir(): string {
  return path.join(
    process.env['FAX_PARSER_CONFIG_DIR'] ||
    path.join(process.env['PROGRAMDATA'] || 'C:\\ProgramData', 'FTD', 'FaxOrderParser')
  );
}

export function getConfigPath(): string {
  return path.join(getConfigDir(), 'config.json');
}

export const DEFAULT_CONFIG: FaxParserConfig = {
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
    encryptionPassword: '',
    encryptionAlgorithm: 'TripleDES',
  },
};

export function loadConfig(): FaxParserConfig {
  const configPath = getConfigPath();
  if (!fs.existsSync(configPath)) {
    return { ...DEFAULT_CONFIG, email: { ...DEFAULT_CONFIG.email } };
  }
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<FaxParserConfig>;
    return {
      ...DEFAULT_CONFIG,
      ...parsed,
      email: {
        ...DEFAULT_CONFIG.email,
        ...(parsed.email ?? {}),
      },
    };
  } catch {
    return { ...DEFAULT_CONFIG, email: { ...DEFAULT_CONFIG.email } };
  }
}

export function saveConfig(config: FaxParserConfig): void {
  const dir = getConfigDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2), 'utf-8');
}
