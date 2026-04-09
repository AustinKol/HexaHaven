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
  // Lobby/session lifecycle
  CREATE_GAME: 'CREATE_GAME',
  JOIN_GAME: 'JOIN_GAME',
  START_GAME: 'START_GAME',
  ROLL_DICE: 'ROLL_DICE',
  END_TURN: 'END_TURN',
  SEND_CHAT_MESSAGE: 'SEND_CHAT_MESSAGE',
  SYNC_GAME_STATE: 'SYNC_GAME_STATE',
  // Setup actions
  PLACE_SETUP_SETTLEMENT: 'PLACE_SETUP_SETTLEMENT',
  PLACE_SETUP_ROAD: 'PLACE_SETUP_ROAD',
  // Turn actions
  ROLL_DICE: 'ROLL_DICE',
  BUILD_ROAD: 'BUILD_ROAD',
  BUILD_SETTLEMENT: 'BUILD_SETTLEMENT',
  UPGRADE_SETTLEMENT: 'UPGRADE_SETTLEMENT',
  // Trade actions
  BANK_TRADE: 'BANK_TRADE',
  OFFER_TRADE: 'OFFER_TRADE',
  ACCEPT_TRADE: 'ACCEPT_TRADE',
  REJECT_TRADE: 'REJECT_TRADE',
  CANCEL_TRADE: 'CANCEL_TRADE',
  END_TURN: 'END_TURN',
} as const;

/** Server -> Client application events. */
export const SERVER_EVENTS = {
  // Single authoritative snapshot channel for state updates.
  GAME_STATE_UPDATE: 'GAME_STATE_UPDATE',
  // Validation/persistence failures are returned to requester only.
  ACTION_REJECTED: 'ACTION_REJECTED',
} as const;
