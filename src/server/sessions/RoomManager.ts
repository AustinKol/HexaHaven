import { shufflePlayerColorOrder } from '../../shared/constants/playerColors';
import type { Room, RoomPlayer } from './Room';
import type { GameState } from '../../shared/types/domain';

const AVATAR_POOL = ['/avatar/avatar_1.png', '/avatar/avatar_2.png', '/avatar/avatar_3.png', '/avatar/avatar_4.png'] as const;
const MAX_PLAYERS_PER_ROOM = AVATAR_POOL.length;

export class RoomManager {
  // Active in-memory lobby/session registry keyed by room code.
  private readonly rooms = new Map<string, Room>();
  // Authoritative in-memory game snapshots keyed by room code.
  private readonly gameStatesByRoomId = new Map<string, GameState>();

  createRoom(hostName: string, maxPlayers?: number): { room: Room; player: RoomPlayer } {
    const roomId = this.generateUniqueRoomId();
    const hostPlayer: RoomPlayer = {
      id: this.generatePlayerId(),
      name: hostName.trim(),
      avatar: this.pickRandomAvatar([]),
      points: 0,
      resources: {
        ember: 0,
        gold: 0,
        stone: 0,
        bloom: 0,
        crystal: 0,
      },
    };
    const room: Room = {
      id: roomId,
      hostId: hostPlayer.id,
      players: [hostPlayer],
      status: 'waiting',
      maxPlayers: maxPlayers ?? MAX_PLAYERS_PER_ROOM,
      playerColorOrder: shufflePlayerColorOrder(),
    };
    this.rooms.set(roomId, room);
    return { room, player: hostPlayer };
  }

  joinRoom(roomId: string, playerName: string): { room: Room; player: RoomPlayer } | null {
    const room = this.rooms.get(roomId);
    if (!room || room.status !== 'waiting' || room.players.length >= room.maxPlayers) {
      return null;
    }
    const usedAvatars = room.players.map((roomPlayer) => roomPlayer.avatar);
    const player: RoomPlayer = {
      id: this.generatePlayerId(),
      name: playerName.trim(),
      avatar: this.pickRandomAvatar(usedAvatars),
      points: 0,
      resources: {
        ember: 0,
        gold: 0,
        stone: 0,
        bloom: 0,
        crystal: 0,
      },
    };
    room.players.push(player);
    return { room, player };
  }

  leaveRoom(roomId: string, playerId: string): Room | null {
    const room = this.rooms.get(roomId);
    if (!room) {
      return null;
    }

    // Host leaves -> delete room
    if (room.hostId === playerId) {
      this.rooms.delete(roomId);
      this.gameStatesByRoomId.delete(roomId);
      return null;
    }

    // Guest leaves -> remove player (FIXED)
    const updatedPlayers = room.players.filter((player) => player.id !== playerId);
    room.players.length = 0;
    room.players.push(...updatedPlayers);

    return room;
  }

  // startRoom(roomId: string, hostId: string): Room | null {
  //   const room = this.rooms.get(roomId);
  //   if (!room) {
  //     return null;
  //   }
  //   if (room.hostId !== hostId || room.status !== 'waiting' || room.players.length < 2) {
  //     return null;
  //   }
  //   room.status = 'in_progress';
  //   return room;
  // }

  getRoom(roomId: string): Room | null {
    return this.rooms.get(roomId) ?? null;
  }

  initializeGameState(roomId: string, gameState: GameState): GameState | null {
    if (!this.rooms.has(roomId)) {
      return null;
    }

    const existingGameState = this.gameStatesByRoomId.get(roomId);
    if (existingGameState) {
      // Initialization is idempotent per room; reuse existing snapshot.
      return existingGameState;
    }

    this.gameStatesByRoomId.set(roomId, gameState);
    return gameState;
  }

  setGameState(roomId: string, gameState: GameState): GameState | null {
    if (!this.rooms.has(roomId)) {
      return null;
    }

    this.gameStatesByRoomId.set(roomId, gameState);
    return gameState;
  }

  getGameState(roomId: string): GameState | null {
    return this.gameStatesByRoomId.get(roomId) ?? null;
  }

  setHydratedGameState(gameState: GameState): GameState {
    const roomId = gameState.roomCode;
    const existingRoom = this.rooms.get(roomId);
    if (!existingRoom) {
      // Recreate a minimal room model when we recovered state from persistence
      // but this process has no in-memory room entry yet.
      this.rooms.set(roomId, this.buildRoomFromGameState(gameState));
    }
    // Keep runtime state aligned with recovered authoritative snapshot.
    this.gameStatesByRoomId.set(roomId, gameState);
    return gameState;
  }

  private buildRoomFromGameState(gameState: GameState): Room {
    // Build Room.players in turn order so host/waiting-room UI reflects
    // the same ordering as server turn sequencing.
    const players: RoomPlayer[] = gameState.playerOrder
      .map((playerId) => gameState.playersById[playerId])
      .filter((player): player is GameState['playersById'][string] => Boolean(player))
      .map((player) => ({
        id: player.playerId,
        name: player.displayName,
        avatar: player.avatarUrl ?? '/avatar/avatar_1.png',
        points: player.stats.publicVP,
        resources: {
          ember: player.resources.EMBER,
          gold: player.resources.GOLD,
          stone: player.resources.STONE,
          bloom: player.resources.BLOOM,
          crystal: player.resources.CRYSTAL,
        },
      }));

    return {
      id: roomIdFromState(gameState),
      hostId: gameState.createdBy,
      players,
      status: gameState.roomStatus,
      maxPlayers: gameState.config.playerCount,
      playerColorOrder: shufflePlayerColorOrder(),
    };
  }

  private generateUniqueRoomId(): string {
    let roomId = '';
    do {
      // Retry until we get an unused join code.
      roomId = this.generateRoomId();
    } while (this.rooms.has(roomId));
    return roomId;
  }

  private generateRoomId(): string {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let output = '';
    for (let i = 0; i < 6; i += 1) {
      output += chars[Math.floor(Math.random() * chars.length)];
    }
    return output;
  }

  private generatePlayerId(): string {
    return `p_${Math.random().toString(36).slice(2, 10)}`;
  }

  private pickRandomAvatar(excludedAvatars: string[]): string {
    const available = AVATAR_POOL.filter((avatar) => !excludedAvatars.includes(avatar));
    if (available.length === 0) {
      return AVATAR_POOL[0];
    }
    const randomIndex = Math.floor(Math.random() * available.length);
    return available[randomIndex];
  }
}

function roomIdFromState(gameState: GameState): string {
  // In current contracts, roomCode is the canonical lookup key for both room and game state maps.
  return gameState.roomCode;
}
