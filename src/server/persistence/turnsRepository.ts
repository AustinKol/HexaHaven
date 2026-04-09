import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import type { ResourceBundle, TurnRecordStatus } from '../../shared/types/domain';
import { FirestoreRepository } from './FirestoreRepository';

// ─── Turn document types (design doc §4.2.12) ─────────────────────────────────

export interface TurnAction {
  actionId: string;
  type:
    | 'DICE_ROLL'
    | 'COLLECT_RESOURCES'
    | 'BUILD_ROAD'
    | 'BUILD_SETTLEMENT'
    | 'UPGRADE_SETTLEMENT'
    | 'GOAL_COMPLETED';
  timestamp: FirebaseFirestore.Timestamp;
  // Type-specific optional fields:
  result?: Record<string, unknown>;       // dice roll result
  resources?: ResourceBundle;             // resources collected/spent
  structureId?: string;                   // build actions
  location?: Record<string, unknown>;     // build actions
  cost?: ResourceBundle;                  // build actions
  goalId?: string;                        // goal completion
  goalType?: string;                      // goal completion
}

export interface TurnDoc {
  turnId: string;
  turnNumber: number;
  playerId: string;
  playerName: string;
  status: TurnRecordStatus;
  diceRoll: { d1: number; d2: number; sum: number; rolledAt: FirebaseFirestore.Timestamp } | null;
  actions: TurnAction[];
  startedAt: FirebaseFirestore.Timestamp;
  endedAt: FirebaseFirestore.Timestamp | null;
  duration: number | null; // seconds elapsed
}

function normalizeTimestampValue(value: unknown): FirebaseFirestore.Timestamp | Date {
  if (value && typeof value === 'object' && 'toDate' in value && typeof value.toDate === 'function') {
    return value as FirebaseFirestore.Timestamp;
  }
  if (value instanceof Date) {
    return value;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    return new Date(value);
  }
  return Timestamp.now();
}

// ─── Repository ───────────────────────────────────────────────────────────────

export class TurnsRepository extends FirestoreRepository {
  // /games/{gameId}/turns/{turnId}
  private turnsCol(gameId: string) {
    return this.db.collection(`games/${gameId}/turns`);
  }

  /**
   * Creates a new in-progress turn document at the start of a player's turn.
   * turnId is typically `turn_${turnNumber}` for easy lookup.
   */
  async createTurn(
    gameId: string,
    params: {
      turnId: string;
      turnNumber: number;
      playerId: string;
      playerName: string;
    },
  ): Promise<void> {
    const doc: Omit<TurnDoc, 'startedAt'> & { startedAt: unknown } = {
      turnId: params.turnId,
      turnNumber: params.turnNumber,
      playerId: params.playerId,
      playerName: params.playerName,
      status: 'in_progress',
      diceRoll: null,
      actions: [],
      startedAt: FieldValue.serverTimestamp(),
      endedAt: null,
      duration: null,
    };
    await this.turnsCol(gameId).doc(params.turnId).set(doc);
  }

  /**
   * Appends an action to the turn's actions array.
   * Uses arrayUnion so concurrent appends don't overwrite each other.
   * NOTE: arrayUnion does NOT guarantee order — the GameEngine appends actions
   *       sequentially (single-threaded per room), so order is preserved in practice.
   */
  async appendAction(gameId: string, turnId: string, action: TurnAction): Promise<void> {
    await this.turnsCol(gameId).doc(turnId).update({
      actions: FieldValue.arrayUnion({ ...action, timestamp: normalizeTimestampValue(action.timestamp) }),
    });
  }

  /**
   * Records the dice roll result on the current turn document.
   * Also appends a DICE_ROLL action entry.
   */
  async recordDiceRoll(
    gameId: string,
    turnId: string,
    roll: { d1: number; d2: number; sum: number },
  ): Promise<void> {
    const now = Timestamp.now();
    const diceRollEntry = {
      d1: roll.d1,
      d2: roll.d2,
      sum: roll.sum,
      rolledAt: now,
    };
    const action: TurnAction = {
      actionId: `dice_${Date.now()}`,
      type: 'DICE_ROLL',
      timestamp: now,
      result: { d1: roll.d1, d2: roll.d2, sum: roll.sum },
    };
    await this.turnsCol(gameId).doc(turnId).update({
      diceRoll: diceRollEntry,
      actions: FieldValue.arrayUnion(action),
    });
  }

  /**
   * Marks a turn as completed and records its end time and duration.
   * Called by the server when the active player ends their turn.
   */
  async completeTurn(gameId: string, turnId: string, durationSeconds: number): Promise<void> {
    await this.turnsCol(gameId).doc(turnId).update({
      status: 'completed',
      endedAt: FieldValue.serverTimestamp(),
      duration: durationSeconds,
    });
  }

  /** Fetches a single turn document. */
  async getTurn(gameId: string, turnId: string): Promise<TurnDoc | null> {
    const snap = await this.turnsCol(gameId).doc(turnId).get();
    if (!snap.exists) return null;
    return snap.data() as TurnDoc;
  }

  /**
   * Returns the full turn history for a game, ordered by turnNumber ascending.
   * Per design doc §4.2.15 — indexed on turnNumber.
   */
  async getTurnHistory(gameId: string): Promise<TurnDoc[]> {
    const snap = await this.turnsCol(gameId).orderBy('turnNumber', 'asc').get();
    return snap.docs.map((d) => d.data() as TurnDoc);
  }
}

export const turnsRepository = new TurnsRepository();
