// FROZEN -- see Demo_1_Instructions.md Section 3.3
// Do not modify without whole-team agreement.
//
// Usage:
//   Server: Server<ClientToServerEvents, ServerToClientEvents>
//   Client: Socket<ServerToClientEvents, ClientToServerEvents>

import type {
  ClientRole,
  GameConfig,
  GameState,
  ResourceType,
  ResourceBundle,
} from './domain';

// ─── Ack types ───────────────────────────────────────────────────────

export interface AckError {
  code:
    | 'INVALID_CONFIGURATION'
    | 'SESSION_NOT_FOUND'
    | 'PLAYER_CAPACITY_EXCEEDED'
    | 'NOT_HOST'
    | 'NOT_ACTIVE_PLAYER'
    | 'INVALID_PHASE'
    | 'MANDATORY_ACTION_INCOMPLETE'
    | 'INSUFFICIENT_RESOURCES'
    | 'INTERNAL_ERROR';
  message: string;
  details?: Record<string, unknown>;
}

export type SocketAck<T> =
  | { ok: true; data: T }
  | { ok: false; error: AckError };

// ─── Client -> Server request payloads ───────────────────────────────

export interface CreateGameRequest {
  displayName: string;
  config: GameConfig;
}

export interface JoinGameRequest {
  joinCode: string;
  displayName: string;
  role: ClientRole;
}

export interface StartGameRequest {
  gameId: string;
}

export interface RollDiceRequest {
  gameId: string;
}

export interface EndTurnRequest {
  gameId: string;
}

export interface BankTradeRequest {
  gameId: string;
  giveResource: ResourceType;
  receiveResource: ResourceType;
}

export interface SyncGameStateRequest {
  // Pull-only sync request; server returns authoritative latest snapshot.
  gameId: string;
}

export interface PlaceSetupSettlementRequest {
  gameId: string;
  vertexId: string;
}

export interface PlaceSetupRoadRequest {
  gameId: string;
  edgeId: string;
}

export interface BuildRoadRequest {
  gameId: string;
  edgeId: string;
}

export interface BuildSettlementRequest {
  gameId: string;
  vertexId: string;
}

export interface UpgradeSettlementRequest {
  gameId: string;
  vertexId: string;
}

export interface OfferTradeRequest {
  gameId: string;
  targetPlayerId: string;
  // Bundle form keeps payload stable if trade UI supports composite offers.
  give: ResourceBundle;
  receive: ResourceBundle;
}

export interface AcceptTradeRequest {
  gameId: string;
  offerId: string;
}

export interface RejectTradeRequest {
  gameId: string;
  offerId: string;
}

export interface CancelTradeRequest {
  gameId: string;
  offerId: string;
}

export interface SendChatMessageRequest {
  gameId: string;
  message: string;
}

// ─── Server -> Client ack data ───────────────────────────────────────

export interface CreateGameAckData {
  clientId: string;
  playerId: string;
  role: 'PLAYER';
  gameState: GameState;
}

export interface JoinGameAckData {
  clientId: string;
  playerId: string;
  role: ClientRole;
  gameState: GameState;
}

export interface SimpleActionAckData {
  gameState: GameState;
}

export interface ActionRejectedEvent {
  code: AckError['code'];
  message: string;
  details?: Record<string, unknown>;
}

// ─── Typed Socket.io event interfaces ────────────────────────────────

export interface ServerToClientEvents {
  GAME_STATE_UPDATE: (gameState: GameState) => void;
  ACTION_REJECTED: (event: ActionRejectedEvent) => void;
}

export interface ClientToServerEvents {
  CREATE_GAME: (
    request: CreateGameRequest,
    ack: (response: SocketAck<CreateGameAckData>) => void,
  ) => void;
  JOIN_GAME: (
    request: JoinGameRequest,
    ack: (response: SocketAck<JoinGameAckData>) => void,
  ) => void;
  START_GAME: (
    request: StartGameRequest,
    ack: (response: SocketAck<SimpleActionAckData>) => void,
  ) => void;
  ROLL_DICE: (
    request: RollDiceRequest,
    ack: (response: SocketAck<SimpleActionAckData>) => void,
  ) => void;
  BANK_TRADE: (
    request: BankTradeRequest,
    ack: (response: SocketAck<SimpleActionAckData>) => void,
  ) => void;
  OFFER_TRADE: (
    request: OfferTradeRequest,
    ack: (response: SocketAck<SimpleActionAckData>) => void,
  ) => void;
  ACCEPT_TRADE: (
    request: AcceptTradeRequest,
    ack: (response: SocketAck<SimpleActionAckData>) => void,
  ) => void;
  REJECT_TRADE: (
    request: RejectTradeRequest,
    ack: (response: SocketAck<SimpleActionAckData>) => void,
  ) => void;
  CANCEL_TRADE: (
    request: CancelTradeRequest,
    ack: (response: SocketAck<SimpleActionAckData>) => void,
  ) => void;
  PLACE_SETUP_SETTLEMENT: (
    request: PlaceSetupSettlementRequest,
    ack: (response: SocketAck<SimpleActionAckData>) => void,
  ) => void;
  PLACE_SETUP_ROAD: (
    request: PlaceSetupRoadRequest,
    ack: (response: SocketAck<SimpleActionAckData>) => void,
  ) => void;
  BUILD_ROAD: (
    request: BuildRoadRequest,
    ack: (response: SocketAck<SimpleActionAckData>) => void,
  ) => void;
  BUILD_SETTLEMENT: (
    request: BuildSettlementRequest,
    ack: (response: SocketAck<SimpleActionAckData>) => void,
  ) => void;
  UPGRADE_SETTLEMENT: (
    request: UpgradeSettlementRequest,
    ack: (response: SocketAck<SimpleActionAckData>) => void,
  ) => void;
  END_TURN: (
    request: EndTurnRequest,
    ack: (response: SocketAck<SimpleActionAckData>) => void,
  ) => void;
  // Recovery action to fetch authoritative state after refresh/reconnect.
  SYNC_GAME_STATE: (
    request: SyncGameStateRequest,
    ack: (response: SocketAck<SimpleActionAckData>) => void,
  ) => void;
  SEND_CHAT_MESSAGE: (
    request: SendChatMessageRequest,
    ack: (response: SocketAck<SimpleActionAckData>) => void,
  ) => void;
}
