import type { ResourceBundle } from './types/domain';

export type BuildStructureKind = 'ROAD' | 'SETTLEMENT' | 'CITY';

export const BUILD_COSTS: Record<BuildStructureKind, ResourceBundle> = {
  ROAD: { CRYSTAL: 0, STONE: 1, BLOOM: 0, EMBER: 1, GOLD: 0 },
  SETTLEMENT: { CRYSTAL: 0, STONE: 1, BLOOM: 1, EMBER: 1, GOLD: 0 },
  CITY: { CRYSTAL: 0, STONE: 3, BLOOM: 2, EMBER: 0, GOLD: 0 },
};
