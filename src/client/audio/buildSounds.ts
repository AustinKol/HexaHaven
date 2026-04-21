import { loadSettings } from '../settings/gameSettings';
import { scaledGameSfxVolume } from './musicVolume';

/** Gain before master volume — road placement one-shot. */
const BASE_BUILD_ROAD_VOLUME = 0.4;
/** Gain before master volume — settlement and city placement (shared clip). */
const BASE_BUILD_SETTLEMENT_VOLUME = 0.45;
/** Gain before master volume — dice roll one-shot. */
const BASE_DICE_ROLL_VOLUME = 0.55;

/** Plays a short sound when the local player places a structure on the map. */
export function playBuildPlacementSound(kind: 'ROAD' | 'SETTLEMENT' | 'CITY'): void {
  if (!loadSettings().sfxEnabled) {
    return;
  }
  const src = kind === 'ROAD' ? '/audio/build-road.mp3' : '/audio/build-settlement.mp3';
  const base = kind === 'ROAD' ? BASE_BUILD_ROAD_VOLUME : BASE_BUILD_SETTLEMENT_VOLUME;
  const audio = new Audio(src);
  audio.volume = scaledGameSfxVolume(base);
  void audio.play().catch(() => {
    // Autoplay policy or missing file — ignore
  });
}

/** Plays the dice rolling SFX when the local player clicks roll. */
export function playDiceRollSound(): void {
  if (!loadSettings().sfxEnabled) {
    return;
  }
  const audio = new Audio('/audio/dice-roll.mp3');
  audio.volume = scaledGameSfxVolume(BASE_DICE_ROLL_VOLUME);
  void audio.play().catch(() => {
    // Autoplay policy or missing file — ignore
  });
}
