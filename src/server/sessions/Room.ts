import type { RoomStatus } from '../../shared/types/domain';

export interface RoomPlayer {
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
}

export type { RoomStatus };

export interface Room {
  id: string;
  hostId: string;
  players: RoomPlayer[];
  status: RoomStatus;
  maxPlayers: number;
}
