import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildEdgeLocationFromId,
  buildVertexLocationFromId,
  generateBoardTiles,
  parseEdgeId,
} from '../../shared/boardLayout';
import type { GameState, PlayerState, ResourceBundle, StructureState } from '../../shared/types/domain';
import {
  canPlaceRoad,
  canUpgradeSettlementToCity,
  validateSettlementPlacement,
} from './GamePersistenceService';

const ZERO_RESOURCES: ResourceBundle = {
  CRYSTAL: 0,
  STONE: 0,
  BLOOM: 0,
  EMBER: 0,
  GOLD: 0,
};

const FIXED_NOW = '2026-01-01T00:00:00.000Z';
const BASE_TILES = generateBoardTiles({ mapSeed: 123, mapSize: 'small' }, FIXED_NOW);
const centerTile = BASE_TILES.find((tile) => tile.tileId === 't:0,0');
if (!centerTile) {
  throw new Error('Expected center tile for test board');
}
const CENTER_TILE = centerTile;

function createPlayer(playerId: string, displayName: string, color: string): PlayerState {
  return {
    playerId,
    userId: playerId,
    displayName,
    avatarUrl: null,
    color,
    isHost: false,
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

function createSettlementStructure(
  structureId: string,
  ownerPlayerId: string,
  ownerName: string,
  ownerColor: string,
  vertexId: string,
  type: 'SETTLEMENT' | 'CITY' = 'SETTLEMENT',
): StructureState {
  const vertex = buildVertexLocationFromId(vertexId);
  return {
    structureId,
    ownerPlayerId,
    ownerName,
    ownerColor,
    type,
    level: type === 'CITY' ? 2 : 1,
    locationType: 'VERTEX',
    vertex,
    edge: null,
    adjacentStructures: [],
    adjacentTiles: vertex.adjacentHexes.map((coord) => 't:' + coord.q + ',' + coord.r),
    builtAtTurn: 1,
    builtAt: FIXED_NOW,
    cost: { ...ZERO_RESOURCES },
    roadPath: null,
  };
}

function createRoadStructure(
  structureId: string,
  ownerPlayerId: string,
  ownerName: string,
  ownerColor: string,
  edgeId: string,
): StructureState {
  return {
    structureId,
    ownerPlayerId,
    ownerName,
    ownerColor,
    type: 'ROAD',
    level: 1,
    locationType: 'EDGE',
    vertex: null,
    edge: buildEdgeLocationFromId(edgeId),
    adjacentStructures: [],
    adjacentTiles: [],
    builtAtTurn: 1,
    builtAt: FIXED_NOW,
    cost: { ...ZERO_RESOURCES },
    roadPath: null,
  };
}

function createGameState(structures: StructureState[]): GameState {
  const playersById: Record<string, PlayerState> = {
    p1: createPlayer('p1', 'Player One', '#ff0000'),
    p2: createPlayer('p2', 'Player Two', '#0000ff'),
  };

  return {
    gameId: 'g_test',
    roomCode: 'ABC123',
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
      mapSeed: 123,
      mapSize: 'small',
      timerEnabled: false,
      turnTimeSec: null,
      allowReroll: false,
      startingResources: { ...ZERO_RESOURCES },
    },
    playerOrder: ['p1', 'p2'],
    playersById,
    board: {
      tilesById: Object.fromEntries(BASE_TILES.map((tile) => [tile.tileId, tile])),
      structuresById: Object.fromEntries(structures.map((structure) => [structure.structureId, structure])),
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

function requireParsedEdge(edgeId: string): [string, string] {
  const parsed = parseEdgeId(edgeId);
  if (!parsed) {
    throw new Error('Invalid edge id in test: ' + edgeId);
  }
  return parsed;
}

function findEdgeTouchingVertex(vertexId: string): string {
  const found = CENTER_TILE.edges.find((edgeId) => {
    const [left, right] = requireParsedEdge(edgeId);
    return left === vertexId || right === vertexId;
  });
  if (!found) {
    throw new Error('No edge found for vertex in test board: ' + vertexId);
  }
  return found;
}

function findAdjacentVertex(vertexId: string): string {
  const edgeId = findEdgeTouchingVertex(vertexId);
  const [left, right] = requireParsedEdge(edgeId);
  return left === vertexId ? right : left;
}

function findTwoEdgesTouchingVertex(vertexId: string): [string, string] {
  const edges = CENTER_TILE.edges.filter((edgeId) => {
    const [left, right] = requireParsedEdge(edgeId);
    return left === vertexId || right === vertexId;
  });
  if (edges.length < 2) {
    throw new Error('Expected two edges touching vertex in test board: ' + vertexId);
  }
  return [edges[0], edges[1]];
}

test('legal second settlement placement when connected to own road and obeying distance rule', () => {
  const existingSettlementVertex = CENTER_TILE.vertices[0];
  const candidateVertex = CENTER_TILE.vertices[3];
  const supportingRoad = findEdgeTouchingVertex(candidateVertex);

  const gameState = createGameState([
    createSettlementStructure('s:p1:first', 'p1', 'Player One', '#ff0000', existingSettlementVertex, 'SETTLEMENT'),
    createRoadStructure('r:p1:support', 'p1', 'Player One', '#ff0000', supportingRoad),
  ]);

  assert.equal(validateSettlementPlacement(gameState, 'p1', candidateVertex), null);
});

test('illegal settlement placement adjacent to any settlement or city', () => {
  const occupiedVertex = CENTER_TILE.vertices[0];
  const adjacentVertex = findAdjacentVertex(occupiedVertex);
  const gameState = createGameState([
    createSettlementStructure('c:p2:block', 'p2', 'Player Two', '#0000ff', occupiedVertex, 'CITY'),
  ]);

  assert.equal(validateSettlementPlacement(gameState, 'p1', adjacentVertex), 'DISTANCE_RULE');
});

test('legal road placement connected to own network', () => {
  const candidateEdge = CENTER_TILE.edges[0];
  const [leftVertexId] = requireParsedEdge(candidateEdge);
  const gameState = createGameState([
    createSettlementStructure('s:p1:anchor', 'p1', 'Player One', '#ff0000', leftVertexId, 'SETTLEMENT'),
  ]);

  assert.equal(canPlaceRoad(gameState, 'p1', candidateEdge), true);
});

test('illegal road placement when trying to connect through an opponent settlement', () => {
  const blockedVertex = CENTER_TILE.vertices[1];
  const [existingRoadEdge, candidateEdge] = findTwoEdgesTouchingVertex(blockedVertex);
  const gameState = createGameState([
    createRoadStructure('r:p1:existing', 'p1', 'Player One', '#ff0000', existingRoadEdge),
    createSettlementStructure('s:p2:block', 'p2', 'Player Two', '#0000ff', blockedVertex, 'SETTLEMENT'),
  ]);

  assert.equal(canPlaceRoad(gameState, 'p1', candidateEdge), false);
});

test('legal city upgrade of own settlement', () => {
  const vertex = CENTER_TILE.vertices[2];
  const gameState = createGameState([
    createSettlementStructure('s:p1:upgrade', 'p1', 'Player One', '#ff0000', vertex, 'SETTLEMENT'),
  ]);

  assert.equal(canUpgradeSettlementToCity(gameState, 'p1', vertex), true);
});
