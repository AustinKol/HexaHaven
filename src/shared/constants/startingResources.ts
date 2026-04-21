import type { ResourceBundle } from '../types/domain';

/** Default inventory for each player when a session begins (dev / playtest). */
export const DEFAULT_STARTING_RESOURCE_COUNT = 10;

export function defaultStartingResourceBundle(): ResourceBundle {
  const n = DEFAULT_STARTING_RESOURCE_COUNT;
  return {
    CRYSTAL: n,
    STONE: n,
    BLOOM: n,
    EMBER: n,
    GOLD: n,
  };
}
