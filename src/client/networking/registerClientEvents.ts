import type { Socket } from 'socket.io-client';
import type { ClientToServerEvents, ServerToClientEvents } from '../../shared/types/socket';
import { setClientState } from '../state/clientState';

export function registerClientEvents(socket: Socket<ServerToClientEvents, ClientToServerEvents>): void {
  socket.on('connect', () => {
    setClientState({ clientId: socket.id ?? null });
  });

  socket.on('disconnect', () => {
    setClientState({ clientId: null });
  });

  socket.on('connect_error', (err) => {
    // Surface as an action rejection for Friday demo UX.
    setClientState({
      lastActionRejected: {
        code: 'INTERNAL_ERROR',
        message: err?.message ?? 'Unable to connect to server.',
      },
    });
  });

  socket.on('GAME_STATE_UPDATE', (gameState) => {
    console.log('[Client Socket] Received GAME_STATE_UPDATE. Chat messages count:', gameState.chatMessages?.length);
    setClientState({ gameState });
  });

  socket.on('ACTION_REJECTED', (event) => {
    setClientState({ lastActionRejected: event });
  });
}
