import type { Server, Socket } from 'socket.io';
import { CLIENT_EVENTS, SERVER_EVENTS, SocketEvents } from '../../shared/constants/socketEvents';
import type { GameState, PlayerStats, ResourceBundle } from '../../shared/types/domain';
import type {
  AckError,
  ClientToServerEvents,
  CreateGameRequest,
  JoinGameRequest,
  ServerToClientEvents,
  SocketAck,
  CreateGameAckData,
  JoinGameAckData,
  SimpleActionAckData,
} from '../../shared/types/socket';
import { GameEngine } from '../engine/GameEngine';
import type { Room } from '../sessions/Room';
import { roomManager } from '../sessions/roomManagerSingleton';
import { logger } from '../utils/logger';

type TypedSocket = Socket<ClientToServerEvents, ServerToClientEvents>;
type SimpleActionAck = (response: SocketAck<SimpleActionAckData>) => void;
type CreateGameAck = (response: SocketAck<CreateGameAckData>) => void;
type JoinGameAck = (response: SocketAck<JoinGameAckData>) => void;

const PLAYER_COLORS = ['#FF6B6B', '#4ECDC4', '#45B7D1', '#F7B801'] as const;

const EMPTY_RESOURCES: ResourceBundle = {
  CRYSTAL: 0,
  STONE: 0,
  BLOOM: 0,
  EMBER: 0,
  GOLD: 0,
};

const EMPTY_STATS: PlayerStats = {
  publicVP: 0,
  settlementsBuilt: 0,
  roadsBuilt: 0,
  totalResourcesCollected: 0,
  totalResourcesSpent: 0,
  longestRoadLength: 0,
  turnsPlayed: 0,
};

function cloneResources(): ResourceBundle {
  return { ...EMPTY_RESOURCES };
}

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
        color: PLAYER_COLORS[index % PLAYER_COLORS.length],
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

function rejectCreateOrJoin(
  socket: TypedSocket,
  ack: CreateGameAck | JoinGameAck,
  error: AckError,
): void {
  socket.emit(SERVER_EVENTS.ACTION_REJECTED, {
    code: error.code,
    message: error.message,
    details: error.details,
  });
  ack({ ok: false, error } as SocketAck<CreateGameAckData> | SocketAck<JoinGameAckData>);
}

function completeAction(
  io: Server<ClientToServerEvents, ServerToClientEvents>,
  gameId: string,
  gameState: GameState,
  ack: SimpleActionAck,
): void {
  io.to(gameId).emit(SERVER_EVENTS.GAME_STATE_UPDATE, gameState);
  ack({ ok: true, data: { gameState } });
}

function completeCreateOrJoin(
  io: Server<ClientToServerEvents, ServerToClientEvents>,
  gameId: string,
  payload: CreateGameAckData | JoinGameAckData,
  ack: CreateGameAck | JoinGameAck,
): void {
  io.to(gameId).emit(SERVER_EVENTS.GAME_STATE_UPDATE, payload.gameState);
  ack({ ok: true, data: payload } as SocketAck<CreateGameAckData> | SocketAck<JoinGameAckData>);
}

export function registerSocketHandlers(
  io: Server<ClientToServerEvents, ServerToClientEvents>,
): void {
  const gameEngine = new GameEngine();

  io.on(SocketEvents.Connection, (socket) => {
    const handshakeGameId = normalizeId((socket.handshake.auth as Record<string, unknown>).gameId)
      ?? normalizeId((socket.handshake.query as Record<string, unknown>).gameId);
    if (handshakeGameId !== null) {
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
      const playerCount = resolvePlayerCount((request.config as Record<string, unknown> | null)?.playerCount);

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

    socket.on(CLIENT_EVENTS.JOIN_GAME, (request, ack) => {
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

      const room = roomManager.getRoom(joinCode);
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
            playerOrder: joined.room.players.map((player) => player.id),
            playersById: Object.fromEntries(
              joined.room.players.map((player, index) => [
                player.id,
                {
                  playerId: player.id,
                  userId: player.id,
                  displayName: player.name,
                  avatarUrl: player.avatar,
                  color: PLAYER_COLORS[index % PLAYER_COLORS.length],
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
              startingResources: cloneResources(),
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
        ?? roomManager.initializeGameState(gameId, buildInitialGameStateFromRoom(room));

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

    socket.on(SocketEvents.Disconnect, () => {
      logger.info(`Client disconnected: ${socket.id}`);
    });
  });
}
