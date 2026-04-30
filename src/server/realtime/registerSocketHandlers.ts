import type { Server, Socket } from 'socket.io';
import { CLIENT_EVENTS, SERVER_EVENTS, SocketEvents } from '../../shared/constants/socketEvents';
import type { GameState, ResourceBundle } from '../../shared/types/domain';
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
  PlayerTradeRequest,
  PlayerTradeRequestUpdateEvent,
  RespondPlayerTradeRequestAckData,
  RespondPlayerTradeRequestPayload,
  RollDiceRequest,
  SendPlayerTradeRequestAckData,
  SendPlayerTradeRequestPayload,
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
type SendTradeAck = (response: SocketAck<SendPlayerTradeRequestAckData>) => void;
type RespondTradeAck = (response: SocketAck<RespondPlayerTradeRequestAckData>) => void;

const PLAYER_TRADE_REQUEST_TTL_MS = 10_000;
const RESOURCE_KEYS: Array<keyof ResourceBundle> = ['CRYSTAL', 'STONE', 'BLOOM', 'EMBER', 'GOLD'];

interface SocketSession {
  gameId: string;
  roomCode: string;
  playerId: string;
}

interface PendingPlayerTradeRequest {
  tradeRequest: PlayerTradeRequest;
  timeoutId: ReturnType<typeof setTimeout>;
}

const socketPlayerMap = new Map<string, SocketSession>();
const activeGameIds = new Set<string>();
const pendingPlayerTradeRequests = new Map<string, PendingPlayerTradeRequest>();

function buildPlayerRoomId(gameId: string, playerId: string): string {
  return `${gameId}:player:${playerId}`;
}

function sanitizeResourceCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.trunc(value));
}

function normalizeResourceBundle(bundle: Partial<ResourceBundle> | null | undefined): ResourceBundle {
  return {
    CRYSTAL: sanitizeResourceCount(bundle?.CRYSTAL),
    STONE: sanitizeResourceCount(bundle?.STONE),
    BLOOM: sanitizeResourceCount(bundle?.BLOOM),
    EMBER: sanitizeResourceCount(bundle?.EMBER),
    GOLD: sanitizeResourceCount(bundle?.GOLD),
  };
}

function resourceBundleSum(bundle: ResourceBundle): number {
  return bundle.CRYSTAL + bundle.STONE + bundle.BLOOM + bundle.EMBER + bundle.GOLD;
}

function hasResources(inventory: ResourceBundle, required: ResourceBundle): boolean {
  return RESOURCE_KEYS.every((resourceKey) => inventory[resourceKey] >= required[resourceKey]);
}

function cloneTradeRequestWithStatus(
  tradeRequest: PlayerTradeRequest,
  status: PlayerTradeRequest['status'],
): PlayerTradeRequest {
  return {
    ...tradeRequest,
    status,
  };
}

function emitTradeUpdateToParticipants(
  io: TypedServer,
  tradeRequest: PlayerTradeRequest,
  outcome: PlayerTradeRequestUpdateEvent['outcome'],
  message: string,
): void {
  const payload: PlayerTradeRequestUpdateEvent = {
    tradeRequest,
    outcome,
    message,
  };
  io.to(buildPlayerRoomId(tradeRequest.gameId, tradeRequest.senderPlayerId)).emit(
    SERVER_EVENTS.PLAYER_TRADE_REQUEST_UPDATED,
    payload,
  );
  io.to(buildPlayerRoomId(tradeRequest.gameId, tradeRequest.receiverPlayerId)).emit(
    SERVER_EVENTS.PLAYER_TRADE_REQUEST_UPDATED,
    payload,
  );
}

function createTradeRequestId(): string {
  return `trade_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
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

  if (
    normalized.includes('need 4')
    || normalized.includes('insufficient')
    || normalized.includes('enough resources')
  ) {
    return 'INSUFFICIENT_RESOURCES';
  }

  if (normalized.includes('trade') && normalized.includes('expired')) {
    return 'TRADE_REQUEST_EXPIRED';
  }

  if (normalized.includes('trade') && normalized.includes('not found')) {
    return 'TRADE_REQUEST_NOT_FOUND';
  }

  if (normalized.includes('trade') && normalized.includes('only allowed')) {
    return 'TRADE_NOT_ALLOWED';
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

function rejectWithAck<T>(
  socket: TypedSocket,
  ack: (response: SocketAck<T>) => void,
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
    socket.leave(buildPlayerRoomId(existingSession.gameId, existingSession.playerId));
  }
  if (
    existingSession
    && existingSession.gameId === gameState.gameId
    && existingSession.playerId !== playerId
  ) {
    socket.leave(buildPlayerRoomId(existingSession.gameId, existingSession.playerId));
  }

  const session: SocketSession = {
    gameId: gameState.gameId,
    roomCode: gameState.roomCode,
    playerId,
  };

  socket.join(gameState.gameId);
  socket.join(buildPlayerRoomId(gameState.gameId, playerId));
  socketPlayerMap.set(socket.id, session);
  activeGameIds.add(gameState.gameId);

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
  pendingPlayerTradeRequests.forEach((pending) => {
    clearTimeout(pending.timeoutId);
  });
  pendingPlayerTradeRequests.clear();

  let timeoutPollInFlight = false;
  setInterval(() => {
    if (timeoutPollInFlight || activeGameIds.size === 0) {
      return;
    }
    timeoutPollInFlight = true;
    void (async () => {
      try {
        for (const gameId of activeGameIds) {
          const updatedGameState = await gamePersistenceService.advanceTurnIfExpired(gameId);
          if (updatedGameState) {
            io.to(gameId).emit(SERVER_EVENTS.GAME_STATE_UPDATE, updatedGameState);
          }
        }
      } catch (error) {
        logger.warn(`Turn timeout poll failed: ${(error as Error).message}`);
      } finally {
        timeoutPollInFlight = false;
      }
    })();
  }, 1000);

  const clearPendingPlayerTradeRequest = (tradeRequestId: string): PendingPlayerTradeRequest | null => {
    const pending = pendingPlayerTradeRequests.get(tradeRequestId) ?? null;
    if (!pending) {
      return null;
    }
    clearTimeout(pending.timeoutId);
    pendingPlayerTradeRequests.delete(tradeRequestId);
    return pending;
  };

  const expirePendingPlayerTradeRequest = (tradeRequestId: string): void => {
    const pending = clearPendingPlayerTradeRequest(tradeRequestId);
    if (!pending) {
      return;
    }
    const expiredRequest = cloneTradeRequestWithStatus(pending.tradeRequest, 'expired');
    emitTradeUpdateToParticipants(
      io,
      expiredRequest,
      'expired',
      'Trade request expired.',
    );
  };

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

    socket.on(
      CLIENT_EVENTS.SEND_PLAYER_TRADE_REQUEST,
      async (
        request: SendPlayerTradeRequestPayload,
        ack: SendTradeAck,
      ) => {
        const requestedIdentifier = normalizeId(request.gameId);
        if (requestedIdentifier === null) {
          rejectWithAck(socket, ack, 'INVALID_CONFIGURATION', 'Game id is required.');
          return;
        }

        const session = await resolveSocketSession(socket, requestedIdentifier);
        if (session === null) {
          rejectWithAck(socket, ack, 'SESSION_NOT_FOUND', 'Player session not found for SEND_PLAYER_TRADE_REQUEST.');
          return;
        }

        try {
          const gameState = await gamePersistenceService.getGameState(session.gameId);
          if (!gameState) {
            rejectWithAck(socket, ack, 'SESSION_NOT_FOUND', 'Game session not found.');
            return;
          }
          if (gameState.roomStatus !== 'in_progress') {
            rejectWithAck(socket, ack, 'TRADE_NOT_ALLOWED', 'Player trade is only allowed during an active game.');
            return;
          }
          if (gameState.turn.currentPlayerId !== session.playerId || gameState.turn.phase !== 'ACTION') {
            rejectWithAck(
              socket,
              ack,
              'TRADE_NOT_ALLOWED',
              'Player trade is only allowed during your ACTION phase.',
            );
            return;
          }

          const receiverPlayerId = normalizeId(request.receiverPlayerId);
          if (!receiverPlayerId) {
            rejectWithAck(socket, ack, 'INVALID_CONFIGURATION', 'Receiver player id is required.');
            return;
          }
          if (receiverPlayerId === session.playerId) {
            rejectWithAck(socket, ack, 'INVALID_CONFIGURATION', 'You cannot trade with yourself.');
            return;
          }

          const sender = gameState.playersById[session.playerId];
          const receiver = gameState.playersById[receiverPlayerId];
          if (!sender || !receiver) {
            rejectWithAck(socket, ack, 'SESSION_NOT_FOUND', 'Player not found.');
            return;
          }

          const offeredResources = normalizeResourceBundle(request.offeredResources);
          const requestedResources = normalizeResourceBundle(request.requestedResources);
          if (resourceBundleSum(offeredResources) <= 0 || resourceBundleSum(requestedResources) <= 0) {
            rejectWithAck(socket, ack, 'INVALID_CONFIGURATION', 'Trade offer and request cannot be empty.');
            return;
          }
          if (!hasResources(sender.resources, offeredResources)) {
            rejectWithAck(socket, ack, 'INSUFFICIENT_RESOURCES', 'You do not have enough resources for this offer.');
            return;
          }

          const createdAtMs = Date.now();
          const tradeRequest: PlayerTradeRequest = {
            id: createTradeRequestId(),
            gameId: session.gameId,
            senderPlayerId: session.playerId,
            receiverPlayerId,
            offeredResources,
            requestedResources,
            status: 'pending',
            createdAt: new Date(createdAtMs).toISOString(),
            expiresAt: new Date(createdAtMs + PLAYER_TRADE_REQUEST_TTL_MS).toISOString(),
          };
          const timeoutId = setTimeout(() => {
            expirePendingPlayerTradeRequest(tradeRequest.id);
          }, PLAYER_TRADE_REQUEST_TTL_MS);

          pendingPlayerTradeRequests.set(tradeRequest.id, { tradeRequest, timeoutId });
          io.to(buildPlayerRoomId(session.gameId, receiverPlayerId)).emit(
            SERVER_EVENTS.PLAYER_TRADE_REQUEST_RECEIVED,
            tradeRequest,
          );
          emitTradeUpdateToParticipants(io, tradeRequest, 'pending', 'Trade request sent.');
          ack({ ok: true, data: { tradeRequest } });
        } catch (error) {
          logger.error('SEND_PLAYER_TRADE_REQUEST failed:', error);
          const message = (error as Error).message;
          rejectWithAck(socket, ack, resolveErrorCode(message), message);
        }
      },
    );

    socket.on(
      CLIENT_EVENTS.RESPOND_PLAYER_TRADE_REQUEST,
      async (
        request: RespondPlayerTradeRequestPayload,
        ack: RespondTradeAck,
      ) => {
        const requestedIdentifier = normalizeId(request.gameId);
        if (requestedIdentifier === null) {
          rejectWithAck(socket, ack, 'INVALID_CONFIGURATION', 'Game id is required.');
          return;
        }

        const session = await resolveSocketSession(socket, requestedIdentifier);
        if (session === null) {
          rejectWithAck(socket, ack, 'SESSION_NOT_FOUND', 'Player session not found for RESPOND_PLAYER_TRADE_REQUEST.');
          return;
        }

        const tradeRequestId = normalizeId(request.tradeRequestId);
        if (!tradeRequestId) {
          rejectWithAck(socket, ack, 'INVALID_CONFIGURATION', 'Trade request id is required.');
          return;
        }

        const pending = pendingPlayerTradeRequests.get(tradeRequestId);
        if (!pending) {
          rejectWithAck(socket, ack, 'TRADE_REQUEST_NOT_FOUND', 'Trade request not found.');
          return;
        }

        const tradeRequest = pending.tradeRequest;
        if (tradeRequest.gameId !== session.gameId) {
          rejectWithAck(socket, ack, 'TRADE_REQUEST_NOT_FOUND', 'Trade request not found in this game.');
          return;
        }
        if (tradeRequest.receiverPlayerId !== session.playerId) {
          rejectWithAck(socket, ack, 'TRADE_NOT_ALLOWED', 'Only the receiver can respond to this trade.');
          return;
        }

        if (request.response === 'declined') {
          clearPendingPlayerTradeRequest(tradeRequest.id);
          const declinedTradeRequest = cloneTradeRequestWithStatus(tradeRequest, 'declined');
          emitTradeUpdateToParticipants(io, declinedTradeRequest, 'declined', 'Trade request declined.');
          ack({ ok: true, data: { tradeRequest: declinedTradeRequest } });
          return;
        }

        const expiresAtMs = Date.parse(tradeRequest.expiresAt);
        if (Number.isFinite(expiresAtMs) && Date.now() > expiresAtMs) {
          expirePendingPlayerTradeRequest(tradeRequest.id);
          rejectWithAck(socket, ack, 'TRADE_REQUEST_EXPIRED', 'Trade request expired.');
          return;
        }

        clearPendingPlayerTradeRequest(tradeRequest.id);
        try {
          const updatedGameState = await gamePersistenceService.executePlayerTrade(
            tradeRequest.gameId,
            tradeRequest.senderPlayerId,
            tradeRequest.receiverPlayerId,
            tradeRequest.offeredResources,
            tradeRequest.requestedResources,
          );
          const acceptedTradeRequest = cloneTradeRequestWithStatus(tradeRequest, 'accepted');
          emitTradeUpdateToParticipants(io, acceptedTradeRequest, 'accepted', 'Trade request accepted.');
          io.to(updatedGameState.gameId).emit(SERVER_EVENTS.GAME_STATE_UPDATE, updatedGameState);
          ack({ ok: true, data: { tradeRequest: acceptedTradeRequest } });
        } catch (error) {
          const message = (error as Error).message;
          const failedTradeRequest = cloneTradeRequestWithStatus(tradeRequest, 'declined');
          emitTradeUpdateToParticipants(
            io,
            failedTradeRequest,
            'failed',
            `Trade failed: ${message}`,
          );
          logger.error('RESPOND_PLAYER_TRADE_REQUEST failed:', error);
          rejectWithAck(socket, ack, resolveErrorCode(message), message);
        }
      },
    );

    socket.on(SocketEvents.Disconnect, () => {
      logger.info(`Client disconnected: ${socket.id}`);
      const session = socketPlayerMap.get(socket.id);
      if (session) {
        void gamePersistenceService.markPlayerDisconnected(session.gameId, session.playerId, socket.id);
      }
      socketPlayerMap.delete(socket.id);
    });
  });
}
