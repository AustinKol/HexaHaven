import type {
  ChatMessage,
  GameState,
  GameConfig,
  PlayerState,
  ResourceBundle,
  ResourceType,
  TurnState,
  StructureState,
  DiceRoll,
  PlayerStats,
} from '../../shared/types/domain';
import { gameSessionsRepository } from './gameSessionsRepository';
import { playersRepository } from './playersRepository';
import { boardRepository } from './boardRepository';
import { turnsRepository } from './turnsRepository';
import { gameStateStore } from '../sessions/GameStateStore';
import { logger } from '../utils/logger';

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

const PLAYER_COLORS = ['#E74C3C', '#3498DB', '#2ECC71', '#F39C12'];
const RESOURCE_TYPES: ResourceType[] = ['CRYSTAL', 'STONE', 'BLOOM', 'EMBER', 'GOLD'];

function isResourceType(value: string): value is ResourceType {
  return RESOURCE_TYPES.includes(value as ResourceType);
}

function generateId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

function generateRoomCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

function nowISO(): string {
  return new Date().toISOString();
}

function mergeChatMessages(...messageGroups: Array<ChatMessage[] | undefined>): ChatMessage[] {
  const messagesById = new Map<string, ChatMessage>();

  for (const messages of messageGroups) {
    for (const message of messages ?? []) {
      messagesById.set(message.id, message);
    }
  }

  return Array.from(messagesById.values()).sort((left, right) => (
    left.timestamp.localeCompare(right.timestamp) || left.id.localeCompare(right.id)
  ));
}

// ─── Service ──────────────────────────────────────────────────────────────────

export class GamePersistenceService {
  // ───────────────────────────────────────────── CREATE GAME ─────────────────

  /**
   * Creates a new game in Firestore, adds the host as the first player,
   * and caches the resulting GameState in memory.
   * Throws on Firestore failure — caller must NOT mutate local state.
   */
  async createGame(
    displayName: string,
    config: GameConfig,
  ): Promise<{ gameState: GameState; playerId: string }> {
    const gameId = generateId('game');
    const roomCode = generateRoomCode();
    const playerId = generateId('p');
    const now = nowISO();

    const startingResources = config.startingResources ?? DEFAULT_RESOURCES;

    // 1. Write game session to Firestore
    await gameSessionsRepository.createGame({
      gameId,
      roomCode,
      createdBy: playerId,
      config,
      startingResources,
    });

    // 2. Write host player to Firestore
    const hostPlayer: PlayerState = {
      playerId,
      userId: playerId,
      displayName,
      avatarUrl: null,
      color: PLAYER_COLORS[0],
      isHost: true,
      resources: { ...startingResources },
      goals: [],
      stats: { ...DEFAULT_STATS },
      presence: { isConnected: true, lastSeenAt: now, connectionId: '' },
      joinedAt: now,
      updatedAt: now,
    };
    await playersRepository.createPlayer(gameId, hostPlayer);
    await gameSessionsRepository.updatePlayerOrder(gameId, [playerId]);

    // 3. Build in-memory GameState
    const gameState: GameState = {
      gameId,
      roomCode,
      roomStatus: 'waiting',
      createdBy: playerId,
      createdAt: now,
      updatedAt: now,
      isDeleted: false,
      winnerPlayerId: null,
      config,
      playerOrder: [playerId],
      playersById: { [playerId]: hostPlayer },
      board: { tilesById: {}, structuresById: {} },
      turn: {
        currentTurn: 0,
        currentPlayerId: null,
        currentPlayerIndex: null,
        phase: null,
        turnStartedAt: null,
        turnEndsAt: null,
        lastDiceRoll: null,
      },
      chatMessages: [],
    };

    // 4. Cache only after all writes succeed
    gameStateStore.set(gameId, gameState);
    logger.info(`Game ${gameId} (room ${roomCode}) created by ${displayName}`);
    return { gameState, playerId };
  }

  // ───────────────────────────────────────────── JOIN GAME ───────────────────

  async joinGame(
    joinCode: string,
    displayName: string,
  ): Promise<{ gameState: GameState; playerId: string }> {
    // Look up game by room code — try cache first, then Firestore
    const gameState = await this.getGameState(joinCode);
    if (!gameState) {
      throw new Error(`No game found with join code ${joinCode}`);
    }
    if (gameState.roomStatus !== 'waiting') {
      throw new Error('Game is not accepting new players');
    }
    const playerCount = Object.keys(gameState.playersById).length;
    if (playerCount >= gameState.config.playerCount) {
      throw new Error('Game is full');
    }

    const playerId = generateId('p');
    const now = nowISO();

    const newPlayer: PlayerState = {
      playerId,
      userId: playerId,
      displayName,
      avatarUrl: null,
      color: PLAYER_COLORS[playerCount],
      isHost: false,
      resources: { ...(gameState.config.startingResources ?? DEFAULT_RESOURCES) },
      goals: [],
      stats: { ...DEFAULT_STATS },
      presence: { isConnected: true, lastSeenAt: now, connectionId: '' },
      joinedAt: now,
      updatedAt: now,
    };

    // 1. Write player to Firestore
    await playersRepository.createPlayer(gameState.gameId, newPlayer);

    // 2. Update player order in Firestore
    const newOrder = [...gameState.playerOrder, playerId];
    await gameSessionsRepository.updatePlayerOrder(gameState.gameId, newOrder);

    // 3. Update in-memory state only after writes succeed
    gameState.playersById[playerId] = newPlayer;
    gameState.playerOrder = newOrder;
    gameState.updatedAt = now;
    gameStateStore.set(gameState.gameId, gameState);

    logger.info(`Player ${displayName} joined game ${gameState.gameId}`);
    return { gameState, playerId };
  }

  // ───────────────────────────────────────────── START GAME ─────────────────

  async startGame(
    gameId: string,
    requestingPlayerId: string,
  ): Promise<GameState> {
    const gameState = gameStateStore.get(gameId);
    if (!gameState) throw new Error(`Game ${gameId} not found`);
    if (gameState.createdBy !== requestingPlayerId) throw new Error('Only the host can start the game');
    if (gameState.roomStatus !== 'waiting') throw new Error('Game already started');
    if (Object.keys(gameState.playersById).length < 2) throw new Error('Need at least 2 players');

    const now = nowISO();
    const firstPlayerId = gameState.playerOrder[0];

    const turn: TurnState = {
      currentTurn: 1,
      currentPlayerId: firstPlayerId,
      currentPlayerIndex: 0,
      phase: 'ROLL',
      turnStartedAt: now,
      turnEndsAt: gameState.config.timerEnabled && gameState.config.turnTimeSec
        ? new Date(Date.now() + gameState.config.turnTimeSec * 1000).toISOString()
        : null,
      lastDiceRoll: null,
    };

    // 1. Update game status in Firestore
    await gameSessionsRepository.updateGameStatus(gameId, 'in_progress');

    // 2. Write turn state to Firestore
    await gameSessionsRepository.updateTurnState(gameId, turn);

    // 3. Create first turn document in Firestore
    const firstPlayerName = gameState.playersById[firstPlayerId].displayName;
    await turnsRepository.createTurn(gameId, {
      turnId: `turn_1`,
      turnNumber: 1,
      playerId: firstPlayerId,
      playerName: firstPlayerName,
    });

    // 4. Update in-memory state only after all writes succeed
    gameState.roomStatus = 'in_progress';
    gameState.turn = turn;
    gameState.updatedAt = now;
    gameStateStore.set(gameId, gameState);

    logger.info(`Game ${gameId} started. Turn 1: ${firstPlayerName}`);
    return gameState;
  }

  // ───────────────────────────────────────── SETUP PLACEMENT ────────────────

  async setupPlacement(
    gameId: string,
    playerId: string,
    structure: StructureState,
  ): Promise<GameState> {
    const gameState = gameStateStore.get(gameId);
    if (!gameState) throw new Error(`Game ${gameId} not found`);

    // 1. Write structure to Firestore
    await boardRepository.upsertStructure(gameId, structure);

    // 2. Update player stats in Firestore
    const player = gameState.playersById[playerId];
    const updatedStats: PlayerStats = {
      ...player.stats,
      settlementsBuilt: structure.type === 'SETTLEMENT'
        ? player.stats.settlementsBuilt + 1
        : player.stats.settlementsBuilt,
      roadsBuilt: structure.type === 'ROAD'
        ? player.stats.roadsBuilt + 1
        : player.stats.roadsBuilt,
    };
    await playersRepository.updateStats(gameId, playerId, updatedStats);

    // 3. Update in-memory state
    gameState.board.structuresById[structure.structureId] = structure;
    gameState.playersById[playerId].stats = updatedStats;
    gameState.updatedAt = nowISO();
    gameStateStore.set(gameId, gameState);

    logger.info(`Setup placement: ${structure.type} by ${playerId} in game ${gameId}`);
    return gameState;
  }

  // ───────────────────────────────────────────── ROLL DICE ──────────────────

  async rollDice(
    gameId: string,
    playerId: string,
  ): Promise<GameState> {
    const gameState = gameStateStore.get(gameId);
    if (!gameState) throw new Error(`Game ${gameId} not found`);
    if (gameState.turn.currentPlayerId !== playerId) throw new Error('Not the active player');
    if (gameState.turn.phase !== 'ROLL') throw new Error('Not in ROLL phase');

    const d1 = Math.floor(Math.random() * 6) + 1;
    const d2 = Math.floor(Math.random() * 6) + 1;
    const sum = d1 + d2;
    const now = nowISO();

    const diceRoll: DiceRoll = { d1Val: d1, d2Val: d2, sum, rolledAt: now };
    const turnId = `turn_${gameState.turn.currentTurn}`;

    // 1. Record dice roll in turn document
    await turnsRepository.recordDiceRoll(gameId, turnId, { d1, d2, sum });

    // 2. Update turn state on game session
    const updatedTurn: TurnState = {
      ...gameState.turn,
      phase: 'ACTION',
      lastDiceRoll: diceRoll,
    };
    await gameSessionsRepository.updateTurnState(gameId, updatedTurn);

    // 3. Update in-memory state
    gameState.turn = updatedTurn;
    gameState.updatedAt = now;
    gameStateStore.set(gameId, gameState);

    logger.info(`Dice roll in game ${gameId}: ${d1}+${d2}=${sum}`);
    return gameState;
  }

  // ──────────────────────────────────────── BUILD STRUCTURE ─────────────────

  async buildStructure(
    gameId: string,
    playerId: string,
    structure: StructureState,
    cost: ResourceBundle,
  ): Promise<GameState> {
    const gameState = gameStateStore.get(gameId);
    if (!gameState) throw new Error(`Game ${gameId} not found`);
    if (gameState.turn.currentPlayerId !== playerId) throw new Error('Not the active player');
    if (gameState.turn.phase !== 'ACTION') throw new Error('Not in ACTION phase');

    const player = gameState.playersById[playerId];

    // Compute new resources after spending cost
    const newResources: ResourceBundle = {
      CRYSTAL: player.resources.CRYSTAL - cost.CRYSTAL,
      STONE: player.resources.STONE - cost.STONE,
      BLOOM: player.resources.BLOOM - cost.BLOOM,
      EMBER: player.resources.EMBER - cost.EMBER,
      GOLD: player.resources.GOLD - cost.GOLD,
    };

    // 1. Write structure to Firestore
    await boardRepository.upsertStructure(gameId, structure);

    // 2. Deduct resources in Firestore
    await playersRepository.updateResources(gameId, playerId, newResources);

    // 3. Update stats in Firestore
    const updatedStats: PlayerStats = {
      ...player.stats,
      settlementsBuilt: structure.type === 'SETTLEMENT'
        ? player.stats.settlementsBuilt + 1
        : player.stats.settlementsBuilt,
      roadsBuilt: structure.type === 'ROAD'
        ? player.stats.roadsBuilt + 1
        : player.stats.roadsBuilt,
      totalResourcesSpent: player.stats.totalResourcesSpent
        + cost.CRYSTAL + cost.STONE + cost.BLOOM + cost.EMBER + cost.GOLD,
    };
    await playersRepository.updateStats(gameId, playerId, updatedStats);

    // 4. Log action in turn document
    const turnId = `turn_${gameState.turn.currentTurn}`;
    const actionType = structure.type === 'ROAD' ? 'BUILD_ROAD' : 'BUILD_SETTLEMENT';
    await turnsRepository.appendAction(gameId, turnId, {
      actionId: generateId('act'),
      type: actionType,
      timestamp: new Date() as unknown as FirebaseFirestore.Timestamp,
      structureId: structure.structureId,
      cost,
    });

    // 5. Update in-memory state
    gameState.board.structuresById[structure.structureId] = structure;
    gameState.playersById[playerId].resources = newResources;
    gameState.playersById[playerId].stats = updatedStats;
    gameState.updatedAt = nowISO();
    gameStateStore.set(gameId, gameState);

    logger.info(`Build ${structure.type} by ${playerId} in game ${gameId}`);
    return gameState;
  }

  // ────────────────────────────────────────────── TRADE ─────────────────────

  async trade(
    gameId: string,
    givingPlayerId: string,
    receivingPlayerId: string,
    offered: ResourceBundle,
    requested: ResourceBundle,
  ): Promise<GameState> {
    const gameState = gameStateStore.get(gameId);
    if (!gameState) throw new Error(`Game ${gameId} not found`);

    const giver = gameState.playersById[givingPlayerId];
    const receiver = gameState.playersById[receivingPlayerId];
    if (!giver || !receiver) throw new Error('Player not found');

    const giverResources: ResourceBundle = {
      CRYSTAL: giver.resources.CRYSTAL - offered.CRYSTAL + requested.CRYSTAL,
      STONE: giver.resources.STONE - offered.STONE + requested.STONE,
      BLOOM: giver.resources.BLOOM - offered.BLOOM + requested.BLOOM,
      EMBER: giver.resources.EMBER - offered.EMBER + requested.EMBER,
      GOLD: giver.resources.GOLD - offered.GOLD + requested.GOLD,
    };

    const receiverResources: ResourceBundle = {
      CRYSTAL: receiver.resources.CRYSTAL + offered.CRYSTAL - requested.CRYSTAL,
      STONE: receiver.resources.STONE + offered.STONE - requested.STONE,
      BLOOM: receiver.resources.BLOOM + offered.BLOOM - requested.BLOOM,
      EMBER: receiver.resources.EMBER + offered.EMBER - requested.EMBER,
      GOLD: receiver.resources.GOLD + offered.GOLD - requested.GOLD,
    };

    // 1. Update giver resources in Firestore
    await playersRepository.updateResources(gameId, givingPlayerId, giverResources);

    // 2. Update receiver resources in Firestore
    await playersRepository.updateResources(gameId, receivingPlayerId, receiverResources);

    // 3. Update in-memory state
    gameState.playersById[givingPlayerId].resources = giverResources;
    gameState.playersById[receivingPlayerId].resources = receiverResources;
    gameState.updatedAt = nowISO();
    gameStateStore.set(gameId, gameState);

    logger.info(`Trade between ${givingPlayerId} and ${receivingPlayerId} in game ${gameId}`);
    return gameState;
  }

  async bankTrade(
    gameId: string,
    playerId: string,
    giveResource: string,
    receiveResource: string,
  ): Promise<GameState> {
    const gameState = await this.getGameState(gameId);
    if (!gameState) throw new Error(`Game ${gameId} not found`);
    if (gameState.roomStatus !== 'in_progress') throw new Error('Bank trade is only allowed during an active game');
    if (gameState.turn.currentPlayerId !== playerId) throw new Error('Only the active player can bank trade');
    if (gameState.turn.phase !== 'ACTION') throw new Error('Bank trade is only allowed during the ACTION phase');
    if (!isResourceType(giveResource) || !isResourceType(receiveResource)) {
      throw new Error('Invalid resource type');
    }
    if (giveResource === receiveResource) {
      throw new Error('Give and receive resources must be different');
    }

    const player = gameState.playersById[playerId];
    if (!player) throw new Error('Player not found');

    const currentAmount = player.resources[giveResource] ?? 0;
    if (currentAmount < 4) {
      throw new Error(`Need 4 ${giveResource} to bank trade`);
    }

    const updatedResources: ResourceBundle = {
      ...player.resources,
      [giveResource]: currentAmount - 4,
      [receiveResource]: (player.resources[receiveResource] ?? 0) + 1,
    };

    await playersRepository.updateResources(gameState.gameId, playerId, updatedResources);

    gameState.playersById[playerId] = {
      ...player,
      resources: updatedResources,
      updatedAt: nowISO(),
    };
    gameState.updatedAt = nowISO();
    gameStateStore.set(gameState.gameId, gameState);

    logger.info(`Bank trade by ${playerId} in game ${gameState.gameId}`);
    return gameState;
  }

  // ───────────────────────────────────────────── END TURN ───────────────────

  async endTurn(
    gameId: string,
    playerId: string,
  ): Promise<GameState> {
    const gameState = gameStateStore.get(gameId);
    if (!gameState) throw new Error(`Game ${gameId} not found`);
    if (gameState.turn.currentPlayerId !== playerId) throw new Error('Not the active player');

    const currentTurnNum = gameState.turn.currentTurn;
    const turnId = `turn_${currentTurnNum}`;
    const now = nowISO();

    // Calculate turn duration
    const startedAt = gameState.turn.turnStartedAt
      ? new Date(gameState.turn.turnStartedAt).getTime()
      : Date.now();
    const durationSec = Math.round((Date.now() - startedAt) / 1000);

    // Advance to next player
    const currentIndex = gameState.turn.currentPlayerIndex ?? 0;
    const nextIndex = (currentIndex + 1) % gameState.playerOrder.length;
    const nextPlayerId = gameState.playerOrder[nextIndex];
    const nextTurnNum = currentTurnNum + 1;

    // Update current player stats
    const currentPlayer = gameState.playersById[playerId];
    const updatedStats: PlayerStats = {
      ...currentPlayer.stats,
      turnsPlayed: currentPlayer.stats.turnsPlayed + 1,
    };

    const nextTurn: TurnState = {
      currentTurn: nextTurnNum,
      currentPlayerId: nextPlayerId,
      currentPlayerIndex: nextIndex,
      phase: 'ROLL',
      turnStartedAt: now,
      turnEndsAt: gameState.config.timerEnabled && gameState.config.turnTimeSec
        ? new Date(Date.now() + gameState.config.turnTimeSec * 1000).toISOString()
        : null,
      lastDiceRoll: null,
    };

    // 1. Complete current turn in Firestore
    await turnsRepository.completeTurn(gameId, turnId, durationSec);

    // 2. Update player stats in Firestore
    await playersRepository.updateStats(gameId, playerId, updatedStats);

    // 3. Create next turn document in Firestore
    const nextPlayerName = gameState.playersById[nextPlayerId].displayName;
    await turnsRepository.createTurn(gameId, {
      turnId: `turn_${nextTurnNum}`,
      turnNumber: nextTurnNum,
      playerId: nextPlayerId,
      playerName: nextPlayerName,
    });

    // 4. Update turn state on game session in Firestore
    await gameSessionsRepository.updateTurnState(gameId, nextTurn);

    // 5. Update in-memory state
    gameState.playersById[playerId].stats = updatedStats;
    gameState.turn = nextTurn;
    gameState.updatedAt = now;
    gameStateStore.set(gameId, gameState);

    logger.info(`Turn ${currentTurnNum} ended. Turn ${nextTurnNum}: ${nextPlayerName}`);
    return gameState;
  }

  // ──────────────────────────────────────── FINALIZE GAME ───────────────────

  async finalizeGame(
    gameId: string,
    winnerId: string,
  ): Promise<GameState> {
    const gameState = gameStateStore.get(gameId);
    if (!gameState) throw new Error(`Game ${gameId} not found`);

    // 1. Finalize in Firestore (transactional — idempotent)
    await gameSessionsRepository.finalizeGame(gameId, winnerId);

    // 2. Complete the current turn if one is in progress
    const turnId = `turn_${gameState.turn.currentTurn}`;
    const startedAt = gameState.turn.turnStartedAt
      ? new Date(gameState.turn.turnStartedAt).getTime()
      : Date.now();
    const durationSec = Math.round((Date.now() - startedAt) / 1000);
    await turnsRepository.completeTurn(gameId, turnId, durationSec).catch(() => {
      // Turn may not exist if game ends during setup — safe to ignore
    });

    // 3. Update in-memory state
    gameState.roomStatus = 'finished';
    gameState.winnerPlayerId = winnerId;
    gameState.updatedAt = nowISO();
    gameStateStore.set(gameId, gameState);

    logger.info(`Game ${gameId} finished. Winner: ${winnerId}`);
    return gameState;
  }

  async appendChatMessage(
    gameId: string,
    playerId: string,
    rawMessage: string,
  ): Promise<GameState> {
    const gameState = await this.getGameState(gameId);
    if (!gameState) throw new Error(`Game ${gameId} not found`);

    const player = gameState.playersById[playerId];
    if (!player) throw new Error('Player not found');

    const message = rawMessage.trim();
    if (!message) throw new Error('Chat message cannot be empty');

    const chatMessage: ChatMessage = {
      id: generateId('chat'),
      senderId: playerId,
      senderName: player.displayName,
      message,
      timestamp: nowISO(),
    };

    await gameSessionsRepository.appendChatMessage(gameState.gameId, chatMessage);

    gameState.chatMessages = [...(gameState.chatMessages ?? []), chatMessage];
    gameState.updatedAt = nowISO();
    gameStateStore.set(gameState.gameId, gameState);

    logger.info(`Chat message by ${playerId} in game ${gameState.gameId}`);
    return gameState;
  }

  async getGameState(identifier: string): Promise<GameState | null> {
    const normalizedIdentifier = identifier.trim();
    if (!normalizedIdentifier) {
      return null;
    }

    const candidates = Array.from(new Set([normalizedIdentifier, normalizedIdentifier.toUpperCase()]));
    for (const candidate of candidates) {
      const cachedById = gameStateStore.get(candidate);
      if (cachedById) {
        return cachedById;
      }

      const cachedByRoomCode = gameStateStore.findByRoomCode(candidate);
      if (cachedByRoomCode) {
        return cachedByRoomCode;
      }
    }

    for (const candidate of candidates) {
      const loadedGame = await this.loadGame(candidate);
      if (loadedGame) {
        return loadedGame;
      }
    }

    return null;
  }

  // ──────────────────────────────────────── LOAD GAME ───────────────────────

  /**
   * Reconstructs a full GameState from Firestore documents.
   * Looks up the game by roomCode if the input looks like a room code (6 chars),
   * otherwise treats it as a gameId.
   */
  async loadGame(identifier: string): Promise<GameState | null> {
    // Resolve the game session doc
    let gameDoc = await gameSessionsRepository.getGame(identifier);
    if (!gameDoc) {
      gameDoc = await gameSessionsRepository.getGameByRoomCode(identifier);
    }
    if (!gameDoc || gameDoc.isDeleted) return null;

    const gameId = gameDoc.gameId;

    // Fetch all subcollections in parallel
    const [players, tilesById, structuresById, chatMessages] = await Promise.all([
      playersRepository.getPlayers(gameId),
      boardRepository.getTiles(gameId),
      boardRepository.getStructures(gameId),
      gameSessionsRepository.getChatMessages(gameId),
    ]);

    // Build playersById map
    const playersById: Record<string, PlayerState> = {};
    for (const p of players) {
      playersById[p.playerId] = p;
    }

    // Convert Firestore timestamps to ISO strings
    const toISO = (ts: FirebaseFirestore.Timestamp | null | undefined): string | null => {
      if (!ts) return null;
      if (typeof (ts as { toDate?: () => Date }).toDate === 'function') {
        return (ts as unknown as { toDate(): Date }).toDate().toISOString();
      }
      return String(ts);
    };

    const lastDiceRoll: GameState['turn']['lastDiceRoll'] = gameDoc.lastDiceRoll
      ? {
          d1Val: gameDoc.lastDiceRoll.d1Val,
          d2Val: gameDoc.lastDiceRoll.d2Val,
          sum: gameDoc.lastDiceRoll.sum,
          rolledAt: toISO(gameDoc.lastDiceRoll.rolledAt) ?? nowISO(),
        }
      : null;

    const gameState: GameState = {
      gameId: gameDoc.gameId,
      roomCode: gameDoc.roomCode,
      roomStatus: gameDoc.status,
      createdBy: gameDoc.createdBy,
      createdAt: toISO(gameDoc.createdAt) ?? nowISO(),
      updatedAt: toISO(gameDoc.updatedAt) ?? nowISO(),
      isDeleted: gameDoc.isDeleted,
      winnerPlayerId: gameDoc.winnerPlayerId,
      config: gameDoc.config,
      playerOrder: gameDoc.playerOrder,
      playersById,
      board: { tilesById, structuresById },
      turn: {
        currentTurn: gameDoc.currentTurn,
        currentPlayerId: gameDoc.currentPlayerId,
        currentPlayerIndex: gameDoc.currentPlayerIndex,
        phase: gameDoc.phase,
        turnStartedAt: toISO(gameDoc.turnStartedAt),
        turnEndsAt: toISO(gameDoc.turnEndsAt),
        lastDiceRoll,
      },
      chatMessages: mergeChatMessages(gameDoc.chatMessages, chatMessages),
    };

    // Cache the loaded state
    gameStateStore.set(gameId, gameState);
    logger.info(`Game ${gameId} loaded from Firestore`);
    return gameState;
  }
}

export const gamePersistenceService = new GamePersistenceService();
