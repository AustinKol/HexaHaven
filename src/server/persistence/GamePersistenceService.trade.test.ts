import test from 'node:test';
import assert from 'node:assert/strict';
import type { GameState, PlayerState, ResourceBundle, TurnState } from '../../shared/types/domain';
import { GamePersistenceService } from './GamePersistenceService';
import { boardRepository } from './boardRepository';
import { gameSessionsRepository } from './gameSessionsRepository';
import { playersRepository } from './playersRepository';
import { turnsRepository } from './turnsRepository';

const ZERO_RESOURCES: ResourceBundle = {
  CRYSTAL: 0,
  STONE: 0,
  BLOOM: 0,
  EMBER: 0,
  GOLD: 0,
};

const FIXED_NOW = '2026-01-01T00:00:00.000Z';

function createPlayer(playerId: string, displayName: string, resources: ResourceBundle, isHost = false): PlayerState {
  return {
    playerId,
    userId: playerId,
    displayName,
    avatarUrl: null,
    color: isHost ? '#ff0000' : '#0000ff',
    isHost,
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

function createGameState(params: {
  roomStatus?: GameState['roomStatus'];
  phase?: TurnState['phase'];
  currentPlayerId?: string | null;
  senderResources?: Partial<ResourceBundle>;
  receiverResources?: Partial<ResourceBundle>;
  timerEnabled?: boolean;
  turnTimeSec?: number | null;
} = {}): GameState {
  const p1 = createPlayer(
    'p1',
    'Mimi',
    {
      ...ZERO_RESOURCES,
      EMBER: 2,
      STONE: 2,
      ...(params.senderResources ?? {}),
    },
    true,
  );
  const p2 = createPlayer(
    'p2',
    'Komachi',
    {
      ...ZERO_RESOURCES,
      BLOOM: 2,
      GOLD: 1,
      ...(params.receiverResources ?? {}),
    },
  );

  return {
    gameId: 'g_trade_service',
    roomCode: 'SVR123',
    roomStatus: params.roomStatus ?? 'in_progress',
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
      timerEnabled: params.timerEnabled ?? false,
      turnTimeSec: params.turnTimeSec ?? null,
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
      currentTurn: 4,
      currentPlayerId: params.currentPlayerId ?? 'p1',
      currentPlayerIndex: 0,
      phase: params.phase ?? 'ACTION',
      turnStartedAt: FIXED_NOW,
      turnEndsAt: '2026-01-01T00:01:00.000Z',
      lastDiceRoll: null,
    },
    chatMessages: [],
  };
}

test('accepted player trade transfers resources via authoritative service', async () => {
  const service = new GamePersistenceService();
  const originalGetGameState = service.getGameState.bind(service);
  const originalApplyPlayerTradeAtomic = playersRepository.applyPlayerTradeAtomic.bind(playersRepository);
  const originalTouchGame = gameSessionsRepository.touchGame.bind(gameSessionsRepository);
  const originalAppendAction = turnsRepository.appendAction.bind(turnsRepository);

  let gameState = createGameState();
  service.getGameState = async () => gameState;
  playersRepository.applyPlayerTradeAtomic = async (_gameId, _senderId, _receiverId, offer, request) => {
    gameState = {
      ...gameState,
      playersById: {
        ...gameState.playersById,
        p1: {
          ...gameState.playersById.p1,
          resources: {
            ...gameState.playersById.p1.resources,
            EMBER: gameState.playersById.p1.resources.EMBER - offer.EMBER + request.EMBER,
            BLOOM: gameState.playersById.p1.resources.BLOOM - offer.BLOOM + request.BLOOM,
          },
        },
        p2: {
          ...gameState.playersById.p2,
          resources: {
            ...gameState.playersById.p2.resources,
            EMBER: gameState.playersById.p2.resources.EMBER - request.EMBER + offer.EMBER,
            BLOOM: gameState.playersById.p2.resources.BLOOM - request.BLOOM + offer.BLOOM,
          },
        },
      },
    };
    return {
      senderResources: { ...gameState.playersById.p1.resources },
      receiverResources: { ...gameState.playersById.p2.resources },
    };
  };
  gameSessionsRepository.touchGame = async () => {};
  turnsRepository.appendAction = async () => {};

  try {
    const updated = await service.executePlayerTrade(
      'g_trade_service',
      'p1',
      'p2',
      { ...ZERO_RESOURCES, EMBER: 1 },
      { ...ZERO_RESOURCES, BLOOM: 1 },
    );
    assert.equal(updated.playersById.p1.resources.EMBER, 1);
    assert.equal(updated.playersById.p1.resources.BLOOM, 1);
    assert.equal(updated.playersById.p2.resources.EMBER, 1);
    assert.equal(updated.playersById.p2.resources.BLOOM, 1);
  } finally {
    service.getGameState = originalGetGameState;
    playersRepository.applyPlayerTradeAtomic = originalApplyPlayerTradeAtomic;
    gameSessionsRepository.touchGame = originalTouchGame;
    turnsRepository.appendAction = originalAppendAction;
  }
});

test('accepted player trade fails when resources changed at accept time', async () => {
  const service = new GamePersistenceService();
  const originalGetGameState = service.getGameState.bind(service);
  const originalApplyPlayerTradeAtomic = playersRepository.applyPlayerTradeAtomic.bind(playersRepository);

  const gameState = createGameState();
  service.getGameState = async () => gameState;
  playersRepository.applyPlayerTradeAtomic = async () => {
    throw new Error('Sender no longer has enough resources for this trade');
  };

  try {
    await assert.rejects(
      () =>
        service.executePlayerTrade(
          'g_trade_service',
          'p1',
          'p2',
          { ...ZERO_RESOURCES, EMBER: 1 },
          { ...ZERO_RESOURCES, BLOOM: 1 },
        ),
      /no longer has enough resources/i,
    );
  } finally {
    service.getGameState = originalGetGameState;
    playersRepository.applyPlayerTradeAtomic = originalApplyPlayerTradeAtomic;
  }
});

test('default turn duration is 60 seconds when custom timer is not configured', async () => {
  const service = new GamePersistenceService();
  const originalGetGameState = service.getGameState.bind(service);
  const originalUpdateGameStatus = gameSessionsRepository.updateGameStatus.bind(gameSessionsRepository);
  const originalUpdateTurnState = gameSessionsRepository.updateTurnState.bind(gameSessionsRepository);
  const originalInitTiles = boardRepository.initTiles.bind(boardRepository);
  const originalCreateTurn = turnsRepository.createTurn.bind(turnsRepository);

  let capturedTurnState: TurnState | null = null;
  const waitingState = createGameState({
    roomStatus: 'waiting',
    phase: 'ROLL',
    currentPlayerId: null,
    timerEnabled: false,
    turnTimeSec: null,
  });
  service.getGameState = async () => {
    if (capturedTurnState) {
      return {
        ...waitingState,
        roomStatus: 'in_progress',
        turn: capturedTurnState,
      };
    }
    return waitingState;
  };
  gameSessionsRepository.updateGameStatus = async () => {};
  gameSessionsRepository.updateTurnState = async (_gameId, turnState) => {
    capturedTurnState = turnState;
  };
  boardRepository.initTiles = async () => {};
  turnsRepository.createTurn = async () => {};

  try {
    const started = await service.startGame('g_trade_service', 'p1');
    const startedAt = Date.parse(started.turn.turnStartedAt ?? '');
    const endsAt = Date.parse(started.turn.turnEndsAt ?? '');
    assert.ok(Number.isFinite(startedAt));
    assert.ok(Number.isFinite(endsAt));
    const diffSeconds = Math.round((endsAt - startedAt) / 1000);
    assert.equal(diffSeconds, 60);
  } finally {
    service.getGameState = originalGetGameState;
    gameSessionsRepository.updateGameStatus = originalUpdateGameStatus;
    gameSessionsRepository.updateTurnState = originalUpdateTurnState;
    boardRepository.initTiles = originalInitTiles;
    turnsRepository.createTurn = originalCreateTurn;
  }
});
