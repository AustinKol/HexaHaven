import type { GameState, ResourceBundle } from '../../shared/types/domain';
import type { AckError } from '../../shared/types/socket';

type TradeResult =
  | { ok: true; gameState: GameState }
  | { ok: false; error: AckError };

const RESOURCE_KEYS = ['EMBER', 'GOLD', 'STONE', 'BLOOM', 'CRYSTAL'] as const;
type ResourceKey = typeof RESOURCE_KEYS[number];

function isResourceKey(value: string): value is ResourceKey {
  return RESOURCE_KEYS.includes(value as ResourceKey);
}

export class TradeManager {
  bankTrade(
    gameState: GameState,
    playerId: string,
    giveResource: string,
    receiveResource: string,
  ): TradeResult {
    if (gameState.roomStatus !== 'in_progress') {
      return {
        ok: false,
        error: {
          code: 'INVALID_PHASE',
          message: 'Bank trade is only allowed during an active game.',
        },
      };
    }

    if (gameState.turn.currentPlayerId !== playerId) {
      return {
        ok: false,
        error: {
          code: 'NOT_ACTIVE_PLAYER',
          message: 'Only the active player can bank trade.',
        },
      };
    }

    if (gameState.turn.phase !== 'ACTION') {
      return {
        ok: false,
        error: {
          code: 'INVALID_PHASE',
          message: 'Bank trade is only allowed during the ACTION phase.',
        },
      };
    }

    if (!isResourceKey(giveResource) || !isResourceKey(receiveResource)) {
      return {
        ok: false,
        error: {
          code: 'INVALID_CONFIGURATION',
          message: 'Invalid resource type.',
        },
      };
    }

    if (giveResource === receiveResource) {
      return {
        ok: false,
        error: {
          code: 'INVALID_CONFIGURATION',
          message: 'Give and receive resources must be different.',
        },
      };
    }

    const player = gameState.playersById[playerId];
    if (!player) {
      return {
        ok: false,
        error: {
          code: 'SESSION_NOT_FOUND',
          message: 'Player not found in game state.',
        },
      };
    }

    const currentAmount = player.resources[giveResource] ?? 0;
    if (currentAmount < 4) {
      return {
        ok: false,
        error: {
          code: 'INSUFFICIENT_RESOURCES',
          message: `Need 4 ${giveResource} to bank trade.`,
        },
      };
    }

    const updatedResources: ResourceBundle = {
      ...player.resources,
      [giveResource]: currentAmount - 4,
      [receiveResource]: (player.resources[receiveResource] ?? 0) + 1,
    };

    const updatedGameState: GameState = {
      ...gameState,
      playersById: {
        ...gameState.playersById,
        [playerId]: {
          ...player,
          resources: updatedResources,
          updatedAt: new Date().toISOString(),
        },
      },
    };

    return {
      ok: true,
      gameState: updatedGameState,
    };
  }
}