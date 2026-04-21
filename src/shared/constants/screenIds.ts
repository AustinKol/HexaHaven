export const ScreenId = {
  Entry: 'entry',
  MainMenu: 'main-menu',
  HostGame: 'host-game',
  JoinGame: 'join-game',
  WaitingRoom: 'waiting-room',
  GameBoard: 'game-board',
  Settings: 'settings',
  Rules: 'rules',
  TestMapGen: 'test-map-gen',
} as const;

export type ScreenId = (typeof ScreenId)[keyof typeof ScreenId];
