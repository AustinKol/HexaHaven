import type { RoomStatus } from '../../shared/types/domain';

export interface RoomPlayer {
  id: string;
  name: string;
  avatar: string;
  points: number;
}

export { RoomStatus };

export interface Room {
  id: string;
  hostId: string;
  players: RoomPlayer[];
  status: RoomStatus;
}
