import test from 'node:test';
import assert from 'node:assert/strict';
import { CLIENT_EVENTS, SERVER_EVENTS, SocketEvents } from '../../shared/constants/socketEvents';
import type {
  JoinGameRequest,
  RollDiceRequest,
  SendChatMessageRequest,
} from '../../shared/types/socket';
import type { PlayerState, ResourceBundle } from '../../shared/types/domain';
import type { GameState } from '../../shared/types/domain';
import { registerSocketHandlers } from './registerSocketHandlers';
import { gamePersistenceService } from '../persistence/GamePersistenceService';

const ZERO_RESOURCES: ResourceBundle = {
  CRYSTAL: 0,
  STONE: 0,
  BLOOM: 0,
  EMBER: 0,
  GOLD: 0,
};

const FIXED_NOW = '2026-01-01T00:00:00.000Z';

class FakeSocket {
  id: string;
  data: Record<string, unknown> = {};
  handshake: { auth: Record<string, unknown>; query: Record<string, unknown> };
  rooms = new Set<string>();
  emitted: Array<{ event: string; payload: unknown }> = [];
  private handlers = new Map<string, (...args: unknown[]) => unknown>();

  constructor(id: string, auth?: Record<string, unknown>) {
    this.id = id;
    this.handshake = { auth: auth ?? {}, query: {} };
  }

  on(event: string, handler: (...args: unknown[]) => unknown): void {
    this.handlers.set(event, handler);
  }

  emit(event: string, payload: unknown): void {
    this.emitted.push({ event, payload });
  }

  join(room: string): void {
    this.rooms.add(room);
  }

  leave(room: string): void {
    this.rooms.delete(room);
  }

  async trigger(event: string, ...args: unknown[]): Promise<unknown> {
    const handler = this.handlers.get(event);
    if (!handler) {
      throw new Error('Missing handler for event: ' + event);
    }
    return await handler(...args);
  }
}

class FakeIo {
  connectionHandler: ((socket: FakeSocket) => void) | null = null;
  roomEmits: Array<{ room: string; event: string; payload: unknown }> = [];

  on(event: string, handler: (socket: FakeSocket) => void): void {
    if (event === SocketEvents.Connection) {
      this.connectionHandler = handler;
    }
  }

  to(room: string): { emit: (event: string, payload: unknown) => void } {
    return {
      emit: (event: string, payload: unknown) => {
        this.roomEmits.push({ room, event, payload });
      },
    };
  }

  connect(socket: FakeSocket): void {
    if (!this.connectionHandler) {
      throw new Error('Connection handler not registered');
    }
    this.connectionHandler(socket);
  }
}

function createPlayer(playerId: string, displayName: string, isHost: boolean): PlayerState {
  return {
    playerId,
    userId: playerId,
    displayName,
    avatarUrl: null,
    color: isHost ? '#ff0000' : '#0000ff',
    isHost,
    resources: { ...ZERO_RESOURCES },
    goals: [],
    stats: {
      publicVP: 0,
      settlementsBuilt: 0,
      citiesBuilt: 0,
      roadsBuilt: 0,
      totalResourcesCollected: 0,
      totalResourcesSpent: 0,
      longestRoadLength: 0,
      turnsPlayed: 0,
    },
    presence: {
      isConnected: true,
      lastSeenAt: FIXED_NOW,
      connectionId: '',
    },
    joinedAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
  };
}

function createGameState(chatMessages: GameState['chatMessages'] = []): GameState {
  const p1 = createPlayer('p1', 'Mimi', true);
  const p2 = createPlayer('p2', 'Komachi', false);
  return {
    gameId: 'g_sync',
    roomCode: 'ABC123',
    roomStatus: 'in_progress',
    createdBy: p1.playerId,
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    isDeleted: false,
    winnerPlayerId: null,
    config: {
      playerCount: 2,
      goalCount: 0,
      winRule: 'FIRST_TO_X_POINTS',
      mapSeed: 11,
      mapSize: 'small',
      timerEnabled: false,
      turnTimeSec: null,
      allowReroll: false,
      startingResources: { ...ZERO_RESOURCES },
    },
    playerOrder: ['p1', 'p2'],
    playersById: {
      p1,
      p2,
    },
    board: {
      tilesById: {
        't:0,0': {
          tileId: 't:0,0',
          coord: { q: 0, r: 0 },
          resourceType: 'STONE',
          numberToken: 8,
          adjacentTiles: [],
          vertices: [],
          edges: [],
          createdAt: FIXED_NOW,
        },
      },
      structuresById: {},
    },
    turn: {
      currentTurn: 4,
      currentPlayerId: 'p1',
      currentPlayerIndex: 0,
      phase: 'ROLL',
      turnStartedAt: FIXED_NOW,
      turnEndsAt: '2026-01-01T00:00:30.000Z',
      lastDiceRoll: null,
    },
    chatMessages,
  };
}

test('rejoin hydrate restores full board state and attaches socket to live game room', async () => {
  const io = new FakeIo();
  const originalSetInterval = global.setInterval;
  const originalJoinGame = gamePersistenceService.joinGame.bind(gamePersistenceService);
  const originalGetGameState = gamePersistenceService.getGameState.bind(gamePersistenceService);
  const originalMarkPlayerConnected = gamePersistenceService.markPlayerConnected.bind(gamePersistenceService);
  const originalMarkPlayerDisconnected = gamePersistenceService.markPlayerDisconnected.bind(gamePersistenceService);

  let currentState = createGameState();
  gamePersistenceService.joinGame = async (_joinCode, displayName) => ({
    gameState: currentState,
    playerId: displayName.toLowerCase() === 'mimi' ? 'p1' : 'p2',
  });
  gamePersistenceService.getGameState = async () => currentState;
  gamePersistenceService.markPlayerConnected = async () => {};
  gamePersistenceService.markPlayerDisconnected = async () => {};
  global.setInterval = (() => 0 as unknown as ReturnType<typeof setInterval>) as typeof setInterval;

  try {
    registerSocketHandlers(io as unknown as Parameters<typeof registerSocketHandlers>[0]);
    const socket = new FakeSocket('s-rejoin');
    io.connect(socket);

    const joinRequest: JoinGameRequest = { joinCode: 'ABC123', displayName: 'Mimi' };
    let joinAck: unknown = null;
    await socket.trigger(CLIENT_EVENTS.JOIN_GAME, joinRequest, (response: unknown) => {
      joinAck = response;
    });
    assert.ok(joinAck && typeof joinAck === 'object');
    assert.equal(socket.rooms.has('g_sync'), true);

    const hydrateRequest = { gameId: 'ABC123' };
    let hydrateAck: unknown = null;
    await socket.trigger(CLIENT_EVENTS.HYDRATE_SESSION, hydrateRequest, (response: unknown) => {
      hydrateAck = response;
    });
    assert.ok(hydrateAck && typeof hydrateAck === 'object');
    const hydrateData = hydrateAck as { ok: boolean; data?: { gameState: GameState } };
    assert.equal(hydrateData.ok, true);
    assert.equal(Object.keys(hydrateData.data?.gameState.board.tilesById ?? {}).length, 1);
    assert.ok(hydrateData.data?.gameState.board.tilesById['t:0,0']);
  } finally {
    global.setInterval = originalSetInterval;
    gamePersistenceService.joinGame = originalJoinGame;
    gamePersistenceService.getGameState = originalGetGameState;
    gamePersistenceService.markPlayerConnected = originalMarkPlayerConnected;
    gamePersistenceService.markPlayerDisconnected = originalMarkPlayerDisconnected;
  }
});

test('post-rejoin roll/chat updates are broadcast immediately to the shared live room', async () => {
  const io = new FakeIo();
  const originalSetInterval = global.setInterval;
  const originalJoinGame = gamePersistenceService.joinGame.bind(gamePersistenceService);
  const originalGetGameState = gamePersistenceService.getGameState.bind(gamePersistenceService);
  const originalRollDice = gamePersistenceService.rollDice.bind(gamePersistenceService);
  const originalAppendChatMessage = gamePersistenceService.appendChatMessage.bind(gamePersistenceService);
  const originalMarkPlayerConnected = gamePersistenceService.markPlayerConnected.bind(gamePersistenceService);
  const originalMarkPlayerDisconnected = gamePersistenceService.markPlayerDisconnected.bind(gamePersistenceService);

  let currentState = createGameState();
  gamePersistenceService.joinGame = async (_joinCode, displayName) => ({
    gameState: currentState,
    playerId: displayName.toLowerCase() === 'mimi' ? 'p1' : 'p2',
  });
  gamePersistenceService.getGameState = async () => currentState;
  gamePersistenceService.rollDice = async () => {
    currentState = {
      ...currentState,
      turn: {
        ...currentState.turn,
        phase: 'ACTION',
        lastDiceRoll: {
          d1Val: 3,
          d2Val: 4,
          sum: 7,
          rolledAt: FIXED_NOW,
        },
      },
    };
    return currentState;
  };
  gamePersistenceService.appendChatMessage = async (_gameId, playerId, message) => {
    currentState = {
      ...currentState,
      chatMessages: [
        ...currentState.chatMessages,
        {
          id: 'chat_1',
          senderId: playerId,
          senderName: currentState.playersById[playerId]?.displayName ?? playerId,
          message,
          timestamp: FIXED_NOW,
        },
      ],
    };
    return currentState;
  };
  gamePersistenceService.markPlayerConnected = async () => {};
  gamePersistenceService.markPlayerDisconnected = async () => {};
  global.setInterval = (() => 0 as unknown as ReturnType<typeof setInterval>) as typeof setInterval;

  try {
    registerSocketHandlers(io as unknown as Parameters<typeof registerSocketHandlers>[0]);
    const mimi = new FakeSocket('s-mimi');
    const komachi = new FakeSocket('s-komachi');
    io.connect(mimi);
    io.connect(komachi);

    await mimi.trigger(
      CLIENT_EVENTS.JOIN_GAME,
      { joinCode: 'ABC123', displayName: 'Mimi' } as JoinGameRequest,
      () => {},
    );
    await komachi.trigger(
      CLIENT_EVENTS.JOIN_GAME,
      { joinCode: 'ABC123', displayName: 'Komachi' } as JoinGameRequest,
      () => {},
    );
    assert.equal(mimi.rooms.has('g_sync'), true);
    assert.equal(komachi.rooms.has('g_sync'), true);

    io.roomEmits = [];

    await mimi.trigger(
      CLIENT_EVENTS.ROLL_DICE,
      { gameId: 'ABC123' } as RollDiceRequest,
      () => {},
    );
    assert.equal(io.roomEmits.length, 1);
    assert.equal(io.roomEmits[0].room, 'g_sync');
    assert.equal(io.roomEmits[0].event, SERVER_EVENTS.GAME_STATE_UPDATE);
    const rolledState = io.roomEmits[0].payload as GameState;
    assert.equal(rolledState.turn.lastDiceRoll?.sum, 7);

    await komachi.trigger(
      CLIENT_EVENTS.SEND_CHAT_MESSAGE,
      { gameId: 'ABC123', message: 'hello' } as SendChatMessageRequest,
      () => {},
    );
    assert.equal(io.roomEmits.length, 2);
    assert.equal(io.roomEmits[1].room, 'g_sync');
    assert.equal(io.roomEmits[1].event, SERVER_EVENTS.GAME_STATE_UPDATE);
    const chatState = io.roomEmits[1].payload as GameState;
    assert.equal(chatState.chatMessages.length, 1);
    assert.equal(chatState.chatMessages[0].message, 'hello');
  } finally {
    global.setInterval = originalSetInterval;
    gamePersistenceService.joinGame = originalJoinGame;
    gamePersistenceService.getGameState = originalGetGameState;
    gamePersistenceService.rollDice = originalRollDice;
    gamePersistenceService.appendChatMessage = originalAppendChatMessage;
    gamePersistenceService.markPlayerConnected = originalMarkPlayerConnected;
    gamePersistenceService.markPlayerDisconnected = originalMarkPlayerDisconnected;
  }
});
