// DEPRECATED: These interfaces predate the frozen GameState shape.
// Person 2 (Firestore owner) should redefine Firestore document types
// based on the new types in domain.ts. Do not build new code against these.

export interface PersistedGameSession {
  id: string;
  hostId: string;
  playerIds: string[];
  status: string;
  createdAt: number;
  updatedAt: number;
}

export interface PersistedPlayer {
  id: string;
  name: string;
  joinedAt: number;
}

export interface PersistedBoard {
  sessionId: string;
  data: Record<string, unknown>;
}

export interface PersistedTurn {
  sessionId: string;
  turnNumber: number;
  playerId: string;
  timestamp: number;
}
