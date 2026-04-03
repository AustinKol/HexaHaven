import type { GameState } from '../../shared/types/domain';

/**
 * In-memory cache of active GameState objects, keyed by gameId.
 * Populated after successful Firestore writes or loads.
 */
class GameStateStore {
  private readonly games = new Map<string, GameState>();

  get(gameId: string): GameState | null {
    return this.games.get(gameId) ?? null;
  }

  set(gameId: string, state: GameState): void {
    this.games.set(gameId, state);
  }

  /** Finds a game by its roomCode (join code). */
  findByRoomCode(roomCode: string): GameState | null {
    for (const state of this.games.values()) {
      if (state.roomCode === roomCode) return state;
    }
    return null;
  }

  delete(gameId: string): void {
    this.games.delete(gameId);
  }
}

export const gameStateStore = new GameStateStore();
