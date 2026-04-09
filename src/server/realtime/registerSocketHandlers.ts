import type { Server, Socket } from 'socket.io';
import { TradeManager } from '../engine/TradeManager';
import { defaultStartingResourceBundle } from '../../shared/constants/startingResources';
import { CLIENT_EVENTS, SERVER_EVENTS, SocketEvents } from '../../shared/constants/socketEvents';
import type { GameState, PlayerStats, ResourceBundle } from '../../shared/types/domain';
import type {
  AckError,
  ClientToServerEvents,
  CreateGameRequest,
  ServerToClientEvents,
  SocketAck,
  CreateGameAckData,
  JoinGameAckData,
  SimpleActionAckData,
} from '../../shared/types/socket';
import { resolvePlayerColor } from '../../shared/constants/playerColors';
import { GameEngine } from '../engine/GameEngine';
import { boardRepository } from '../persistence/boardRepository';
import { gameSessionsRepository } from '../persistence/gameSessionsRepository';
import { playersRepository } from '../persistence/playersRepository';
import type { Room } from '../sessions/Room';
import { roomManager } from '../sessions/roomManagerSingleton';
import { logger } from '../utils/logger';

type TypedSocket = Socket<ClientToServerEvents, ServerToClientEvents>;
type SimpleActionAck = (response: SocketAck<SimpleActionAckData>) => void;
type CreateOrJoinAck<T extends CreateGameAckData | JoinGameAckData> = (response: SocketAck<T>) => void;

const EMPTY_STATS: PlayerStats = {
  publicVP: 0,
  settlementsBuilt: 0,
  citiesBuilt: 0,
  roadsBuilt: 0,
  totalResourcesCollected: 0,
  totalResourcesSpent: 0,
  longestRoadLength: 0,
  turnsPlayed: 0,
};

function cloneStats(): PlayerStats {
  return { ...EMPTY_STATS };
}

function resolvePlayerCount(requestedCount: unknown): number | null {
  // Friday scope: allow only small player counts to simplify UI/room mgmt.
  if (typeof requestedCount !== 'number' || !Number.isFinite(requestedCount)) {
    return null;
  }
  const rounded = Math.trunc(requestedCount);
  if (rounded < 2 || rounded > 4) {
    return null;
  }
  return rounded;
}

function mapRoomResourcesToBundle(resources: {
  ember: number;
  gold: number;
  stone: number;
  bloom: number;
  crystal: number;
}): ResourceBundle {
  return {
    CRYSTAL: resources.crystal,
    STONE: resources.stone,
    BLOOM: resources.bloom,
    EMBER: resources.ember,
    GOLD: resources.gold,
  };
}

function normalizeId(rawValue: unknown): string | null {
  if (typeof rawValue === 'string') {
    const value = rawValue.trim();
    return value.length > 0 ? value : null;
  }

  if (Array.isArray(rawValue) && rawValue.length > 0) {
    return normalizeId(rawValue[0]);
  }

  return null;
}

function createFallbackCreateGameRequest(room: Room): CreateGameRequest {
  return {
    displayName: room.players[0]?.name ?? 'Host',
    config: {
      playerCount: room.maxPlayers,
      goalCount: 0,
      winRule: 'ALL_GOALS_COMPLETE',
      mapSeed: 0,
      mapSize: 'small',
      timerEnabled: false,
      turnTimeSec: null,
      allowReroll: false,
      startingResources: defaultStartingResourceBundle(),
    },
  };
}

function buildInitialGameStateFromRoom(room: Room, request: CreateGameRequest): GameState {
  const nowIso = new Date().toISOString();
  const playerOrder = room.players.map((player) => player.id);
  const playersById = Object.fromEntries(
    room.players.map((player, index) => [
      player.id,
      {
        playerId: player.id,
        userId: player.id,
        displayName: player.name,
        avatarUrl: player.avatar,
        color: resolvePlayerColor(room, index, null),
        isHost: player.id === room.hostId,
        resources: mapRoomResourcesToBundle(player.resources),
        goals: [],
        stats: cloneStats(),
        presence: {
          isConnected: true,
          lastSeenAt: nowIso,
          connectionId: '',
        },
        joinedAt: nowIso,
        updatedAt: nowIso,
      },
    ]),
  );

  return {
    gameId: room.id,
    roomCode: room.id,
    roomStatus: room.status,
    createdBy: room.hostId,
    createdAt: nowIso,
    updatedAt: nowIso,
    isDeleted: false,
    winnerPlayerId: null,
    config: {
      ...request.config,
    },
    playerOrder,
    playersById,
    board: {
      tilesById: {},
      structuresById: {},
    },
    setup: {
      inProgress: false,
      round: 1,
      currentPlayerIndex: 0,
      expectedPlacement: 'SETTLEMENT',
      lastPlacedSettlementVertexId: null,
    },
    trade: {
      activeOffer: null,
    },
    turn: {
      currentTurn: 0,
      currentPlayerId: null,
      currentPlayerIndex: null,
      phase: null,
      turnStartedAt: null,
      turnEndsAt: null,
      lastDiceRoll: null,
    },
  };
}

function resolvePlayerId(socket: TypedSocket, gameState: GameState): string | null {
  // Accept player identity from runtime socket data first, then auth/query fallback for reconnect compatibility.
  const socketPlayerId = normalizeId((socket.data as Record<string, unknown>).playerId);
  if (socketPlayerId !== null && gameState.playersById[socketPlayerId]) {
    return socketPlayerId;
  }

  const authPlayerId = normalizeId((socket.handshake.auth as Record<string, unknown>).playerId);
  if (authPlayerId !== null && gameState.playersById[authPlayerId]) {
    return authPlayerId;
  }

  const queryPlayerId = normalizeId((socket.handshake.query as Record<string, unknown>).playerId);
  if (queryPlayerId !== null && gameState.playersById[queryPlayerId]) {
    return queryPlayerId;
  }

  return null;
}

function resolveRawPlayerId(socket: TypedSocket): string | null {
  return normalizeId((socket.data as Record<string, unknown>).playerId)
    ?? normalizeId((socket.handshake.auth as Record<string, unknown>).playerId)
    ?? normalizeId((socket.handshake.query as Record<string, unknown>).playerId);
}

function rejectAction(socket: TypedSocket, ack: SimpleActionAck, error: AckError): void {
  socket.emit(SERVER_EVENTS.ACTION_REJECTED, {
    code: error.code,
    message: error.message,
    details: error.details,
  });
  ack({ ok: false, error });
}

function rejectCreateOrJoin<T extends CreateGameAckData | JoinGameAckData>(
  socket: TypedSocket,
  ack: CreateOrJoinAck<T>,
  error: AckError,
): void {
  socket.emit(SERVER_EVENTS.ACTION_REJECTED, {
    code: error.code,
    message: error.message,
    details: error.details,
  });
  ack({ ok: false, error });
}

function completeAction(
  io: Server<ClientToServerEvents, ServerToClientEvents>,
  gameId: string,
  gameState: GameState,
  ack: SimpleActionAck,
): void {
  // Single authoritative broadcast channel for all successful state changes.
  io.to(gameId).emit(SERVER_EVENTS.GAME_STATE_UPDATE, gameState);
  ack({ ok: true, data: { gameState } });
}

function completeCreateOrJoin<T extends CreateGameAckData | JoinGameAckData>(
  io: Server<ClientToServerEvents, ServerToClientEvents>,
  gameId: string,
  payload: T,
  ack: CreateOrJoinAck<T>,
): void {
  io.to(gameId).emit(SERVER_EVENTS.GAME_STATE_UPDATE, payload.gameState);
  ack({ ok: true, data: payload });
}

function toIsoString(value: unknown, fallback: string = new Date().toISOString()): string {
  if (typeof value === 'string' && value.trim()) {
    return value;
  }
  if (value && typeof value === 'object' && 'toDate' in value) {
    const maybeDate = (value as { toDate: () => Date }).toDate();
    if (maybeDate instanceof Date && !Number.isNaN(maybeDate.getTime())) {
      return maybeDate.toISOString();
    }
  }
  return fallback;
}

async function loadLatestGameStateSnapshot(roomCodeOrGameId: string): Promise<GameState | null> {
  const inMemory = roomManager.getGameState(roomCodeOrGameId);
  if (inMemory) {
    // Fast path: avoid persistence reads when state is already hot in memory.
    return inMemory;
  }

  try {
    const sessionDoc = await gameSessionsRepository.getGame(roomCodeOrGameId)
      ?? await gameSessionsRepository.getGameByRoomCode(roomCodeOrGameId);
    if (!sessionDoc) {
      return null;
    }

    const gameId = sessionDoc.gameId;
    const roomCode = sessionDoc.roomCode;
    const players = await playersRepository.getPlayers(gameId);
    const tilesById = await boardRepository.getTiles(gameId);
    const structuresById = await boardRepository.getStructures(gameId);
    const nowIso = new Date().toISOString();

    const gameState: GameState = {
      gameId,
      roomCode,
      roomStatus: sessionDoc.status,
      createdBy: sessionDoc.createdBy,
      createdAt: toIsoString(sessionDoc.createdAt, nowIso),
      updatedAt: toIsoString(sessionDoc.updatedAt, nowIso),
      isDeleted: sessionDoc.isDeleted,
      winnerPlayerId: sessionDoc.winnerPlayerId,
      config: sessionDoc.config,
      playerOrder: sessionDoc.playerOrder,
      playersById: Object.fromEntries(
        players.map((player) => [
          player.playerId,
          {
            ...player,
            joinedAt: toIsoString(player.joinedAt, nowIso),
            updatedAt: toIsoString(player.updatedAt, nowIso),
            presence: {
              ...player.presence,
              lastSeenAt: toIsoString(player.presence.lastSeenAt, nowIso),
            },
          },
        ]),
      ),
      board: {
        tilesById,
        structuresById,
      },
      setup: {
        // Setup/trade defaults are included in recovered snapshots so payload shape always matches the shared contract.
        inProgress: false,
        round: 1,
        currentPlayerIndex: sessionDoc.currentPlayerIndex ?? 0,
        expectedPlacement: 'SETTLEMENT',
        lastPlacedSettlementVertexId: null,
      },
      trade: {
        activeOffer: null,
      },
      turn: {
        currentTurn: sessionDoc.currentTurn,
        currentPlayerId: sessionDoc.currentPlayerId,
        currentPlayerIndex: sessionDoc.currentPlayerIndex,
        phase: sessionDoc.phase,
        turnStartedAt: sessionDoc.turnStartedAt ? toIsoString(sessionDoc.turnStartedAt, nowIso) : null,
        turnEndsAt: sessionDoc.turnEndsAt ? toIsoString(sessionDoc.turnEndsAt, nowIso) : null,
        lastDiceRoll: sessionDoc.lastDiceRoll
          ? {
              d1Val: sessionDoc.lastDiceRoll.d1Val,
              d2Val: sessionDoc.lastDiceRoll.d2Val,
              sum: sessionDoc.lastDiceRoll.sum,
              rolledAt: toIsoString(sessionDoc.lastDiceRoll.rolledAt, nowIso),
            }
          : null,
      },
    };

    roomManager.setHydratedGameState(gameState);
    return gameState;
  } catch (error) {
    logger.warn('Failed to load game state snapshot from Firestore fallback.', error);
    return null;
  }
}

export function registerSocketHandlers(
  io: Server<ClientToServerEvents, ServerToClientEvents>,
): void {
  const gameEngine = new GameEngine();
  const tradeManager = new TradeManager();

  io.on(SocketEvents.Connection, (socket) => {
    const handshakeGameId = normalizeId((socket.handshake.auth as Record<string, unknown>).gameId)
      ?? normalizeId((socket.handshake.query as Record<string, unknown>).gameId);
    if (handshakeGameId !== null) {
      // Join room early when provided so server push events can flow immediately.
      socket.join(handshakeGameId);
    }

    const handshakePlayerId = normalizeId((socket.handshake.auth as Record<string, unknown>).playerId)
      ?? normalizeId((socket.handshake.query as Record<string, unknown>).playerId);
    if (handshakePlayerId !== null) {
      (socket.data as Record<string, unknown>).playerId = handshakePlayerId;
    }

    logger.info(`Client connected: ${socket.id}`);

    socket.on(CLIENT_EVENTS.CREATE_GAME, (request, ack) => {
      const displayName = typeof request.displayName === 'string' ? request.displayName.trim() : '';
      const playerCount = resolvePlayerCount(request.config.playerCount);

      if (!displayName) {
        rejectCreateOrJoin(socket, ack, { code: 'INVALID_CONFIGURATION', message: 'Display name is required.' });
        return;
      }
      if (playerCount === null) {
        rejectCreateOrJoin(socket, ack, { code: 'INVALID_CONFIGURATION', message: 'Invalid player count.' });
        return;
      }

      const { room, player } = roomManager.createRoom(displayName, playerCount);
      const gameId = room.id.toUpperCase();
      room.id = gameId;

      // Normalize stored room key casing.
      // RoomManager currently stores by generated id, so we need the room keyed with upper-case id.
      // Easiest for Friday: create a second entry if necessary.
      // (This keeps join codes predictable for the UI.)
      if (roomManager.getRoom(gameId) === null) {
        // If the manager stored it under a different casing, best-effort: remove old + re-add by touching internal map is not possible.
        // For Friday slice, generated ids are already uppercase; this should be a no-op.
      }

      socket.join(gameId);
      (socket.data as Record<string, unknown>).playerId = player.id;

      const gameState = roomManager.initializeGameState(gameId, buildInitialGameStateFromRoom(room, request));
      if (!gameState) {
        rejectCreateOrJoin(socket, ack, { code: 'INTERNAL_ERROR', message: 'Unable to initialize game state.' });
        return;
      }

      const payload: CreateGameAckData = {
        clientId: socket.id,
        playerId: player.id,
        role: 'PLAYER',
        gameState,
      };
      completeCreateOrJoin(io, gameId, payload, ack);
    });

    socket.on(CLIENT_EVENTS.JOIN_GAME, async (request, ack) => {
      const joinCode = typeof request.joinCode === 'string' ? request.joinCode.trim().toUpperCase() : '';
      const displayName = typeof request.displayName === 'string' ? request.displayName.trim() : '';

      if (!joinCode) {
        rejectCreateOrJoin(socket, ack, { code: 'INVALID_CONFIGURATION', message: 'Join code is required.' });
        return;
      }
      if (!displayName) {
        rejectCreateOrJoin(socket, ack, { code: 'INVALID_CONFIGURATION', message: 'Display name is required.' });
        return;
      }

      let room = roomManager.getRoom(joinCode);
      if (!room) {
        // Reload from persistence when process memory does not have this room.
        await loadLatestGameStateSnapshot(joinCode);
        room = roomManager.getRoom(joinCode);
      }
      if (!room) {
        rejectCreateOrJoin(socket, ack, { code: 'SESSION_NOT_FOUND', message: 'Session not found for JOIN_GAME.' });
        return;
      }
      if (room.status !== 'waiting') {
        rejectCreateOrJoin(socket, ack, { code: 'INVALID_PHASE', message: 'Cannot join a game that has already started.' });
        return;
      }
      if (room.players.length >= room.maxPlayers) {
        rejectCreateOrJoin(socket, ack, { code: 'PLAYER_CAPACITY_EXCEEDED', message: 'Room is full.' });
        return;
      }

      const joined = roomManager.joinRoom(joinCode, displayName);
      if (!joined) {
        rejectCreateOrJoin(socket, ack, { code: 'INTERNAL_ERROR', message: 'Unable to join room.' });
        return;
      }

      socket.join(joinCode);
      (socket.data as Record<string, unknown>).playerId = joined.player.id;

      const existingGameState = roomManager.getGameState(joinCode);
      const gameState = roomManager.setGameState(
        joinCode,
        existingGameState
          ? {
            ...existingGameState,
            updatedAt: new Date().toISOString(),
            // Recompute order/indexed players from room source of truth after join.
            playerOrder: joined.room.players.map((player) => player.id),
            playersById: Object.fromEntries(
              joined.room.players.map((player, index) => [
                player.id,
                {
                  playerId: player.id,
                  userId: player.id,
                  displayName: player.name,
                  avatarUrl: player.avatar,
                  color: resolvePlayerColor(joined.room, index, existingGameState?.playersById[player.id]),
                  isHost: player.id === joined.room.hostId,
                  resources: mapRoomResourcesToBundle(player.resources),
                  goals: [],
                  stats: cloneStats(),
                  presence: {
                    isConnected: true,
                    lastSeenAt: new Date().toISOString(),
                    connectionId: '',
                  },
                  joinedAt: new Date().toISOString(),
                  updatedAt: new Date().toISOString(),
                },
              ]),
            ),
          }
          : buildInitialGameStateFromRoom(joined.room, {
            displayName: joined.room.players[0]?.name ?? 'Host',
            // If somehow joining before host initialized state, keep config minimal.
            config: {
              playerCount: joined.room.maxPlayers,
              goalCount: 0,
              winRule: 'ALL_GOALS_COMPLETE',
              mapSeed: 0,
              mapSize: 'small',
              timerEnabled: false,
              turnTimeSec: null,
              allowReroll: false,
              startingResources: defaultStartingResourceBundle(),
            },
          }),
      );

      if (!gameState) {
        rejectCreateOrJoin(socket, ack, { code: 'INTERNAL_ERROR', message: 'Unable to store game state for JOIN_GAME.' });
        return;
      }

      const payload: JoinGameAckData = {
        clientId: socket.id,
        playerId: joined.player.id,
        role: request.role,
        gameState,
      };
      completeCreateOrJoin(io, joinCode, payload, ack);
    });

    socket.on(CLIENT_EVENTS.START_GAME, (request, ack) => {
      const normalizedGameId = normalizeId(request.gameId);
      if (normalizedGameId === null) {
        rejectAction(socket, ack, {
          code: 'INVALID_CONFIGURATION',
          message: 'Game id is required.',
        });
        return;
      }
      const gameId = normalizedGameId.toUpperCase();

      socket.join(gameId);

      const room = roomManager.getRoom(gameId);
      if (!room) {
        rejectAction(socket, ack, {
          code: 'SESSION_NOT_FOUND',
          message: 'Session not found for START_GAME.',
        });
        return;
      }

      const requesterPlayerId = resolveRawPlayerId(socket);
      if (requesterPlayerId === null) {
        rejectAction(socket, ack, {
          code: 'SESSION_NOT_FOUND',
          message: 'Player session not found for START_GAME.',
        });
        return;
      }

      if (requesterPlayerId !== room.hostId) {
        rejectAction(socket, ack, {
          code: 'NOT_HOST',
          message: 'Only the host can start the game.',
        });
        return;
      }

      const existingGameState = roomManager.getGameState(gameId);
      const gameState = existingGameState
        ?? roomManager.initializeGameState(gameId, buildInitialGameStateFromRoom(room, createFallbackCreateGameRequest(room)));

      if (!gameState) {
        rejectAction(socket, ack, {
          code: 'SESSION_NOT_FOUND',
          message: 'Unable to initialize game state for START_GAME.',
        });
        return;
      }

      const engineResult = gameEngine.startGame(gameState);
      if (!engineResult.ok) {
        rejectAction(socket, ack, engineResult.error);
        return;
      }

      const updatedGameState: GameState = {
        ...engineResult.gameState,
        updatedAt: new Date().toISOString(),
      };

      if (!roomManager.setGameState(gameId, updatedGameState)) {
        rejectAction(socket, ack, {
          code: 'SESSION_NOT_FOUND',
          message: 'Unable to store game state for START_GAME.',
        });
        return;
      }

      room.status = updatedGameState.roomStatus;

      completeAction(io, gameId, updatedGameState, ack);
    });

    socket.on(CLIENT_EVENTS.ROLL_DICE, (request, ack) => {
      const normalizedGameId = normalizeId(request.gameId);
      if (normalizedGameId === null) {
        rejectAction(socket, ack, {
          code: 'INVALID_CONFIGURATION',
          message: 'Game id is required.',
        });
        return;
      }
      const gameId = normalizedGameId.toUpperCase();

      const gameState = roomManager.getGameState(gameId);
      if (!gameState) {
        rejectAction(socket, ack, {
          code: 'SESSION_NOT_FOUND',
          message: 'Session not found for ROLL_DICE.',
        });
        return;
      }

      const playerId = resolvePlayerId(socket, gameState);
      if (playerId === null) {
        rejectAction(socket, ack, {
          code: 'SESSION_NOT_FOUND',
          message: 'Player session not found for ROLL_DICE.',
        });
        return;
      }

      const engineResult = gameEngine.rollDice(gameState, playerId);
      if (!engineResult.ok) {
        rejectAction(socket, ack, engineResult.error);
        return;
      }

      const updatedGameState: GameState = {
        ...engineResult.gameState,
        updatedAt: new Date().toISOString(),
      };

      if (!roomManager.setGameState(gameId, updatedGameState)) {
        rejectAction(socket, ack, {
          code: 'SESSION_NOT_FOUND',
          message: 'Unable to store game state for ROLL_DICE.',
        });
        return;
      }

      completeAction(io, gameId, updatedGameState, ack);
    });

    const rejectUntilEngineReady = (ack: SimpleActionAck, actionName: string): void => {
      // Contract branch is intentionally present so client/server stay in sync
      // on event surface while gameplay managers are integrated incrementally.
      rejectAction(socket, ack, {
        code: 'INVALID_PHASE',
        message: `${actionName} is wired in realtime contracts but not yet implemented by the gameplay engine.`,
      });
    };

    socket.on(CLIENT_EVENTS.PLACE_SETUP_SETTLEMENT, (_request, ack) => {
      rejectUntilEngineReady(ack, CLIENT_EVENTS.PLACE_SETUP_SETTLEMENT);
    });

    socket.on(CLIENT_EVENTS.PLACE_SETUP_ROAD, (_request, ack) => {
      rejectUntilEngineReady(ack, CLIENT_EVENTS.PLACE_SETUP_ROAD);
    });

    socket.on(CLIENT_EVENTS.BUILD_ROAD, (_request, ack) => {
      rejectUntilEngineReady(ack, CLIENT_EVENTS.BUILD_ROAD);
    });

    socket.on(CLIENT_EVENTS.BUILD_SETTLEMENT, (_request, ack) => {
      rejectUntilEngineReady(ack, CLIENT_EVENTS.BUILD_SETTLEMENT);
    });

    socket.on(CLIENT_EVENTS.UPGRADE_SETTLEMENT, (_request, ack) => {
      rejectUntilEngineReady(ack, CLIENT_EVENTS.UPGRADE_SETTLEMENT);
    });

    socket.on(CLIENT_EVENTS.OFFER_TRADE, (_request, ack) => {
      rejectUntilEngineReady(ack, CLIENT_EVENTS.OFFER_TRADE);
    });

    socket.on(CLIENT_EVENTS.ACCEPT_TRADE, (_request, ack) => {
      rejectUntilEngineReady(ack, CLIENT_EVENTS.ACCEPT_TRADE);
    });

    socket.on(CLIENT_EVENTS.REJECT_TRADE, (_request, ack) => {
      rejectUntilEngineReady(ack, CLIENT_EVENTS.REJECT_TRADE);
    });

    socket.on(CLIENT_EVENTS.CANCEL_TRADE, (_request, ack) => {
      rejectUntilEngineReady(ack, CLIENT_EVENTS.CANCEL_TRADE);
    });

    socket.on(CLIENT_EVENTS.BANK_TRADE, (request, ack) => {
      const normalizedGameId = normalizeId(request.gameId);
      if (normalizedGameId === null) {
        rejectAction(socket, ack, {
          code: 'INVALID_CONFIGURATION',
          message: 'Game id is required.',
        });
        return;
      }
      const gameId = normalizedGameId.toUpperCase();

      const gameState = roomManager.getGameState(gameId);
      if (!gameState) {
        rejectAction(socket, ack, {
          code: 'SESSION_NOT_FOUND',
          message: 'Session not found for BANK_TRADE.',
        });
        return;
      }

      const playerId = resolvePlayerId(socket, gameState);
      if (playerId === null) {
        rejectAction(socket, ack, {
          code: 'SESSION_NOT_FOUND',
          message: 'Player session not found for BANK_TRADE.',
        });
        return;
      }

      const result = tradeManager.bankTrade(
        gameState,
        playerId,
        request.giveResource,
        request.receiveResource,
      );

      if (!result.ok) {
        rejectAction(socket, ack, result.error);
        return;
      }

      const updatedGameState: GameState = {
        ...result.gameState,
        updatedAt: new Date().toISOString(),
      };

      if (!roomManager.setGameState(gameId, updatedGameState)) {
        rejectAction(socket, ack, {
          code: 'SESSION_NOT_FOUND',
          message: 'Unable to store game state for BANK_TRADE.',
        });
        return;
      }

      completeAction(io, gameId, updatedGameState, ack);
    });

    socket.on(CLIENT_EVENTS.END_TURN, (request, ack) => {
      const normalizedGameId = normalizeId(request.gameId);
      if (normalizedGameId === null) {
        rejectAction(socket, ack, {
          code: 'INVALID_CONFIGURATION',
          message: 'Game id is required.',
        });
        return;
      }
      const gameId = normalizedGameId.toUpperCase();

      const gameState = roomManager.getGameState(gameId);
      if (!gameState) {
        rejectAction(socket, ack, {
          code: 'SESSION_NOT_FOUND',
          message: 'Session not found for END_TURN.',
        });
        return;
      }

      const playerId = resolvePlayerId(socket, gameState);
      if (playerId === null) {
        rejectAction(socket, ack, {
          code: 'SESSION_NOT_FOUND',
          message: 'Player session not found for END_TURN.',
        });
        return;
      }

      const engineResult = gameEngine.endTurn(gameState, playerId);
      if (!engineResult.ok) {
        rejectAction(socket, ack, engineResult.error);
        return;
      }

      const updatedGameState: GameState = {
        ...engineResult.gameState,
        updatedAt: new Date().toISOString(),
      };

      if (!roomManager.setGameState(gameId, updatedGameState)) {
        rejectAction(socket, ack, {
          code: 'SESSION_NOT_FOUND',
          message: 'Unable to store game state for END_TURN.',
        });
        return;
      }

      completeAction(io, gameId, updatedGameState, ack);
    });

    socket.on(CLIENT_EVENTS.SYNC_GAME_STATE, async (request, ack) => {
      const normalizedGameId = normalizeId(request.gameId);
      if (normalizedGameId === null) {
        rejectAction(socket, ack, {
          code: 'INVALID_CONFIGURATION',
          message: 'Game id is required.',
        });
        return;
      }
      const gameId = normalizedGameId.toUpperCase();

      const gameState = await loadLatestGameStateSnapshot(gameId);
      if (!gameState) {
        rejectAction(socket, ack, {
          code: 'SESSION_NOT_FOUND',
          message: 'Session not found for SYNC_GAME_STATE.',
        });
        return;
      }

      const playerId = resolvePlayerId(socket, gameState);
      if (playerId === null) {
        rejectAction(socket, ack, {
          code: 'SESSION_NOT_FOUND',
          message: 'Player session not found for SYNC_GAME_STATE.',
        });
        return;
      }

      socket.join(gameId);
      // Returns/broadcasts the latest authoritative snapshot for refresh recovery.
      completeAction(io, gameId, gameState, ack);
    });

    socket.on(SocketEvents.Disconnect, () => {
      logger.info(`Client disconnected: ${socket.id}`);
    });
  });
}
