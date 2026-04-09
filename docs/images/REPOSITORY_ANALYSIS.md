# HexaHaven - Repository Analysis

> **Generated:** April 1, 2026  
> **Repo:** HexaHaven  
> **Branch:** main  
> **Tech Stack:** TypeScript, Phaser 3, Vite, Express, Socket.IO, Firebase/Firestore, Tailwind CSS

---

## Table of Contents

1. [Project Overview](#project-overview)
2. [Architecture](#architecture)
3. [Directory Structure](#directory-structure)
4. [Configuration Files](#configuration-files)
5. [Entry Points](#entry-points)
6. [Shared Code (`src/shared/`)](#shared-code)
7. [Client Code (`src/client/`)](#client-code)
8. [Game Code (`src/game/`)](#game-code)
9. [Server Code (`src/server/`)](#server-code)
10. [Static Assets](#static-assets)

---

## Project Overview

HexaHaven is a **turn-based multiplayer hex strategy game** (Settlers of Catan-inspired) built as a COMP 361 university project. Players host/join rooms via a 6-character game key, compete on a procedurally generated hexagonal map, roll dice to collect resources, and build roads, settlements, cities, and dev cards to earn Victory Points. First to 10 VP wins.

**Key Features:**
- 2-4 player multiplayer via Socket.IO
- Procedural hex map generation using simplex noise
- Server-authoritative game state with real-time sync
- Firebase Firestore persistence layer (read-only from client)
- Phaser 3-based map rendering with per-biome detail overlays
- Tailwind CSS + vanilla DOM for menu/lobby UI
- Background music with per-screen volume control

---

## Architecture

```
Browser (Client)                          Node.js (Server)
  ┌──────────────┐                       ┌──────────────────┐
  │ Vite + TS    │ ──── Socket.IO ────── │ Express + Socket │
  │ Phaser 3     │ ──── REST /api/ ───── │ GameEngine       │
  │ Tailwind CSS │                       │ RoomManager      │
  └──────────────┘                       │ Firestore (Admin)│
                                         └──────────────────┘
```

- **Client** runs at `localhost:8080` (Vite dev server, proxies `/api` and `/socket.io` to the server).
- **Server** runs at `localhost:3000` (Express + Socket.IO).
- **Shared** types/constants are imported by both client and server.
- **Firestore** is used for persistence. Clients have read-only access; all writes go through the server via Firebase Admin SDK.

---

## Directory Structure

```
HexaHaven/
├── dist/                     # Production build output
├── docs/                     # Design & spec documents, demo plans
├── public/                   # Static assets (audio, avatars, fonts, images, videos)
├── src/
│   ├── main.ts               # Client entry point
│   ├── vite-env.d.ts         # Vite type declarations
│   ├── client/               # Browser-side code (DOM UI, networking, audio, state)
│   │   ├── app/              # App shell & screen registry
│   │   ├── audio/            # Menu & game music management
│   │   ├── bootstrap/        # Client startup
│   │   ├── config/           # Client env vars & Firebase config
│   │   ├── input/            # Input handler registry (stub)
│   │   ├── networking/       # Socket.IO client, REST API client
│   │   ├── rendering/        # Canvas/Renderer roots (stubs)
│   │   ├── screens/          # All UI screens (Entry, MainMenu, Host, Join, etc.)
│   │   ├── settings/         # Game settings (volume, SFX) with localStorage
│   │   ├── state/            # Client-side reactive state (clientState, lobbyState)
│   │   ├── styles/           # Tailwind CSS entry + custom fonts
│   │   └── ui/               # Reusable UI components (music toggle button)
│   ├── game/                 # Phaser 3 game scenes (legacy/alternate entry)
│   │   ├── main.ts           # Phaser game config
│   │   └── scenes/           # MainMenu & MapGenTest scenes
│   ├── server/               # Node.js server
│   │   ├── main.ts           # Server entry point
│   │   ├── createServer.ts   # Express + Socket.IO assembly
│   │   ├── config/           # Server env, Firebase Admin init
│   │   ├── engine/           # GameEngine & TurnManager (core game logic)
│   │   ├── http/             # REST API routes (health, rooms)
│   │   ├── persistence/      # Firestore repositories (board, game sessions, players, turns)
│   │   ├── realtime/         # Socket.IO server & event handlers
│   │   ├── sessions/         # In-memory Room & RoomManager
│   │   └── utils/            # Logger
│   └── shared/               # Code shared by client & server
│       ├── constants/        # API routes, screen IDs, socket event names
│       ├── schemas/          # Re-exports of domain types
│       └── types/            # Domain types, API types, socket types, persistence types
├── index.html                # HTML shell
├── package.json
├── vite.config.ts
├── tsconfig.json / tsconfig.client.json / tsconfig.server.json
├── firebase.json / firestore.rules / firestore.indexes.json / .firebaserc
└── .env.example
```

---

## Configuration Files

### `package.json`
**Description:** Project manifest. Defines scripts, dependencies, and metadata.

```json
{
    "name": "hexahaven",
    "description": "HexaHaven - COMP 361 project",
    "version": "0.1.0",
    "private": true,
    "license": "MIT",
    "scripts": {
        "dev": "concurrently -n client,server -c blue,green \"vite\" \"tsx watch src/server/main.ts\"",
        "dev:client": "vite",
        "dev:server": "tsx watch src/server/main.ts",
        "build": "vite build"
    },
    "devDependencies": {
        "@types/cors": "^2.8.17",
        "@types/express": "^5.0.0",
        "@types/node": "^22.13.0",
        "concurrently": "^9.1.2",
        "tsx": "^4.19.0",
        "typescript": "~5.7.2",
        "vite": "^6.3.1"
    },
    "dependencies": {
        "@tailwindcss/vite": "^4.1.18",
        "cors": "^2.8.5",
        "express": "^4.21.0",
        "firebase-admin": "^13.7.0",
        "phaser": "^3.90.0",
        "simplex-noise": "^4.0.2",
        "socket.io": "^4.8.0",
        "socket.io-client": "^4.8.0",
        "tailwindcss": "^4.1.18",
        "terser": "^5.39.0"
    }
}
```

### `vite.config.ts`
**Description:** Vite build configuration. Sets dev port to 8080, proxies `/api` and `/socket.io` to the Express server at port 3000. Uses Tailwind CSS plugin.

```ts
import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  root: '.',
  base: './',
  server: {
    port: 8080,
    proxy: {
      '/api': 'http://localhost:3000',
      '/socket.io': {
        target: 'http://localhost:3000',
        ws: true,
      },
    },
  },
  plugins: [tailwindcss()],
});
```

### `tsconfig.json`
**Description:** Root TypeScript config covering all source code. Strict mode enabled, ES2020 target, bundler module resolution.

### `tsconfig.client.json`
**Description:** Client-specific TS config. Includes `src/client`, `src/shared`, `src/main.ts`, and `src/vite-env.d.ts`. Adds DOM lib types.

### `tsconfig.server.json`
**Description:** Server-specific TS config. Includes `src/server` and `src/shared`. Excludes DOM libs, adds Node types.

### `firebase.json`
**Description:** Firebase project config pointing to Firestore rules and indexes files.

```json
{
  "firestore": {
    "rules": "firestore.rules",
    "indexes": "firestore.indexes.json"
  }
}
```

### `firestore.rules`
**Description:** Firestore security rules. Server-authoritative architecture: all client writes are denied. Clients get read access on game/player/board/turn data. Games with `isDeleted: true` are hidden from reads.

```
rules_version = '2';

service cloud.firestore {
  match /databases/{database}/documents {

    match /games/{gameId} {
      allow read: if resource == null || !resource.data.isDeleted;
      allow write: if false;

      match /players/{playerId} {
        allow read: if true;
        allow write: if false;
      }

      match /board/{document=**} {
        allow read: if true;
        allow write: if false;
      }

      match /turns/{turnId} {
        allow read: if true;
        allow write: if false;
      }
    }

    match /users/{userId} {
      allow read: if true;
      allow write: if false;

      match /activeGames/{gameId} {
        allow read: if true;
        allow write: if false;
      }
    }

    match /{document=**} {
      allow read, write: if false;
    }
  }
}
```

### `firestore.indexes.json`
**Description:** Composite Firestore indexes for efficient queries on games (by roomCode), turns (by turnNumber), structures (by owner), and activeGames (by lastAccessedAt).

```json
{
  "indexes": [
    {
      "collectionGroup": "games",
      "queryScope": "COLLECTION",
      "fields": [
        { "fieldPath": "roomCode",  "order": "ASCENDING" },
        { "fieldPath": "isDeleted", "order": "ASCENDING" }
      ]
    },
    {
      "collectionGroup": "turns",
      "queryScope": "COLLECTION",
      "fields": [
        { "fieldPath": "turnNumber", "order": "ASCENDING" }
      ]
    },
    {
      "collectionGroup": "structures",
      "queryScope": "COLLECTION",
      "fields": [
        { "fieldPath": "ownerPlayerId", "order": "ASCENDING" }
      ]
    },
    {
      "collectionGroup": "activeGames",
      "queryScope": "COLLECTION",
      "fields": [
        { "fieldPath": "lastAccessedAt", "order": "DESCENDING" }
      ]
    }
  ],
  "fieldOverrides": []
}
```

### `.firebaserc`
**Description:** Maps the default Firebase project to `hexahaven-67429`.

### `.env.example`
**Description:** Template for environment variables. Documents server port, Firebase Admin SDK credential options (service account JSON or file path), Firebase client SDK config keys, and client-to-server URL.

### `index.html`
**Description:** HTML shell. Mounts the app into `<div id="app">` and loads `src/main.ts` as a module.

```html
<!doctype html>
<html lang="en">
<head>
    <meta charset="UTF-8" />
    <link rel="icon" type="image/png" href="/favicon.png" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>HexaHaven</title>
</head>
<body>
    <div id="app"></div>
    <script type="module" src="/src/main.ts"></script>
</body>
</html>
```

---

## Entry Points

### `src/main.ts`
**Description:** The browser entry point. Imports the global CSS file and calls `startClient()` to boot the application.

```ts
import './client/styles/index.css';
import { startClient } from './client/bootstrap/startClient';

startClient();
```

### `src/server/main.ts`
**Description:** The server entry point. Initializes Firestore, builds the Express+Socket.IO server, and starts listening.

```ts
import { buildServer } from './createServer';
import { ServerEnv } from './config/env';
import { initFirestore } from './config/firebaseAdmin';
import { logger } from './utils/logger';

// Initialize Firestore before the server starts accepting requests.
initFirestore();

const { httpServer } = buildServer();

httpServer.listen(ServerEnv.port, () => {
  logger.info(`Server listening on port ${ServerEnv.port}`);
});
```

---

## Shared Code

### `src/shared/types/domain.ts`
**Description:** **FROZEN** domain type definitions shared by client and server. Defines all core game types: `RoomStatus`, `GamePhase`, `ResourceType`, `ResourceBundle`, `DiceRoll`, `GameConfig`, `PlayerState`, `PlayerStats`, `Goal`, `TileState`, `StructureState`, `BoardState`, `TurnState`, and the master `GameState` interface. This is the single source of truth for the game's data model.

```ts
// FROZEN -- see Demo_1_Instructions.md Section 3
// Do not modify without whole-team agreement.

// ─── 3.1 Frozen enums ───────────────────────────────────────────────

export type RoomStatus = 'waiting' | 'in_progress' | 'finished';

export type GamePhase = 'ROLL' | 'COLLECT' | 'ACTION' | 'END';

export type ClientRole = 'PLAYER' | 'SPECTATOR';

export type ResourceType = 'CRYSTAL' | 'STONE' | 'BLOOM' | 'EMBER' | 'GOLD';

export type StructureType = 'ROAD' | 'SETTLEMENT' | 'GARDEN';

export type LocationType = 'EDGE' | 'VERTEX';

export type TurnRecordStatus = 'in_progress' | 'completed';

// ─── 3.2 Frozen GameState shape ─────────────────────────────────────

export interface ResourceBundle {
  CRYSTAL: number;
  STONE: number;
  BLOOM: number;
  EMBER: number;
  GOLD: number;
}

export interface DiceRoll {
  d1Val: number;
  d2Val: number;
  sum: number;
  rolledAt: string; // ISO string in app layer
}

export interface GameConfig {
  playerCount: number;
  goalCount: number;
  winRule: 'ALL_GOALS_COMPLETE' | 'ANY_X_GOALS_COMPLETE' | 'FIRST_TO_X_POINTS';
  mapSeed: number;
  mapSize: 'small' | 'medium' | 'large';
  timerEnabled: boolean;
  turnTimeSec: number | null;
  allowReroll: boolean;
  startingResources: ResourceBundle;
}

export interface PresenceInfo {
  isConnected: boolean;
  lastSeenAt: string;
  connectionId: string;
}

export interface PlayerStats {
  publicVP: number;
  settlementsBuilt: number;
  roadsBuilt: number;
  totalResourcesCollected: number;
  totalResourcesSpent: number;
  longestRoadLength: number;
  turnsPlayed: number;
}

export interface Goal {
  goalId: string;
  type: 'UPGRADE_SETTLEMENT' | 'ROAD_PATH' | 'COLLECT_RESOURCE';
  params: Record<string, unknown>;
  completed: boolean;
  completedAtTurn: number;
  description: string;
  progress: number;
  targetValue: number;
}

export interface PlayerState {
  playerId: string;
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  color: string;
  isHost: boolean;
  resources: ResourceBundle;
  goals: Goal[];
  stats: PlayerStats;
  presence: PresenceInfo;
  joinedAt: string;
  updatedAt: string;
}

export interface HexCoord {
  q: number;
  r: number;
}

export interface VertexLocation {
  id: string;
  hex: HexCoord;
  corner: number;
  adjacentHexes: HexCoord[];
}

export interface EdgeLocation {
  id: string;
  hex: HexCoord;
  dir: number;
  adjacentHexes: HexCoord[];
}

export interface RoadPath {
  connectedRoads: string[];
  pathLength: number;
}

export interface TileState {
  tileId: string;
  coord: HexCoord;
  resourceType: ResourceType | 'DESERT';
  numberToken: number | null;
  adjacentTiles: string[];
  vertices: string[];
  edges: string[];
  createdAt: string;
}

export interface StructureState {
  structureId: string;
  ownerPlayerId: string;
  ownerName: string;
  ownerColor: string;
  type: StructureType;
  level: number;
  locationType: LocationType;
  vertex: VertexLocation | null;
  edge: EdgeLocation | null;
  adjacentStructures: string[];
  adjacentTiles: string[];
  builtAtTurn: number;
  builtAt: string;
  cost: ResourceBundle;
  roadPath: RoadPath | null;
}

export interface BoardState {
  tilesById: Record<string, TileState>;
  structuresById: Record<string, StructureState>;
}

export interface TurnState {
  currentTurn: number;
  currentPlayerId: string | null;
  currentPlayerIndex: number | null;
  phase: GamePhase | null;
  turnStartedAt: string | null;
  turnEndsAt: string | null;
  lastDiceRoll: DiceRoll | null;
}

export interface GameState {
  gameId: string;
  roomCode: string;
  roomStatus: RoomStatus;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  isDeleted: boolean;
  winnerPlayerId: string | null;
  config: GameConfig;
  playerOrder: string[];
  playersById: Record<string, PlayerState>;
  board: BoardState;
  turn: TurnState;
}
```

### `src/shared/types/socket.ts`
**Description:** **FROZEN** Socket.IO typed event interfaces. Defines all client-to-server and server-to-server event signatures, request/response payloads, and error codes. Used by both client and server for type-safe socket communication.

```ts
// FROZEN -- see Demo_1_Instructions.md Section 3.3

import type { ClientRole, GameConfig, GameState } from './domain';

export interface AckError {
  code:
    | 'INVALID_CONFIGURATION'
    | 'SESSION_NOT_FOUND'
    | 'PLAYER_CAPACITY_EXCEEDED'
    | 'NOT_HOST'
    | 'NOT_ACTIVE_PLAYER'
    | 'INVALID_PHASE'
    | 'MANDATORY_ACTION_INCOMPLETE'
    | 'INTERNAL_ERROR';
  message: string;
  details?: Record<string, unknown>;
}

export type SocketAck<T> =
  | { ok: true; data: T }
  | { ok: false; error: AckError };

export interface CreateGameRequest {
  displayName: string;
  config: GameConfig;
}

export interface JoinGameRequest {
  joinCode: string;
  displayName: string;
  role: ClientRole;
}

export interface StartGameRequest { gameId: string; }
export interface RollDiceRequest  { gameId: string; }
export interface EndTurnRequest   { gameId: string; }

export interface CreateGameAckData {
  clientId: string;
  playerId: string;
  role: 'PLAYER';
  gameState: GameState;
}

export interface JoinGameAckData {
  clientId: string;
  playerId: string;
  role: ClientRole;
  gameState: GameState;
}

export interface SimpleActionAckData { gameState: GameState; }

export interface ActionRejectedEvent {
  code: AckError['code'];
  message: string;
  details?: Record<string, unknown>;
}

export interface ServerToClientEvents {
  GAME_STATE_UPDATE: (gameState: GameState) => void;
  ACTION_REJECTED: (event: ActionRejectedEvent) => void;
}

export interface ClientToServerEvents {
  CREATE_GAME: (request: CreateGameRequest, ack: (response: SocketAck<CreateGameAckData>) => void) => void;
  JOIN_GAME: (request: JoinGameRequest, ack: (response: SocketAck<JoinGameAckData>) => void) => void;
  START_GAME: (request: StartGameRequest, ack: (response: SocketAck<SimpleActionAckData>) => void) => void;
  ROLL_DICE: (request: RollDiceRequest, ack: (response: SocketAck<SimpleActionAckData>) => void) => void;
  END_TURN: (request: EndTurnRequest, ack: (response: SocketAck<SimpleActionAckData>) => void) => void;
}
```

### `src/shared/types/api.ts`
**Description:** REST API response types. `ApiResponse<T>` wraps success/error responses. `RoomSnapshot` represents a room's public state for the REST API.

```ts
import type { RoomStatus } from './domain';

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface RoomSnapshot {
  roomId: string;
  status: RoomStatus;
  maxPlayers: number;
  players: Array<{
    id: string;
    name: string;
    avatar: string;
    points: number;
    resources: { ember: number; gold: number; stone: number; bloom: number; crystal: number; };
  }>;
}
```

### `src/shared/types/persistence.ts`
**Description:** **DEPRECATED** persistence types from before the frozen GameState shape. Kept for reference but not used for new code.

### `src/shared/constants/socketEvents.ts`
**Description:** **FROZEN** socket event name constants. `CLIENT_EVENTS`: `CREATE_GAME`, `JOIN_GAME`, `START_GAME`, `ROLL_DICE`, `END_TURN`. `SERVER_EVENTS`: `GAME_STATE_UPDATE`, `ACTION_REJECTED`.

```ts
export const SocketEvents = {
  Connection: 'connection',
  Disconnect: 'disconnect',
} as const;

export const CLIENT_EVENTS = {
  CREATE_GAME: 'CREATE_GAME',
  JOIN_GAME: 'JOIN_GAME',
  START_GAME: 'START_GAME',
  ROLL_DICE: 'ROLL_DICE',
  END_TURN: 'END_TURN',
} as const;

export const SERVER_EVENTS = {
  GAME_STATE_UPDATE: 'GAME_STATE_UPDATE',
  ACTION_REJECTED: 'ACTION_REJECTED',
} as const;
```

### `src/shared/constants/apiRoutes.ts`
**Description:** REST API route constants shared by client and server.

```ts
export const ApiRoutes = {
  Health: '/api/health',
  HostRoom: '/api/rooms/host',
  JoinRoom: '/api/rooms/join',
  StartRoom: '/api/rooms/start',
  RoomStatus: '/api/rooms',
  LeaveRoom: '/api/rooms/leave',
} as const;
```

### `src/shared/constants/screenIds.ts`
**Description:** Screen identifier constants used by the client's screen navigation system.

```ts
export const ScreenId = {
  Entry: 'entry',
  MainMenu: 'main-menu',
  HostGame: 'host-game',
  JoinGame: 'join-game',
  WatchGame: 'watch-game',
  WaitingRoom: 'waiting-room',
  GameBoard: 'game-board',
  Result: 'result',
  Settings: 'settings',
  Rules: 'rules',
  TestMapGen: 'test-map-gen',
} as const;

export type ScreenId = (typeof ScreenId)[keyof typeof ScreenId];
```

### `src/shared/schemas/board.ts`, `game.ts`, `player.ts`
**Description:** Re-export modules. They simply re-export types from `domain.ts` for convenience.

---

## Client Code

### `src/client/bootstrap/startClient.ts`
**Description:** Client bootstrap. Grabs the `#app` DOM element and creates a new `App` instance to kick off the UI.

```ts
import { App } from '../app/App';

export function startClient(): void {
  const root = document.getElementById('app');
  if (!root) throw new Error('Missing #app element');
  const app = new App(root);
  app.start();
}
```

### `src/client/app/App.ts`
**Description:** The main application shell. Manages screen lifecycle (register, show, destroy) and controls menu music (stops music on game board and test map screens, plays it on all other screens).

```ts
import { ScreenId as ScreenIds, type ScreenId } from '../../shared/constants/screenIds';
import { EntryScreen } from '../screens/EntryScreen';
import { startMenuMusic, stopMenuMusic } from '../audio/menuMusic';
import { GameBoardScreen } from '../screens/GameBoardScreen';
import { HostGameScreen } from '../screens/HostGameScreen';
import { JoinGameScreen } from '../screens/JoinGameScreen';
import { MainMenuScreen } from '../screens/MainMenuScreen';
import { RulesScreen } from '../screens/RulesScreen';
import { SettingsScreen } from '../screens/SettingsScreen';
import { TestMapGenScreen } from '../screens/TestMapGenScreen';
import { WaitingRoomScreen } from '../screens/WaitingRoomScreen';
import { WatchGameScreen } from '../screens/WatchGameScreen';
import { getScreen, registerScreen } from './ScreenRegistry';

interface AppScreen {
  render?: (parentElement: HTMLElement, onComplete?: () => void, navigate?: (screenId: ScreenId) => void) => void;
  destroy?: () => void;
}

export class App {
  private currentScreen: AppScreen | null = null;
  private readonly noMenuMusicScreens = new Set<ScreenId>([
    ScreenIds.TestMapGen,
    ScreenIds.GameBoard,
  ]);

  constructor(private root: HTMLElement) {
    this.initializeScreens();
  }

  private initializeScreens(): void {
    registerScreen('entry', new EntryScreen());
    registerScreen('main-menu', new MainMenuScreen());
    registerScreen('host-game', new HostGameScreen());
    registerScreen('join-game', new JoinGameScreen());
    registerScreen('watch-game', new WatchGameScreen());
    registerScreen('waiting-room', new WaitingRoomScreen());
    registerScreen('game-board', new GameBoardScreen());
    registerScreen('settings', new SettingsScreen());
    registerScreen('rules', new RulesScreen());
    registerScreen('test-map-gen', new TestMapGenScreen());
  }

  start(): void {
    this.root.dataset.ready = 'true';
    this.showScreen('entry', () => this.showScreen('main-menu'));
  }

  showScreen(screenId: ScreenId, onComplete?: () => void): void {
    if (this.noMenuMusicScreens.has(screenId)) {
      stopMenuMusic();
    } else {
      startMenuMusic();
    }
    if (this.currentScreen?.destroy) {
      this.currentScreen.destroy();
    }
    const screen = getScreen(screenId) as AppScreen | undefined;
    if (screen) {
      this.currentScreen = screen;
      const navigate = (nextScreenId: ScreenId) => this.showScreen(nextScreenId);
      if (typeof screen.render === 'function') {
        screen.render(this.root, onComplete, navigate);
      }
    }
  }
}
```

### `src/client/app/ScreenRegistry.ts`
**Description:** Simple Map-based registry for screen instances keyed by `ScreenId`.

```ts
import type { ScreenId } from '../../shared/constants/screenIds';

const screens = new Map<ScreenId, unknown>();

export function registerScreen(id: ScreenId, screen: unknown): void {
  screens.set(id, screen);
}

export function getScreen(id: ScreenId): unknown | undefined {
  return screens.get(id);
}
```

### `src/client/config/env.ts`
**Description:** Client environment config. Reads the server URL from Vite's `import.meta.env`.

```ts
export const ClientEnv = {
  serverUrl: import.meta.env.VITE_SERVER_URL ?? 'http://localhost:3000',
} as const;
```

### `src/client/config/firebaseConfig.ts`
**Description:** Firebase client SDK configuration. Reads all Firebase config values from Vite env vars.

```ts
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY ?? '',
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN ?? '',
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID ?? '',
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET ?? '',
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID ?? '',
  appId: import.meta.env.VITE_FIREBASE_APP_ID ?? '',
} as const;

export default firebaseConfig;
```

### `src/client/audio/menuMusic.ts`
**Description:** Menu music manager. Handles play/pause lifecycle, autoplay retry on user interaction, volume sync with game settings, and enable/disable toggling.

```ts
import { SETTINGS_CHANGED_EVENT } from '../settings/gameSettings';
import { BASE_MENU_MUSIC_VOLUME, scaledMusicVolume } from './musicVolume';

let menuMusic: HTMLAudioElement | null = null;
let listenersBound = false;
let shouldBePlayingForScreen = false;
let isEnabledByUser = true;

function syncMenuMusicGain(): void {
  if (!menuMusic) return;
  menuMusic.volume = scaledMusicVolume(BASE_MENU_MUSIC_VOLUME);
}

function getMenuMusic(): HTMLAudioElement {
  if (!menuMusic) {
    menuMusic = new Audio('/audio/menu-music.mp3');
    menuMusic.loop = true;
    syncMenuMusicGain();
  }
  return menuMusic;
}

export function refreshMenuMusicVolume(): void {
  getMenuMusic();
  syncMenuMusicGain();
}

window.addEventListener(SETTINGS_CHANGED_EVENT, syncMenuMusicGain);

function tryPlay(): void {
  if (!shouldBePlayingForScreen || !isEnabledByUser) return;
  const audio = getMenuMusic();
  void audio.play().catch(() => {});
}

function bindInteractionRetry(): void {
  if (listenersBound) return;
  listenersBound = true;
  const retry = () => { tryPlay(); };
  window.addEventListener('pointerdown', retry);
  window.addEventListener('keydown', retry);
}

export function startMenuMusic(): void {
  shouldBePlayingForScreen = true;
  bindInteractionRetry();
  tryPlay();
}

export function stopMenuMusic(): void {
  shouldBePlayingForScreen = false;
  if (!menuMusic) return;
  menuMusic.pause();
  menuMusic.currentTime = 0;
}

export function isMenuMusicEnabled(): boolean { return isEnabledByUser; }

export function setMenuMusicEnabled(enabled: boolean): void {
  isEnabledByUser = enabled;
  if (isEnabledByUser) { bindInteractionRetry(); tryPlay(); return; }
  if (!menuMusic) return;
  menuMusic.pause();
  menuMusic.currentTime = 0;
}
```

### `src/client/audio/musicVolume.ts`
**Description:** Volume scaling utilities. Provides base volume constants for menu and game board music, reads master volume from settings (0-100%), and scales appropriately.

```ts
import { loadSettings } from '../settings/gameSettings';

export const BASE_MENU_MUSIC_VOLUME = 0.5;
export const BASE_GAME_BOARD_MUSIC_VOLUME = 0.35;

export function getMasterVolumeFactor(): number {
  const raw = loadSettings().masterVolume;
  const v = typeof raw === 'number' ? raw : Number(raw);
  if (Number.isNaN(v)) return 0.8;
  return Math.max(0, Math.min(1, v / 100));
}

export function scaledMusicVolume(base: number): number {
  return Math.min(1, Math.max(0, base * getMasterVolumeFactor()));
}
```

### `src/client/settings/gameSettings.ts`
**Description:** Game settings persistence using localStorage. Stores master volume (0-100) and SFX toggle. Dispatches a custom event on `window` when settings change so audio systems can react.

```ts
const SETTINGS_KEY = 'hexahaven_settings';

export const SETTINGS_CHANGED_EVENT = 'hexahaven-settings-changed';

export interface GameSettings {
  masterVolume: number;
  sfxEnabled: boolean;
}

const DEFAULTS: GameSettings = {
  masterVolume: 80,
  sfxEnabled: true,
};

export function loadSettings(): GameSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULTS };
    const merged = { ...DEFAULTS, ...JSON.parse(raw) };
    return {
      masterVolume: typeof merged.masterVolume === 'number' ? merged.masterVolume : DEFAULTS.masterVolume,
      sfxEnabled: typeof merged.sfxEnabled === 'boolean' ? merged.sfxEnabled : DEFAULTS.sfxEnabled,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(settings: GameSettings): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  window.dispatchEvent(new Event(SETTINGS_CHANGED_EVENT));
}
```

### `src/client/state/clientState.ts`
**Description:** Reactive client-side state store. Holds the current screen, client/player IDs, role, game state, and last action rejection. Supports subscribe/unsubscribe for listener-based reactivity.

```ts
import type { ScreenId } from '../../shared/constants/screenIds';
import type { ActionRejectedEvent } from '../../shared/types/socket';
import type { ClientRole, GameState } from '../../shared/types/domain';

export interface ClientState {
  currentScreen: ScreenId | null;
  clientId: string | null;
  playerId: string | null;
  role: ClientRole | null;
  gameState: GameState | null;
  lastActionRejected: ActionRejectedEvent | null;
}

export const clientState: ClientState = {
  currentScreen: null,
  clientId: null,
  playerId: null,
  role: null,
  gameState: null,
  lastActionRejected: null,
};

export type ClientStateListener = (state: ClientState) => void;

const listeners = new Set<ClientStateListener>();

export function subscribeClientState(listener: ClientStateListener): () => void {
  listeners.add(listener);
  listener(clientState);
  return () => listeners.delete(listener);
}

export function setClientState(patch: Partial<ClientState>): void {
  Object.assign(clientState, patch);
  listeners.forEach((listener) => listener(clientState));
}

export function resetClientState(): void {
  setClientState({
    currentScreen: null, clientId: null, playerId: null,
    role: null, gameState: null, lastActionRejected: null,
  });
}
```

### `src/client/state/lobbyState.ts`
**Description:** Lobby session persistence using localStorage. Stores the current room ID, player ID, player name, and role (host/guest/spectator) so the UI can survive page refreshes.

```ts
type LobbyRole = 'host' | 'guest' | 'spectator';

export interface LobbySession {
  roomId: string;
  playerId: string;
  playerName: string;
  role: LobbyRole;
}

const STORAGE_KEY = 'hexahaven:lobby-session';

export function setLobbySession(session: LobbySession): void {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
}

export function getLobbySession(): LobbySession | null {
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw) as LobbySession; }
  catch { return null; }
}

export function clearLobbySession(): void {
  window.localStorage.removeItem(STORAGE_KEY);
}
```

### `src/client/networking/socketClient.ts`
**Description:** Socket.IO client wrapper. Manages a single socket connection with auth (gameId/playerId). Provides typed `emitWithAck` helper with timeout support. Exposes high-level functions: `createGame()`, `joinGame()`, `startGame()`, `rollDice()`, `endTurn()` that emit events and update client state on success.

```ts
import { io, type Socket } from 'socket.io-client';
import type { ClientToServerEvents, ServerToClientEvents } from '../../shared/types/socket';
import { ClientEnv } from '../config/env';
import { registerClientEvents } from './registerClientEvents';
import type {
  CreateGameAckData, CreateGameRequest,
  JoinGameAckData, JoinGameRequest,
  SimpleActionAckData, SocketAck,
} from '../../shared/types/socket';
import { setClientState } from '../state/clientState';

type TypedSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

let socket: TypedSocket | null = null;

export function getSocket(): TypedSocket | null { return socket; }

export function disconnectSocket(): void {
  if (socket) { socket.removeAllListeners(); socket.disconnect(); socket = null; }
}

export function connectSocket(auth?: { gameId?: string; playerId?: string }): TypedSocket {
  if (socket) return socket;
  socket = io(ClientEnv.serverUrl, {
    transports: ['websocket'],
    autoConnect: true,
    auth: { gameId: auth?.gameId, playerId: auth?.playerId },
  });
  registerClientEvents(socket);
  return socket;
}

function emitWithAck<T>(
  emitter: (ack: (response: SocketAck<T>) => void) => void,
  timeoutMs: number = 8000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      reject(new Error('Timed out waiting for server response.'));
    }, timeoutMs);
    emitter((response) => {
      window.clearTimeout(timer);
      if (!response.ok) {
        setClientState({ lastActionRejected: { code: response.error.code, message: response.error.message, details: response.error.details } });
        reject(new Error(response.error.message));
        return;
      }
      resolve(response.data);
    });
  });
}

export async function createGame(request: CreateGameRequest): Promise<CreateGameAckData> {
  const s = connectSocket();
  const data = await emitWithAck<CreateGameAckData>((ack) => { s.emit('CREATE_GAME', request, ack); });
  setClientState({ playerId: data.playerId, role: data.role, gameState: data.gameState, lastActionRejected: null });
  return data;
}

export async function joinGame(request: JoinGameRequest): Promise<JoinGameAckData> {
  const s = connectSocket({ gameId: request.joinCode });
  const data = await emitWithAck<JoinGameAckData>((ack) => { s.emit('JOIN_GAME', request, ack); });
  setClientState({ playerId: data.playerId, role: data.role, gameState: data.gameState, lastActionRejected: null });
  return data;
}

export async function startGame(gameId: string): Promise<SimpleActionAckData> {
  const s = connectSocket({ gameId });
  return emitWithAck<SimpleActionAckData>((ack) => { s.emit('START_GAME', { gameId }, ack); });
}

export async function rollDice(gameId: string): Promise<SimpleActionAckData> {
  const s = connectSocket({ gameId });
  return emitWithAck<SimpleActionAckData>((ack) => { s.emit('ROLL_DICE', { gameId }, ack); });
}

export async function endTurn(gameId: string): Promise<SimpleActionAckData> {
  const s = connectSocket({ gameId });
  return emitWithAck<SimpleActionAckData>((ack) => { s.emit('END_TURN', { gameId }, ack); });
}
```

### `src/client/networking/registerClientEvents.ts`
**Description:** Registers Socket.IO event listeners on the client socket. Handles `connect`, `disconnect`, `connect_error`, `GAME_STATE_UPDATE`, and `ACTION_REJECTED` events, updating client state accordingly.

```ts
import type { Socket } from 'socket.io-client';
import type { ClientToServerEvents, ServerToClientEvents } from '../../shared/types/socket';
import { setClientState } from '../state/clientState';

export function registerClientEvents(socket: Socket<ServerToClientEvents, ClientToServerEvents>): void {
  socket.on('connect', () => { setClientState({ clientId: socket.id ?? null }); });
  socket.on('disconnect', () => { setClientState({ clientId: null }); });
  socket.on('connect_error', (err) => {
    setClientState({ lastActionRejected: { code: 'INTERNAL_ERROR', message: err?.message ?? 'Unable to connect to server.' } });
  });
  socket.on('GAME_STATE_UPDATE', (gameState) => { setClientState({ gameState }); });
  socket.on('ACTION_REJECTED', (event) => { setClientState({ lastActionRejected: event }); });
}
```

### `src/client/networking/apiClient.ts`
**Description:** Simple REST API fetch wrapper that prepends the server URL.

```ts
import { ClientEnv } from '../config/env';

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${ClientEnv.serverUrl}${path}`, init);
  return res.json() as Promise<T>;
}
```

### `src/client/ui/musicToggleButton.ts`
**Description:** Reusable music toggle button component. Creates a floating circular button (bottom-right corner) with speaker on/off SVG icons. Used across menu screens.

*Summary: ~25 lines, creates a button DOM element with SVG icon, toggles menu music on click.*

### `src/client/styles/index.css`
**Description:** Global stylesheet. Imports Tailwind CSS, defines custom `@font-face` rules for "04B_30__" (pixel font for titles/UI) and "Wonderful Christmas" (serif font for rules body), and sets base body/app styles.

*Summary: Defines `.font-hexahaven-title`, `.font-hexahaven-ui`, and `.font-hexahaven-rules-body` utility classes. Sets body bg to dark, app to full viewport height.*

### `src/client/screens/EntryScreen.ts`
**Description:** Splash/loading screen shown on app startup. Displays the HexaHaven title with a hex icon, animated loading dots, and a background video. Transitions to main menu after 2 seconds.

*Summary: ~90 lines of DOM construction with Tailwind classes for a splash screen with video background, animated hex icon, "Loading..." text, and auto-transition.*

### `src/client/screens/MainMenuScreen.ts`
**Description:** Main menu screen. Displays the game title, subtitle ("Shape your haven, one turn at a time!"), and navigation buttons: Host Game, Join Game, Watch Game, How to Play, Settings, Test Map Gen. Features a background video and music toggle.

*Summary: ~95 lines. Creates primary (blue) and secondary (slate) styled buttons. Each button navigates to the corresponding screen via the `navigate` callback.*

### `src/client/screens/HostGameScreen.ts`
**Description:** Host game form. Player enters their name and selects game size (2/3/4 players). On submit, calls `createGame()` via socket, saves the lobby session, and navigates to the waiting room.

*Summary: ~140 lines. Input field for name, select dropdown for player count, Create Game Key button, Back button. Handles submit with loading state and error display.*

### `src/client/screens/JoinGameScreen.ts`
**Description:** Join game form. Player enters their name and a 6-character game key. Input auto-uppercases and filters to alphanumeric. On submit, calls `joinGame()` via socket and navigates to waiting room.

*Summary: ~125 lines. Similar structure to HostGameScreen with name input and game key input. Auto-formats key to uppercase.*

### `src/client/screens/WatchGameScreen.ts`
**Description:** Spectator entry screen. Player enters a game key, the client verifies it via REST API (`/api/rooms/:roomId`), and navigates to the game board as a spectator.

*Summary: ~120 lines. Game key input, Watch button, REST API call to verify room exists and has started.*

### `src/client/screens/WaitingRoomScreen.ts`
**Description:** Lobby waiting room. Displays the game key (click to copy), player list with avatars, capacity counter, and status messages. Host sees a "Start Game" button enabled when 2+ players have joined. Subscribes to client state for real-time player list updates. Navigates to game board when room status becomes `in_progress`.

*Summary: ~195 lines. Real-time player list rendering, copy-to-clipboard game key, start game button for host, leave button for all.*

### `src/client/screens/GameBoardScreen.ts`
**Description:** The main game board screen. Embeds a `TestMapGenScreen` (Phaser) for the hex map, overlays a Turn HUD panel (top-right) showing current player, phase, dice roll, and Roll Dice/End Turn buttons, a player info panel (top-left) showing all player cards with avatars and VP, and a bottom resource bar showing the active player's resource inventory with tap-to-select cycling and build action buttons (Road, Settlement, City, Dev Card). Handles real-time game state updates, resource selection for building, and local build cost deduction.

*Summary: ~775 lines. The largest screen file. Key gameplay logic includes:*
- *Resource selection cycling (tap resource to increment selection from 0 to owned count)*
- *Build option cost validation (`isBuildOptionReady` checks selection matches cost and player can afford it)*
- *Local game state cloning for optimistic build deductions*
- *Turn HUD with Roll Dice / End Turn via socket calls*
- *Background game music with volume control*

### `src/client/screens/SettingsScreen.ts`
**Description:** Settings screen with volume slider (range input + arrow buttons in 5% steps) and SFX toggle pill. Persists settings to localStorage and dispatches change events for live audio updates.

*Summary: ~210 lines. Volume row with left/right arrow buttons, range slider, and percentage pill. SFX row with clickable ON/OFF pill.*

### `src/client/screens/RulesScreen.ts`
**Description:** How-to-play rules screen. Renders structured game rules from a data array including paragraphs, ordered/unordered lists, and a build cost table. Scrollable panel with a "Go back" button.

*Summary: ~250 lines. Data-driven rules rendering with sections: Objective, Setup, Turn, Building Rules, Development Cards, Victory Points, End.*

### `src/client/screens/ResultScreen.ts`
**Description:** Stub screen for game results. Currently just an empty class with a screen ID.

```ts
import { ScreenId } from '../../shared/constants/screenIds';

export class ResultScreen {
  readonly id = ScreenId.Result;
}
```

### `src/client/screens/TestMapGenScreen.ts`
**Description:** Standalone hex map generation and rendering screen using Phaser 3. This is the most complex file in the codebase (~700+ lines). Generates a hexagonal grid using simplex noise with multiple octaves for elevation and moisture, assigns biomes based on a Whittaker-style classification, and renders each hex with rich per-biome detail overlays (ocean waves, beach sand, forests with trees, mountains with snow caps, ember with log stacks, crystal with faceted gems, gold with nuggets, etc.).

**Key features:**
- Seeded random number generation (mulberry32 PRNG) for deterministic maps from room codes
- Hex coordinate math (axial coords, pixel conversion, hex rounding)
- `TerrainGenerator` class with multi-octave simplex noise for elevation and moisture
- `computeBiomeScores()` Whittaker-style biome classification (STONE, BLOOM, EMBER, CRYSTAL, GOLD)
- Number token distribution across resource hexes
- Per-biome detail drawing functions (ocean, beach, desert, savannah, forest, jungle, mountain, arctic, stone, bloom, ember, crystal, gold)
- Configurable options: map seed, compact fit mode, background music, reserved bottom pixels

*Content not included in full due to length (~700+ lines of rendering/drawing code). Core logic is the terrain generation and biome classification system.*

### `src/client/input/InputRegistry.ts`
**Description:** Stub class for input handler registrations. Currently empty.

### `src/client/rendering/CanvasRoot.ts` & `RendererRoot.ts`
**Description:** Stub classes for canvas and renderer initialization. Currently empty.

---

## Game Code

### `src/game/main.ts`
**Description:** Phaser 3 game configuration and launcher. Defines a 1024x768 game with scenes: Boot, Preloader, MainMenu, Game, GameOver, MapGenTest. This appears to be the original/legacy Phaser entry point (the current app uses the DOM-based screen system instead).

```ts
import { Boot } from './scenes/Boot';
import { GameOver } from './scenes/GameOver';
import { Game as MainGame } from './scenes/Game';
import { MainMenu } from './scenes/MainMenu';
import { MapGenTest } from './scenes/MapGenTest';
import { AUTO, Game } from 'phaser';
import { Preloader } from './scenes/Preloader';

const config: Phaser.Types.Core.GameConfig = {
    type: AUTO,
    width: 1024,
    height: 768,
    parent: 'game-container',
    backgroundColor: '#028af8',
    scene: [ Boot, Preloader, MainMenu, MainGame, GameOver, MapGenTest ],
    scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH }
};

const StartGame = (parent: string) => {
    return new Game({ ...config, parent });
}

export default StartGame;
```

### `src/game/scenes/MainMenu.ts`
**Description:** Legacy Phaser MainMenu scene with background image, logo, and buttons to start the game or navigate to MapGenTest.

```ts
import { Scene, GameObjects } from 'phaser';

export class MainMenu extends Scene {
    background: GameObjects.Image;
    logo: GameObjects.Image;
    title: GameObjects.Text;

    constructor() { super('MainMenu'); }

    create() {
        this.background = this.add.image(512, 384, 'background');
        this.logo = this.add.image(512, 300, 'logo');
        this.title = this.add.text(512, 400, 'Main Menu', {
            fontFamily: 'Arial Black', fontSize: 38, color: '#ffffff',
            stroke: '#000000', strokeThickness: 8, align: 'center'
        }).setOrigin(0.5);

        const gameButton = this.add.text(512, 500, 'Start Game', {
            fontFamily: 'Arial', fontSize: 24, color: '#00ff00', backgroundColor: '#000000'
        }).setOrigin(0.5).setPadding(10).setInteractive({ useHandCursor: true });
        gameButton.on('pointerdown', () => { this.scene.start('Game'); });

        const mapGenButton = this.add.text(512, 550, 'Go to Map Gen Test', {
            fontFamily: 'Arial', fontSize: 24, color: '#00ff00', backgroundColor: '#000000'
        }).setOrigin(0.5).setPadding(10).setInteractive({ useHandCursor: true });
        mapGenButton.on('pointerdown', () => { this.scene.start('MapGenTest'); });
    }
}
```

### `src/game/scenes/MapGenTest.ts`
**Description:** Early Phaser-based hex map generation test scene. Uses simplex noise to generate elevation and moisture values, normalizes them via histogram equalization, and renders a colored hex grid using a Whittaker-style biome lookup. This is the predecessor to the more sophisticated `TestMapGenScreen.ts`.

```ts
import { Scene } from 'phaser';
import { createNoise2D } from 'simplex-noise';

interface HexState {
    cellSize: number; hexSize: number; hexWidth: number; hexHeight: number;
    cols: number; rows: number; hexPoints: number[]; frequency: number;
    hexGrid: Map<string, Hex>;
}

export class MapGenTest extends Scene {
    camera: Phaser.Cameras.Scene2D.Camera;
    background: Phaser.GameObjects.Image;
    msg_text: Phaser.GameObjects.Text;
    hex: HexState;
    hexGrid: Map<string, Hex>;

    constructor() {
        super('MapGenTest');
        this.hex = {
            cellSize: 16, hexSize: 0, hexWidth: 0, hexHeight: 0,
            cols: 0, rows: 0, hexPoints: [], frequency: 0.08,
            hexGrid: new Map<string, Hex>()
        };
        this.hexGrid = this.hex.hexGrid;
    }

    create() {
        this.camera = this.cameras.main;
        this.camera.setBackgroundColor(0x000000);
        const width = this.scale.width;
        const height = this.scale.height;

        this.hex.hexSize = this.hex.cellSize;
        this.hex.hexWidth = Math.sqrt(3) * this.hex.hexSize;
        this.hex.hexHeight = 2 * this.hex.hexSize;
        this.hex.cols = Math.ceil(width / this.hex.hexWidth) + 2;
        this.hex.rows = Math.ceil(height / (this.hex.hexSize * 1.5)) + 2;

        // Precompute hexagon vertices for pointy-top hex
        this.hex.hexPoints = (() => {
            const pts: number[] = [];
            for (let i = 0; i < 6; i++) {
                const angle = Phaser.Math.DegToRad(60 * i + 30);
                pts.push(this.hex.hexSize * Math.cos(angle), this.hex.hexSize * Math.sin(angle));
            }
            return pts;
        })();

        const elevNoise = createNoise2D();
        const moistNoise = createNoise2D();
        const gridData: Hex[] = [];

        for (let r = 0; r < this.hex.rows; r++) {
            for (let c = 0; c < this.hex.cols; c++) {
                const q = c - (r - (r & 1)) / 2;
                const r_axial = r;
                const h = new Hex(q, r_axial);
                (h as any).screenX = c * this.hex.hexWidth + (r % 2) * (this.hex.hexWidth / 2);
                (h as any).screenY = r * (this.hex.hexSize * 1.5);
                const nx = c * this.hex.frequency;
                const ny = r * this.hex.frequency;
                h.elevation = elevNoise(nx, ny);
                h.moisture = moistNoise(nx + 1000, ny + 1000);
                gridData.push(h);
                this.hexGrid.set(`${h.q},${h.r}`, h);
            }
        }

        this.normalizeValues(gridData, 'elevation');
        this.normalizeValues(gridData, 'moisture');

        gridData.forEach(h => {
            const color = this.getBiomeColor(h.elevation, h.moisture);
            this.add.polygon((h as any).screenX, (h as any).screenY, this.hex.hexPoints, color, 1);
        });
    }

    normalizeValues(list: Hex[], property: 'elevation' | 'moisture') {
        list.sort((a, b) => a[property] - b[property]);
        const total = list.length;
        list.forEach((hex, index) => { hex[property] = index / total; });
    }

    getBiomeColor(e: number, m: number): number {
        if (e < 0.3) return 0x08224b;   // Deep Ocean
        if (e < 0.35) return 0x3fa9f5;  // Shallow Water
        if (e > 0.85) {
            if (m < 0.3) return 0x555555;  // Scorched Peak
            if (m < 0.7) return 0x888888;  // Bare Mountain
            return 0xffffff;               // Snow
        }
        if (e > 0.6) {
            if (m < 0.33) return 0xd2c38e; // Desert Dunes
            if (m < 0.66) return 0x556B2F; // Shrubland
            return 0x228B22;               // Forest
        }
        if (m < 0.2) return 0xe0d2a4;  // Sand/Beach
        if (m < 0.5) return 0x90EE90;  // Grassland
        if (m < 0.8) return 0x228B22;  // Forest
        return 0x006400;               // Jungle/Swamp
    }
}

class Hex {
    q: number; r: number; s: number;
    elevation: number; moisture: number;
    constructor(q: number, r: number) {
        this.q = q; this.r = r; this.s = -q - r;
    }
}
```

---

## Server Code

### `src/server/createServer.ts`
**Description:** Assembles the Express app with CORS, JSON parsing, REST routes, and Socket.IO server. Returns the composed `app`, `httpServer`, and `io` instances.

```ts
import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import rootRouter from './http/router';
import { createSocketServer } from './realtime/socketServer';
import { registerSocketHandlers } from './realtime/registerSocketHandlers';

export function buildServer() {
  const app = express();
  app.use(cors());
  app.use(express.json());
  app.use(rootRouter);

  const httpServer = createServer(app);
  const io = createSocketServer(httpServer);
  registerSocketHandlers(io);

  return { app, httpServer, io };
}
```

### `src/server/config/env.ts`
**Description:** Server environment configuration. Reads PORT and NODE_ENV from process.env.

```ts
export const ServerEnv = {
  port: Number(process.env.PORT ?? 3000),
  nodeEnv: process.env.NODE_ENV ?? 'development',
} as const;
```

### `src/server/config/firebaseAdmin.ts`
**Description:** Firebase Admin SDK initialization. Supports three credential resolution strategies: (1) `FIREBASE_SERVICE_ACCOUNT` env var (JSON string), (2) `GOOGLE_APPLICATION_CREDENTIALS` env var (file path), (3) Application Default Credentials. Exposes `getFirestore()` for repositories to use.

```ts
import * as admin from 'firebase-admin';
import type { Firestore } from 'firebase-admin/firestore';
import { logger } from '../utils/logger';

let db: Firestore | null = null;

export function initFirestore(): void {
  if (admin.apps.length > 0) { db = admin.firestore(); return; }

  const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (serviceAccountJson) {
    try {
      const serviceAccount = JSON.parse(serviceAccountJson) as admin.ServiceAccount;
      admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
      logger.info('Firebase Admin initialized from FIREBASE_SERVICE_ACCOUNT env var.');
    } catch {
      logger.error('Failed to parse FIREBASE_SERVICE_ACCOUNT.');
      return;
    }
  } else {
    try {
      admin.initializeApp();
      logger.info('Firebase Admin initialized via GOOGLE_APPLICATION_CREDENTIALS / ADC.');
    } catch (err) {
      logger.error('Firebase Admin initialization failed.');
      logger.error(String(err));
      return;
    }
  }
  db = admin.firestore();
}

export function getFirestore(): Firestore | null { return db; }
```

### `src/server/engine/GameEngine.ts`
**Description:** Core game logic engine. Provides three operations: `startGame()` (transitions from waiting to in_progress, distributes starting resources), `rollDice()` (validates phase and active player, generates dice roll), and `endTurn()` (validates and advances to next player). Returns `EngineResult` (ok with updated state, or error).

```ts
import type { GameState, ResourceBundle } from '../../shared/types/domain';
import type { AckError } from '../../shared/types/socket';
import { TurnManager } from './TurnManager';

export type EngineResult =
  | { ok: true; gameState: GameState }
  | { ok: false; error: AckError };

const DEFAULT_STARTING_HAND: ResourceBundle = {
  CRYSTAL: 1, STONE: 1, BLOOM: 1, EMBER: 1, GOLD: 1,
};

function sumResourceBundle(bundle: ResourceBundle): number {
  return bundle.CRYSTAL + bundle.STONE + bundle.BLOOM + bundle.EMBER + bundle.GOLD;
}

export class GameEngine {
  private readonly turnManager = new TurnManager();

  startGame(gameState: GameState, startedAtIso: string = new Date().toISOString()): EngineResult {
    if (gameState.roomStatus !== 'waiting')
      return this.fail('INVALID_PHASE', 'Game can only be started while room status is waiting.');
    if (gameState.playerOrder.length < 2)
      return this.fail('INVALID_CONFIGURATION', 'Cannot start game with fewer than 2 players.');
    if (!gameState.playersById[gameState.playerOrder[0]])
      return this.fail('INVALID_CONFIGURATION', 'First player in order does not exist.');

    const startingHand: ResourceBundle =
      sumResourceBundle(gameState.config.startingResources) > 0
        ? { ...gameState.config.startingResources }
        : { ...DEFAULT_STARTING_HAND };

    const playersWithStartingHand = Object.fromEntries(
      Object.entries(gameState.playersById).map(([id, player]) => [
        id, { ...player, resources: { ...startingHand } },
      ]),
    );

    const inProgressState: GameState = {
      ...gameState, roomStatus: 'in_progress', playersById: playersWithStartingHand,
    };
    const initializedState = this.turnManager.initializeFirstTurn(inProgressState, startedAtIso);
    return { ok: true, gameState: initializedState };
  }

  rollDice(gameState: GameState, playerId: string, rolledAtIso: string = new Date().toISOString()): EngineResult {
    const validation = this.turnManager.validateCanRoll(gameState, playerId);
    if (!validation.ok) return { ok: false, error: validation.error };
    const diceRoll = this.turnManager.rollTwoDice(rolledAtIso);
    if (diceRoll.d1Val < 1 || diceRoll.d1Val > 6 || diceRoll.d2Val < 1 || diceRoll.d2Val > 6
        || diceRoll.sum < 2 || diceRoll.sum > 12 || diceRoll.sum !== (diceRoll.d1Val + diceRoll.d2Val))
      return this.fail('INTERNAL_ERROR', 'Dice roll produced an invalid result.');
    const updatedState = this.turnManager.applyRoll(gameState, diceRoll);
    return { ok: true, gameState: updatedState };
  }

  endTurn(gameState: GameState, playerId: string, startedAtIso: string = new Date().toISOString()): EngineResult {
    const validation = this.turnManager.validateCanEndTurn(gameState, playerId);
    if (!validation.ok) return { ok: false, error: validation.error };
    const updatedState = this.turnManager.advanceToNextTurn(gameState, startedAtIso);
    return { ok: true, gameState: updatedState };
  }

  private fail(code: AckError['code'], message: string): EngineResult {
    return { ok: false, error: { code, message } };
  }
}
```

### `src/server/engine/TurnManager.ts`
**Description:** Turn lifecycle manager. Handles first turn initialization, turn phase validation (ROLL -> ACTION), dice rolling, applying dice results, and advancing to the next player in round-robin order.

```ts
import type { DiceRoll, GameState } from '../../shared/types/domain';
import type { AckError } from '../../shared/types/socket';

export type TurnValidationResult =
  | { ok: true }
  | { ok: false; error: AckError };

export class TurnManager {
  initializeFirstTurn(gameState: GameState, startedAtIso: string = new Date().toISOString()): GameState {
    if (gameState.playerOrder.length === 0)
      throw new Error('Cannot initialize first turn without players.');
    return {
      ...gameState,
      turn: {
        currentTurn: 1, currentPlayerId: gameState.playerOrder[0],
        currentPlayerIndex: 0, phase: 'ROLL',
        turnStartedAt: startedAtIso, turnEndsAt: null, lastDiceRoll: null,
      },
    };
  }

  isActivePlayer(gameState: GameState, playerId: string): boolean {
    return gameState.turn.currentPlayerId === playerId;
  }

  validateCanRoll(gameState: GameState, playerId: string): TurnValidationResult {
    if (gameState.roomStatus !== 'in_progress')
      return this.fail('INVALID_PHASE', 'Cannot roll dice unless the room is in progress.');
    if (!this.isActivePlayer(gameState, playerId))
      return this.fail('NOT_ACTIVE_PLAYER', 'Only the active player can roll dice.');
    if (gameState.turn.phase !== 'ROLL')
      return this.fail('INVALID_PHASE', 'Dice can only be rolled during the ROLL phase.');
    if (gameState.turn.lastDiceRoll !== null)
      return this.fail('INVALID_PHASE', 'Dice have already been rolled this turn.');
    return { ok: true };
  }

  validateCanEndTurn(gameState: GameState, playerId: string): TurnValidationResult {
    if (gameState.roomStatus !== 'in_progress')
      return this.fail('INVALID_PHASE', 'Cannot end turn unless the room is in progress.');
    if (!this.isActivePlayer(gameState, playerId))
      return this.fail('NOT_ACTIVE_PLAYER', 'Only the active player can end the turn.');
    if (gameState.turn.lastDiceRoll === null)
      return this.fail('MANDATORY_ACTION_INCOMPLETE', 'You must roll dice before ending the turn.');
    if (gameState.turn.phase !== 'ACTION')
      return this.fail('INVALID_PHASE', 'Turn can only end during the ACTION phase.');
    return { ok: true };
  }

  advanceToNextTurn(gameState: GameState, startedAtIso: string = new Date().toISOString()): GameState {
    if (gameState.playerOrder.length === 0)
      throw new Error('Cannot advance turn without players.');
    const currentIndex = gameState.turn.currentPlayerIndex ?? -1;
    const nextPlayerIndex = (currentIndex + 1) % gameState.playerOrder.length;
    const nextPlayerId = gameState.playerOrder[nextPlayerIndex];
    return {
      ...gameState,
      turn: {
        currentTurn: gameState.turn.currentTurn + 1, currentPlayerId: nextPlayerId,
        currentPlayerIndex: nextPlayerIndex, phase: 'ROLL',
        turnStartedAt: startedAtIso, turnEndsAt: null, lastDiceRoll: null,
      },
    };
  }

  rollTwoDice(rolledAtIso: string = new Date().toISOString(), randomFn: () => number = Math.random): DiceRoll {
    const d1Val = this.rollDie(randomFn);
    const d2Val = this.rollDie(randomFn);
    return { d1Val, d2Val, sum: d1Val + d2Val, rolledAt: rolledAtIso };
  }

  applyRoll(gameState: GameState, diceRoll: DiceRoll): GameState {
    return { ...gameState, turn: { ...gameState.turn, lastDiceRoll: diceRoll, phase: 'ACTION' } };
  }

  private rollDie(randomFn: () => number): number {
    return Math.floor(randomFn() * 6) + 1;
  }

  private fail(code: AckError['code'], message: string): TurnValidationResult {
    return { ok: false, error: { code, message } };
  }
}
```

### `src/server/http/router.ts`
**Description:** Express root router. Composes health and rooms sub-routers.

```ts
import { Router } from 'express';
import healthRouter from './routes/health';
import roomsRouter from './routes/rooms';

const rootRouter = Router();
rootRouter.use(healthRouter);
rootRouter.use(roomsRouter);

export default rootRouter;
```

### `src/server/http/routes/health.ts`
**Description:** Health check endpoint at `GET /api/health`. Returns `{ status: 'ok' }`.

```ts
import { Router } from 'express';
import { ApiRoutes } from '../../../shared/constants/apiRoutes';

const healthRouter = Router();
healthRouter.get(ApiRoutes.Health, (_req, res) => {
  res.json({ status: 'ok' });
});

export default healthRouter;
```

### `src/server/http/routes/rooms.ts`
**Description:** REST API routes for room management. Provides endpoints for hosting, joining, starting, leaving rooms, and checking room status. Builds `GameState` from `Room` data and runs the `GameEngine` for start operations. Also used by the Watch Game flow for room validation.

*Summary: ~330 lines. Key endpoints:*
- `POST /api/rooms/host` - Create a room, return room snapshot + player ID
- `POST /api/rooms/join` - Join a room by key, return room snapshot + player ID
- `POST /api/rooms/start` - Start the game (host only, 2+ players required)
- `GET /api/rooms/:roomId` - Get room status snapshot
- `POST /api/rooms/leave` - Leave a room (host leaving deletes room)

### `src/server/realtime/socketServer.ts`
**Description:** Creates the Socket.IO server with CORS enabled for all origins.

```ts
import type { Server as HttpServer } from 'http';
import { Server } from 'socket.io';

export function createSocketServer(httpServer: HttpServer): Server {
  return new Server(httpServer, { cors: { origin: '*' } });
}
```

### `src/server/realtime/registerSocketHandlers.ts`
**Description:** The main Socket.IO event handler registration. Handles all client events: `CREATE_GAME`, `JOIN_GAME`, `START_GAME`, `ROLL_DICE`, `END_TURN`. Each handler validates the request, interacts with the `RoomManager` and `GameEngine`, broadcasts game state updates to all clients in the room, and sends typed ack responses. This is the real-time counterpart to the REST room routes.

*Summary: ~575 lines. Core server-side gameplay orchestration:*
- *On connection: joins the socket to the game room if auth contains gameId*
- *`CREATE_GAME`: Validates name/player count, creates room, initializes GameState, broadcasts*
- *`JOIN_GAME`: Validates join code, adds player, updates GameState, broadcasts*
- *`START_GAME`: Host-only, runs `gameEngine.startGame()`, broadcasts*
- *`ROLL_DICE`: Validates active player + phase, runs `gameEngine.rollDice()`, broadcasts*
- *`END_TURN`: Validates active player + phase, runs `gameEngine.endTurn()`, broadcasts*

### `src/server/sessions/Room.ts`
**Description:** Room and RoomPlayer type definitions. A Room has an id, hostId, player list, status, and max players. Each RoomPlayer has resources in a flat object format (ember, gold, stone, bloom, crystal).

```ts
import type { RoomStatus } from '../../shared/types/domain';

export interface RoomPlayer {
  id: string;
  name: string;
  avatar: string;
  points: number;
  resources: { ember: number; gold: number; stone: number; bloom: number; crystal: number; };
}

export interface Room {
  id: string;
  hostId: string;
  players: RoomPlayer[];
  status: RoomStatus;
  maxPlayers: number;
}
```

### `src/server/sessions/RoomManager.ts`
**Description:** In-memory room and game state manager. Handles room creation (with unique 6-char alphanumeric IDs), player joining (with random avatar assignment from a pool of 4), player leaving (host leaves = room deleted), and game state storage/retrieval.

```ts
import type { Room, RoomPlayer } from './Room';
import type { GameState } from '../../shared/types/domain';

const AVATAR_POOL = ['/avatar/avatar_1.png', '/avatar/avatar_2.png', '/avatar/avatar_3.png', '/avatar/avatar_4.png'] as const;
const MAX_PLAYERS_PER_ROOM = AVATAR_POOL.length;

export class RoomManager {
  private readonly rooms = new Map<string, Room>();
  private readonly gameStatesByRoomId = new Map<string, GameState>();

  createRoom(hostName: string, maxPlayers?: number): { room: Room; player: RoomPlayer } {
    const roomId = this.generateUniqueRoomId();
    const hostPlayer: RoomPlayer = {
      id: this.generatePlayerId(), name: hostName.trim(),
      avatar: this.pickRandomAvatar([]), points: 0,
      resources: { ember: 0, gold: 0, stone: 0, bloom: 0, crystal: 0 },
    };
    const room: Room = {
      id: roomId, hostId: hostPlayer.id, players: [hostPlayer],
      status: 'waiting', maxPlayers: maxPlayers ?? MAX_PLAYERS_PER_ROOM,
    };
    this.rooms.set(roomId, room);
    return { room, player: hostPlayer };
  }

  joinRoom(roomId: string, playerName: string): { room: Room; player: RoomPlayer } | null {
    const room = this.rooms.get(roomId);
    if (!room || room.status !== 'waiting' || room.players.length >= room.maxPlayers) return null;
    const usedAvatars = room.players.map((p) => p.avatar);
    const player: RoomPlayer = {
      id: this.generatePlayerId(), name: playerName.trim(),
      avatar: this.pickRandomAvatar(usedAvatars), points: 0,
      resources: { ember: 0, gold: 0, stone: 0, bloom: 0, crystal: 0 },
    };
    room.players.push(player);
    return { room, player };
  }

  leaveRoom(roomId: string, playerId: string): Room | null {
    const room = this.rooms.get(roomId);
    if (!room) return null;
    if (room.hostId === playerId) {
      this.rooms.delete(roomId);
      this.gameStatesByRoomId.delete(roomId);
      return null;
    }
    const updatedPlayers = room.players.filter((p) => p.id !== playerId);
    room.players.length = 0;
    room.players.push(...updatedPlayers);
    return room;
  }

  getRoom(roomId: string): Room | null { return this.rooms.get(roomId) ?? null; }

  initializeGameState(roomId: string, gameState: GameState): GameState | null {
    if (!this.rooms.has(roomId)) return null;
    const existing = this.gameStatesByRoomId.get(roomId);
    if (existing) return existing;
    this.gameStatesByRoomId.set(roomId, gameState);
    return gameState;
  }

  setGameState(roomId: string, gameState: GameState): GameState | null {
    if (!this.rooms.has(roomId)) return null;
    this.gameStatesByRoomId.set(roomId, gameState);
    return gameState;
  }

  getGameState(roomId: string): GameState | null {
    return this.gameStatesByRoomId.get(roomId) ?? null;
  }

  private generateUniqueRoomId(): string {
    let roomId = '';
    do { roomId = this.generateRoomId(); } while (this.rooms.has(roomId));
    return roomId;
  }

  private generateRoomId(): string {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let output = '';
    for (let i = 0; i < 6; i++) output += chars[Math.floor(Math.random() * chars.length)];
    return output;
  }

  private generatePlayerId(): string {
    return `p_${Math.random().toString(36).slice(2, 10)}`;
  }

  private pickRandomAvatar(excludedAvatars: string[]): string {
    const available = AVATAR_POOL.filter((a) => !excludedAvatars.includes(a));
    if (available.length === 0) return AVATAR_POOL[0];
    return available[Math.floor(Math.random() * available.length)];
  }
}
```

### `src/server/sessions/roomManagerSingleton.ts`
**Description:** Singleton instance of `RoomManager` shared across the server.

```ts
import { RoomManager } from './RoomManager';
export const roomManager = new RoomManager();
```

### `src/server/sessions/presence.ts`
**Description:** Stub class for player presence tracking. Currently empty.

```ts
export class PresenceTracker {
  // Player presence tracking will be added here.
}
```

### `src/server/utils/logger.ts`
**Description:** Simple logger utility wrapping `console.log`, `console.warn`, and `console.error` with level prefixes.

```ts
export const logger = {
  info: (...args: unknown[]) => console.log('[INFO]', ...args),
  warn: (...args: unknown[]) => console.warn('[WARN]', ...args),
  error: (...args: unknown[]) => console.error('[ERROR]', ...args),
};
```

### `src/server/persistence/FirestoreRepository.ts`
**Description:** Base class for all Firestore repositories. Provides a `db` getter that retrieves the initialized Firestore instance or throws if not initialized.

```ts
import type { Firestore } from 'firebase-admin/firestore';
import { getFirestore } from '../config/firebaseAdmin';

export class FirestoreRepository {
  protected get db(): Firestore {
    const db = getFirestore();
    if (!db) throw new Error('Firestore is not initialized. Call initFirestore() at server startup.');
    return db;
  }
}
```

### `src/server/persistence/gameSessionsRepository.ts`
**Description:** Firestore repository for game session documents (`/games/{gameId}`). Supports CRUD operations: create game, get by ID or room code, update status/turn state/player order, finalize game (set winner), and soft-delete.

*Summary: ~165 lines. Key methods:*
- `createGame()` - Creates a new game doc with initial turn state
- `getGame()` / `getGameByRoomCode()` - Fetch game by ID or room code
- `roomCodeExists()` - Uniqueness check
- `updateGameStatus()` / `updateTurnState()` / `updatePlayerOrder()` - Partial updates
- `finalizeGame()` - Transaction-based winner + finished status update
- `softDelete()` - Sets isDeleted flag

### `src/server/persistence/boardRepository.ts`
**Description:** Firestore repository for board data (`/games/{gameId}/board/state/tiles/{tileId}` and `.../structures/{structureId}`). Handles batch tile initialization, tile/structure CRUD, and owner-based structure queries.

*Summary: ~95 lines. Key methods:*
- `initTiles()` - Batch-writes all tiles (splits at 400 ops per batch)
- `getTiles()` - Returns all tiles keyed by tileId
- `upsertStructure()` / `updateStructure()` / `getStructures()` / `getStructuresByOwner()`

### `src/server/persistence/playersRepository.ts`
**Description:** Firestore repository for player data (`/games/{gameId}/players/{playerId}`) and user profiles (`/users/{userId}`). Manages player CRUD, resource/stats/goals/presence updates, active game tracking, and user profile upserts.

*Summary: ~155 lines. Key methods:*
- `createPlayer()` / `getPlayer()` / `getPlayers()` - Player CRUD within a game
- `updateResources()` / `updateStats()` / `updateGoals()` / `updatePresence()` - Partial updates
- `addActiveGame()` / `updateActiveGame()` / `getActiveGames()` - User's active game list
- `upsertUser()` - User profile management

### `src/server/persistence/turnsRepository.ts`
**Description:** Firestore repository for turn history (`/games/{gameId}/turns/{turnId}`). Records each turn with dice rolls, actions, timing, and status. Supports creating turns, appending actions, recording dice rolls, completing turns, and fetching turn history.

*Summary: ~145 lines. Key methods:*
- `createTurn()` - Creates an in-progress turn document
- `appendAction()` - Adds an action via `arrayUnion`
- `recordDiceRoll()` - Records dice result + DICE_ROLL action
- `completeTurn()` - Marks completed with duration
- `getTurn()` / `getTurnHistory()` - Fetch individual or ordered history

---

## Static Assets

### `public/` Directory
| Path | Description |
|------|-------------|
| `public/audio/menu-music.mp3` | Menu background music loop |
| `public/audio/game-board-theme.mp3` | In-game board background music |
| `public/avatar/avatar_1-4.png` | Player avatar images (4 total) |
| `public/favicon.png` | Browser favicon |
| `public/fonts/04B_30__.TTF` | Pixel font for titles and UI text |
| `public/fonts/04b_30.ttf` | Same pixel font (lowercase variant) |
| `public/fonts/WonderfulChristmas.otf` | Serif font for rules body text |
| `public/images/beach-corner-1-3.png` | Beach corner decoration images |
| `public/images/test-map-grass.png` | Grass tile test images |
| `public/images/test-map-water-bg.png` | Water background test image |
| `public/images/buildings/` | Building icons (city, dev-card, road, settlement) |
| `public/images/resources/` | Resource icons (bloom, crystal, ember, gold, stone) |
| `public/videos/welcome-bg.mp4` | Background video for menu screens |
| `public/videos/water-bg.mp4` | Water background video |

### `docs/` Directory
| Path | Description |
|------|-------------|
| `docs/images/Demo_1_Instructions.md` | Demo 1 instructions document |
| `docs/images/Demo_2_First_Actions.md` | Demo 2 first actions plan |
| `docs/images/Demo_2_Plan.md` | Demo 2 plan document |
| `docs/images/HexaHaven_Design_Document.pdf` | Design document |
| `docs/images/HexaHaven_Specification_Document.pdf` | Specification document |
| `docs/images/game-screen.png` | Game screenshot for README |

---

## Summary Statistics

| Metric | Count |
|--------|-------|
| Source files (`.ts`) | ~55 |
| Client screens | 10 (Entry, MainMenu, Host, Join, Watch, WaitingRoom, GameBoard, Settings, Rules, TestMapGen) + 1 stub (Result) |
| Server routes | 5 REST endpoints + 5 Socket events |
| Shared types | ~25 interfaces/types |
| Firestore repositories | 4 (GameSessions, Players, Board, Turns) |
| Total dependencies | 10 runtime + 6 dev |
