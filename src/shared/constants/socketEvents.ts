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
  ROLL_DICE: 'ROLL_DICE',
  END_TURN: 'END_TURN',
} as const;

/** Server -> Client application events. */
export const SERVER_EVENTS = {
  GAME_STATE_UPDATE: 'GAME_STATE_UPDATE',
  ACTION_REJECTED: 'ACTION_REJECTED',
} as const;
