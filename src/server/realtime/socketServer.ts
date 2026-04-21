import type { Server as HttpServer } from 'http';
import { Server } from 'socket.io';
import type { ClientToServerEvents, ServerToClientEvents } from '../../shared/types/socket';

export function createSocketServer(
  httpServer: HttpServer,
): Server<ClientToServerEvents, ServerToClientEvents> {
  return new Server<ClientToServerEvents, ServerToClientEvents>(httpServer, {
    cors: { origin: '*' },
  });
}
