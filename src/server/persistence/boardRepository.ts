import { FieldValue } from 'firebase-admin/firestore';
import type { TileState, StructureState } from '../../shared/types/domain';
import { FirestoreRepository } from './FirestoreRepository';

// ─── Path helpers ─────────────────────────────────────────────────────────────
//
// Board layout in Firestore (matches design doc §4.2.9 / §4.2.10):
//   /games/{gameId}/board/state/tiles/{tileId}
//   /games/{gameId}/board/state/structures/{structureId}

export class BoardRepository extends FirestoreRepository {
  private tilesCol(gameId: string) {
    return this.db.collection(`games/${gameId}/board/state/tiles`);
  }

  private structuresCol(gameId: string) {
    return this.db.collection(`games/${gameId}/board/state/structures`);
  }

  // ─── Tiles ───────────────────────────────────────────────────────────────

  /**
   * Batch-writes all tiles for a game.
   * Tiles are static after creation — call once at game start.
   * Firestore batches are limited to 500 ops; splits automatically if needed.
   */
  async initTiles(gameId: string, tiles: TileState[]): Promise<void> {
    const col = this.tilesCol(gameId);
    const BATCH_SIZE = 400;

    for (let i = 0; i < tiles.length; i += BATCH_SIZE) {
      const batch = this.db.batch();
      const chunk = tiles.slice(i, i + BATCH_SIZE);
      for (const tile of chunk) {
        batch.set(col.doc(tile.tileId), {
          ...tile,
          createdAt: FieldValue.serverTimestamp(),
        });
      }
      await batch.commit();
    }
  }

  /** Returns all tiles for a game, keyed by tileId. */
  async getTiles(gameId: string): Promise<Record<string, TileState>> {
    const snap = await this.tilesCol(gameId).get();
    const tilesById: Record<string, TileState> = {};
    for (const doc of snap.docs) {
      const tile = doc.data() as TileState;
      tilesById[tile.tileId] = tile;
    }
    return tilesById;
  }

  // ─── Structures ──────────────────────────────────────────────────────────

  /** Writes a new structure document (road, settlement, etc.). */
  async upsertStructure(gameId: string, structure: StructureState): Promise<void> {
    await this.structuresCol(gameId).doc(structure.structureId).set({
      ...structure,
      builtAt: FieldValue.serverTimestamp(),
    });
  }

  /** Partially updates an existing structure (e.g., settlement level upgrade). */
  async updateStructure(
    gameId: string,
    structureId: string,
    updates: Partial<Pick<StructureState, 'level' | 'roadPath' | 'adjacentStructures'>>,
  ): Promise<void> {
    await this.structuresCol(gameId).doc(structureId).update(updates);
  }

  /** Returns all structures for a game, keyed by structureId. */
  async getStructures(gameId: string): Promise<Record<string, StructureState>> {
    const snap = await this.structuresCol(gameId).get();
    const structuresById: Record<string, StructureState> = {};
    for (const doc of snap.docs) {
      const s = doc.data() as StructureState;
      structuresById[s.structureId] = s;
    }
    return structuresById;
  }

  /**
   * Returns all structures owned by a specific player.
   * Per design doc §4.2.15 — indexed on ownerPlayerId.
   */
  async getStructuresByOwner(gameId: string, ownerPlayerId: string): Promise<StructureState[]> {
    const snap = await this.structuresCol(gameId).where('ownerPlayerId', '==', ownerPlayerId).get();
    return snap.docs.map((d) => d.data() as StructureState);
  }
}

export const boardRepository = new BoardRepository();
