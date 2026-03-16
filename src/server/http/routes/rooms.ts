import { Router } from 'express';
import { ApiRoutes } from '../../../shared/constants/apiRoutes';
import type { ApiResponse, RoomSnapshot } from '../../../shared/types/api';
import type { RoomStatus } from '../../../shared/types/domain';
import { roomManager } from '../../sessions/roomManagerSingleton';

interface HostRoomBody {
  name?: string;
}

interface JoinRoomBody {
  name?: string;
  roomId?: string;
}

interface StartRoomBody {
  roomId?: string;
  playerId?: string;
}

function buildRoomSnapshot(
  room: {
    id: string;
    players: Array<{
      id: string;
      name: string;
      avatar: string;
      points: number;
      resources: {
        ember: number;
        gold: number;
        stone: number;
        bloom: number;
        crystal: number;
      };
    }>;
    status: RoomStatus;
  },
): RoomSnapshot {
  return {
    roomId: room.id,
    status: room.status,
    players: room.players.map((player) => ({
      id: player.id,
      name: player.name,
      avatar: player.avatar,
      points: player.points,
      resources: player.resources,
    })),
  };
}

const roomsRouter = Router();

roomsRouter.post(ApiRoutes.HostRoom, (req, res) => {
  const { name } = (req.body ?? {}) as HostRoomBody;
  const trimmedName = name?.trim() ?? '';
  if (!trimmedName) {
    const response: ApiResponse = { success: false, error: 'Name is required.' };
    res.status(400).json(response);
    return;
  }
  const { room, player } = roomManager.createRoom(trimmedName);
  const response: ApiResponse<{ room: RoomSnapshot; playerId: string }> = {
    success: true,
    data: {
      room: buildRoomSnapshot(room),
      playerId: player.id,
    },
  };
  res.json(response);
});

roomsRouter.post(ApiRoutes.JoinRoom, (req, res) => {
  const { name, roomId } = (req.body ?? {}) as JoinRoomBody;
  const trimmedName = name?.trim() ?? '';
  const normalizedRoomId = roomId?.trim().toUpperCase() ?? '';
  if (!trimmedName || !normalizedRoomId) {
    const response: ApiResponse = { success: false, error: 'Name and room key are required.' };
    res.status(400).json(response);
    return;
  }
  const joined = roomManager.joinRoom(normalizedRoomId, trimmedName);
  if (!joined) {
    const response: ApiResponse = { success: false, error: 'Room not found or already full.' };
    res.status(404).json(response);
    return;
  }
  const response: ApiResponse<{ room: RoomSnapshot; playerId: string }> = {
    success: true,
    data: {
      room: buildRoomSnapshot(joined.room),
      playerId: joined.player.id,
    },
  };
  res.json(response);
});

roomsRouter.post(ApiRoutes.StartRoom, (req, res) => {
  const { roomId, playerId } = (req.body ?? {}) as StartRoomBody;
  const normalizedRoomId = roomId?.trim().toUpperCase() ?? '';
  const normalizedPlayerId = playerId?.trim() ?? '';
  if (!normalizedRoomId || !normalizedPlayerId) {
    const response: ApiResponse = { success: false, error: 'Room key and player id are required.' };
    res.status(400).json(response);
    return;
  }

  const room = roomManager.startRoom(normalizedRoomId, normalizedPlayerId);
  if (!room) {
    const response: ApiResponse = { success: false, error: 'Unable to start game.' };
    res.status(403).json(response);
    return;
  }

  const response: ApiResponse<{ room: RoomSnapshot }> = {
    success: true,
    data: {
      room: buildRoomSnapshot(room),
    },
  };
  res.json(response);
});

roomsRouter.get(`${ApiRoutes.RoomStatus}/:roomId`, (req, res) => {
  const normalizedRoomId = req.params.roomId.trim().toUpperCase();
  const room = roomManager.getRoom(normalizedRoomId);
  if (!room) {
    const response: ApiResponse = { success: false, error: 'Room not found.' };
    res.status(404).json(response);
    return;
  }
  const response: ApiResponse<{ room: RoomSnapshot }> = {
    success: true,
    data: {
      room: buildRoomSnapshot(room),
    },
  };
  res.json(response);
});

export default roomsRouter;
