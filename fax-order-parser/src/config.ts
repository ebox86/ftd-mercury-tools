import * as fs from 'fs';
import * as path from 'path';

export type EmailEncryptionAlgorithm = 'None' | 'DES' | 'RC2' | 'Rijndael' | 'TripleDES';

export interface EmailConfig {
  senderAddress: string;
  senderPassword: string;
  smtpUsername?: string;
  recipientAddress: string;
  errorRecipientAddress?: string;
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

export interface MailGatewayConfig {
  enabled: boolean;
  mode: 'built-in-relay';
  bindAddress: string;
  smtpPort: number;
  pop3Port: number;
  forwardEnabled: boolean;
  forwardToAddress: string;
  forwardSmtpHost: string;
  forwardSmtpPort: number;
  forwardUsername: string;
  forwardPassword: string;
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
  mailGateway: MailGatewayConfig;
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
    errorRecipientAddress: 'order-error@localhost.local',
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
  mailGateway: {
    enabled: true,
    mode: 'built-in-relay',
    bindAddress: '127.0.0.1',
    smtpPort: 2525,
    pop3Port: 1110,
    forwardEnabled: true,
    forwardToAddress: 'your-gmail-address@gmail.com',
    forwardSmtpHost: 'smtp.gmail.com',
    forwardSmtpPort: 587,
    forwardUsername: 'your-gmail-address@gmail.com',
    forwardPassword: '',
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
    mailGateway: { ...DEFAULT_CONFIG.mailGateway },
    processing: { ...DEFAULT_CONFIG.processing },
  };
}

export interface MailboxTargets {
  primary: string;
  error: string;
}

export function resolveMailGatewayConfig(config: Partial<FaxParserConfig> | undefined): MailGatewayConfig {
  const legacy = config?.localRelay;
  const explicit = config?.mailGateway;
  const enabled = explicit?.enabled ?? legacy?.enabled ?? DEFAULT_CONFIG.mailGateway.enabled;

  return {
    enabled,
    mode: explicit?.mode ?? 'built-in-relay',
    bindAddress: explicit?.bindAddress ?? '127.0.0.1',
    smtpPort: explicit?.smtpPort ?? legacy?.smtpPort ?? DEFAULT_CONFIG.mailGateway.smtpPort,
    pop3Port: explicit?.pop3Port ?? legacy?.pop3Port ?? DEFAULT_CONFIG.mailGateway.pop3Port,
    forwardEnabled: explicit?.forwardEnabled ?? DEFAULT_CONFIG.mailGateway.forwardEnabled,
    forwardToAddress: explicit?.forwardToAddress ?? DEFAULT_CONFIG.mailGateway.forwardToAddress,
    forwardSmtpHost: explicit?.forwardSmtpHost ?? DEFAULT_CONFIG.mailGateway.forwardSmtpHost,
    forwardSmtpPort: explicit?.forwardSmtpPort ?? DEFAULT_CONFIG.mailGateway.forwardSmtpPort,
    forwardUsername: explicit?.forwardUsername ?? DEFAULT_CONFIG.mailGateway.forwardUsername,
    forwardPassword: explicit?.forwardPassword ?? DEFAULT_CONFIG.mailGateway.forwardPassword,
  };
}

function normalizeLocalRelayConfig(config: FaxParserConfig): FaxParserConfig {
  const gateway = resolveMailGatewayConfig(config);
  if (!gateway.enabled) return { ...config, mailGateway: gateway };

  return {
    ...config,
    mailGateway: gateway,
    localRelay: {
      ...config.localRelay,
      enabled: gateway.enabled,
      smtpPort: gateway.smtpPort,
      pop3Port: gateway.pop3Port,
    },
    email: {
      ...config.email,
      senderAddress: DEFAULT_CONFIG.email.senderAddress,
      senderPassword: '',
      smtpUsername: '',
      recipientAddress: DEFAULT_CONFIG.email.recipientAddress,
      smtpHost: DEFAULT_CONFIG.email.smtpHost,
      smtpPort: DEFAULT_CONFIG.email.smtpPort,
      encryptionPassword: '',
      encryptionAlgorithm: 'None',
    },
  };
}

export function resolveMailboxTargets(config: Partial<FaxParserConfig> | undefined): MailboxTargets {
  const recipient = config?.email?.recipientAddress?.trim();
  const errorRecipient = config?.email?.errorRecipientAddress?.trim();
  const primary = recipient || DEFAULT_CONFIG.email.recipientAddress;
  const error = errorRecipient || primary;
  return { primary, error };
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
      mailGateway: {
        ...DEFAULT_CONFIG.mailGateway,
        ...(parsed.mailGateway ?? {}),
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
