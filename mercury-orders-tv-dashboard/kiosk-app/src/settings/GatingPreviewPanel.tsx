export interface GatingPreviewValues {
  sampleAmountLabel: string;
  thresholdLabel: string;
  firstZip: string;
  isZipWatchlist: boolean;
  firstSenderPattern: string;
}

interface GatingPreviewPanelProps {
  preview: GatingPreviewValues;
}

export function GatingPreviewPanel({ preview }: GatingPreviewPanelProps) {
  const zipBadgeVariant = preview.isZipWatchlist ? 'review' : 'reject';
  return (
    <div className="app__settings-preview app__settings-preview--gating">
      <span className="app__settings-preview-label">Live preview &mdash; how flagged orders look on the board</span>
      <div className="app__settings-preview-gate-card app__settings-preview-gate-card--review">
        <span className="app__settings-preview-badge app__settings-preview-badge--review">Below Threshold</span>
        <span className="app__settings-preview-gate-name">CHEN, ROBERT</span>
        <span className="app__settings-preview-gate-meta">
          Order #58213 &middot; {preview.sampleAmountLabel} (min {preview.thresholdLabel}) &middot; Delivers today
        </span>
      </div>
      <div className={`app__settings-preview-gate-card app__settings-preview-gate-card--${zipBadgeVariant}`}>
        <span className={`app__settings-preview-badge app__settings-preview-badge--${zipBadgeVariant}`}>
          {preview.isZipWatchlist ? 'ZIP Watch' : 'ZIP Not Allowed'}
        </span>
        <span className="app__settings-preview-gate-name">MARTINEZ, ANA</span>
        <span className="app__settings-preview-gate-meta">
          Order #58244 &middot; ZIP {preview.firstZip} &middot; Local delivery
        </span>
      </div>
      <div className="app__settings-preview-gate-card app__settings-preview-gate-card--reject">
        <span className="app__settings-preview-badge app__settings-preview-badge--reject">Sender Match</span>
        <span className="app__settings-preview-gate-name">WIRE-IN, WELLINGTON FLORIST</span>
        <span className="app__settings-preview-gate-meta">
          Order #58267 &middot; Sender matches &ldquo;{preview.firstSenderPattern}&rdquo;
        </span>
      </div>
    </div>
  );
}
