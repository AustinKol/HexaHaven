import test from 'node:test';
import assert from 'node:assert/strict';
import type { GameState, PlayerState, ResourceBundle, TileState } from '../../shared/types/domain';
import { GamePersistenceService } from './GamePersistenceService';
import { playersRepository } from './playersRepository';
import { gameSessionsRepository } from './gameSessionsRepository';

const ZERO_RESOURCES: ResourceBundle = {
  CRYSTAL: 0,
  STONE: 0,
  BLOOM: 0,
  EMBER: 0,
  GOLD: 0,
};

const FIXED_NOW = '2026-01-01T00:00:00.000Z';

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
      isConnected: false,
      lastSeenAt: FIXED_NOW,
      connectionId: '',
    },
    joinedAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
  };
}

function createGameState(params: {
  gameId?: string;
  roomCode?: string;
  roomStatus: GameState['roomStatus'];
  players: PlayerState[];
  currentTurn?: number;
  turnEndsAt?: string | null;
  tilesById?: Record<string, TileState>;
}): GameState {
  const gameId = params.gameId ?? 'g_rejoin';
  const roomCode = params.roomCode ?? 'ABC123';
  const playersById = Object.fromEntries(params.players.map((player) => [player.playerId, player]));
  const playerOrder = params.players.map((player) => player.playerId);

  return {
    gameId,
    roomCode,
    roomStatus: params.roomStatus,
    createdBy: playerOrder[0] ?? 'p1',
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    isDeleted: false,
    winnerPlayerId: null,
    config: {
      playerCount: 4,
      goalCount: 0,
      winRule: 'FIRST_TO_X_POINTS',
      mapSeed: 0,
      mapSize: 'small',
      timerEnabled: false,
      turnTimeSec: null,
      allowReroll: false,
      startingResources: { ...ZERO_RESOURCES },
    },
    playerOrder,
    playersById,
    board: {
      tilesById: params.tilesById ?? {},
      structuresById: {},
    },
    turn: {
      currentTurn: params.currentTurn ?? 7,
      currentPlayerId: playerOrder[0] ?? null,
      currentPlayerIndex: playerOrder.length > 0 ? 0 : null,
      phase: params.roomStatus === 'in_progress' ? 'ACTION' : 'ROLL',
      turnStartedAt: FIXED_NOW,
      turnEndsAt: params.turnEndsAt ?? '2026-01-01T00:00:30.000Z',
      lastDiceRoll: null,
    },
    chatMessages: [],
  };
}

function createTile(tileId: string, q: number, r: number): TileState {
  return {
    tileId,
    coord: { q, r },
    resourceType: 'STONE',
    numberToken: 8,
    adjacentTiles: [],
    vertices: [],
    edges: [],
    createdAt: FIXED_NOW,
  };
}

test('rejoin in-progress game with same display name returns the same player identity and no duplicate player writes', async () => {
  const service = new GamePersistenceService();
  const gameState = createGameState({
    roomStatus: 'in_progress',
    players: [
      createPlayer('p1', 'Alice', true),
      createPlayer('p2', 'Bob', false),
    ],
    currentTurn: 11,
    turnEndsAt: '2026-01-01T00:08:30.000Z',
    tilesById: {
      't:0,0': createTile('t:0,0', 0, 0),
    },
  });

  const originalGetGameState = service.getGameState.bind(service);
  const originalCreatePlayer = playersRepository.createPlayer.bind(playersRepository);
  const originalUpdatePlayerOrder = gameSessionsRepository.updatePlayerOrder.bind(gameSessionsRepository);
  const originalUpdateTurnState = gameSessionsRepository.updateTurnState.bind(gameSessionsRepository);
  let createPlayerCalls = 0;
  let updatePlayerOrderCalls = 0;
  let updateTurnStateCalls = 0;

  service.getGameState = async () => gameState;
  playersRepository.createPlayer = async () => {
    createPlayerCalls += 1;
  };
  gameSessionsRepository.updatePlayerOrder = async () => {
    updatePlayerOrderCalls += 1;
  };
  gameSessionsRepository.updateTurnState = async () => {
    updateTurnStateCalls += 1;
  };

  try {
    const result = await service.joinGame('ABC123', '  aLiCe  ');
    assert.equal(result.playerId, 'p1');
    assert.equal(result.gameState.turn.currentTurn, 11);
    assert.equal(result.gameState.turn.turnEndsAt, '2026-01-01T00:08:30.000Z');
    assert.equal(Object.keys(result.gameState.board.tilesById).length, 1);
    assert.ok(result.gameState.board.tilesById['t:0,0']);
    assert.equal(createPlayerCalls, 0);
    assert.equal(updatePlayerOrderCalls, 0);
    assert.equal(updateTurnStateCalls, 0);
  } finally {
    service.getGameState = originalGetGameState;
    playersRepository.createPlayer = originalCreatePlayer;
    gameSessionsRepository.updatePlayerOrder = originalUpdatePlayerOrder;
    gameSessionsRepository.updateTurnState = originalUpdateTurnState;
  }
});

test('new player cannot join an in-progress game', async () => {
  const service = new GamePersistenceService();
  const gameState = createGameState({
    roomStatus: 'in_progress',
    players: [createPlayer('p1', 'Alice', true)],
  });
  const originalGetGameState = service.getGameState.bind(service);
  service.getGameState = async () => gameState;

  try {
    await assert.rejects(
      () => service.joinGame('ABC123', 'Charlie'),
      /not accepting new players/i,
    );
  } finally {
    service.getGameState = originalGetGameState;
  }
});

test('waiting room new join still creates a new player and updates player order', async () => {
  const service = new GamePersistenceService();
  const waitingState = createGameState({
    roomStatus: 'waiting',
    players: [createPlayer('p1', 'Alice', true)],
  });

  let callCount = 0;
  const originalGetGameState = service.getGameState.bind(service);
  const originalCreatePlayer = playersRepository.createPlayer.bind(playersRepository);
  const originalUpdatePlayerOrder = gameSessionsRepository.updatePlayerOrder.bind(gameSessionsRepository);

  service.getGameState = async () => {
    callCount += 1;
    if (callCount === 1) {
      return waitingState;
    }
    return {
      ...waitingState,
      playerOrder: [...waitingState.playerOrder, 'p_new'],
      playersById: {
        ...waitingState.playersById,
        p_new: createPlayer('p_new', 'Charlie', false),
      },
    };
  };

  let createdPlayerName: string | null = null;
  let playerOrderUpdate: string[] | null = null;
  playersRepository.createPlayer = async (_gameId, player) => {
    createdPlayerName = player.displayName;
  };
  gameSessionsRepository.updatePlayerOrder = async (_gameId, playerOrder) => {
    playerOrderUpdate = [...playerOrder];
  };

  try {
    const result = await service.joinGame('ABC123', '  Charlie ');
    assert.ok(result.playerId.length > 0);
    assert.equal(createdPlayerName, 'Charlie');
    assert.equal((playerOrderUpdate ?? []).length, 2);
  } finally {
    service.getGameState = originalGetGameState;
    playersRepository.createPlayer = originalCreatePlayer;
    gameSessionsRepository.updatePlayerOrder = originalUpdatePlayerOrder;
  }
});

test('ambiguous duplicate display names are rejected for safe rejoin matching', async () => {
  const service = new GamePersistenceService();
  const gameState = createGameState({
    roomStatus: 'in_progress',
    players: [
      createPlayer('p1', 'Alice', true),
      createPlayer('p2', 'alice', false),
    ],
  });
  const originalGetGameState = service.getGameState.bind(service);
  service.getGameState = async () => gameState;

  try {
    await assert.rejects(
      () => service.joinGame('ABC123', 'alice'),
      /ambiguous/i,
    );
  } finally {
    service.getGameState = originalGetGameState;
  }
});

test('stale disconnect events do not override presence for a newer socket session', async () => {
  const service = new GamePersistenceService();
  const player = createPlayer('p1', 'Alice', true);
  player.presence = {
    isConnected: true,
    lastSeenAt: FIXED_NOW,
    connectionId: 'socket-new',
  };

  const originalGetPlayer = playersRepository.getPlayer.bind(playersRepository);
  const originalUpdatePresence = playersRepository.updatePresence.bind(playersRepository);
  let updatePresenceCalls = 0;

  playersRepository.getPlayer = async () => player;
  playersRepository.updatePresence = async () => {
    updatePresenceCalls += 1;
  };

  try {
    await service.markPlayerDisconnected('g_rejoin', 'p1', 'socket-old');
    assert.equal(updatePresenceCalls, 0);

    await service.markPlayerDisconnected('g_rejoin', 'p1', 'socket-new');
    assert.equal(updatePresenceCalls, 1);
  } finally {
    playersRepository.getPlayer = originalGetPlayer;
    playersRepository.updatePresence = originalUpdatePresence;
  }
});
