import type { Server, Socket } from 'socket.io';
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
  SendChatMessageRequest,
} from '../../shared/types/socket';
import { resolvePlayerColor } from '../../shared/constants/playerColors';
import { GameEngine } from '../engine/GameEngine';
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
  if (typeof ack !== 'function') {
    return;
  }
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
  if (typeof ack !== 'function') {
    return;
  }
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

export function registerSocketHandlers(
  io: Server<ClientToServerEvents, ServerToClientEvents>,
): void {
  const gameEngine = new GameEngine();
  
  // Verify constant is loaded on server start
  const chatEventName = CLIENT_EVENTS.SEND_CHAT_MESSAGE || 'SEND_CHAT_MESSAGE';
  logger.info(`[SocketInit] Registering server handlers. Chat event string: "${chatEventName}"`);

  io.on(SocketEvents.Connection, (socket) => {
    const handshakeGameId = normalizeId((socket.handshake.auth as Record<string, unknown>).gameId)
      ?? normalizeId((socket.handshake.query as Record<string, unknown>).gameId);
    if (handshakeGameId !== null) {
      const room = handshakeGameId.toUpperCase();
      socket.join(room);
      logger.info(`Socket ${socket.id} joined room: ${room}`);
    }

    const handshakePlayerId = normalizeId((socket.handshake.auth as Record<string, unknown>).playerId)
      ?? normalizeId((socket.handshake.query as Record<string, unknown>).playerId);
    if (handshakePlayerId !== null) {
      (socket.data as Record<string, unknown>).playerId = handshakePlayerId;
    }
    logger.info(`Client connected: ${socket.id} (Handshake GameID: ${handshakeGameId})`);

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
        chatMessages: gameState.chatMessages,
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
        chatMessages: gameState.chatMessages,
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
        chatMessages: gameState.chatMessages,
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

    socket.on(CLIENT_EVENTS.SYNC_GAME_STATE, (request, ack) => {
      const normalizedGameId = normalizeId((request as any).gameId);
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

      const incomingState = (request as any).gameState;
      const updatedGameState: GameState = {
        ...incomingState,
        chatMessages: gameState.chatMessages,
        updatedAt: new Date().toISOString(),
      };

      if (!roomManager.setGameState(gameId, updatedGameState)) {
        rejectAction(socket, ack, {
          code: 'SESSION_NOT_FOUND',
          message: 'Unable to store game state for SYNC_GAME_STATE.',
        });
        return;
      }

      completeAction(io, gameId, updatedGameState, ack);
    });

    socket.on(SocketEvents.Disconnect, () => {
      logger.info(`Client disconnected: ${socket.id}`);
    });

    socket.on(chatEventName, (request: SendChatMessageRequest, ack) => {
      logger.info(`[Server] Received SEND_CHAT_MESSAGE from ${socket.id}:`, request);
      try {
        const normalizedGameId = normalizeId(request.gameId);
        if (normalizedGameId === null) {
          rejectAction(socket, ack, { code: 'INVALID_CONFIGURATION', message: 'Game id is required.' });
          return;
        }
        const gameId = normalizedGameId.toUpperCase();

        const message = request.message ? String(request.message).trim() : '';
        const senderPlayerId = resolveRawPlayerId(socket);

        if (!senderPlayerId) {
          logger.warn(`[Chat] Rejecting message: Player ID not found for socket ${socket.id}.`);
          rejectAction(socket, ack, { code: 'INTERNAL_ERROR', message: 'Player ID not found for chat.' });
          return;
        }
        if (!message) {
          rejectAction(socket, ack, { code: 'INVALID_CONFIGURATION', message: 'Chat message cannot be empty.' });
          return;
        }

        const gameState = roomManager.getGameState(gameId);
        logger.debug(`[Chat] Game state retrieved for game ${gameId}. Current messages: ${gameState?.chatMessages?.length ?? 0}`);
        if (!gameState) {
          rejectAction(socket, ack, { code: 'SESSION_NOT_FOUND', message: 'Game session not found.' });
          return;
        }

        // Diagnostic: Ensure array exists on the state object before pushing
        if (!gameState.chatMessages) {
          logger.warn(`[Chat] chatMessages array was missing for game ${gameId}. Initializing now.`);
          gameState.chatMessages = [];
        }

        const sender = gameState.playersById[senderPlayerId];
        if (!sender) {
          rejectAction(socket, ack, { code: 'INTERNAL_ERROR', message: 'Sender player not found in game state.' });
          return;
        }

        const newChatMessage = {
          id: `chat-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`, // Simple unique ID
          senderId: senderPlayerId,
          senderName: sender.displayName,
          message,
          timestamp: new Date().toISOString(),
        };
        logger.info(`[Chat] Adding new message from ${sender.displayName} (${senderPlayerId}): "${message}"`);
        gameState.chatMessages.push(newChatMessage);
        roomManager.setGameState(gameId, gameState); // Persist the updated state
        completeAction(io, gameId, gameState, ack);
      } catch (err) {
        logger.error('[Chat] Unhandled error in SEND_CHAT_MESSAGE handler:', err);
        rejectAction(socket, ack, { code: 'INTERNAL_ERROR', message: 'Internal server error while processing chat message.' });
      }
    });
  });
}
