import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faArrowUp, faArrowDown, faPause, faPlay, faTrash } from '@fortawesome/free-solid-svg-icons';
import type { SoundLibraryEntry } from './types';

interface SoundLibraryTableProps {
  entries: SoundLibraryEntry[];
  playingSoundId: string;
  onRename: (id: string, name: string) => void;
  onMove: (id: string, direction: -1 | 1) => void;
  onRemove: (id: string) => void;
  onTogglePreview: (id: string) => void;
}

export function SoundLibraryTable({
  entries,
  playingSoundId,
  onRename,
  onMove,
  onRemove,
  onTogglePreview,
}: SoundLibraryTableProps) {
  return (
    <div className="app__config-sound-table">
      <div className="app__config-sound-table-header">
        <span>Order</span><span>Play</span><span>Name</span><span>Type</span><span></span>
      </div>
      {entries.map((entry, index) => (
        <div className="app__config-sound-table-row" key={entry.id}>
          <div className="app__config-sound-order-btns">
            <button
              type="button"
              onClick={() => onMove(entry.id, -1)}
              disabled={index === 0}
              aria-label="Move sound up"
            >
              <FontAwesomeIcon icon={faArrowUp} />
            </button>
            <button
              type="button"
              onClick={() => onMove(entry.id, 1)}
              disabled={index === entries.length - 1}
              aria-label="Move sound down"
            >
              <FontAwesomeIcon icon={faArrowDown} />
            </button>
          </div>
          <button
            type="button"
            className={`app__config-sound-play-btn${playingSoundId === entry.id ? ' app__config-sound-play-btn--active' : ''}`}
            onClick={() => onTogglePreview(entry.id)}
            aria-label={playingSoundId === entry.id ? 'Stop preview' : 'Play preview'}
          >
            <FontAwesomeIcon icon={playingSoundId === entry.id ? faPause : faPlay} />
          </button>
          <input
            type="text"
            value={entry.name}
            onChange={(event) => onRename(entry.id, event.target.value)}
          />
          <span className="app__config-sound-kind">{entry.kind}</span>
          {entry.kind === 'custom' ? (
            <button
              type="button"
              className="app__config-icon-btn"
              onClick={() => onRemove(entry.id)}
              aria-label="Remove sound"
            >
              <FontAwesomeIcon icon={faTrash} />
            </button>
          ) : <span />}
        </div>
      ))}
    </div>
  );
}
