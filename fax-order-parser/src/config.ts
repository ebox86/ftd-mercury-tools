import * as fs from 'fs';
import * as path from 'path';

export type EmailEncryptionAlgorithm = 'None' | 'DES' | 'RC2' | 'Rijndael' | 'TripleDES';

export interface EmailConfig {
  senderAddress: string;
  senderPassword: string;
  smtpUsername?: string;
  recipientAddress: string;
  smtpHost: string;
  smtpPort: number;
  subjectLine: string;
  encryptionPassword?: string;
  encryptionAlgorithm?: EmailEncryptionAlgorithm;
}

export interface FieldBounds {
  x: number; // fraction of image width  (0–1)
  y: number; // fraction of image height (0–1)
  w: number;
  h: number;
}

export interface LocalRelayConfig {
  enabled: boolean;
  smtpPort: number;
  pop3Port: number;
}

export interface ProcessingConfig {
  useOrderPlacedDateWhenDeliveryDateMissing: boolean;
}

export interface FaxParserConfig {
  watchFolder: string;
  pollIntervalSeconds: number;
  fileFormat: 'PDF' | 'TIF';
  processedSubfolder: string;
  email: EmailConfig;
  fieldMap: Record<string, string>;
  fieldBounds?: Record<string, FieldBounds>;
  localRelay: LocalRelayConfig;
  processing: ProcessingConfig;
}

export const DEFAULT_FIELD_MAP: Record<string, string> = {
  'Bill Name':             'Customer Name',
  'Recipient Name':        'For the Passing Of',
  'Card Message':          'Card Message',
  'Product Code 1':        'Product Item Number',
  'Delivery Instructions': 'Delivery Time',
  'Additional Information':'For the Passing Of',
  'Delivery Date':         'Delivery Date',
};

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
    senderAddress: 'faxparser@localhost.local',
    senderPassword: '',
    smtpUsername: '',
    recipientAddress: 'order@localhost.local',
    smtpHost: '127.0.0.1',
    smtpPort: 2525,
    subjectLine: 'Online Order',
    encryptionPassword: '',
    encryptionAlgorithm: 'None',
  },
  fieldMap: { ...DEFAULT_FIELD_MAP },
  localRelay: {
    enabled: true,
    smtpPort: 2525,
    pop3Port: 1110,
  },
  processing: {
    useOrderPlacedDateWhenDeliveryDateMissing: true,
  },
};

function cloneDefaultConfig(): FaxParserConfig {
  return {
    ...DEFAULT_CONFIG,
    email: { ...DEFAULT_CONFIG.email },
    fieldMap: { ...DEFAULT_FIELD_MAP },
    localRelay: { ...DEFAULT_CONFIG.localRelay },
    processing: { ...DEFAULT_CONFIG.processing },
  };
}

function normalizeLocalRelayConfig(config: FaxParserConfig): FaxParserConfig {
  if (!config.localRelay.enabled) return config;

  return {
    ...config,
    email: {
      ...config.email,
      senderAddress: DEFAULT_CONFIG.email.senderAddress,
      senderPassword: '',
      smtpUsername: '',
      recipientAddress: DEFAULT_CONFIG.email.recipientAddress,
      smtpHost: DEFAULT_CONFIG.email.smtpHost,
      smtpPort: config.localRelay.smtpPort,
      encryptionPassword: '',
      encryptionAlgorithm: 'None',
    },
  };
}

export function loadConfig(): FaxParserConfig {
  const configPath = getConfigPath();
  if (!fs.existsSync(configPath)) {
    return normalizeLocalRelayConfig(cloneDefaultConfig());
  }
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<FaxParserConfig>;
    return normalizeLocalRelayConfig({
      ...DEFAULT_CONFIG,
      ...parsed,
      email: {
        ...DEFAULT_CONFIG.email,
        ...(parsed.email ?? {}),
      },
      fieldMap: {
        ...DEFAULT_FIELD_MAP,
        ...(parsed.fieldMap ?? {}),
      },
      localRelay: {
        ...DEFAULT_CONFIG.localRelay,
        ...(parsed.localRelay ?? {}),
      },
      processing: {
        ...DEFAULT_CONFIG.processing,
        ...(parsed.processing ?? {}),
      },
    });
  } catch {
    return normalizeLocalRelayConfig(cloneDefaultConfig());
  }
}

export function saveConfig(config: FaxParserConfig): void {
  const dir = getConfigDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2), 'utf-8');
}
