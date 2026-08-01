import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faGear } from '@fortawesome/free-solid-svg-icons';
import { SETTINGS_SECTIONS, SETTINGS_SECTION_GROUPS } from './sections';
import type { SettingsSectionId } from './types';

interface SettingsSidebarNavProps {
  activeSection: SettingsSectionId;
  onSelect: (section: SettingsSectionId) => void;
  deviceLabel?: string;
}

export function SettingsSidebarNav({ activeSection, onSelect, deviceLabel }: SettingsSidebarNavProps) {
  return (
    <nav className="app__settings-sidebar" aria-label="Settings sections">
      <div className="app__settings-brand">
        <span className="app__settings-brand-icon"><FontAwesomeIcon icon={faGear} /></span>
        <span className="app__settings-brand-copy">
          <strong>Talaria Settings</strong>
          <span>TV Kiosk &middot; Talaria</span>
        </span>
      </div>
      {SETTINGS_SECTION_GROUPS.map(group => (
        <div className="app__settings-nav-group" key={group}>
          <span className="app__settings-nav-label">{group}</span>
          {SETTINGS_SECTIONS.filter(section => section.group === group).map(section => (
            <button
              key={section.id}
              type="button"
              className={`app__settings-nav-btn${activeSection === section.id ? ' app__settings-nav-btn--active' : ''}`}
              onClick={() => onSelect(section.id)}
            >
              {section.label}
            </button>
          ))}
        </div>
      ))}
      <div className="app__settings-signed-in">
        Signed in as <strong>{deviceLabel || 'This device'}</strong>
      </div>
    </nav>
  );
}
