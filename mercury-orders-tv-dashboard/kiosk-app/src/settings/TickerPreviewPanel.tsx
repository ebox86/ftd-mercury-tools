import type { CSSProperties } from 'react';

interface TickerPreviewPanelProps {
  hourLabel: string;
  minuteLabel: string;
  secondLabel: string;
  meridiemLabel: string;
  dateLabel: string;
  separatorsVisible: boolean;
  scrollText: string;
  clockBgColor: string;
  clockTextColor: string;
  clockBorderColor: string;
}

export function TickerPreviewPanel({
  hourLabel,
  minuteLabel,
  secondLabel,
  meridiemLabel,
  dateLabel,
  separatorsVisible,
  scrollText,
  clockBgColor,
  clockTextColor,
  clockBorderColor,
}: TickerPreviewPanelProps) {
  const clockStyle = {
    '--ticker-clock-bg': clockBgColor,
    '--ticker-clock-text': clockTextColor,
    '--ticker-clock-border': clockBorderColor,
  } as CSSProperties;

  return (
    <div className="app__settings-preview">
      <span className="app__settings-preview-label">Live preview &mdash; matches the on-screen ticker bar</span>
      <div className="app__settings-preview-ticker">
        <div className="app__settings-preview-ticker-clock" style={clockStyle}>
          <span className="app__settings-preview-ticker-time">
            <span>{hourLabel}</span>
            <span style={{ opacity: separatorsVisible ? 1 : 0.18 }}>:</span>
            <span>{minuteLabel}</span>
            <span style={{ opacity: separatorsVisible ? 1 : 0.18 }}>:</span>
            <span>{secondLabel}</span>
            {meridiemLabel ? <span className="app__settings-preview-ticker-meridiem">{meridiemLabel}</span> : null}
          </span>
          <span className="app__settings-preview-ticker-date">{dateLabel}</span>
        </div>
        <div className="app__settings-preview-ticker-track">
          <span>{scrollText}</span>
        </div>
      </div>
    </div>
  );
}
