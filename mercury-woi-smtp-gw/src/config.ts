import * as fs from 'fs';
import * as path from 'path';

export interface GatewayConfig {
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

export interface WoiSmtpGatewayConfig {
  gateway: GatewayConfig;
}

export const DEFAULT_CONFIG: WoiSmtpGatewayConfig = {
  gateway: {
    bindAddress: '127.0.0.1',
    smtpPort: 2525,
    pop3Port: 1110,
    forwardEnabled: false,
    forwardToAddress: 'woi-inbox@example.com',
    forwardSmtpHost: 'smtp.example.com',
    forwardSmtpPort: 587,
    forwardUsername: 'woi-user@example.com',
    forwardPassword: '',
  },
};

export function getConfigDir(): string {
  return path.join(
    process.env['WOI_GATEWAY_CONFIG_DIR'] ||
    path.join(process.env['PROGRAMDATA'] || 'C:\\ProgramData', 'FTD', 'WoiSmtpGateway')
  );
}

export function getConfigPath(): string {
  return path.join(getConfigDir(), 'gateway-config.json');
}

export function getQueueDir(): string {
  return path.join(getConfigDir(), 'mailqueue');
}

export function loadConfig(): WoiSmtpGatewayConfig {
  const configPath = getConfigPath();
  if (!fs.existsSync(configPath)) {
    return { ...DEFAULT_CONFIG };
  }
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<WoiSmtpGatewayConfig>;
    return {
      gateway: {
        ...DEFAULT_CONFIG.gateway,
        ...(parsed.gateway ?? {}),
      },
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(config: WoiSmtpGatewayConfig): void {
  const dir = getConfigDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2), 'utf-8');
}

export function getGatewayConfig(): GatewayConfig {
  return loadConfig().gateway;
}
