import test from 'node:test';
import assert from 'node:assert/strict';
import { CLIENT_EVENTS, SERVER_EVENTS, SocketEvents } from '../../shared/constants/socketEvents';
import type {
  JoinGameRequest,
  RespondPlayerTradeRequestPayload,
  SendPlayerTradeRequestPayload,
  SocketAck,
  SendPlayerTradeRequestAckData,
  RespondPlayerTradeRequestAckData,
} from '../../shared/types/socket';
import type { GameState, PlayerState, ResourceBundle } from '../../shared/types/domain';
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

function createPlayer(playerId: string, displayName: string, resources: ResourceBundle): PlayerState {
  return {
    playerId,
    userId: playerId,
    displayName,
    avatarUrl: null,
    color: playerId === 'p1' ? '#ff0000' : '#0000ff',
    isHost: playerId === 'p1',
    resources,
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

function createGameState(params?: {
  senderResources?: Partial<ResourceBundle>;
  receiverResources?: Partial<ResourceBundle>;
}): GameState {
  const senderResources: ResourceBundle = {
    ...ZERO_RESOURCES,
    EMBER: 2,
    STONE: 2,
    ...(params?.senderResources ?? {}),
  };
  const receiverResources: ResourceBundle = {
    ...ZERO_RESOURCES,
    BLOOM: 2,
    GOLD: 1,
    ...(params?.receiverResources ?? {}),
  };
  const p1 = createPlayer('p1', 'Mimi', senderResources);
  const p2 = createPlayer('p2', 'Komachi', receiverResources);
  return {
    gameId: 'g_trade',
    roomCode: 'TRD123',
    roomStatus: 'in_progress',
    createdBy: 'p1',
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    isDeleted: false,
    winnerPlayerId: null,
    config: {
      playerCount: 2,
      goalCount: 0,
      winRule: 'FIRST_TO_X_POINTS',
      mapSeed: 0,
      mapSize: 'small',
      timerEnabled: false,
      turnTimeSec: null,
      allowReroll: false,
      startingResources: { ...ZERO_RESOURCES },
    },
    playerOrder: ['p1', 'p2'],
    playersById: { p1, p2 },
    board: {
      tilesById: {},
      structuresById: {},
    },
    turn: {
      currentTurn: 3,
      currentPlayerId: 'p1',
      currentPlayerIndex: 0,
      phase: 'ACTION',
      turnStartedAt: FIXED_NOW,
      turnEndsAt: '2026-01-01T00:01:00.000Z',
      lastDiceRoll: null,
    },
    chatMessages: [],
  };
}

async function triggerWithAck<T>(
  socket: FakeSocket,
  event: string,
  payload: unknown,
): Promise<SocketAck<T>> {
  return await new Promise<SocketAck<T>>((resolve, reject) => {
    void socket
      .trigger(event, payload, (ack: SocketAck<T>) => {
        resolve(ack);
      })
      .catch(reject);
  });
}

test('cannot send empty player trade request', async () => {
  const io = new FakeIo();
  const originalSetInterval = global.setInterval;
  const originalJoinGame = gamePersistenceService.joinGame.bind(gamePersistenceService);
  const originalGetGameState = gamePersistenceService.getGameState.bind(gamePersistenceService);
  const originalExecutePlayerTrade = gamePersistenceService.executePlayerTrade.bind(gamePersistenceService);
  const originalMarkPlayerConnected = gamePersistenceService.markPlayerConnected.bind(gamePersistenceService);
  const originalMarkPlayerDisconnected = gamePersistenceService.markPlayerDisconnected.bind(gamePersistenceService);
  const gameState = createGameState();

  gamePersistenceService.joinGame = async () => ({ gameState, playerId: 'p1' });
  gamePersistenceService.getGameState = async () => gameState;
  gamePersistenceService.executePlayerTrade = async () => gameState;
  gamePersistenceService.markPlayerConnected = async () => {};
  gamePersistenceService.markPlayerDisconnected = async () => {};
  global.setInterval = ((() => 0) as unknown) as typeof setInterval;

  try {
    registerSocketHandlers(io as unknown as Parameters<typeof registerSocketHandlers>[0]);
    const mimi = new FakeSocket('s-mimi');
    io.connect(mimi);
    await mimi.trigger(
      CLIENT_EVENTS.JOIN_GAME,
      { joinCode: 'TRD123', displayName: 'Mimi' } satisfies JoinGameRequest,
      () => {},
    );

    const ackResponse = await triggerWithAck<SendPlayerTradeRequestAckData>(
      mimi,
      CLIENT_EVENTS.SEND_PLAYER_TRADE_REQUEST,
      {
        gameId: 'TRD123',
        receiverPlayerId: 'p2',
        offeredResources: { ...ZERO_RESOURCES },
        requestedResources: { ...ZERO_RESOURCES, BLOOM: 1 },
      } satisfies SendPlayerTradeRequestPayload,
    );
    assert.equal(ackResponse.ok, false);
    if (ackResponse.ok) {
      assert.fail('Expected trade request rejection');
    }
    assert.equal(ackResponse.error.code, 'INVALID_CONFIGURATION');
  } finally {
    global.setInterval = originalSetInterval;
    gamePersistenceService.joinGame = originalJoinGame;
    gamePersistenceService.getGameState = originalGetGameState;
    gamePersistenceService.executePlayerTrade = originalExecutePlayerTrade;
    gamePersistenceService.markPlayerConnected = originalMarkPlayerConnected;
    gamePersistenceService.markPlayerDisconnected = originalMarkPlayerDisconnected;
  }
});

test('cannot trade with self and cannot send offer without enough resources', async () => {
  const io = new FakeIo();
  const originalSetInterval = global.setInterval;
  const originalJoinGame = gamePersistenceService.joinGame.bind(gamePersistenceService);
  const originalGetGameState = gamePersistenceService.getGameState.bind(gamePersistenceService);
  const originalExecutePlayerTrade = gamePersistenceService.executePlayerTrade.bind(gamePersistenceService);
  const originalMarkPlayerConnected = gamePersistenceService.markPlayerConnected.bind(gamePersistenceService);
  const originalMarkPlayerDisconnected = gamePersistenceService.markPlayerDisconnected.bind(gamePersistenceService);
  const gameState = createGameState({
    senderResources: { EMBER: 1, STONE: 0 },
  });

  gamePersistenceService.joinGame = async () => ({ gameState, playerId: 'p1' });
  gamePersistenceService.getGameState = async () => gameState;
  gamePersistenceService.executePlayerTrade = async () => gameState;
  gamePersistenceService.markPlayerConnected = async () => {};
  gamePersistenceService.markPlayerDisconnected = async () => {};
  global.setInterval = ((() => 0) as unknown) as typeof setInterval;

  try {
    registerSocketHandlers(io as unknown as Parameters<typeof registerSocketHandlers>[0]);
    const mimi = new FakeSocket('s-mimi');
    io.connect(mimi);
    await mimi.trigger(
      CLIENT_EVENTS.JOIN_GAME,
      { joinCode: 'TRD123', displayName: 'Mimi' } satisfies JoinGameRequest,
      () => {},
    );

    const selfAck = await triggerWithAck<SendPlayerTradeRequestAckData>(
      mimi,
      CLIENT_EVENTS.SEND_PLAYER_TRADE_REQUEST,
      {
        gameId: 'TRD123',
        receiverPlayerId: 'p1',
        offeredResources: { ...ZERO_RESOURCES, EMBER: 1 },
        requestedResources: { ...ZERO_RESOURCES, BLOOM: 1 },
      } satisfies SendPlayerTradeRequestPayload,
    );
    assert.equal(selfAck.ok, false);
    if (selfAck.ok) {
      assert.fail('Expected self-trade rejection');
    }
    assert.equal(selfAck.error.code, 'INVALID_CONFIGURATION');

    const resourcesAck = await triggerWithAck<SendPlayerTradeRequestAckData>(
      mimi,
      CLIENT_EVENTS.SEND_PLAYER_TRADE_REQUEST,
      {
        gameId: 'TRD123',
        receiverPlayerId: 'p2',
        offeredResources: { ...ZERO_RESOURCES, STONE: 3 },
        requestedResources: { ...ZERO_RESOURCES, BLOOM: 1 },
      } satisfies SendPlayerTradeRequestPayload,
    );
    assert.equal(resourcesAck.ok, false);
    if (resourcesAck.ok) {
      assert.fail('Expected insufficient-resource rejection');
    }
    assert.equal(resourcesAck.error.code, 'INSUFFICIENT_RESOURCES');
  } finally {
    global.setInterval = originalSetInterval;
    gamePersistenceService.joinGame = originalJoinGame;
    gamePersistenceService.getGameState = originalGetGameState;
    gamePersistenceService.executePlayerTrade = originalExecutePlayerTrade;
    gamePersistenceService.markPlayerConnected = originalMarkPlayerConnected;
    gamePersistenceService.markPlayerDisconnected = originalMarkPlayerDisconnected;
  }
});

test('declined and expired trade requests transfer nothing', async () => {
  const io = new FakeIo();
  const originalSetInterval = global.setInterval;
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const originalJoinGame = gamePersistenceService.joinGame.bind(gamePersistenceService);
  const originalGetGameState = gamePersistenceService.getGameState.bind(gamePersistenceService);
  const originalExecutePlayerTrade = gamePersistenceService.executePlayerTrade.bind(gamePersistenceService);
  const originalMarkPlayerConnected = gamePersistenceService.markPlayerConnected.bind(gamePersistenceService);
  const originalMarkPlayerDisconnected = gamePersistenceService.markPlayerDisconnected.bind(gamePersistenceService);
  const gameState = createGameState();

  let scheduledTimeout: (() => void) | null = null;
  let executeCalls = 0;
  gamePersistenceService.joinGame = async (_joinCode, displayName) => ({
    gameState,
    playerId: displayName.toLowerCase() === 'mimi' ? 'p1' : 'p2',
  });
  gamePersistenceService.getGameState = async () => gameState;
  gamePersistenceService.executePlayerTrade = async () => {
    executeCalls += 1;
    return gameState;
  };
  gamePersistenceService.markPlayerConnected = async () => {};
  gamePersistenceService.markPlayerDisconnected = async () => {};
  global.setInterval = ((() => 0) as unknown) as typeof setInterval;
  global.setTimeout = (((handler: TimerHandler) => {
    if (typeof handler === 'function') {
      scheduledTimeout = handler as () => void;
    }
    return (1 as unknown) as ReturnType<typeof setTimeout>;
  }) as unknown) as typeof setTimeout;
  global.clearTimeout = ((() => undefined) as unknown) as typeof clearTimeout;

  try {
    registerSocketHandlers(io as unknown as Parameters<typeof registerSocketHandlers>[0]);
    const mimi = new FakeSocket('s-mimi');
    const komachi = new FakeSocket('s-komachi');
    io.connect(mimi);
    io.connect(komachi);

    await mimi.trigger(
      CLIENT_EVENTS.JOIN_GAME,
      { joinCode: 'TRD123', displayName: 'Mimi' } satisfies JoinGameRequest,
      () => {},
    );
    await komachi.trigger(
      CLIENT_EVENTS.JOIN_GAME,
      { joinCode: 'TRD123', displayName: 'Komachi' } satisfies JoinGameRequest,
      () => {},
    );

    const sendAck = await triggerWithAck<SendPlayerTradeRequestAckData>(
      mimi,
      CLIENT_EVENTS.SEND_PLAYER_TRADE_REQUEST,
      {
        gameId: 'TRD123',
        receiverPlayerId: 'p2',
        offeredResources: { ...ZERO_RESOURCES, EMBER: 1 },
        requestedResources: { ...ZERO_RESOURCES, BLOOM: 1 },
      } satisfies SendPlayerTradeRequestPayload,
    );
    assert.equal(sendAck.ok, true);
    if (!sendAck.ok) {
      assert.fail('Expected send-trade success');
    }
    const tradeRequestId = sendAck.data.tradeRequest.id;

    io.roomEmits = [];
    const declineAck = await triggerWithAck<RespondPlayerTradeRequestAckData>(
      komachi,
      CLIENT_EVENTS.RESPOND_PLAYER_TRADE_REQUEST,
      {
        gameId: 'TRD123',
        tradeRequestId,
        response: 'declined',
      } satisfies RespondPlayerTradeRequestPayload,
    );
    assert.equal(declineAck.ok, true);
    if (!declineAck.ok) {
      assert.fail('Expected decline success');
    }
    assert.equal(declineAck.data.tradeRequest.status, 'declined');
    assert.equal(executeCalls, 0);
    assert.equal(io.roomEmits.some((entry) => entry.event === SERVER_EVENTS.GAME_STATE_UPDATE), false);

    io.roomEmits = [];
    const secondSendAck = await triggerWithAck<SendPlayerTradeRequestAckData>(
      mimi,
      CLIENT_EVENTS.SEND_PLAYER_TRADE_REQUEST,
      {
        gameId: 'TRD123',
        receiverPlayerId: 'p2',
        offeredResources: { ...ZERO_RESOURCES, EMBER: 1 },
        requestedResources: { ...ZERO_RESOURCES, BLOOM: 1 },
      } satisfies SendPlayerTradeRequestPayload,
    );
    if (!secondSendAck.ok) {
      assert.fail('Expected second send-trade success');
    }
    if (!scheduledTimeout) {
      assert.fail('Expected scheduled timeout callback');
    }
    (scheduledTimeout as () => void)();

    assert.equal(executeCalls, 0);
    const expiredUpdate = io.roomEmits.find(
      (entry) =>
        entry.event === SERVER_EVENTS.PLAYER_TRADE_REQUEST_UPDATED
        && (entry.payload as { outcome?: string }).outcome === 'expired',
    );
    assert.ok(expiredUpdate);
  } finally {
    global.setInterval = originalSetInterval;
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
    gamePersistenceService.joinGame = originalJoinGame;
    gamePersistenceService.getGameState = originalGetGameState;
    gamePersistenceService.executePlayerTrade = originalExecutePlayerTrade;
    gamePersistenceService.markPlayerConnected = originalMarkPlayerConnected;
    gamePersistenceService.markPlayerDisconnected = originalMarkPlayerDisconnected;
  }
});

test('accepted trade updates game state, and failed accept reports failure when resources changed', async () => {
  const io = new FakeIo();
  const originalSetInterval = global.setInterval;
  const originalJoinGame = gamePersistenceService.joinGame.bind(gamePersistenceService);
  const originalGetGameState = gamePersistenceService.getGameState.bind(gamePersistenceService);
  const originalExecutePlayerTrade = gamePersistenceService.executePlayerTrade.bind(gamePersistenceService);
  const originalMarkPlayerConnected = gamePersistenceService.markPlayerConnected.bind(gamePersistenceService);
  const originalMarkPlayerDisconnected = gamePersistenceService.markPlayerDisconnected.bind(gamePersistenceService);

  let gameState = createGameState();
  let executeCalls = 0;
  let shouldFailAccept = false;
  gamePersistenceService.joinGame = async (_joinCode, displayName) => ({
    gameState,
    playerId: displayName.toLowerCase() === 'mimi' ? 'p1' : 'p2',
  });
  gamePersistenceService.getGameState = async () => gameState;
  gamePersistenceService.executePlayerTrade = async () => {
    executeCalls += 1;
    if (shouldFailAccept) {
      throw new Error('Sender no longer has enough resources for this trade');
    }
    gameState = {
      ...gameState,
      playersById: {
        ...gameState.playersById,
        p1: {
          ...gameState.playersById.p1,
          resources: { ...gameState.playersById.p1.resources, EMBER: 1, BLOOM: 1 },
        },
        p2: {
          ...gameState.playersById.p2,
          resources: { ...gameState.playersById.p2.resources, EMBER: 1, BLOOM: 1 },
        },
      },
    };
    return gameState;
  };
  gamePersistenceService.markPlayerConnected = async () => {};
  gamePersistenceService.markPlayerDisconnected = async () => {};
  global.setInterval = ((() => 0) as unknown) as typeof setInterval;

  try {
    registerSocketHandlers(io as unknown as Parameters<typeof registerSocketHandlers>[0]);
    const mimi = new FakeSocket('s-mimi');
    const komachi = new FakeSocket('s-komachi');
    io.connect(mimi);
    io.connect(komachi);

    await mimi.trigger(
      CLIENT_EVENTS.JOIN_GAME,
      { joinCode: 'TRD123', displayName: 'Mimi' } satisfies JoinGameRequest,
      () => {},
    );
    await komachi.trigger(
      CLIENT_EVENTS.JOIN_GAME,
      { joinCode: 'TRD123', displayName: 'Komachi' } satisfies JoinGameRequest,
      () => {},
    );

    const sendAck = await triggerWithAck<SendPlayerTradeRequestAckData>(
      mimi,
      CLIENT_EVENTS.SEND_PLAYER_TRADE_REQUEST,
      {
        gameId: 'TRD123',
        receiverPlayerId: 'p2',
        offeredResources: { ...ZERO_RESOURCES, EMBER: 1 },
        requestedResources: { ...ZERO_RESOURCES, BLOOM: 1 },
      } satisfies SendPlayerTradeRequestPayload,
    );
    if (!sendAck.ok) {
      assert.fail('Expected send-trade success');
    }
    const firstTradeId = sendAck.data.tradeRequest.id;

    io.roomEmits = [];
    const acceptAck = await triggerWithAck<RespondPlayerTradeRequestAckData>(
      komachi,
      CLIENT_EVENTS.RESPOND_PLAYER_TRADE_REQUEST,
      {
        gameId: 'TRD123',
        tradeRequestId: firstTradeId,
        response: 'accepted',
      } satisfies RespondPlayerTradeRequestPayload,
    );
    assert.equal(acceptAck.ok, true);
    if (!acceptAck.ok) {
      assert.fail('Expected accept success');
    }
    assert.equal(acceptAck.data.tradeRequest.status, 'accepted');
    assert.equal(executeCalls, 1);
    assert.equal(io.roomEmits.some((entry) => entry.event === SERVER_EVENTS.GAME_STATE_UPDATE), true);

    shouldFailAccept = true;
    const failedSendAck = await triggerWithAck<SendPlayerTradeRequestAckData>(
      mimi,
      CLIENT_EVENTS.SEND_PLAYER_TRADE_REQUEST,
      {
        gameId: 'TRD123',
        receiverPlayerId: 'p2',
        offeredResources: { ...ZERO_RESOURCES, EMBER: 1 },
        requestedResources: { ...ZERO_RESOURCES, BLOOM: 1 },
      } satisfies SendPlayerTradeRequestPayload,
    );
    if (!failedSendAck.ok) {
      assert.fail('Expected send-trade success for failure scenario');
    }

    io.roomEmits = [];
    const failedAcceptAck = await triggerWithAck<RespondPlayerTradeRequestAckData>(
      komachi,
      CLIENT_EVENTS.RESPOND_PLAYER_TRADE_REQUEST,
      {
        gameId: 'TRD123',
        tradeRequestId: failedSendAck.data.tradeRequest.id,
        response: 'accepted',
      } satisfies RespondPlayerTradeRequestPayload,
    );
    assert.equal(failedAcceptAck.ok, false);
    if (failedAcceptAck.ok) {
      assert.fail('Expected failed accept rejection');
    }
    assert.equal(failedAcceptAck.error.code, 'INSUFFICIENT_RESOURCES');
    assert.equal(io.roomEmits.some((entry) => entry.event === SERVER_EVENTS.GAME_STATE_UPDATE), false);
    const failedUpdate = io.roomEmits.find(
      (entry) =>
        entry.event === SERVER_EVENTS.PLAYER_TRADE_REQUEST_UPDATED
        && (entry.payload as { outcome?: string }).outcome === 'failed',
    );
    assert.ok(failedUpdate);
  } finally {
    global.setInterval = originalSetInterval;
    gamePersistenceService.joinGame = originalJoinGame;
    gamePersistenceService.getGameState = originalGetGameState;
    gamePersistenceService.executePlayerTrade = originalExecutePlayerTrade;
    gamePersistenceService.markPlayerConnected = originalMarkPlayerConnected;
    gamePersistenceService.markPlayerDisconnected = originalMarkPlayerDisconnected;
  }
});
