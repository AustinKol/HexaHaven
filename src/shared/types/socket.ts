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
  END_TURN: (
    request: EndTurnRequest,
    ack: (response: SocketAck<SimpleActionAckData>) => void,
  ) => void;
}
