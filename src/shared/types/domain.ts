// FROZEN -- see Demo_1_Instructions.md Section 3
// Do not modify without whole-team agreement.

// ─── 3.1 Frozen enums ───────────────────────────────────────────────

export type RoomStatus = 'waiting' | 'in_progress' | 'finished';

export type GamePhase = 'ROLL' | 'COLLECT' | 'ACTION' | 'END';

export type ClientRole = 'PLAYER' | 'SPECTATOR';

export type ResourceType = 'CRYSTAL' | 'STONE' | 'BLOOM' | 'EMBER' | 'GOLD';

export type StructureType = 'ROAD' | 'SETTLEMENT' | 'CITY';

export type LocationType = 'EDGE' | 'VERTEX';

export type TurnRecordStatus = 'in_progress' | 'completed';

// ─── 3.2 Frozen GameState shape ─────────────────────────────────────

export interface ResourceBundle {
  CRYSTAL: number;
  STONE: number;
  BLOOM: number;
  EMBER: number;
  GOLD: number;
}

export interface DiceRoll {
  d1Val: number;
  d2Val: number;
  sum: number;
  rolledAt: string; // ISO string in app layer
}

export interface GameConfig {
  playerCount: number;
  goalCount: number;
  winRule: 'ALL_GOALS_COMPLETE' | 'ANY_X_GOALS_COMPLETE' | 'FIRST_TO_X_POINTS';
  mapSeed: number;
  mapSize: 'small' | 'medium' | 'large';
  timerEnabled: boolean;
  turnTimeSec: number | null;
  allowReroll: boolean;
  startingResources: ResourceBundle;
}

export interface PresenceInfo {
  isConnected: boolean;
  lastSeenAt: string;
  connectionId: string;
}

export interface PlayerStats {
  publicVP: number;
  settlementsBuilt: number;
  citiesBuilt: number;
  roadsBuilt: number;
  totalResourcesCollected: number;
  totalResourcesSpent: number;
  longestRoadLength: number;
  turnsPlayed: number;
}

export interface Goal {
  goalId: string;
  type: 'UPGRADE_SETTLEMENT' | 'ROAD_PATH' | 'COLLECT_RESOURCE';
  params: Record<string, unknown>;
  completed: boolean;
  completedAtTurn: number;
  description: string;
  progress: number;
  targetValue: number;
}

export interface PlayerState {
  playerId: string;
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  color: string;
  isHost: boolean;
  resources: ResourceBundle;
  goals: Goal[];
  stats: PlayerStats;
  presence: PresenceInfo;
  joinedAt: string;
  updatedAt: string;
}

export interface HexCoord {
  q: number;
  r: number;
}

export interface VertexLocation {
  id: string;
  hex: HexCoord;
  corner: number;
  adjacentHexes: HexCoord[];
}

export interface EdgeLocation {
  id: string;
  hex: HexCoord;
  dir: number;
  adjacentHexes: HexCoord[];
}

export interface RoadPath {
  connectedRoads: string[];
  pathLength: number;
}

export interface TileState {
  tileId: string;
  coord: HexCoord;
  resourceType: ResourceType | 'DESERT';
  numberToken: number | null;
  adjacentTiles: string[];
  vertices: string[];
  edges: string[];
  createdAt: string;
}

export interface StructureState {
  structureId: string;
  ownerPlayerId: string;
  ownerName: string;
  ownerColor: string;
  type: StructureType;
  level: number;
  locationType: LocationType;
  vertex: VertexLocation | null;
  edge: EdgeLocation | null;
  adjacentStructures: string[];
  adjacentTiles: string[];
  builtAtTurn: number;
  builtAt: string;
  cost: ResourceBundle;
  roadPath: RoadPath | null;
}

export interface BoardState {
  tilesById: Record<string, TileState>;
  structuresById: Record<string, StructureState>;
}

// Setup flow state is kept in GameState so reconnect/reload can resume
// deterministic setup progression without client-local assumptions.
export type SetupPlacementType = 'SETTLEMENT' | 'ROAD';

export interface SetupState {
  inProgress: boolean;
  round: 1 | 2;
  currentPlayerIndex: number;
  expectedPlacement: SetupPlacementType;
  lastPlacedSettlementVertexId: string | null;
}

export interface PlayerTradeOffer {
  offerId: string;
  fromPlayerId: string;
  targetPlayerId: string;
  // Full bundles allow multi-resource offers while preserving one-offer model.
  give: ResourceBundle;
  receive: ResourceBundle;
  createdAt: string;
}

export interface TradeState {
  // Demo 2 rule: at most one active player-to-player offer at a time.
  activeOffer: PlayerTradeOffer | null;
}

export interface TurnState {
  currentTurn: number;
  currentPlayerId: string | null;
  currentPlayerIndex: number | null;
  phase: GamePhase | null;
  turnStartedAt: string | null;
  turnEndsAt: string | null;
  lastDiceRoll: DiceRoll | null;
}

export interface GameState {
  gameId: string;
  roomCode: string;
  roomStatus: RoomStatus;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  isDeleted: boolean;
  winnerPlayerId: string | null;
  config: GameConfig;
  playerOrder: string[];
  playersById: Record<string, PlayerState>;
  board: BoardState;
  // Demo 2 additions for setup sequencing and synchronized trade state.
  setup: SetupState;
  trade: TradeState;
  turn: TurnState;
}
