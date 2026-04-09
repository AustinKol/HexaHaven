import { io, type Socket } from 'socket.io-client';
import type { ClientToServerEvents, ServerToClientEvents } from '../../shared/types/socket';
import { ClientEnv } from '../config/env';
import { registerClientEvents } from './registerClientEvents';
import type {
  BankTradeRequest,
  CreateGameAckData,
  CreateGameRequest,
  JoinGameAckData,
  JoinGameRequest,
  SimpleActionAckData,
  SocketAck,
  SendChatMessageRequest,
} from '../../shared/types/socket';
import { CLIENT_EVENTS } from '../../shared/constants/socketEvents';
import { clientState, setClientState } from '../state/clientState';

type TypedSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

let socket: TypedSocket | null = null;

function resolveSocketAuth(gameId?: string): { gameId?: string; playerId?: string } {
  return {
    gameId,
    playerId: clientState.playerId ?? undefined,
  };
}

export function getSocket(): TypedSocket | null {
  return socket;
}

export function disconnectSocket(): void {
  if (socket) {
    socket.removeAllListeners();
    socket.disconnect();
    socket = null;
  }
}

export function connectSocket(auth?: { gameId?: string; playerId?: string }): TypedSocket {
  if (socket) {
    // If we already have a socket, keep it; screens rely on a single connection.
    return socket;
  }

  socket = io(ClientEnv.serverUrl, {
    transports: ['websocket'],
    autoConnect: true,
    auth: {
      gameId: auth?.gameId,
      playerId: auth?.playerId,
    },
  });

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
    s.emit('CREATE_GAME', request, ack);
  });
  setClientState({
    playerId: data.playerId,
    role: data.role,
    gameState: data.gameState,
    lastActionRejected: null,
  });
  return data;
}

export async function joinGame(request: JoinGameRequest): Promise<JoinGameAckData> {
  const s = connectSocket({ gameId: request.joinCode });
  const data = await emitWithAck<JoinGameAckData>((ack) => {
    s.emit('JOIN_GAME', request, ack);
  });
  setClientState({
    playerId: data.playerId,
    role: data.role,
    gameState: data.gameState,
    lastActionRejected: null,
  });
  return data;
}

export async function startGame(gameId: string): Promise<SimpleActionAckData> {
  const s = connectSocket(resolveSocketAuth(gameId));
  return emitWithAck<SimpleActionAckData>((ack) => {
    s.emit('START_GAME', { gameId }, ack);
  });
}

export async function rollDice(gameId: string): Promise<SimpleActionAckData> {
  const s = connectSocket(resolveSocketAuth(gameId));
  return emitWithAck<SimpleActionAckData>((ack) => {
    s.emit('ROLL_DICE', { gameId }, ack);
  });
}

export async function endTurn(gameId: string): Promise<SimpleActionAckData> {
  const s = connectSocket(resolveSocketAuth(gameId));
  return emitWithAck<SimpleActionAckData>((ack) => {
    s.emit('END_TURN', { gameId }, ack);
  });
}

export async function syncGameState(gameId: string, gameState: any): Promise<SimpleActionAckData> {
  const s = connectSocket(resolveSocketAuth(gameId));
  return emitWithAck<SimpleActionAckData>((ack) => {
    s.emit('SYNC_GAME_STATE', { gameId, gameState }, ack);
  });
}

export async function bankTrade(
  request: BankTradeRequest,
): Promise<SimpleActionAckData> {
  const s = connectSocket(resolveSocketAuth(request.gameId));
  return emitWithAck<SimpleActionAckData>((ack) => {
    s.emit('BANK_TRADE', request, ack);
  });
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
    setClientState({
      gameState: data.gameState,
    });
  } catch (error) {
    console.error('Failed to send chat message:', error);
  }
}
