const SETTINGS_KEY = 'hexahaven_settings';

/** Dispatched on `window` whenever settings are persisted (volume, SFX). */
export const SETTINGS_CHANGED_EVENT = 'hexahaven-settings-changed';

export interface GameSettings {
  masterVolume: number;
  sfxEnabled: boolean;
}

const DEFAULTS: GameSettings = {
  masterVolume: 80,
  sfxEnabled: true,
};

export function loadSettings(): GameSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULTS };
    const merged = { ...DEFAULTS, ...JSON.parse(raw) };
    return {
      masterVolume: typeof merged.masterVolume === 'number' ? merged.masterVolume : DEFAULTS.masterVolume,
      sfxEnabled: typeof merged.sfxEnabled === 'boolean' ? merged.sfxEnabled : DEFAULTS.sfxEnabled,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(settings: GameSettings): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  window.dispatchEvent(new Event(SETTINGS_CHANGED_EVENT));
}
