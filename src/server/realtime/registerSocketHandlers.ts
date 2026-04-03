import type { Server, Socket } from 'socket.io';
import type {
  ClientToServerEvents,
  ServerToClientEvents,
  CreateGameRequest,
  JoinGameRequest,
  StartGameRequest,
  RollDiceRequest,
  EndTurnRequest,
  SocketAck,
  CreateGameAckData,
  JoinGameAckData,
  SimpleActionAckData,
  AckError,
} from '../../shared/types/socket';
import { SocketEvents, CLIENT_EVENTS } from '../../shared/constants/socketEvents';
import { gamePersistenceService } from '../persistence/GamePersistenceService';
import { logger } from '../utils/logger';

type TypedServer = Server<ClientToServerEvents, ServerToClientEvents>;
type TypedSocket = Socket<ClientToServerEvents, ServerToClientEvents>;

// Maps socket.id → { gameId, playerId } for quick lookup on disconnect / events
const socketPlayerMap = new Map<string, { gameId: string; playerId: string }>();

function errorAck(code: AckError['code'], message: string): { ok: false; error: AckError } {
  return { ok: false, error: { code, message } };
}

export function registerSocketHandlers(io: TypedServer): void {
  io.on(SocketEvents.Connection, (socket: TypedSocket) => {
    logger.info(`Client connected: ${socket.id}`);

    // ─── CREATE_GAME ────────────────────────────────────────────────────
    socket.on(
      CLIENT_EVENTS.CREATE_GAME,
      async (
        request: CreateGameRequest,
        ack: (response: SocketAck<CreateGameAckData>) => void,
      ) => {
        try {
          const { gameState, playerId } = await gamePersistenceService.createGame(
            request.displayName,
            request.config,
          );

          // Join socket room for broadcasts
          socket.join(gameState.gameId);
          socketPlayerMap.set(socket.id, { gameId: gameState.gameId, playerId });

          ack({
            ok: true,
            data: {
              clientId: socket.id,
              playerId,
              role: 'PLAYER',
              gameState,
            },
          });
        } catch (err) {
          logger.error('CREATE_GAME failed:', err);
          ack(errorAck('INTERNAL_ERROR', (err as Error).message));
        }
      },
    );

    // ─── JOIN_GAME ──────────────────────────────────────────────────────
    socket.on(
      CLIENT_EVENTS.JOIN_GAME,
      async (
        request: JoinGameRequest,
        ack: (response: SocketAck<JoinGameAckData>) => void,
      ) => {
        try {
          const { gameState, playerId } = await gamePersistenceService.joinGame(
            request.joinCode,
            request.displayName,
          );

          socket.join(gameState.gameId);
          socketPlayerMap.set(socket.id, { gameId: gameState.gameId, playerId });

          // Ack the joining player
          ack({
            ok: true,
            data: {
              clientId: socket.id,
              playerId,
              role: request.role,
              gameState,
            },
          });

          // Broadcast updated state to all other players in the room
          socket.to(gameState.gameId).emit('GAME_STATE_UPDATE', gameState);
        } catch (err) {
          logger.error('JOIN_GAME failed:', err);
          const message = (err as Error).message;
          const code: AckError['code'] = message.includes('not found')
            ? 'SESSION_NOT_FOUND'
            : message.includes('full')
              ? 'PLAYER_CAPACITY_EXCEEDED'
              : 'INTERNAL_ERROR';
          ack(errorAck(code, message));
        }
      },
    );

    // ─── START_GAME ─────────────────────────────────────────────────────
    socket.on(
      CLIENT_EVENTS.START_GAME,
      async (
        request: StartGameRequest,
        ack: (response: SocketAck<SimpleActionAckData>) => void,
      ) => {
        try {
          const mapping = socketPlayerMap.get(socket.id);
          if (!mapping || mapping.gameId !== request.gameId) {
            ack(errorAck('SESSION_NOT_FOUND', 'You are not in this game'));
            return;
          }

          const gameState = await gamePersistenceService.startGame(
            request.gameId,
            mapping.playerId,
          );

          ack({ ok: true, data: { gameState } });
          socket.to(gameState.gameId).emit('GAME_STATE_UPDATE', gameState);
        } catch (err) {
          logger.error('START_GAME failed:', err);
          const message = (err as Error).message;
          const code: AckError['code'] = message.includes('host')
            ? 'NOT_HOST'
            : 'INTERNAL_ERROR';
          ack(errorAck(code, message));
        }
      },
    );

    // ─── ROLL_DICE ──────────────────────────────────────────────────────
    socket.on(
      CLIENT_EVENTS.ROLL_DICE,
      async (
        request: RollDiceRequest,
        ack: (response: SocketAck<SimpleActionAckData>) => void,
      ) => {
        try {
          const mapping = socketPlayerMap.get(socket.id);
          if (!mapping || mapping.gameId !== request.gameId) {
            ack(errorAck('SESSION_NOT_FOUND', 'You are not in this game'));
            return;
          }

          const gameState = await gamePersistenceService.rollDice(
            request.gameId,
            mapping.playerId,
          );

          ack({ ok: true, data: { gameState } });
          socket.to(gameState.gameId).emit('GAME_STATE_UPDATE', gameState);
        } catch (err) {
          logger.error('ROLL_DICE failed:', err);
          const message = (err as Error).message;
          const code: AckError['code'] = message.includes('active player')
            ? 'NOT_ACTIVE_PLAYER'
            : message.includes('phase')
              ? 'INVALID_PHASE'
              : 'INTERNAL_ERROR';
          ack(errorAck(code, message));
        }
      },
    );

    // ─── END_TURN ───────────────────────────────────────────────────────
    socket.on(
      CLIENT_EVENTS.END_TURN,
      async (
        request: EndTurnRequest,
        ack: (response: SocketAck<SimpleActionAckData>) => void,
      ) => {
        try {
          const mapping = socketPlayerMap.get(socket.id);
          if (!mapping || mapping.gameId !== request.gameId) {
            ack(errorAck('SESSION_NOT_FOUND', 'You are not in this game'));
            return;
          }

          const gameState = await gamePersistenceService.endTurn(
            request.gameId,
            mapping.playerId,
          );

          ack({ ok: true, data: { gameState } });
          socket.to(gameState.gameId).emit('GAME_STATE_UPDATE', gameState);
        } catch (err) {
          logger.error('END_TURN failed:', err);
          const message = (err as Error).message;
          const code: AckError['code'] = message.includes('active player')
            ? 'NOT_ACTIVE_PLAYER'
            : 'INTERNAL_ERROR';
          ack(errorAck(code, message));
        }
      },
    );

    // ─── DISCONNECT ─────────────────────────────────────────────────────
    socket.on(SocketEvents.Disconnect, () => {
      logger.info(`Client disconnected: ${socket.id}`);
      socketPlayerMap.delete(socket.id);
    });
  });
}
