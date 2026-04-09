import type { DiceRoll, GameState } from '../../shared/types/domain';
import type { AckError } from '../../shared/types/socket';

export type TurnValidationResult =
  | { ok: true }
  | { ok: false; error: AckError };

export class TurnManager {
  initializeFirstTurn(gameState: GameState, startedAtIso: string = new Date().toISOString()): GameState {
    if (gameState.playerOrder.length === 0) {
      throw new Error('Cannot initialize first turn without players.');
    }

    return {
      ...gameState,
      turn: {
        currentTurn: 1,
        currentPlayerId: gameState.playerOrder[0],
        currentPlayerIndex: 0,
        phase: 'ROLL',
        turnStartedAt: startedAtIso,
        turnEndsAt: null,
        lastDiceRoll: null,
      },
    };
  }

  isActivePlayer(gameState: GameState, playerId: string): boolean {
    return gameState.turn.currentPlayerId === playerId;
  }

  validateCanRoll(gameState: GameState, playerId: string): TurnValidationResult {
    if (gameState.roomStatus !== 'in_progress') {
      return this.fail('INVALID_PHASE', 'Cannot roll dice unless the room is in progress.');
    }

    if (!this.isActivePlayer(gameState, playerId)) {
      return this.fail('NOT_ACTIVE_PLAYER', 'Only the active player can roll dice.');
    }

    if (gameState.turn.phase !== 'ROLL') {
      return this.fail('INVALID_PHASE', 'Dice can only be rolled during the ROLL phase.');
    }

    if (gameState.turn.lastDiceRoll !== null) {
      return this.fail('INVALID_PHASE', 'Dice have already been rolled this turn.');
    }

    return { ok: true };
  }

  validateCanEndTurn(gameState: GameState, playerId: string): TurnValidationResult {
    if (gameState.roomStatus !== 'in_progress') {
      return this.fail('INVALID_PHASE', 'Cannot end turn unless the room is in progress.');
    }

    if (!this.isActivePlayer(gameState, playerId)) {
      return this.fail('NOT_ACTIVE_PLAYER', 'Only the active player can end the turn.');
    }

    if (gameState.turn.lastDiceRoll === null) {
      return this.fail('MANDATORY_ACTION_INCOMPLETE', 'You must roll dice before ending the turn.');
    }

    if (gameState.turn.phase !== 'ACTION') {
      return this.fail('INVALID_PHASE', 'Turn can only end during the ACTION phase after rolling dice.');
    }

    return { ok: true };
  }

  advanceToNextTurn(gameState: GameState, startedAtIso: string = new Date().toISOString()): GameState {
    if (gameState.playerOrder.length === 0) {
      throw new Error('Cannot advance turn without players.');
    }

    const currentIndex = gameState.turn.currentPlayerIndex ?? -1;
    const nextPlayerIndex = (currentIndex + 1) % gameState.playerOrder.length;
    const nextPlayerId = gameState.playerOrder[nextPlayerIndex];

    return {
      ...gameState,
      turn: {
        currentTurn: gameState.turn.currentTurn + 1,
        currentPlayerId: nextPlayerId,
        currentPlayerIndex: nextPlayerIndex,
        phase: 'ROLL',
        turnStartedAt: startedAtIso,
        turnEndsAt: null,
        lastDiceRoll: null,
      },
    };
  }

  rollTwoDice(rolledAtIso: string = new Date().toISOString(), randomFn: () => number = Math.random): DiceRoll {
    const d1Val = this.rollDie(randomFn);
    const d2Val = this.rollDie(randomFn);

    return {
      d1Val,
      d2Val,
      sum: d1Val + d2Val,
      rolledAt: rolledAtIso,
    };
  }

  applyRoll(gameState: GameState, diceRoll: DiceRoll): GameState {
    return {
      ...gameState,
      turn: {
        ...gameState.turn,
        lastDiceRoll: diceRoll,
        phase: 'ACTION',
      },
    };
  }

  private rollDie(randomFn: () => number): number {
    return Math.floor(randomFn() * 6) + 1;
  }

  private fail(code: AckError['code'], message: string): TurnValidationResult {
    return { ok: false, error: { code, message } };
  }
}
