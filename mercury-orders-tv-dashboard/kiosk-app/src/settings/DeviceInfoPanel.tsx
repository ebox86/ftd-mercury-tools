import { useState } from 'react';

interface DeviceInfoPanelProps {
  deviceId: string;
  deviceLabel: string;
  deviceToken: string;
  isPaired: boolean;
  serverOrigin: string;
}

export function DeviceInfoPanel({ deviceId, deviceLabel, deviceToken, isPaired, serverOrigin }: DeviceInfoPanelProps) {
  const [copyLabel, setCopyLabel] = useState('Copy');

  const kioskUrl = isPaired && deviceToken && typeof window !== 'undefined'
    ? `${window.location.origin}${window.location.pathname}?deviceToken=${deviceToken}`
    : '';

  const handleCopy = () => {
    if (!kioskUrl) return;
    const done = () => {
      setCopyLabel('Copied');
      window.setTimeout(() => setCopyLabel('Copy'), 1500);
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(kioskUrl).then(done, done);
    } else {
      done();
    }
  };

  return (
    <section className="app__config-section">
      <div className="app__config-section-header-row">
        <h3 className="app__config-section-title">Device Info</h3>
        <span className="app__config-advanced-badge">Advanced</span>
      </div>
      <p className="app__config-section-subtitle">
        Read-only. TVs are paired, renamed, and revoked from the bridge's Admin page (Paired Devices there) &mdash; not here.
      </p>

      {kioskUrl ? (
        <div className="app__config-kiosk-url-card">
          <span>Kiosk URL</span>
          <div className="app__config-kiosk-url-row">
            <input
              className="app__config-kiosk-url-box"
              type="text"
              value={kioskUrl}
              readOnly
              onFocus={(event) => event.target.select()}
            />
            <button type="button" className="app__settings-btn app__settings-btn--primary app__config-kiosk-url-copy" onClick={handleCopy}>
              {copyLabel}
            </button>
          </div>
        </div>
      ) : null}

      <div className="app__config-grid app__config-grid--2col">
        <label className="app__config-row">
          <span>Device name</span>
          <input type="text" value={isPaired ? deviceLabel : 'Not paired'} readOnly />
        </label>
        <label className="app__config-row">
          <span>Pairing status</span>
          <div className="app__config-row-static">
            <span className={`app__config-status-pill${isPaired ? ' app__config-status-pill--on' : ' app__config-status-pill--off'}`}>
              {isPaired ? 'Paired' : 'Pairing not required'}
            </span>
          </div>
        </label>
        <label className="app__config-row">
          <span>Paired server</span>
          <input type="text" value={serverOrigin || '--'} readOnly />
        </label>
        <label className="app__config-row">
          <span>Device ID</span>
          <input type="text" value={deviceId || '--'} readOnly />
        </label>
      </div>
    </section>
  );
}
