// FROZEN -- see Demo_1_Instructions.md Section 3.3
// Do not modify without whole-team agreement.
//
// CLIENT_EVENTS keys must match ClientToServerEvents method names in socket.ts.
// SERVER_EVENTS keys must match ServerToClientEvents method names in socket.ts.

/** Socket.io lifecycle events (built-in). */
export const SocketEvents = {
  Connection: 'connection',
  Disconnect: 'disconnect',
} as const;

/** Client -> Server application events. */
export const CLIENT_EVENTS = {
  CREATE_GAME: 'CREATE_GAME',
  JOIN_GAME: 'JOIN_GAME',
  START_GAME: 'START_GAME',
  HYDRATE_SESSION: 'HYDRATE_SESSION',
  ROLL_DICE: 'ROLL_DICE',
  BUILD_STRUCTURE: 'BUILD_STRUCTURE',
  END_TURN: 'END_TURN',
  SEND_CHAT_MESSAGE: 'SEND_CHAT_MESSAGE',
  BANK_TRADE: 'BANK_TRADE',
  SEND_PLAYER_TRADE_REQUEST: 'SEND_PLAYER_TRADE_REQUEST',
  RESPOND_PLAYER_TRADE_REQUEST: 'RESPOND_PLAYER_TRADE_REQUEST',
} as const;

/** Server -> Client application events. */
export const SERVER_EVENTS = {
  GAME_STATE_UPDATE: 'GAME_STATE_UPDATE',
  ACTION_REJECTED: 'ACTION_REJECTED',
  PLAYER_TRADE_REQUEST_RECEIVED: 'PLAYER_TRADE_REQUEST_RECEIVED',
  PLAYER_TRADE_REQUEST_UPDATED: 'PLAYER_TRADE_REQUEST_UPDATED',
} as const;
