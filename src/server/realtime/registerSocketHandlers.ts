import type { Server, Socket } from 'socket.io';
import { CLIENT_EVENTS, SERVER_EVENTS, SocketEvents } from '../../shared/constants/socketEvents';
import type { GameState } from '../../shared/types/domain';
import type {
  AckError,
  BankTradeRequest,
  BuildStructureRequest,
  ClientToServerEvents,
  CreateGameAckData,
  CreateGameRequest,
  EndTurnRequest,
  HydrateSessionRequest,
  JoinGameAckData,
  JoinGameRequest,
  RollDiceRequest,
  SendChatMessageRequest,
  ServerToClientEvents,
  SimpleActionAckData,
  SocketAck,
  StartGameRequest,
} from '../../shared/types/socket';
import { gamePersistenceService } from '../persistence/GamePersistenceService';
import { logger } from '../utils/logger';

type TypedServer = Server<ClientToServerEvents, ServerToClientEvents>;
type TypedSocket = Socket<ClientToServerEvents, ServerToClientEvents>;
type SimpleActionAck = (response: SocketAck<SimpleActionAckData>) => void;
type CreateOrJoinAck<T extends CreateGameAckData | JoinGameAckData> = (response: SocketAck<T>) => void;

interface SocketSession {
  gameId: string;
  roomCode: string;
  playerId: string;
}

const socketPlayerMap = new Map<string, SocketSession>();

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

function resolvePlayerCount(requestedCount: unknown): number | null {
  if (typeof requestedCount !== 'number' || !Number.isFinite(requestedCount)) {
    return null;
  }

  const rounded = Math.trunc(requestedCount);
  if (rounded < 2 || rounded > 4) {
    return null;
  }

  return rounded;
}

function buildAckError(
  code: AckError['code'],
  message: string,
  details?: Record<string, unknown>,
): AckError {
  const error: AckError = { code, message };
  if (details !== undefined) {
    error.details = details;
  }
  return error;
}

function resolveErrorCode(message: string): AckError['code'] {
  const normalized = message.toLowerCase();

  if (
    normalized.includes('display name')
    || normalized.includes('join code')
    || normalized.includes('game id is required')
    || normalized.includes('invalid player count')
    || normalized.includes('invalid resource type')
    || normalized.includes('invalid road location')
    || normalized.includes('invalid settlement location')
    || normalized.includes('invalid city location')
    || normalized.includes('occupied')
    || normalized.includes('upgrade your own settlement')
    || normalized.includes('connect to one of your existing roads or structures')
    || normalized.includes('must be different')
    || normalized.includes('cannot be empty')
    || normalized.includes('need at least 2 players')
  ) {
    return 'INVALID_CONFIGURATION';
  }

  if (normalized.includes('full')) {
    return 'PLAYER_CAPACITY_EXCEEDED';
  }

  if (normalized.includes('host')) {
    return 'NOT_HOST';
  }

  if (normalized.includes('active player')) {
    return 'NOT_ACTIVE_PLAYER';
  }

  if (
    normalized.includes('phase')
    || normalized.includes('active game')
    || normalized.includes('already started')
    || normalized.includes('accepting new players')
  ) {
    return 'INVALID_PHASE';
  }

  if (normalized.includes('need 4') || normalized.includes('insufficient')) {
    return 'INSUFFICIENT_RESOURCES';
  }

  if (
    normalized.includes('not found')
    || normalized.includes('no game found')
    || normalized.includes('game not found')
    || normalized.includes('player not found')
  ) {
    return 'SESSION_NOT_FOUND';
  }

  return 'INTERNAL_ERROR';
}

function emitActionRejected(socket: TypedSocket, error: AckError): void {
  socket.emit(SERVER_EVENTS.ACTION_REJECTED, {
    code: error.code,
    message: error.message,
    details: error.details,
  });
}

function rejectAction(
  socket: TypedSocket,
  ack: SimpleActionAck,
  code: AckError['code'],
  message: string,
  details?: Record<string, unknown>,
): void {
  const error = buildAckError(code, message, details);
  emitActionRejected(socket, error);
  if (typeof ack === 'function') {
    ack({ ok: false, error });
  }
}

function rejectCreateOrJoin<T extends CreateGameAckData | JoinGameAckData>(
  socket: TypedSocket,
  ack: CreateOrJoinAck<T>,
  code: AckError['code'],
  message: string,
  details?: Record<string, unknown>,
): void {
  const error = buildAckError(code, message, details);
  emitActionRejected(socket, error);
  if (typeof ack === 'function') {
    ack({ ok: false, error });
  }
}

function completeAction(
  io: TypedServer,
  gameId: string,
  gameState: GameState,
  ack: SimpleActionAck,
): void {
  io.to(gameId).emit(SERVER_EVENTS.GAME_STATE_UPDATE, gameState);
  if (typeof ack === 'function') {
    ack({ ok: true, data: { gameState } });
  }
}

function completeCreateOrJoin<T extends CreateGameAckData | JoinGameAckData>(
  io: TypedServer,
  gameId: string,
  payload: T,
  ack: CreateOrJoinAck<T>,
): void {
  io.to(gameId).emit(SERVER_EVENTS.GAME_STATE_UPDATE, payload.gameState);
  if (typeof ack === 'function') {
    ack({ ok: true, data: payload });
  }
}

function completeSync(socket: TypedSocket, ack: SimpleActionAck, gameState: GameState): void {
  socket.emit(SERVER_EVENTS.GAME_STATE_UPDATE, gameState);
  if (typeof ack === 'function') {
    ack({ ok: true, data: { gameState } });
  }
}

function rememberSocketSession(
  socket: TypedSocket,
  gameState: GameState,
  playerId: string,
): SocketSession {
  const existingSession = socketPlayerMap.get(socket.id);
  if (existingSession && existingSession.gameId !== gameState.gameId) {
    socket.leave(existingSession.gameId);
  }

  const session: SocketSession = {
    gameId: gameState.gameId,
    roomCode: gameState.roomCode,
    playerId,
  };

  socket.join(gameState.gameId);
  socketPlayerMap.set(socket.id, session);

  const socketData = socket.data as Record<string, unknown>;
  socketData.gameId = gameState.gameId;
  socketData.roomCode = gameState.roomCode;
  socketData.playerId = playerId;
  void gamePersistenceService.markPlayerConnected(gameState.gameId, playerId, socket.id);

  return session;
}

function sessionMatchesIdentifier(session: SocketSession, identifier: string): boolean {
  return identifier === session.gameId || identifier.toUpperCase() === session.roomCode;
}

function resolveRawPlayerId(socket: TypedSocket): string | null {
  return socketPlayerMap.get(socket.id)?.playerId
    ?? normalizeId((socket.data as Record<string, unknown>).playerId)
    ?? normalizeId((socket.handshake.auth as Record<string, unknown>).playerId)
    ?? normalizeId((socket.handshake.query as Record<string, unknown>).playerId);
}

async function resolveSocketSession(
  socket: TypedSocket,
  requestedIdentifier: string,
): Promise<SocketSession | null> {
  const mappedSession = socketPlayerMap.get(socket.id);
  if (mappedSession && sessionMatchesIdentifier(mappedSession, requestedIdentifier)) {
    return mappedSession;
  }

  const playerId = resolveRawPlayerId(socket);
  if (playerId === null) {
    return null;
  }

  const gameState = await gamePersistenceService.getGameState(requestedIdentifier);
  if (!gameState || !gameState.playersById[playerId]) {
    return null;
  }

  return rememberSocketSession(socket, gameState, playerId);
}

async function restoreSocketSessionFromHandshake(socket: TypedSocket): Promise<void> {
  const handshakeIdentifier = normalizeId((socket.handshake.auth as Record<string, unknown>).gameId)
    ?? normalizeId((socket.handshake.query as Record<string, unknown>).gameId);

  if (handshakeIdentifier === null) {
    return;
  }

  try {
    const session = await resolveSocketSession(socket, handshakeIdentifier);
    if (session !== null) {
      const gameState = await gamePersistenceService.getGameState(session.gameId);
      if (gameState) {
        socket.emit(SERVER_EVENTS.GAME_STATE_UPDATE, gameState);
      }
      logger.info(`Socket ${socket.id} restored session for ${session.gameId}`);
    }
  } catch (error) {
    logger.warn(`Failed to restore socket session for ${socket.id}: ${(error as Error).message}`);
  }
}

export function registerSocketHandlers(io: TypedServer): void {
  io.on(SocketEvents.Connection, (socket: TypedSocket) => {
    logger.info(`Client connected: ${socket.id}`);
    void restoreSocketSessionFromHandshake(socket);

    socket.on(
      CLIENT_EVENTS.CREATE_GAME,
      async (
        request: CreateGameRequest,
        ack: CreateOrJoinAck<CreateGameAckData>,
      ) => {
        const displayName = typeof request.displayName === 'string' ? request.displayName.trim() : '';
        const config = request.config;
        const playerCount = resolvePlayerCount(config?.playerCount);

        if (!displayName) {
          rejectCreateOrJoin(socket, ack, 'INVALID_CONFIGURATION', 'Display name is required.');
          return;
        }

        if (!config || playerCount === null) {
          rejectCreateOrJoin(socket, ack, 'INVALID_CONFIGURATION', 'Invalid player count.');
          return;
        }

        try {
          const { gameState, playerId } = await gamePersistenceService.createGame(displayName, {
            ...config,
            playerCount,
          });

          rememberSocketSession(socket, gameState, playerId);

          completeCreateOrJoin(io, gameState.gameId, {
            clientId: socket.id,
            playerId,
            role: 'PLAYER',
            gameState,
          }, ack);
        } catch (error) {
          logger.error('CREATE_GAME failed:', error);
          const message = (error as Error).message;
          rejectCreateOrJoin(socket, ack, resolveErrorCode(message), message);
        }
      },
    );

    socket.on(
      CLIENT_EVENTS.JOIN_GAME,
      async (
        request: JoinGameRequest,
        ack: CreateOrJoinAck<JoinGameAckData>,
      ) => {
        const joinCode = typeof request.joinCode === 'string' ? request.joinCode.trim().toUpperCase() : '';
        const displayName = typeof request.displayName === 'string' ? request.displayName.trim() : '';

        if (!joinCode) {
          rejectCreateOrJoin(socket, ack, 'INVALID_CONFIGURATION', 'Join code is required.');
          return;
        }

        if (!displayName) {
          rejectCreateOrJoin(socket, ack, 'INVALID_CONFIGURATION', 'Display name is required.');
          return;
        }

        try {
          const { gameState, playerId } = await gamePersistenceService.joinGame(joinCode, displayName);

          rememberSocketSession(socket, gameState, playerId);

          completeCreateOrJoin(io, gameState.gameId, {
            clientId: socket.id,
            playerId,
            role: 'PLAYER',
            gameState,
          }, ack);
        } catch (error) {
          logger.error('JOIN_GAME failed:', error);
          const message = (error as Error).message;
          rejectCreateOrJoin(socket, ack, resolveErrorCode(message), message);
        }
      },
    );

    socket.on(
      CLIENT_EVENTS.START_GAME,
      async (
        request: StartGameRequest,
        ack: SimpleActionAck,
      ) => {
        const requestedIdentifier = normalizeId(request.gameId);
        if (requestedIdentifier === null) {
          rejectAction(socket, ack, 'INVALID_CONFIGURATION', 'Game id is required.');
          return;
        }

        const session = await resolveSocketSession(socket, requestedIdentifier);
        if (session === null) {
          rejectAction(socket, ack, 'SESSION_NOT_FOUND', 'Player session not found for START_GAME.');
          return;
        }

        try {
          const gameState = await gamePersistenceService.startGame(session.gameId, session.playerId);
          rememberSocketSession(socket, gameState, session.playerId);
          completeAction(io, gameState.gameId, gameState, ack);
        } catch (error) {
          logger.error('START_GAME failed:', error);
          const message = (error as Error).message;
          rejectAction(socket, ack, resolveErrorCode(message), message);
        }
      },
    );

    socket.on(
      CLIENT_EVENTS.HYDRATE_SESSION,
      async (
        request: HydrateSessionRequest,
        ack: SimpleActionAck,
      ) => {
        const requestedIdentifier = normalizeId(request.gameId);
        if (requestedIdentifier === null) {
          rejectAction(socket, ack, 'INVALID_CONFIGURATION', 'Game id is required.');
          return;
        }

        const session = await resolveSocketSession(socket, requestedIdentifier);
        if (session === null) {
          rejectAction(socket, ack, 'SESSION_NOT_FOUND', 'Player session not found for HYDRATE_SESSION.');
          return;
        }

        try {
          const gameState = await gamePersistenceService.getGameState(session.gameId);
          if (!gameState || !gameState.playersById[session.playerId]) {
            rejectAction(socket, ack, 'SESSION_NOT_FOUND', 'Game session not found.');
            return;
          }

          rememberSocketSession(socket, gameState, session.playerId);
          completeSync(socket, ack, gameState);
        } catch (error) {
          logger.error('HYDRATE_SESSION failed:', error);
          const message = (error as Error).message;
          rejectAction(socket, ack, resolveErrorCode(message), message);
        }
      },
    );

    socket.on(
      CLIENT_EVENTS.ROLL_DICE,
      async (
        request: RollDiceRequest,
        ack: SimpleActionAck,
      ) => {
        const requestedIdentifier = normalizeId(request.gameId);
        if (requestedIdentifier === null) {
          rejectAction(socket, ack, 'INVALID_CONFIGURATION', 'Game id is required.');
          return;
        }

        const session = await resolveSocketSession(socket, requestedIdentifier);
        if (session === null) {
          rejectAction(socket, ack, 'SESSION_NOT_FOUND', 'Player session not found for ROLL_DICE.');
          return;
        }

        try {
          const gameState = await gamePersistenceService.rollDice(session.gameId, session.playerId);
          completeAction(io, gameState.gameId, gameState, ack);
        } catch (error) {
          logger.error('ROLL_DICE failed:', error);
          const message = (error as Error).message;
          rejectAction(socket, ack, resolveErrorCode(message), message);
        }
      },
    );

    socket.on(
      CLIENT_EVENTS.BUILD_STRUCTURE,
      async (
        request: BuildStructureRequest,
        ack: SimpleActionAck,
      ) => {
        const requestedIdentifier = normalizeId(request.gameId);
        if (requestedIdentifier === null) {
          rejectAction(socket, ack, 'INVALID_CONFIGURATION', 'Game id is required.');
          return;
        }

        const session = await resolveSocketSession(socket, requestedIdentifier);
        if (session === null) {
          rejectAction(socket, ack, 'SESSION_NOT_FOUND', 'Player session not found for BUILD_STRUCTURE.');
          return;
        }

        try {
          const gameState = await gamePersistenceService.buildStructure(session.gameId, session.playerId, {
            kind: request.kind,
            vertexId: request.vertexId,
            edgeId: request.edgeId,
          });
          completeAction(io, gameState.gameId, gameState, ack);
        } catch (error) {
          logger.error('BUILD_STRUCTURE failed:', error);
          const message = (error as Error).message;
          rejectAction(socket, ack, resolveErrorCode(message), message);
        }
      },
    );

    socket.on(
      CLIENT_EVENTS.BANK_TRADE,
      async (
        request: BankTradeRequest,
        ack: SimpleActionAck,
      ) => {
        const requestedIdentifier = normalizeId(request.gameId);
        if (requestedIdentifier === null) {
          rejectAction(socket, ack, 'INVALID_CONFIGURATION', 'Game id is required.');
          return;
        }

        const session = await resolveSocketSession(socket, requestedIdentifier);
        if (session === null) {
          rejectAction(socket, ack, 'SESSION_NOT_FOUND', 'Player session not found for BANK_TRADE.');
          return;
        }

        try {
          const gameState = await gamePersistenceService.bankTrade(
            session.gameId,
            session.playerId,
            request.giveResource,
            request.receiveResource,
          );
          completeAction(io, gameState.gameId, gameState, ack);
        } catch (error) {
          logger.error('BANK_TRADE failed:', error);
          const message = (error as Error).message;
          rejectAction(socket, ack, resolveErrorCode(message), message);
        }
      },
    );

    socket.on(
      CLIENT_EVENTS.END_TURN,
      async (
        request: EndTurnRequest,
        ack: SimpleActionAck,
      ) => {
        const requestedIdentifier = normalizeId(request.gameId);
        if (requestedIdentifier === null) {
          rejectAction(socket, ack, 'INVALID_CONFIGURATION', 'Game id is required.');
          return;
        }

        const session = await resolveSocketSession(socket, requestedIdentifier);
        if (session === null) {
          rejectAction(socket, ack, 'SESSION_NOT_FOUND', 'Player session not found for END_TURN.');
          return;
        }

        try {
          const gameState = await gamePersistenceService.endTurn(session.gameId, session.playerId);
          completeAction(io, gameState.gameId, gameState, ack);
        } catch (error) {
          logger.error('END_TURN failed:', error);
          const message = (error as Error).message;
          rejectAction(socket, ack, resolveErrorCode(message), message);
        }
      },
    );

    socket.on(
      CLIENT_EVENTS.SEND_CHAT_MESSAGE,
      async (
        request: SendChatMessageRequest,
        ack: SimpleActionAck,
      ) => {
        const requestedIdentifier = normalizeId(request.gameId);
        if (requestedIdentifier === null) {
          rejectAction(socket, ack, 'INVALID_CONFIGURATION', 'Game id is required.');
          return;
        }

        const session = await resolveSocketSession(socket, requestedIdentifier);
        if (session === null) {
          rejectAction(socket, ack, 'SESSION_NOT_FOUND', 'Player session not found for SEND_CHAT_MESSAGE.');
          return;
        }

        try {
          const gameState = await gamePersistenceService.appendChatMessage(
            session.gameId,
            session.playerId,
            request.message,
          );
          completeAction(io, gameState.gameId, gameState, ack);
        } catch (error) {
          logger.error('SEND_CHAT_MESSAGE failed:', error);
          const message = (error as Error).message;
          rejectAction(socket, ack, resolveErrorCode(message), message);
        }
      },
    );

    socket.on(SocketEvents.Disconnect, () => {
      logger.info(`Client disconnected: ${socket.id}`);
      const session = socketPlayerMap.get(socket.id);
      if (session) {
        void gamePersistenceService.markPlayerDisconnected(session.gameId, session.playerId);
      }
      socketPlayerMap.delete(socket.id);
    });
  });
}
