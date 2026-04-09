import { loadSettings } from '../settings/gameSettings';

/** Design-time gain for menu loop before master volume. */
export const BASE_MENU_MUSIC_VOLUME = 0.5;

/** Design-time gain for in-game board music before master volume. */
export const BASE_GAME_BOARD_MUSIC_VOLUME = 0.35;

/**
 * Board music slider is 0–100% in UI; at 100% we apply this fraction of the old
 * maximum chain so the default (100%) matches ~50% of the previous loudness.
 */
const BOARD_MUSIC_UI_FULL_SCALE = 0.5;

export function getMasterVolumeFactor(): number {
  const raw = loadSettings().masterVolume;
  const v = typeof raw === 'number' ? raw : Number(raw);
  if (Number.isNaN(v)) {
    return 0.8;
  }
  return Math.max(0, Math.min(1, v / 100));
}

function getBoardMusicVolumeFactor(): number {
  const raw = loadSettings().boardMusicVolume;
  const v = typeof raw === 'number' ? raw : Number(raw);
  if (Number.isNaN(v)) {
    return 1;
  }
  return Math.max(0, Math.min(1, v / 100));
}

function getGameSfxVolumeFactor(): number {
  const raw = loadSettings().gameSfxVolume;
  const v = typeof raw === 'number' ? raw : Number(raw);
  if (Number.isNaN(v)) {
    return 1;
  }
  return Math.max(0, Math.min(1, v / 100));
}

export function scaledMusicVolume(base: number): number {
  return Math.min(1, Math.max(0, base * getMasterVolumeFactor()));
}

/** In-game board loop: master × board music slider × {@link BOARD_MUSIC_UI_FULL_SCALE} (UI 100% = half previous max). */
export function scaledBoardMusicVolume(base: number): number {
  return Math.min(
    1,
    Math.max(0, base * getMasterVolumeFactor() * getBoardMusicVolumeFactor() * BOARD_MUSIC_UI_FULL_SCALE),
  );
}

/** Placement and other in-game SFX: master × game SFX slider. */
export function scaledGameSfxVolume(base: number): number {
  return Math.min(1, Math.max(0, base * getMasterVolumeFactor() * getGameSfxVolumeFactor()));
}
