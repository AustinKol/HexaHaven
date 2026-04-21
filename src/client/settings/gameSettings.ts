const SETTINGS_KEY = 'hexahaven_settings';

/** Dispatched on `window` whenever settings are persisted (volume, SFX). */
export const SETTINGS_CHANGED_EVENT = 'hexahaven-settings-changed';

export interface GameSettings {
  masterVolume: number;
  /** 0–100; scales in-game board background music (game screen theme). */
  boardMusicVolume: number;
  /** 0–100; scales placement SFX (roads, settlements, cities). */
  gameSfxVolume: number;
  sfxEnabled: boolean;
}

const DEFAULTS: GameSettings = {
  masterVolume: 80,
  boardMusicVolume: 100,
  gameSfxVolume: 100,
  sfxEnabled: true,
};

export function loadSettings(): GameSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULTS };
    const merged = { ...DEFAULTS, ...JSON.parse(raw) };
    return {
      masterVolume: typeof merged.masterVolume === 'number' ? merged.masterVolume : DEFAULTS.masterVolume,
      boardMusicVolume:
        typeof merged.boardMusicVolume === 'number' ? merged.boardMusicVolume : DEFAULTS.boardMusicVolume,
      gameSfxVolume: typeof merged.gameSfxVolume === 'number' ? merged.gameSfxVolume : DEFAULTS.gameSfxVolume,
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
