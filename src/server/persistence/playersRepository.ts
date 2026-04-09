import { FieldValue } from 'firebase-admin/firestore';
import type { PlayerState, ResourceBundle, PlayerStats, PresenceInfo, RoomStatus } from '../../shared/types/domain';
import { FirestoreRepository } from './FirestoreRepository';

// ─── ActiveGame entry (design doc §4.2.11) ────────────────────────────────────

export interface ActiveGameEntry {
  gameId: string;
  roomCode: string;
  status: RoomStatus;
  lastAccessedAt: FirebaseFirestore.Timestamp;
}

function toIso(value: unknown): string {
  if (value && typeof value === 'object' && 'toDate' in value && typeof value.toDate === 'function') {
    return value.toDate().toISOString();
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    return value;
  }
  return new Date().toISOString();
}

function mapPlayerDoc(data: FirebaseFirestore.DocumentData): PlayerState {
  return {
    ...data,
    joinedAt: toIso(data.joinedAt),
    updatedAt: toIso(data.updatedAt),
    presence: data.presence
      ? {
          ...data.presence,
          lastSeenAt: toIso(data.presence.lastSeenAt),
        }
      : {
          isConnected: false,
          lastSeenAt: new Date().toISOString(),
          connectionId: '',
        },
  } as PlayerState;
}

// ─── Repository ───────────────────────────────────────────────────────────────

export class PlayersRepository extends FirestoreRepository {
  // /games/{gameId}/players/{playerId}
  private playersCol(gameId: string) {
    return this.db.collection(`games/${gameId}/players`);
  }

  // /users/{userId}/activeGames/{gameId}
  private activeGamesCol(userId: string) {
    return this.db.collection(`users/${userId}/activeGames`);
  }

  // /users/{userId}
  private userDoc(userId: string) {
    return this.db.collection('users').doc(userId);
  }

  // ─── Player CRUD ─────────────────────────────────────────────────────────

  /** Creates (or overwrites) the player document within a game session. */
  async createPlayer(gameId: string, player: PlayerState): Promise<void> {
    const now = FieldValue.serverTimestamp();
    await this.playersCol(gameId).doc(player.playerId).set({
      ...player,
      joinedAt: now,
      updatedAt: now,
    });
  }

  /** Fetches a single player's document from a game session. */
  async getPlayer(gameId: string, playerId: string): Promise<PlayerState | null> {
    const snap = await this.playersCol(gameId).doc(playerId).get();
    if (!snap.exists) return null;
    return mapPlayerDoc(snap.data() ?? {});
  }

  /** Fetches all players in a game session. */
  async getPlayers(gameId: string): Promise<PlayerState[]> {
    const snap = await this.playersCol(gameId).get();
    return snap.docs.map((d) => mapPlayerDoc(d.data()));
  }

  /** Updates a player's resource bundle (e.g., after dice roll or trade). */
  async updateResources(gameId: string, playerId: string, resources: ResourceBundle): Promise<void> {
    await this.playersCol(gameId).doc(playerId).update({
      resources,
      updatedAt: FieldValue.serverTimestamp(),
    });
  }

  /** Updates a player's stats (e.g., after building or completing a goal). */
  async updateStats(gameId: string, playerId: string, stats: PlayerStats): Promise<void> {
    await this.playersCol(gameId).doc(playerId).update({
      stats,
      updatedAt: FieldValue.serverTimestamp(),
    });
  }

  /** Updates a player's goals array (after progress changes or goal completion). */
  async updateGoals(
    gameId: string,
    playerId: string,
    goals: PlayerState['goals'],
  ): Promise<void> {
    await this.playersCol(gameId).doc(playerId).update({
      goals,
      updatedAt: FieldValue.serverTimestamp(),
    });
  }

  /** Updates presence info (connected/disconnected, lastSeenAt, connectionId). */
  async updatePresence(gameId: string, playerId: string, presence: PresenceInfo): Promise<void> {
    await this.playersCol(gameId).doc(playerId).update({
      presence,
      updatedAt: FieldValue.serverTimestamp(),
    });
  }

  // ─── User-level active games (design doc §4.2.11) ────────────────────────

  /**
   * Creates or overwrites an entry in /users/{userId}/activeGames/{gameId}.
   * Called when a player joins a session so they can find their active games.
   */
  async addActiveGame(
    userId: string,
    gameId: string,
    roomCode: string,
    status: RoomStatus,
  ): Promise<void> {
    await this.activeGamesCol(userId).doc(gameId).set({
      gameId,
      roomCode,
      status,
      lastAccessedAt: FieldValue.serverTimestamp(),
    });
  }

  /**
   * Updates the status and lastAccessedAt of a user's active game entry.
   * Per design doc §4.2.15 — indexed on lastAccessedAt DESC.
   */
  async updateActiveGame(userId: string, gameId: string, status: RoomStatus): Promise<void> {
    await this.activeGamesCol(userId).doc(gameId).update({
      status,
      lastAccessedAt: FieldValue.serverTimestamp(),
    });
  }

  /**
   * Returns a user's active games ordered by lastAccessedAt descending.
   * Used for the user dashboard / game history.
   */
  async getActiveGames(userId: string): Promise<ActiveGameEntry[]> {
    const snap = await this.activeGamesCol(userId).orderBy('lastAccessedAt', 'desc').get();
    return snap.docs.map((d) => d.data() as ActiveGameEntry);
  }

  // ─── User profile (design doc §4.2.13) ───────────────────────────────────

  /** Creates or updates the top-level user document at /users/{userId}. */
  async upsertUser(userId: string, displayName: string): Promise<void> {
    const ref = this.userDoc(userId);
    const snap = await ref.get();
    if (snap.exists) {
      await ref.update({ displayName, updatedAt: FieldValue.serverTimestamp() });
    } else {
      await ref.set({
        userId,
        displayName,
        isDeleted: false,
        joinedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
  }
}

export const playersRepository = new PlayersRepository();
