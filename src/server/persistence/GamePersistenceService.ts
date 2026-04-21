import { Timestamp } from 'firebase-admin/firestore';
import { PLAYER_COLOR_PALETTE } from '../../shared/constants/playerColors';
import {
  buildEdgeLocationFromId,
  buildVertexLocationFromId,
  generateBoardTiles,
  hexCoordKey,
  parseEdgeId,
  parseVertexId,
} from '../../shared/boardLayout';
import { BUILD_COSTS, type BuildStructureKind } from '../../shared/buildRules';
import type {
  ChatMessage,
  DiceRoll,
  GameConfig,
  GameState,
  PlayerState,
  PlayerStats,
  ResourceBundle,
  ResourceType,
  StructureState,
  TurnState,
} from '../../shared/types/domain';
import { boardRepository } from './boardRepository';
import { gameSessionsRepository } from './gameSessionsRepository';
import { playersRepository } from './playersRepository';
import { turnsRepository } from './turnsRepository';
import { logger } from '../utils/logger';
import { evaluateWinner } from '../engine/WinConditionEvaluator';

const DEFAULT_RESOURCES: ResourceBundle = {
  CRYSTAL: 0,
  STONE: 0,
  BLOOM: 0,
  EMBER: 0,
  GOLD: 0,
};

const DEFAULT_STATS: PlayerStats = {
  publicVP: 0,
  settlementsBuilt: 0,
  citiesBuilt: 0,
  roadsBuilt: 0,
  totalResourcesCollected: 0,
  totalResourcesSpent: 0,
  longestRoadLength: 0,
  turnsPlayed: 0,
};

const RESOURCE_TYPES: ResourceType[] = ['CRYSTAL', 'STONE', 'BLOOM', 'EMBER', 'GOLD'];
const FIXED_TURN_TIME_SEC = 30;

function nowISO(): string {
  return new Date().toISOString();
}

function toIso(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (value && typeof value === 'object' && 'toDate' in value && typeof (value as { toDate?: () => Date }).toDate === 'function') {
    return (value as { toDate(): Date }).toDate().toISOString();
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    return value;
  }
  return null;
}

function generateId(prefix: string): string {
  return prefix + '_' + Math.random().toString(36).slice(2, 10);
}

function generateRoomCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i += 1) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

function sanitizeResourceCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.trunc(value));
}

function sanitizeResourceBundle(bundle: Partial<ResourceBundle> | null | undefined): ResourceBundle {
  return {
    CRYSTAL: sanitizeResourceCount(bundle?.CRYSTAL),
    STONE: sanitizeResourceCount(bundle?.STONE),
    BLOOM: sanitizeResourceCount(bundle?.BLOOM),
    EMBER: sanitizeResourceCount(bundle?.EMBER),
    GOLD: sanitizeResourceCount(bundle?.GOLD),
  };
}

function sanitizeGameConfig(config: GameConfig): GameConfig {
  const playerCount = typeof config.playerCount === 'number' && Number.isFinite(config.playerCount)
    ? Math.min(4, Math.max(2, Math.trunc(config.playerCount)))
    : 2;
  const goalCount = typeof config.goalCount === 'number' && Number.isFinite(config.goalCount)
    ? Math.max(0, Math.trunc(config.goalCount))
    : 0;
  const mapSize = config.mapSize === 'medium' || config.mapSize === 'large' ? config.mapSize : 'small';
  const winRule = config.winRule === 'ANY_X_GOALS_COMPLETE' || config.winRule === 'FIRST_TO_X_POINTS'
    ? config.winRule
    : 'ALL_GOALS_COMPLETE';
  const timerEnabled = Boolean(config.timerEnabled);
  const turnTimeSec = timerEnabled && typeof config.turnTimeSec === 'number' && Number.isFinite(config.turnTimeSec)
    ? Math.max(10, Math.trunc(config.turnTimeSec))
    : null;

  return {
    playerCount,
    goalCount,
    winRule,
    mapSeed: typeof config.mapSeed === 'number' && Number.isFinite(config.mapSeed)
      ? Math.trunc(config.mapSeed)
      : 0,
    mapSize,
    timerEnabled,
    turnTimeSec,
    allowReroll: Boolean(config.allowReroll),
    startingResources: sanitizeResourceBundle(config.startingResources),
  };
}

function cloneResources(bundle: ResourceBundle): ResourceBundle {
  return { ...bundle };
}

function emptyResourceBundle(): ResourceBundle {
  return cloneResources(DEFAULT_RESOURCES);
}

function resourceBundleSum(bundle: ResourceBundle): number {
  return bundle.CRYSTAL + bundle.STONE + bundle.BLOOM + bundle.EMBER + bundle.GOLD;
}

function addResources(left: ResourceBundle, right: ResourceBundle): ResourceBundle {
  return {
    CRYSTAL: left.CRYSTAL + right.CRYSTAL,
    STONE: left.STONE + right.STONE,
    BLOOM: left.BLOOM + right.BLOOM,
    EMBER: left.EMBER + right.EMBER,
    GOLD: left.GOLD + right.GOLD,
  };
}

function subtractResources(left: ResourceBundle, right: ResourceBundle): ResourceBundle {
  return {
    CRYSTAL: left.CRYSTAL - right.CRYSTAL,
    STONE: left.STONE - right.STONE,
    BLOOM: left.BLOOM - right.BLOOM,
    EMBER: left.EMBER - right.EMBER,
    GOLD: left.GOLD - right.GOLD,
  };
}

function hasResources(inventory: ResourceBundle, cost: ResourceBundle): boolean {
  return inventory.CRYSTAL >= cost.CRYSTAL
    && inventory.STONE >= cost.STONE
    && inventory.BLOOM >= cost.BLOOM
    && inventory.EMBER >= cost.EMBER
    && inventory.GOLD >= cost.GOLD;
}

function incrementResource(bundle: ResourceBundle, resourceType: ResourceType, amount: number): void {
  bundle[resourceType] += amount;
}

function normalizeChatMessages(messages: ChatMessage[]): ChatMessage[] {
  return [...messages].sort((left, right) => (
    left.timestamp.localeCompare(right.timestamp) || left.id.localeCompare(right.id)
  ));
}

function isResourceType(value: string): value is ResourceType {
  return RESOURCE_TYPES.includes(value as ResourceType);
}

function normalizeDisplayNameForMatch(displayName: string): string {
  return displayName.trim().toLocaleLowerCase();
}

function findPlayerIdsByDisplayName(gameState: GameState, displayName: string): string[] {
  const normalizedDisplayName = normalizeDisplayNameForMatch(displayName);
  if (!normalizedDisplayName) {
    return [];
  }

  const orderedMatches = gameState.playerOrder.filter((playerId) => {
    const player = gameState.playersById[playerId];
    return player ? normalizeDisplayNameForMatch(player.displayName) === normalizedDisplayName : false;
  });
  const seenPlayerIds = new Set(orderedMatches);
  const additionalMatches = Object.values(gameState.playersById)
    .filter(
      (player) =>
        !seenPlayerIds.has(player.playerId)
        && normalizeDisplayNameForMatch(player.displayName) === normalizedDisplayName,
    )
    .map((player) => player.playerId);

  return [...orderedMatches, ...additionalMatches];
}

function resolveBuildActionType(kind: BuildStructureKind): 'BUILD_ROAD' | 'BUILD_SETTLEMENT' | 'UPGRADE_SETTLEMENT' {
  if (kind === 'ROAD') {
    return 'BUILD_ROAD';
  }
  if (kind === 'CITY') {
    return 'UPGRADE_SETTLEMENT';
  }
  return 'BUILD_SETTLEMENT';
}

function resolveStructureAtVertex(gameState: GameState, vertexId: string): StructureState | null {
  return Object.values(gameState.board.structuresById).find((structure) => structure.vertex?.id === vertexId) ?? null;
}

function resolveStructureAtEdge(gameState: GameState, edgeId: string): StructureState | null {
  return Object.values(gameState.board.structuresById).find((structure) => structure.edge?.id === edgeId) ?? null;
}

function boardHasVertex(gameState: GameState, vertexId: string): boolean {
  return Object.values(gameState.board.tilesById).some((tile) => tile.vertices.includes(vertexId));
}

function boardHasEdge(gameState: GameState, edgeId: string): boolean {
  return Object.values(gameState.board.tilesById).some((tile) => tile.edges.includes(edgeId));
}

function verticesAreAdjacent(vertexIdA: string, vertexIdB: string): boolean {
  const hexesA = new Set(parseVertexId(vertexIdA).map(hexCoordKey));
  return parseVertexId(vertexIdB).filter((h) => hexesA.has(hexCoordKey(h))).length >= 2;
}

function violatesDistanceRule(gameState: GameState, vertexId: string): boolean {
  return Object.values(gameState.board.structuresById).some(
    (s) =>
      (s.type === 'SETTLEMENT' || s.type === 'CITY') &&
      s.vertex?.id !== undefined &&
      s.vertex.id !== vertexId &&
      verticesAreAdjacent(vertexId, s.vertex.id),
  );
}

function edgeTouchesVertex(edgeId: string, vertexId: string): boolean {
  const parsed = parseEdgeId(edgeId);
  if (parsed === null) {
    return false;
  }

  return parsed[0] === vertexId || parsed[1] === vertexId;
}

function isRoadTouchingVertex(structure: StructureState, vertexId: string): boolean {
  if (structure.type !== 'ROAD' || !structure.edge) {
    return false;
  }
  if (structure.edge.vertexIds?.includes(vertexId)) {
    return true;
  }
  return edgeTouchesVertex(structure.edge.id, vertexId);
}

function canConnectRoadFromVertex(
  gameState: GameState,
  playerId: string,
  vertexId: string,
  candidateEdgeId: string,
): boolean {
  const structureAtVertex = resolveStructureAtVertex(gameState, vertexId);
  if (
    structureAtVertex
    && (structureAtVertex.type === 'SETTLEMENT' || structureAtVertex.type === 'CITY')
    && structureAtVertex.ownerPlayerId !== playerId
  ) {
    return false;
  }

  if (
    structureAtVertex
    && (structureAtVertex.type === 'SETTLEMENT' || structureAtVertex.type === 'CITY')
    && structureAtVertex.ownerPlayerId === playerId
  ) {
    return true;
  }

  return Object.values(gameState.board.structuresById).some(
    (structure) =>
      structure.ownerPlayerId === playerId
      && structure.type === 'ROAD'
      && structure.edge?.id !== candidateEdgeId
      && isRoadTouchingVertex(structure, vertexId),
  );
}

function playerHasRoadTouchingVertex(gameState: GameState, playerId: string, vertexId: string): boolean {
  return Object.values(gameState.board.structuresById).some(
    (structure) =>
      structure.ownerPlayerId === playerId
      && structure.type === 'ROAD'
      && isRoadTouchingVertex(structure, vertexId),
  );
}

export function validateSettlementPlacement(
  gameState: GameState,
  playerId: string,
  vertexId: string,
): 'OCCUPIED' | 'DISTANCE_RULE' | 'ROAD_CONNECTION_REQUIRED' | null {
  if (resolveStructureAtVertex(gameState, vertexId)) {
    return 'OCCUPIED';
  }
  if (violatesDistanceRule(gameState, vertexId)) {
    return 'DISTANCE_RULE';
  }

  const playerStructures = Object.values(gameState.board.structuresById).filter(
    (s) => s.ownerPlayerId === playerId,
  );
  const hasExistingSettlement = playerStructures.some(
    (s) => s.type === 'SETTLEMENT' || s.type === 'CITY',
  );
  if (hasExistingSettlement && !playerHasRoadTouchingVertex(gameState, playerId, vertexId)) {
    return 'ROAD_CONNECTION_REQUIRED';
  }

  return null;
}

export function canUpgradeSettlementToCity(gameState: GameState, playerId: string, vertexId: string): boolean {
  const structureAtVertex = resolveStructureAtVertex(gameState, vertexId);
  return Boolean(
    structureAtVertex
    && structureAtVertex.ownerPlayerId === playerId
    && structureAtVertex.type === 'SETTLEMENT',
  );
}

export function canPlaceRoad(gameState: GameState, playerId: string, edgeId: string): boolean {
  const parsed = parseEdgeId(edgeId);
  if (parsed === null) {
    return false;
  }

  const [leftVertexId, rightVertexId] = parsed;
  return canConnectRoadFromVertex(gameState, playerId, leftVertexId, edgeId)
    || canConnectRoadFromVertex(gameState, playerId, rightVertexId, edgeId);
}

function buildResourceCollection(gameState: GameState, sum: number): Map<string, ResourceBundle> {
  const payouts = new Map<string, ResourceBundle>();

  for (const structure of Object.values(gameState.board.structuresById)) {
    if (!structure.vertex) {
      continue;
    }
    if (structure.type !== 'SETTLEMENT' && structure.type !== 'CITY') {
      continue;
    }

    const yieldCount = structure.type === 'CITY' ? 2 : 1;
    for (const tileRef of structure.adjacentTiles) {
      const tileId = tileRef.startsWith('t:') ? tileRef : 't:' + tileRef;
      const tile = gameState.board.tilesById[tileId];
      if (!tile || tile.numberToken !== sum || tile.resourceType === 'DESERT') {
        continue;
      }

      const current = payouts.get(structure.ownerPlayerId) ?? emptyResourceBundle();
      incrementResource(current, tile.resourceType, yieldCount);
      payouts.set(structure.ownerPlayerId, current);
    }
  }

  return payouts;
}

export class GamePersistenceService {
  private computeTurnEndsAtIso(fromMs: number = Date.now()): string {
    return new Date(fromMs + (FIXED_TURN_TIME_SEC * 1000)).toISOString();
  }

  private buildNextTurnState(gameState: GameState, nextPlayerIndex: number, startedAtIso: string): TurnState {
    const nextPlayerId = gameState.playerOrder[nextPlayerIndex];
    return {
      currentTurn: gameState.turn.currentTurn + 1,
      currentPlayerId: nextPlayerId,
      currentPlayerIndex: nextPlayerIndex,
      phase: 'ROLL',
      turnStartedAt: startedAtIso,
      turnEndsAt: this.computeTurnEndsAtIso(new Date(startedAtIso).getTime()),
      lastDiceRoll: null,
    };
  }

  private async generateUniqueRoomCode(): Promise<string> {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const roomCode = generateRoomCode();
      if (!(await gameSessionsRepository.roomCodeExists(roomCode))) {
        return roomCode;
      }
    }

    throw new Error('Unable to allocate a unique join code');
  }

  private async loadRequiredGame(identifier: string): Promise<GameState> {
    const gameState = await this.getGameState(identifier);
    if (!gameState) {
      throw new Error('Game ' + identifier + ' not found');
    }
    return gameState;
  }

  async createGame(
    displayName: string,
    config: GameConfig,
  ): Promise<{ gameState: GameState; playerId: string }> {
    const sanitizedConfig = sanitizeGameConfig(config);
    const gameId = generateId('game');
    const roomCode = await this.generateUniqueRoomCode();
    const playerId = generateId('p');
    const now = nowISO();

    await gameSessionsRepository.createGame({
      gameId,
      roomCode,
      createdBy: playerId,
      config: sanitizedConfig,
      startingResources: sanitizedConfig.startingResources,
    });

    const hostPlayer: PlayerState = {
      playerId,
      userId: playerId,
      displayName,
      avatarUrl: null,
      color: PLAYER_COLOR_PALETTE[0],
      isHost: true,
      resources: cloneResources(sanitizedConfig.startingResources),
      goals: [],
      stats: { ...DEFAULT_STATS },
      presence: { isConnected: true, lastSeenAt: now, connectionId: '' },
      joinedAt: now,
      updatedAt: now,
    };

    await playersRepository.createPlayer(gameId, hostPlayer);
    await gameSessionsRepository.updatePlayerOrder(gameId, [playerId]);

    const gameState = await this.loadRequiredGame(gameId);
    logger.info('Game ' + gameId + ' (room ' + roomCode + ') created by ' + displayName);
    return { gameState, playerId };
  }

  async joinGame(
    joinCode: string,
    displayName: string,
  ): Promise<{ gameState: GameState; playerId: string }> {
    const gameState = await this.loadRequiredGame(joinCode);
    const trimmedDisplayName = displayName.trim();
    if (!trimmedDisplayName) {
      throw new Error('Display name is required');
    }

    const matchingPlayerIds = findPlayerIdsByDisplayName(gameState, trimmedDisplayName);
    if (matchingPlayerIds.length > 1) {
      throw new Error('Display name is ambiguous in this game');
    }
    if (matchingPlayerIds.length === 1) {
      const matchedPlayerId = matchingPlayerIds[0];
      const rejoinState = await this.loadRequiredGame(gameState.gameId);
      logger.info('Player ' + trimmedDisplayName + ' rejoined game ' + rejoinState.gameId + ' as ' + matchedPlayerId);
      return { gameState: rejoinState, playerId: matchedPlayerId };
    }

    if (gameState.roomStatus !== 'waiting') {
      throw new Error('Game is not accepting new players');
    }
    if (gameState.playerOrder.length >= gameState.config.playerCount) {
      throw new Error('Game is full');
    }

    const playerId = generateId('p');
    const now = nowISO();
    const newPlayer: PlayerState = {
      playerId,
      userId: playerId,
      displayName: trimmedDisplayName,
      avatarUrl: null,
      color: PLAYER_COLOR_PALETTE[gameState.playerOrder.length % PLAYER_COLOR_PALETTE.length],
      isHost: false,
      resources: cloneResources(gameState.config.startingResources),
      goals: [],
      stats: { ...DEFAULT_STATS },
      presence: { isConnected: true, lastSeenAt: now, connectionId: '' },
      joinedAt: now,
      updatedAt: now,
    };

    await playersRepository.createPlayer(gameState.gameId, newPlayer);
    await gameSessionsRepository.updatePlayerOrder(gameState.gameId, [...gameState.playerOrder, playerId]);

    const updatedGameState = await this.loadRequiredGame(gameState.gameId);
    logger.info('Player ' + trimmedDisplayName + ' joined game ' + updatedGameState.gameId);
    return { gameState: updatedGameState, playerId };
  }

  async startGame(
    gameId: string,
    requestingPlayerId: string,
  ): Promise<GameState> {
    const gameState = await this.loadRequiredGame(gameId);
    if (gameState.createdBy !== requestingPlayerId) {
      throw new Error('Only the host can start the game');
    }
    if (gameState.roomStatus !== 'waiting') {
      throw new Error('Game already started');
    }
    if (gameState.playerOrder.length < 2) {
      throw new Error('Need at least 2 players');
    }

    const firstPlayerId = gameState.playerOrder[0];
    const firstPlayer = gameState.playersById[firstPlayerId];
    if (!firstPlayer) {
      throw new Error('First player not found');
    }

    const now = nowISO();
    const turn: TurnState = {
      currentTurn: 1,
      currentPlayerId: firstPlayerId,
      currentPlayerIndex: 0,
      phase: 'ROLL',
      turnStartedAt: now,
      turnEndsAt: this.computeTurnEndsAtIso(),
      lastDiceRoll: null,
    };

    const boardTiles = generateBoardTiles(gameState.config, now);

    await gameSessionsRepository.updateGameStatus(gameId, 'in_progress');
    await gameSessionsRepository.updateTurnState(gameId, turn);
    await boardRepository.initTiles(gameId, boardTiles);
    await turnsRepository.createTurn(gameId, {
      turnId: 'turn_1',
      turnNumber: 1,
      playerId: firstPlayerId,
      playerName: firstPlayer.displayName,
    });

    const updatedGameState = await this.loadRequiredGame(gameId);
    logger.info('Game ' + gameId + ' started. Turn 1: ' + firstPlayer.displayName);
    return updatedGameState;
  }

  async rollDice(
    gameId: string,
    playerId: string,
  ): Promise<GameState> {
    const gameState = await this.loadRequiredGame(gameId);
    if (gameState.roomStatus !== 'in_progress') {
      throw new Error('Cannot roll dice unless the game is in progress');
    }
    if (gameState.turn.currentPlayerId !== playerId) {
      throw new Error('Only the active player can roll dice');
    }
    if (gameState.turn.phase !== 'ROLL') {
      throw new Error('Dice can only be rolled during the ROLL phase');
    }
    if (gameState.turn.lastDiceRoll !== null) {
      throw new Error('Dice have already been rolled this turn');
    }

    const d1 = Math.floor(Math.random() * 6) + 1;
    const d2 = Math.floor(Math.random() * 6) + 1;
    const sum = d1 + d2;
    const rolledAt = nowISO();
    const diceRoll: DiceRoll = { d1Val: d1, d2Val: d2, sum, rolledAt };
    const turnId = 'turn_' + gameState.turn.currentTurn;

    await turnsRepository.recordDiceRoll(gameId, turnId, { d1, d2, sum });

    const payouts = buildResourceCollection(gameState, sum);
    for (const [targetPlayerId, bundle] of payouts.entries()) {
      const currentPlayer = gameState.playersById[targetPlayerId];
      if (!currentPlayer || resourceBundleSum(bundle) === 0) {
        continue;
      }

      const updatedResources = addResources(currentPlayer.resources, bundle);
      const updatedStats: PlayerStats = {
        ...currentPlayer.stats,
        totalResourcesCollected: currentPlayer.stats.totalResourcesCollected + resourceBundleSum(bundle),
      };

      await playersRepository.updateResources(gameId, targetPlayerId, updatedResources);
      await playersRepository.updateStats(gameId, targetPlayerId, updatedStats);
    }

    if (payouts.size > 0) {
      await turnsRepository.appendAction(gameId, turnId, {
        actionId: generateId('collect'),
        type: 'COLLECT_RESOURCES',
        timestamp: Timestamp.now(),
        result: {
          payoutsByPlayer: Object.fromEntries(
            Array.from(payouts.entries()).map(([targetPlayerId, bundle]) => [targetPlayerId, bundle]),
          ),
        },
      });
    }

    await gameSessionsRepository.updateTurnState(gameId, {
      ...gameState.turn,
      phase: 'ACTION',
      lastDiceRoll: diceRoll,
    });

    const updatedGameState = await this.loadRequiredGame(gameId);
    logger.info('Dice roll in game ' + gameId + ': ' + d1 + '+' + d2 + '=' + sum);
    return updatedGameState;
  }

  async buildStructure(
    gameId: string,
    playerId: string,
    request: { kind: BuildStructureKind; vertexId?: string; edgeId?: string },
  ): Promise<GameState> {
    const gameState = await this.loadRequiredGame(gameId);
    if (gameState.roomStatus !== 'in_progress') {
      throw new Error('Builds are only allowed during an active game');
    }
    if (gameState.turn.currentPlayerId !== playerId) {
      throw new Error('Only the active player can build');
    }
    if (gameState.turn.phase !== 'ACTION') {
      throw new Error('Builds are only allowed during the ACTION phase');
    }

    const player = gameState.playersById[playerId];
    if (!player) {
      throw new Error('Player not found');
    }

    const cost = BUILD_COSTS[request.kind];
    if (!hasResources(player.resources, cost)) {
      throw new Error('Insufficient resources');
    }

    const now = nowISO();
    const spent = resourceBundleSum(cost);
    const updatedResources = subtractResources(player.resources, cost);
    let updatedStats: PlayerStats = {
      ...player.stats,
      totalResourcesSpent: player.stats.totalResourcesSpent + spent,
    };
    let structureToPersist: StructureState;

    if (request.kind === 'SETTLEMENT') {
      if (!request.vertexId || !boardHasVertex(gameState, request.vertexId)) {
        throw new Error('Invalid settlement location');
      }
      const settlementPlacementError = validateSettlementPlacement(gameState, playerId, request.vertexId);
      if (settlementPlacementError === 'OCCUPIED') {
        throw new Error('That settlement location is already occupied');
      }
      if (settlementPlacementError === 'DISTANCE_RULE') {
        throw new Error('Settlements must be at least two roads apart');
      }
      if (settlementPlacementError === 'ROAD_CONNECTION_REQUIRED') {
        throw new Error('Settlements must connect to one of your existing roads');
      }
      if (settlementPlacementError !== null) {
        throw new Error('Invalid settlement location');
      }

      const vertex = buildVertexLocationFromId(request.vertexId);
      structureToPersist = {
        structureId: 'settlement:' + playerId + ':' + request.vertexId,
        ownerPlayerId: playerId,
        ownerName: player.displayName,
        ownerColor: player.color,
        type: 'SETTLEMENT',
        level: 1,
        locationType: 'VERTEX',
        vertex,
        edge: null,
        adjacentStructures: [],
        adjacentTiles: vertex.adjacentHexes.map((coord) => 't:' + coord.q + ',' + coord.r),
        builtAtTurn: gameState.turn.currentTurn,
        builtAt: now,
        cost,
        roadPath: null,
      };
      updatedStats = {
        ...updatedStats,
        settlementsBuilt: updatedStats.settlementsBuilt + 1,
        publicVP: updatedStats.publicVP + 1,
      };
    } else if (request.kind === 'CITY') {
      if (!request.vertexId || !boardHasVertex(gameState, request.vertexId)) {
        throw new Error('Invalid city location');
      }

      const existingStructure = resolveStructureAtVertex(gameState, request.vertexId);
      if (!existingStructure || !canUpgradeSettlementToCity(gameState, playerId, request.vertexId)) {
        throw new Error('You can only upgrade your own settlement');
      }

      structureToPersist = {
        ...existingStructure,
        ownerName: player.displayName,
        ownerColor: player.color,
        type: 'CITY',
        level: 2,
        builtAtTurn: gameState.turn.currentTurn,
        builtAt: now,
        cost,
      };
      updatedStats = {
        ...updatedStats,
        citiesBuilt: updatedStats.citiesBuilt + 1,
        publicVP: updatedStats.publicVP + 1,
      };
    } else {
      if (!request.edgeId || !boardHasEdge(gameState, request.edgeId)) {
        throw new Error('Invalid road location');
      }
      if (resolveStructureAtEdge(gameState, request.edgeId)) {
        throw new Error('That road location is already occupied');
      }
      if (!canPlaceRoad(gameState, playerId, request.edgeId)) {
        throw new Error('Road must connect to one of your existing roads or structures');
      }

      structureToPersist = {
        structureId: 'road:' + playerId + ':' + request.edgeId,
        ownerPlayerId: playerId,
        ownerName: player.displayName,
        ownerColor: player.color,
        type: 'ROAD',
        level: 1,
        locationType: 'EDGE',
        vertex: null,
        edge: buildEdgeLocationFromId(request.edgeId),
        adjacentStructures: [],
        adjacentTiles: [],
        builtAtTurn: gameState.turn.currentTurn,
        builtAt: now,
        cost,
        roadPath: null,
      };
      updatedStats = {
        ...updatedStats,
        roadsBuilt: updatedStats.roadsBuilt + 1,
      };
    }

    await boardRepository.upsertStructure(gameId, structureToPersist);
    await playersRepository.updateResources(gameId, playerId, updatedResources);
    await playersRepository.updateStats(gameId, playerId, updatedStats);
    await gameSessionsRepository.touchGame(gameId);
    await turnsRepository.appendAction(gameId, 'turn_' + gameState.turn.currentTurn, {
      actionId: generateId('act'),
      type: resolveBuildActionType(request.kind),
      timestamp: Timestamp.now(),
      structureId: structureToPersist.structureId,
      location: request.vertexId ? { vertexId: request.vertexId } : { edgeId: request.edgeId },
      cost,
    });

    const updatedGameState = await this.loadRequiredGame(gameId);
    logger.info('Build ' + request.kind + ' by ' + playerId + ' in game ' + gameId);
    return updatedGameState;
  }

  async bankTrade(
    gameId: string,
    playerId: string,
    giveResource: string,
    receiveResource: string,
  ): Promise<GameState> {
    const gameState = await this.loadRequiredGame(gameId);
    if (gameState.roomStatus !== 'in_progress') {
      throw new Error('Bank trade is only allowed during an active game');
    }
    if (gameState.turn.currentPlayerId !== playerId) {
      throw new Error('Only the active player can bank trade');
    }
    if (gameState.turn.phase !== 'ACTION') {
      throw new Error('Bank trade is only allowed during the ACTION phase');
    }
    if (!isResourceType(giveResource) || !isResourceType(receiveResource)) {
      throw new Error('Invalid resource type');
    }
    if (giveResource === receiveResource) {
      throw new Error('Give and receive resources must be different');
    }

    const player = gameState.playersById[playerId];
    if (!player) {
      throw new Error('Player not found');
    }
    if (player.resources[giveResource] < 4) {
      throw new Error('Need 4 ' + giveResource + ' to bank trade');
    }

    const updatedResources: ResourceBundle = {
      ...player.resources,
      [giveResource]: player.resources[giveResource] - 4,
      [receiveResource]: player.resources[receiveResource] + 1,
    };
    const updatedStats: PlayerStats = {
      ...player.stats,
      totalResourcesSpent: player.stats.totalResourcesSpent + 4,
    };

    await playersRepository.updateResources(gameId, playerId, updatedResources);
    await playersRepository.updateStats(gameId, playerId, updatedStats);
    await gameSessionsRepository.touchGame(gameId);
    await turnsRepository.appendAction(gameId, 'turn_' + gameState.turn.currentTurn, {
      actionId: generateId('bank'),
      type: 'COLLECT_RESOURCES',
      timestamp: Timestamp.now(),
      result: {
        trade: {
          giveResource,
          receiveResource,
        },
      },
    });

    const updatedGameState = await this.loadRequiredGame(gameId);
    logger.info('Bank trade by ' + playerId + ' in game ' + gameId);
    return updatedGameState;
  }

  async endTurn(
    gameId: string,
    playerId: string,
  ): Promise<GameState> {
    const gameState = await this.loadRequiredGame(gameId);
    if (gameState.roomStatus !== 'in_progress') {
      throw new Error('Cannot end turn unless the room is in progress');
    }
    if (gameState.turn.currentPlayerId !== playerId) {
      throw new Error('Only the active player can end the turn');
    }
    if (gameState.turn.lastDiceRoll === null) {
      throw new Error('You must roll dice before ending the turn');
    }
    if (gameState.turn.phase !== 'ACTION') {
      throw new Error('Turn can only end during the ACTION phase after rolling dice');
    }

    const currentTurnNum = gameState.turn.currentTurn;
    const turnId = 'turn_' + currentTurnNum;
    const now = nowISO();
    const currentIndex = gameState.turn.currentPlayerIndex ?? 0;
    const nextIndex = (currentIndex + 1) % gameState.playerOrder.length;
    const nextPlayerId = gameState.playerOrder[nextIndex];
    const nextPlayer = gameState.playersById[nextPlayerId];
    if (!nextPlayer) {
      throw new Error('Next player not found');
    }

    const startedAt = gameState.turn.turnStartedAt
      ? new Date(gameState.turn.turnStartedAt).getTime()
      : Date.now();
    const durationSec = Math.max(0, Math.round((Date.now() - startedAt) / 1000));

    await turnsRepository.completeTurn(gameId, turnId, durationSec);
    await playersRepository.updateStats(gameId, playerId, {
      ...gameState.playersById[playerId].stats,
      turnsPlayed: gameState.playersById[playerId].stats.turnsPlayed + 1,
    });

    const postTurnState = await this.loadRequiredGame(gameId);
    const evaluation = evaluateWinner(postTurnState);
    if (evaluation.winnerPlayerId) {
      return await this.finalizeGame(gameId, evaluation.winnerPlayerId, evaluation.reason);
    }

    const nextTurn = this.buildNextTurnState(gameState, nextIndex, now);

    await turnsRepository.createTurn(gameId, {
      turnId: 'turn_' + nextTurn.currentTurn,
      turnNumber: nextTurn.currentTurn,
      playerId: nextPlayerId,
      playerName: nextPlayer.displayName,
    });
    await gameSessionsRepository.updateTurnState(gameId, nextTurn);

    const updatedGameState = await this.loadRequiredGame(gameId);
    logger.info('Turn ' + currentTurnNum + ' ended. Turn ' + nextTurn.currentTurn + ': ' + nextPlayer.displayName);
    return updatedGameState;
  }

  async finalizeGame(
    gameId: string,
    winnerId: string,
    reason?: string,
  ): Promise<GameState> {
    await gameSessionsRepository.finalizeGame(gameId, winnerId);
    const gameState = await this.loadRequiredGame(gameId);
    logger.info('Game ' + gameId + ' finished. Winner: ' + winnerId + (reason ? ' (' + reason + ')' : ''));
    return gameState;
  }

  async appendChatMessage(
    gameId: string,
    playerId: string,
    rawMessage: string,
  ): Promise<GameState> {
    const gameState = await this.loadRequiredGame(gameId);
    const player = gameState.playersById[playerId];
    if (!player) {
      throw new Error('Player not found');
    }

    const message = rawMessage.trim();
    if (!message) {
      throw new Error('Chat message cannot be empty');
    }

    const chatMessage: ChatMessage = {
      id: generateId('chat'),
      senderId: playerId,
      senderName: player.displayName,
      message,
      timestamp: nowISO(),
    };

    await gameSessionsRepository.appendChatMessage(gameId, chatMessage);
    const updatedGameState = await this.loadRequiredGame(gameId);
    logger.info('Chat message by ' + playerId + ' in game ' + gameId);
    return updatedGameState;
  }

  async markPlayerConnected(gameId: string, playerId: string, connectionId: string): Promise<void> {
    const player = await playersRepository.getPlayer(gameId, playerId);
    if (!player) {
      return;
    }

    await playersRepository.updatePresence(gameId, playerId, {
      isConnected: true,
      lastSeenAt: nowISO(),
      connectionId,
    });
  }

  async markPlayerDisconnected(gameId: string, playerId: string, disconnectedConnectionId?: string): Promise<void> {
    const player = await playersRepository.getPlayer(gameId, playerId);
    if (!player) {
      return;
    }
    const activeConnectionId = player.presence?.connectionId ?? '';
    if (
      disconnectedConnectionId
      && activeConnectionId.length > 0
      && activeConnectionId !== disconnectedConnectionId
    ) {
      return;
    }

    await playersRepository.updatePresence(gameId, playerId, {
      isConnected: false,
      lastSeenAt: nowISO(),
      connectionId: '',
    });
  }

  async getGameState(identifier: string): Promise<GameState | null> {
    const normalizedIdentifier = identifier.trim();
    if (!normalizedIdentifier) {
      return null;
    }

    const candidates = Array.from(new Set([normalizedIdentifier, normalizedIdentifier.toUpperCase()]));
    for (const candidate of candidates) {
      const loadedGame = await this.loadGame(candidate);
      if (loadedGame) {
        return loadedGame;
      }
    }

    return null;
  }

  async advanceTurnIfExpired(gameId: string): Promise<GameState | null> {
    const gameState = await this.loadRequiredGame(gameId);
    if (gameState.roomStatus !== 'in_progress') {
      return null;
    }
    if (!gameState.turn.turnEndsAt) {
      return null;
    }

    const turnEndsAtMs = new Date(gameState.turn.turnEndsAt).getTime();
    if (!Number.isFinite(turnEndsAtMs) || Date.now() < turnEndsAtMs) {
      return null;
    }

    const currentPlayerId = gameState.turn.currentPlayerId;
    const currentIndex = gameState.turn.currentPlayerIndex ?? -1;
    if (!currentPlayerId || gameState.playerOrder.length === 0) {
      return null;
    }

    const nextIndex = (currentIndex + 1) % gameState.playerOrder.length;
    const nextPlayerId = gameState.playerOrder[nextIndex];
    const nextPlayer = gameState.playersById[nextPlayerId];
    if (!nextPlayer) {
      throw new Error('Next player not found');
    }

    const startedAt = gameState.turn.turnStartedAt
      ? new Date(gameState.turn.turnStartedAt).getTime()
      : Date.now();
    const durationSec = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
    const currentTurnNum = gameState.turn.currentTurn;
    const turnId = 'turn_' + currentTurnNum;
    const now = nowISO();
    const endedPlayer = gameState.playersById[currentPlayerId];

    await turnsRepository.completeTurn(gameId, turnId, durationSec);
    if (endedPlayer) {
      await playersRepository.updateStats(gameId, currentPlayerId, {
        ...endedPlayer.stats,
        turnsPlayed: endedPlayer.stats.turnsPlayed + 1,
      });
    }

    const postTurnState = await this.loadRequiredGame(gameId);
    const evaluation = evaluateWinner(postTurnState);
    if (evaluation.winnerPlayerId) {
      return await this.finalizeGame(gameId, evaluation.winnerPlayerId, evaluation.reason);
    }

    const nextTurn = this.buildNextTurnState(gameState, nextIndex, now);
    await turnsRepository.createTurn(gameId, {
      turnId: 'turn_' + nextTurn.currentTurn,
      turnNumber: nextTurn.currentTurn,
      playerId: nextPlayerId,
      playerName: nextPlayer.displayName,
    });
    await gameSessionsRepository.updateTurnState(gameId, nextTurn);

    const updatedGameState = await this.loadRequiredGame(gameId);
    logger.info('Turn ' + currentTurnNum + ' timed out. Turn ' + nextTurn.currentTurn + ': ' + nextPlayer.displayName);
    return updatedGameState;
  }

  async loadGame(identifier: string): Promise<GameState | null> {
    let gameDoc = await gameSessionsRepository.getGame(identifier);
    if (!gameDoc) {
      gameDoc = await gameSessionsRepository.getGameByRoomCode(identifier);
    }
    if (!gameDoc || gameDoc.isDeleted) {
      return null;
    }

    const [players, tilesById, structuresById, chatMessages] = await Promise.all([
      playersRepository.getPlayers(gameDoc.gameId),
      boardRepository.getTiles(gameDoc.gameId),
      boardRepository.getStructures(gameDoc.gameId),
      gameSessionsRepository.getChatMessages(gameDoc.gameId),
    ]);

    const playersById = Object.fromEntries(players.map((player) => [player.playerId, player]));

    return {
      gameId: gameDoc.gameId,
      roomCode: gameDoc.roomCode,
      roomStatus: gameDoc.status,
      createdBy: gameDoc.createdBy,
      createdAt: toIso(gameDoc.createdAt) ?? nowISO(),
      updatedAt: toIso(gameDoc.updatedAt) ?? nowISO(),
      isDeleted: gameDoc.isDeleted,
      winnerPlayerId: gameDoc.winnerPlayerId,
      config: sanitizeGameConfig(gameDoc.config),
      playerOrder: gameDoc.playerOrder,
      playersById,
      board: {
        tilesById,
        structuresById,
      },
      turn: {
        currentTurn: gameDoc.currentTurn,
        currentPlayerId: gameDoc.currentPlayerId,
        currentPlayerIndex: gameDoc.currentPlayerIndex,
        phase: gameDoc.phase,
        turnStartedAt: toIso(gameDoc.turnStartedAt),
        turnEndsAt: toIso(gameDoc.turnEndsAt),
        lastDiceRoll: gameDoc.lastDiceRoll
          ? {
              d1Val: gameDoc.lastDiceRoll.d1Val,
              d2Val: gameDoc.lastDiceRoll.d2Val,
              sum: gameDoc.lastDiceRoll.sum,
              rolledAt: toIso(gameDoc.lastDiceRoll.rolledAt) ?? nowISO(),
            }
          : null,
      },
      chatMessages: normalizeChatMessages(chatMessages),
    };
  }
}

export const gamePersistenceService = new GamePersistenceService();
