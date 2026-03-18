import { FieldValue } from 'firebase-admin/firestore';
import type { RoomStatus, TurnState, GameConfig, ResourceBundle } from '../../shared/types/domain';
import { FirestoreRepository } from './FirestoreRepository';

// ─── Firestore document shape for /games/{gameId} ────────────────────────────

export interface GameSessionDoc {
  gameId: string;
  roomCode: string;
  status: RoomStatus;
  config: GameConfig;
  playerOrder: string[];
  /** playerId → PlayerStats map stored at the top level for quick score reads. */
  playerStats: Record<string, { publicVP: number; settlementsBuilt: number; roadsBuilt: number; totalResourcesCollected: number; totalResourcesSpent: number; longestRoadLength: number; turnsPlayed: number }>;
  winnerPlayerId: string | null;
  createdBy: string;
  createdAt: FirebaseFirestore.Timestamp;
  updatedAt: FirebaseFirestore.Timestamp;
  isDeleted: boolean;
  // Nested turn state — updated each turn end.
  currentTurn: number;
  currentPlayerId: string | null;
  currentPlayerIndex: number | null;
  phase: TurnState['phase'];
  turnStartedAt: FirebaseFirestore.Timestamp | null;
  turnEndsAt: FirebaseFirestore.Timestamp | null;
  lastDiceRoll: { d1Val: number; d2Val: number; sum: number; rolledAt: FirebaseFirestore.Timestamp } | null;
}

// ─── CreateGameParams ─────────────────────────────────────────────────────────

export interface CreateGameParams {
  gameId: string;
  roomCode: string;
  createdBy: string;
  config: GameConfig;
  startingResources: ResourceBundle;
}

// ─── Repository ───────────────────────────────────────────────────────────────

export class GameSessionsRepository extends FirestoreRepository {
  private collection() {
    return this.db.collection('games');
  }

  private doc(gameId: string) {
    return this.collection().doc(gameId);
  }

  /**
   * Creates a new game document.
   * gameId is used as both the Firestore document ID and the readable room code.
   */
  async createGame(params: CreateGameParams): Promise<void> {
    const now = FieldValue.serverTimestamp() as FirebaseFirestore.Timestamp;
    const doc: Omit<GameSessionDoc, 'createdAt' | 'updatedAt'> & { createdAt: unknown; updatedAt: unknown } = {
      gameId: params.gameId,
      roomCode: params.roomCode,
      status: 'waiting',
      config: params.config,
      playerOrder: [],
      playerStats: {},
      winnerPlayerId: null,
      createdBy: params.createdBy,
      createdAt: now,
      updatedAt: now,
      isDeleted: false,
      currentTurn: 0,
      currentPlayerId: null,
      currentPlayerIndex: null,
      phase: null,
      turnStartedAt: null,
      turnEndsAt: null,
      lastDiceRoll: null,
    };
    await this.doc(params.gameId).set(doc);
  }

  /** Fetches a game by its document ID (which equals its roomCode). */
  async getGame(gameId: string): Promise<GameSessionDoc | null> {
    const snap = await this.doc(gameId).get();
    if (!snap.exists) return null;
    return snap.data() as GameSessionDoc;
  }

  /**
   * Queries for a game by roomCode field.
   * Use when you only have the roomCode and not the gameId.
   * Per design doc §4.2.15 — indexed on roomCode.
   */
  async getGameByRoomCode(roomCode: string): Promise<GameSessionDoc | null> {
    const snap = await this.collection().where('roomCode', '==', roomCode).where('isDeleted', '==', false).limit(1).get();
    if (snap.empty) return null;
    return snap.docs[0].data() as GameSessionDoc;
  }

  /** Returns true if a game with the given roomCode already exists (for uniqueness check). */
  async roomCodeExists(roomCode: string): Promise<boolean> {
    const snap = await this.collection().where('roomCode', '==', roomCode).where('isDeleted', '==', false).limit(1).get();
    return !snap.empty;
  }

  /** Updates the game status (e.g., waiting → in_progress → finished). */
  async updateGameStatus(gameId: string, status: RoomStatus): Promise<void> {
    await this.doc(gameId).update({
      status,
      updatedAt: FieldValue.serverTimestamp(),
    });
  }

  /** Updates the turn state fields on the game doc (called at end of each turn). */
  async updateTurnState(gameId: string, turn: TurnState): Promise<void> {
    await this.doc(gameId).update({
      currentTurn: turn.currentTurn,
      currentPlayerId: turn.currentPlayerId,
      currentPlayerIndex: turn.currentPlayerIndex,
      phase: turn.phase,
      turnStartedAt: turn.turnStartedAt ? new Date(turn.turnStartedAt) : null,
      turnEndsAt: turn.turnEndsAt ? new Date(turn.turnEndsAt) : null,
      lastDiceRoll: turn.lastDiceRoll
        ? {
            d1Val: turn.lastDiceRoll.d1Val,
            d2Val: turn.lastDiceRoll.d2Val,
            sum: turn.lastDiceRoll.sum,
            rolledAt: new Date(turn.lastDiceRoll.rolledAt),
          }
        : null,
      updatedAt: FieldValue.serverTimestamp(),
    });
  }

  /** Updates the playerOrder array (called after lobby is full / game starts). */
  async updatePlayerOrder(gameId: string, playerOrder: string[]): Promise<void> {
    await this.doc(gameId).update({
      playerOrder,
      updatedAt: FieldValue.serverTimestamp(),
    });
  }

  /** Sets the winner and marks the game as finished. Uses a transaction to prevent duplicate writes. */
  async finalizeGame(gameId: string, winnerId: string): Promise<void> {
    await this.db.runTransaction(async (tx) => {
      const ref = this.doc(gameId);
      const snap = await tx.get(ref);
      if (!snap.exists) throw new Error(`Game ${gameId} not found.`);
      const data = snap.data() as GameSessionDoc;
      if (data.status === 'finished') return; // Already finalized — idempotent.
      tx.update(ref, {
        status: 'finished',
        winnerPlayerId: winnerId,
        updatedAt: FieldValue.serverTimestamp(),
      });
    });
  }

  /** Soft-deletes a game (sets isDeleted = true). Data is preserved for recovery. */
  async softDelete(gameId: string): Promise<void> {
    await this.doc(gameId).update({
      isDeleted: true,
      updatedAt: FieldValue.serverTimestamp(),
    });
  }
}

export const gameSessionsRepository = new GameSessionsRepository();
