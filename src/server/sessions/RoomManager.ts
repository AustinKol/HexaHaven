import type { Room, RoomPlayer } from './Room';

export class RoomManager {
  private readonly rooms = new Map<string, Room>();

  createRoom(hostName: string): { room: Room; player: RoomPlayer } {
    const roomId = this.generateUniqueRoomId();
    const hostPlayer: RoomPlayer = {
      id: this.generatePlayerId(),
      name: hostName.trim(),
    };
    const room: Room = {
      id: roomId,
      hostId: hostPlayer.id,
      players: [hostPlayer],
      status: 'waiting',
    };
    this.rooms.set(roomId, room);
    return { room, player: hostPlayer };
  }

  joinRoom(roomId: string, playerName: string): { room: Room; player: RoomPlayer } | null {
    const room = this.rooms.get(roomId);
    if (!room || room.players.length >= 2) {
      return null;
    }
    const player: RoomPlayer = {
      id: this.generatePlayerId(),
      name: playerName.trim(),
    };
    room.players.push(player);
    return { room, player };
  }

  getRoom(roomId: string): Room | null {
    return this.rooms.get(roomId) ?? null;
  }

  private generateUniqueRoomId(): string {
    let roomId = '';
    do {
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
}
