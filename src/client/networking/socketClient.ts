import { io, type Socket } from 'socket.io-client';
import type { ClientToServerEvents, ServerToClientEvents } from '../../shared/types/socket';
import { ClientEnv } from '../config/env';
import { registerClientEvents } from './registerClientEvents';
import type {
  BankTradeRequest,
  BuildStructureRequest,
  CreateGameAckData,
  CreateGameRequest,
  HydrateSessionRequest,
  JoinGameAckData,
  JoinGameRequest,
  RespondPlayerTradeRequestAckData,
  RespondPlayerTradeRequestPayload,
  SendPlayerTradeRequestAckData,
  SendPlayerTradeRequestPayload,
  SimpleActionAckData,
  SocketAck,
  SendChatMessageRequest,
} from '../../shared/types/socket';
import { CLIENT_EVENTS } from '../../shared/constants/socketEvents';
import { clientState, setClientState } from '../state/clientState';
import { getLobbySession } from '../state/lobbyState';

type TypedSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

let socket: TypedSocket | null = null;
let currentSocketAuthKey: string | null = null;

function resolvePersistedPlayerId(): string | null {
  if (clientState.playerId && clientState.playerId.trim().length > 0) {
    return clientState.playerId.trim();
  }
  const lobbySession = getLobbySession();
  if (lobbySession?.playerId && lobbySession.playerId.trim().length > 0) {
    return lobbySession.playerId.trim();
  }
  return null;
}

function resolveSocketAuth(gameId?: string, playerId: string | null = clientState.playerId): {
  gameId?: string;
  playerId?: string;
} {
  const resolvedPlayerId = playerId ?? resolvePersistedPlayerId();
  return {
    gameId,
    playerId: resolvedPlayerId ?? undefined,
  };
}

export function getSocket(): TypedSocket | null {
  return socket;
}

function buildSocketAuthKey(auth?: { gameId?: string; playerId?: string }): string {
  return `${auth?.gameId ?? ''}::${auth?.playerId ?? ''}`;
}

function applyActionState(data: SimpleActionAckData): SimpleActionAckData {
  const resolvedPlayerId = resolvePersistedPlayerId();
  setClientState({
    playerId: clientState.playerId ?? resolvedPlayerId,
    gameState: data.gameState,
    lastActionRejected: null,
  });
  return data;
}

export function disconnectSocket(): void {
  if (socket) {
    socket.removeAllListeners();
    socket.disconnect();
    socket = null;
  }
  currentSocketAuthKey = null;
}

export function connectSocket(auth?: { gameId?: string; playerId?: string }): TypedSocket {
  const authKey = buildSocketAuthKey(auth);
  if (socket && currentSocketAuthKey === authKey) {
    if (!socket.connected) {
      socket.connect();
    }
    return socket;
  }

  if (socket) {
    disconnectSocket();
  }

  socket = io(ClientEnv.serverUrl, {
    transports: ['websocket'],
    autoConnect: true,
    auth: {
      gameId: auth?.gameId,
      playerId: auth?.playerId,
    },
  });

  currentSocketAuthKey = authKey;
  registerClientEvents(socket);
  return socket;
}

function emitWithAck<T>(
  emitter: (ack: (response: SocketAck<T>) => void) => void,
  timeoutMs: number = 8000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      reject(new Error('Timed out waiting for server response.'));
    }, timeoutMs);

    emitter((response) => {
      window.clearTimeout(timer);
      if (!response.ok) {
        setClientState({ lastActionRejected: { code: response.error.code, message: response.error.message, details: response.error.details } });
        reject(new Error(response.error.message));
        return;
      }
      resolve(response.data);
    });
  });
}

export async function createGame(request: CreateGameRequest): Promise<CreateGameAckData> {
  const s = connectSocket();
  const data = await emitWithAck<CreateGameAckData>((ack) => {
    s.emit(CLIENT_EVENTS.CREATE_GAME, request, ack);
  });
  setClientState({
    playerId: data.playerId,
    role: data.role,
    gameState: data.gameState,
    lastActionRejected: null,
  });
  connectSocket(resolveSocketAuth(data.gameState.roomCode, data.playerId));
  return data;
}

export async function joinGame(request: JoinGameRequest): Promise<JoinGameAckData> {
  const s = connectSocket({ gameId: request.joinCode });
  const data = await emitWithAck<JoinGameAckData>((ack) => {
    s.emit(CLIENT_EVENTS.JOIN_GAME, request, ack);
  });
  setClientState({
    playerId: data.playerId,
    role: data.role,
    gameState: data.gameState,
    lastActionRejected: null,
  });
  connectSocket(resolveSocketAuth(data.gameState.roomCode, data.playerId));
  return data;
}

export async function startGame(gameId: string): Promise<SimpleActionAckData> {
  const s = connectSocket(resolveSocketAuth(gameId));
  const data = await emitWithAck<SimpleActionAckData>((ack) => {
    s.emit(CLIENT_EVENTS.START_GAME, { gameId }, ack);
  });
  return applyActionState(data);
}

export async function hydrateSession(gameId: string): Promise<SimpleActionAckData> {
  const request: HydrateSessionRequest = { gameId };
  const s = connectSocket(resolveSocketAuth(gameId));
  const data = await emitWithAck<SimpleActionAckData>((ack) => {
    s.emit(CLIENT_EVENTS.HYDRATE_SESSION, request, ack);
  });
  return applyActionState(data);
}

export async function rollDice(gameId: string): Promise<SimpleActionAckData> {
  const s = connectSocket(resolveSocketAuth(gameId));
  const data = await emitWithAck<SimpleActionAckData>((ack) => {
    s.emit(CLIENT_EVENTS.ROLL_DICE, { gameId }, ack);
  });
  return applyActionState(data);
}

export async function buildStructure(
  request: BuildStructureRequest,
): Promise<SimpleActionAckData> {
  const s = connectSocket(resolveSocketAuth(request.gameId));
  const data = await emitWithAck<SimpleActionAckData>((ack) => {
    s.emit(CLIENT_EVENTS.BUILD_STRUCTURE, request, ack);
  });
  return applyActionState(data);
}

export async function endTurn(gameId: string): Promise<SimpleActionAckData> {
  const s = connectSocket(resolveSocketAuth(gameId));
  const data = await emitWithAck<SimpleActionAckData>((ack) => {
    s.emit(CLIENT_EVENTS.END_TURN, { gameId }, ack);
  });
  return applyActionState(data);
}

export async function bankTrade(
  request: BankTradeRequest,
): Promise<SimpleActionAckData> {
  const s = connectSocket(resolveSocketAuth(request.gameId));
  const data = await emitWithAck<SimpleActionAckData>((ack) => {
    s.emit('BANK_TRADE', request, ack);
  });
  return applyActionState(data);
}

export async function sendChatMessage(gameId: string, message: string): Promise<void> {
  const s = connectSocket(resolveSocketAuth(gameId));
  try {
    const request: SendChatMessageRequest = { gameId, message };
    console.log(`[Client] Emitting SEND_CHAT_MESSAGE to socket ${s.id}. Connected: ${s.connected}`, request);
    const data = await emitWithAck<SimpleActionAckData>((ack) =>
      s.emit(CLIENT_EVENTS.SEND_CHAT_MESSAGE, request, ack),
    );
    console.log('[socketClient] Received gameState in sendChatMessage ack. Chat messages count:', data.gameState?.chatMessages?.length);

    // Update local state immediately from the server's response
    applyActionState(data);
  } catch (error) {
    console.error('Failed to send chat message:', error);
  }
}

export async function sendPlayerTradeRequest(
  request: SendPlayerTradeRequestPayload,
): Promise<SendPlayerTradeRequestAckData> {
  const s = connectSocket(resolveSocketAuth(request.gameId));
  const data = await emitWithAck<SendPlayerTradeRequestAckData>((ack) => {
    s.emit(CLIENT_EVENTS.SEND_PLAYER_TRADE_REQUEST, request, ack);
  });
  setClientState({ lastActionRejected: null });
  return data;
}

export async function respondPlayerTradeRequest(
  request: RespondPlayerTradeRequestPayload,
): Promise<RespondPlayerTradeRequestAckData> {
  const s = connectSocket(resolveSocketAuth(request.gameId));
  const data = await emitWithAck<RespondPlayerTradeRequestAckData>((ack) => {
    s.emit(CLIENT_EVENTS.RESPOND_PLAYER_TRADE_REQUEST, request, ack);
  });
  setClientState({ lastActionRejected: null });
  return data;
}
