const SETTINGS_KEY = 'hexahaven_settings';

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
}
