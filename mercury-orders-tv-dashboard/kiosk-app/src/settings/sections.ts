import type { SettingsSectionId } from './types';

export interface SettingsSectionDefinition {
  id: SettingsSectionId;
  label: string;
  group: string;
}

export const SETTINGS_SECTIONS: SettingsSectionDefinition[] = [
  { id: 'pages', label: 'Pages & Rotation', group: 'Dashboard' },
  { id: 'ticker', label: 'Ticker', group: 'Dashboard' },
  { id: 'shop', label: 'Shop & Branding', group: 'Operations' },
  { id: 'gating', label: 'Order Gating', group: 'Operations' },
  { id: 'audio', label: 'Audio Alerts', group: 'Operations' },
  { id: 'feed', label: 'Feed & Timing', group: 'Advanced' },
  { id: 'api', label: 'API & Mercury', group: 'Advanced' },
  { id: 'devices', label: 'Device Info', group: 'Advanced' },
];

export const SETTINGS_SECTION_GROUPS: string[] = ['Dashboard', 'Operations', 'Advanced'];
