export type SettingsSectionId = 'pages' | 'ticker' | 'shop' | 'gating' | 'audio' | 'feed' | 'api' | 'devices';

export type SoundLibraryEntryKind = 'preset' | 'custom';

export interface SoundLibraryEntry {
  id: string;
  name: string;
  kind: SoundLibraryEntryKind;
  presetTone?: 'alarm_pulse' | 'classic_ding' | 'bright_beep';
  dataUrl?: string;
}
