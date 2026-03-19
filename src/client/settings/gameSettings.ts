const SETTINGS_KEY = 'hexahaven_settings';

/** Dispatched on `window` whenever settings are persisted (volume, SFX, text speed). */
export const SETTINGS_CHANGED_EVENT = 'hexahaven-settings-changed';

export type TextSpeed = 'Slow' | 'Medium' | 'Fast';

export interface GameSettings {
  masterVolume: number; 
  sfxEnabled: boolean;
  textSpeed: TextSpeed;
}

const DEFAULTS: GameSettings = {
  masterVolume: 80,
  sfxEnabled: true,
  textSpeed: 'Medium',
};

export function loadSettings(): GameSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULTS };
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(settings: GameSettings): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  window.dispatchEvent(new Event(SETTINGS_CHANGED_EVENT));
}
