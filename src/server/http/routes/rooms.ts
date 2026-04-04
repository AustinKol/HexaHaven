import { Router } from 'express';
import { ApiRoutes } from '../../../shared/constants/apiRoutes';
import type { ApiResponse, RoomSnapshot } from '../../../shared/types/api';
import { defaultStartingResourceBundle } from '../../../shared/constants/startingResources';
import type { GameState, PlayerStats, ResourceBundle, RoomStatus } from '../../../shared/types/domain';
import { GameEngine } from '../../engine/GameEngine';
import type { Room } from '../../sessions/Room';
import { roomManager } from '../../sessions/roomManagerSingleton';

interface HostRoomBody {
  name?: string;
  maxPlayers?: number;
}

interface JoinRoomBody {
  name?: string;
  roomId?: string;
}

interface StartRoomBody {
  roomId?: string;
  playerId?: string;
}

interface LeaveRoomBody {
  roomId?: string;
  playerId?: string;
  
}


const PLAYER_COLORS = ['#FF6B6B', '#4ECDC4', '#45B7D1', '#F7B801'] as const;

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

const gameEngine = new GameEngine();

function cloneStats(): PlayerStats {
  return { ...EMPTY_STATS };
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

function buildInitialGameStateFromRoom(room: Room): GameState {
  const nowIso = new Date().toISOString();
  const playerOrder = room.players.map((player) => player.id);

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
      playerCount: room.players.length,
      goalCount: 0,
      winRule: 'ALL_GOALS_COMPLETE',
      mapSeed: 0,
      mapSize: 'small',
      timerEnabled: false,
      turnTimeSec: null,
      allowReroll: false,
      startingResources: defaultStartingResourceBundle(),
    },
    playerOrder,
    playersById: Object.fromEntries(
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
    ),
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
    maxPlayers: number;
  },
): RoomSnapshot {
  return {
    roomId: room.id,
    status: room.status,
    maxPlayers: room.maxPlayers,
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
  const { name, maxPlayers } = (req.body ?? {}) as HostRoomBody;
  const trimmedName = name?.trim() ?? '';
  if (!trimmedName) {
    const response: ApiResponse = { success: false, error: 'Name is required.' };
    res.status(400).json(response);
    return;
  }
  const { room, player } = roomManager.createRoom(trimmedName, maxPlayers);
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

  const room = roomManager.getRoom(normalizedRoomId);
  if (!room) {
    const response: ApiResponse = { success: false, error: 'Room not found.' };
    res.status(404).json(response);
    return;
  }

  if (room.hostId !== normalizedPlayerId || room.status !== 'waiting' || room.players.length < 2) {
    const response: ApiResponse = { success: false, error: 'Unable to start game.' };
    res.status(403).json(response);
    return;
  }

  const existingGameState = roomManager.getGameState(normalizedRoomId);
  const gameState = existingGameState
    ?? roomManager.initializeGameState(normalizedRoomId, buildInitialGameStateFromRoom(room));

  if (!gameState) {
    const response: ApiResponse = { success: false, error: 'Unable to initialize game state.' };
    res.status(500).json(response);
    return;
  }

  const engineResult = gameEngine.startGame(gameState);
  if (!engineResult.ok) {
    const response: ApiResponse = { success: false, error: engineResult.error.message };
    res.status(403).json(response);
    return;
  }

  const updatedGameState: GameState = {
    ...engineResult.gameState,
    updatedAt: new Date().toISOString(),
  };

  if (!roomManager.setGameState(normalizedRoomId, updatedGameState)) {
    const response: ApiResponse = { success: false, error: 'Unable to store game state.' };
    res.status(500).json(response);
    return;
  }

  room.status = updatedGameState.roomStatus;

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

roomsRouter.post('/api/rooms/leave', (req, res) => {
  const { roomId, playerId } = (req.body ?? {}) as LeaveRoomBody;
  const normalizedRoomId = roomId?.trim().toUpperCase() ?? '';
  const normalizedPlayerId = playerId?.trim() ?? '';

  if (!normalizedRoomId || !normalizedPlayerId) {
    const response: ApiResponse = { success: false, error: 'Room key and player id are required.' };
    res.status(400).json(response);
    return;
  }

  const updatedRoom = roomManager.leaveRoom(normalizedRoomId, normalizedPlayerId);

  // Host left -> room deleted
  if (!updatedRoom) {
    const response: ApiResponse = { success: true };
    res.json(response);
    return;
  }

  const response: ApiResponse<{ room: RoomSnapshot }> = {
    success: true,
    data: {
      room: buildRoomSnapshot(updatedRoom),
    },
  };
  res.json(response);
});

export default roomsRouter;
