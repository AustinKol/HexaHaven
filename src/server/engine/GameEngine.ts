import type { GameState } from '../../shared/types/domain';
import type { AckError } from '../../shared/types/socket';
import { TurnManager } from './TurnManager';

export type EngineResult =
  | { ok: true; gameState: GameState }
  | { ok: false; error: AckError };

export class GameEngine {
  private readonly turnManager = new TurnManager();

  startGame(gameState: GameState, startedAtIso: string = new Date().toISOString()): EngineResult {
    if (gameState.roomStatus !== 'waiting') {
      return this.fail('INVALID_PHASE', 'Game can only be started while room status is waiting.');
    }

    if (gameState.playerOrder.length < 2) {
      return this.fail('INVALID_CONFIGURATION', 'Cannot start game with fewer than 2 players in player order.');
    }

    const firstPlayerId = gameState.playerOrder[0];
    if (!gameState.playersById[firstPlayerId]) {
      return this.fail('INVALID_CONFIGURATION', 'First player in order does not exist in playersById.');
    }

    const inProgressState: GameState = {
      ...gameState,
      roomStatus: 'in_progress',
    };

    const initializedState = this.turnManager.initializeFirstTurn(inProgressState, startedAtIso);
    return { ok: true, gameState: initializedState };
  }

  rollDice(gameState: GameState, playerId: string, rolledAtIso: string = new Date().toISOString()): EngineResult {
    const validation = this.turnManager.validateCanRoll(gameState, playerId);
    if (!validation.ok) {
      return { ok: false, error: validation.error };
    }

    const diceRoll = this.turnManager.rollTwoDice(rolledAtIso);
    if (
      diceRoll.d1Val < 1
      || diceRoll.d1Val > 6
      || diceRoll.d2Val < 1
      || diceRoll.d2Val > 6
      || diceRoll.sum < 2
      || diceRoll.sum > 12
      || diceRoll.sum !== (diceRoll.d1Val + diceRoll.d2Val)
    ) {
      return this.fail('INTERNAL_ERROR', 'Dice roll produced an invalid result.');
    }

    const updatedState = this.turnManager.applyRoll(gameState, diceRoll);
    return { ok: true, gameState: updatedState };
  }

  endTurn(gameState: GameState, playerId: string, startedAtIso: string = new Date().toISOString()): EngineResult {
    const validation = this.turnManager.validateCanEndTurn(gameState, playerId);
    if (!validation.ok) {
      return { ok: false, error: validation.error };
    }

    const updatedState = this.turnManager.advanceToNextTurn(gameState, startedAtIso);
    return { ok: true, gameState: updatedState };
  }

  private fail(code: AckError['code'], message: string): EngineResult {
    return { ok: false, error: { code, message } };
  }
}
