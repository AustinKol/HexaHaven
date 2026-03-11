import type { RoomStatus } from '../../shared/types/domain';

export interface RoomPlayer {
  id: string;
  name: string;
}

export { RoomStatus };

export interface Room {
  id: string;
  hostId: string;
  players: RoomPlayer[];
  status: RoomStatus;
}
