import { loadSettings } from '../settings/gameSettings';

/** Design-time gain for menu loop before master volume. */
export const BASE_MENU_MUSIC_VOLUME = 0.5;

/** Design-time gain for in-game board music before master volume. */
export const BASE_GAME_BOARD_MUSIC_VOLUME = 0.35;

export function getMasterVolumeFactor(): number {
  const raw = loadSettings().masterVolume;
  const v = typeof raw === 'number' ? raw : Number(raw);
  if (Number.isNaN(v)) {
    return 0.8;
  }
  return Math.max(0, Math.min(1, v / 100));
}

export function scaledMusicVolume(base: number): number {
  return Math.min(1, Math.max(0, base * getMasterVolumeFactor()));
}
