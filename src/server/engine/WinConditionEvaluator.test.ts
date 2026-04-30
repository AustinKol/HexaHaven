import test from 'node:test';
import assert from 'node:assert/strict';
import type { GameState, PlayerState, ResourceBundle } from '../../shared/types/domain';
import { DEFAULT_VP_TO_WIN, evaluateWinner } from './WinConditionEvaluator';

const ZERO_RESOURCES: ResourceBundle = {
  CRYSTAL: 0,
  STONE: 0,
  BLOOM: 0,
  EMBER: 0,
  GOLD: 0,
};

const FIXED_NOW = '2026-01-01T00:00:00.000Z';

function createPlayer(playerId: string, vp: number): PlayerState {
  return {
    playerId,
    userId: playerId,
    displayName: playerId,
    avatarUrl: null,
    color: '#ffffff',
    isHost: playerId === 'p1',
    resources: { ...ZERO_RESOURCES },
    goals: [],
    stats: {
      publicVP: vp,
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

function createGameState(vp1: number, vp2: number): GameState {
  const p1 = createPlayer('p1', vp1);
  const p2 = createPlayer('p2', vp2);
  return {
    gameId: 'g_win',
    roomCode: 'WIN123',
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
      currentTurn: 1,
      currentPlayerId: 'p1',
      currentPlayerIndex: 0,
      phase: 'ACTION',
      turnStartedAt: FIXED_NOW,
      turnEndsAt: FIXED_NOW,
      lastDiceRoll: null,
    },
    chatMessages: [],
  };
}

test('default VP threshold is 5', () => {
  assert.equal(DEFAULT_VP_TO_WIN, 5);
  const noWinnerState = createGameState(4, 4);
  assert.equal(evaluateWinner(noWinnerState).winnerPlayerId, null);

  const winnerState = createGameState(5, 3);
  assert.equal(evaluateWinner(winnerState).winnerPlayerId, 'p1');
});
