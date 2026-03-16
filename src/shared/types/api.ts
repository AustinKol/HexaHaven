import type { RoomStatus } from './domain';

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface RoomSnapshot {
  roomId: string;
  status: RoomStatus;
  players: Array<{
    id: string;
    name: string;
    avatar: string;
    points: number;
  }>;
}
