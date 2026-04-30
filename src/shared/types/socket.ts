// FROZEN -- see Demo_1_Instructions.md Section 3.3
// Do not modify without whole-team agreement.
//
// Usage:
//   Server: Server<ClientToServerEvents, ServerToClientEvents>
//   Client: Socket<ServerToClientEvents, ClientToServerEvents>

import type {
  GameConfig,
  GameState,
  ResourceBundle,
} from './domain';
import type { BuildStructureKind } from '../buildRules';

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
    | 'TRADE_REQUEST_NOT_FOUND'
    | 'TRADE_REQUEST_EXPIRED'
    | 'TRADE_NOT_ALLOWED'
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
}

export interface StartGameRequest {
  gameId: string;
}

export interface HydrateSessionRequest {
  gameId: string;
}

export interface RollDiceRequest {
  gameId: string;
}

export interface BuildStructureRequest {
  gameId: string;
  kind: BuildStructureKind;
  vertexId?: string;
  edgeId?: string;
}

export interface EndTurnRequest {
  gameId: string;
}

export interface BankTradeRequest {
  gameId: string;
  giveResource: 'EMBER' | 'GOLD' | 'STONE' | 'BLOOM' | 'CRYSTAL';
  receiveResource: 'EMBER' | 'GOLD' | 'STONE' | 'BLOOM' | 'CRYSTAL';
}

export interface SendChatMessageRequest {
  gameId: string;
  message: string;
}

export interface SendPlayerTradeRequestPayload {
  gameId: string;
  receiverPlayerId: string;
  offeredResources: ResourceBundle;
  requestedResources: ResourceBundle;
}

export interface RespondPlayerTradeRequestPayload {
  gameId: string;
  tradeRequestId: string;
  response: 'accepted' | 'declined';
}

export type PlayerTradeRequestStatus = 'pending' | 'accepted' | 'declined' | 'expired';

export interface PlayerTradeRequest {
  id: string;
  gameId: string;
  senderPlayerId: string;
  receiverPlayerId: string;
  offeredResources: ResourceBundle;
  requestedResources: ResourceBundle;
  status: PlayerTradeRequestStatus;
  createdAt: string;
  expiresAt: string;
}

export interface PlayerTradeRequestUpdateEvent {
  tradeRequest: PlayerTradeRequest;
  outcome: 'pending' | 'accepted' | 'declined' | 'expired' | 'failed';
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
  role: 'PLAYER';
  gameState: GameState;
}

export interface SimpleActionAckData {
  gameState: GameState;
}

export interface SendPlayerTradeRequestAckData {
  tradeRequest: PlayerTradeRequest;
}

export interface RespondPlayerTradeRequestAckData {
  tradeRequest: PlayerTradeRequest;
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
  PLAYER_TRADE_REQUEST_RECEIVED: (tradeRequest: PlayerTradeRequest) => void;
  PLAYER_TRADE_REQUEST_UPDATED: (event: PlayerTradeRequestUpdateEvent) => void;
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
  HYDRATE_SESSION: (
    request: HydrateSessionRequest,
    ack: (response: SocketAck<SimpleActionAckData>) => void,
  ) => void;
  ROLL_DICE: (
    request: RollDiceRequest,
    ack: (response: SocketAck<SimpleActionAckData>) => void,
  ) => void;
  BUILD_STRUCTURE: (
    request: BuildStructureRequest,
    ack: (response: SocketAck<SimpleActionAckData>) => void,
  ) => void;
  BANK_TRADE: (
    request: BankTradeRequest,
    ack: (response: SocketAck<SimpleActionAckData>) => void,
  ) => void;
  END_TURN: (
    request: EndTurnRequest,
    ack: (response: SocketAck<SimpleActionAckData>) => void,
  ) => void;
  SEND_CHAT_MESSAGE: (
    request: SendChatMessageRequest,
    ack: (response: SocketAck<SimpleActionAckData>) => void,
  ) => void;
  SEND_PLAYER_TRADE_REQUEST: (
    request: SendPlayerTradeRequestPayload,
    ack: (response: SocketAck<SendPlayerTradeRequestAckData>) => void,
  ) => void;
  RESPOND_PLAYER_TRADE_REQUEST: (
    request: RespondPlayerTradeRequestPayload,
    ack: (response: SocketAck<RespondPlayerTradeRequestAckData>) => void,
  ) => void;
}
