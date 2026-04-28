# HexaHaven Repo Overview (Balance-Focused)

Generated: 2026-04-22T23:18:00.000Z

## Game Description
- HexaHaven is a multiplayer, turn-based, Catan-style hex strategy game with server-authoritative state and Firestore persistence.
- Players create/join via a 6-character room code, then play on a generated hex map where dice outcomes drive resource income.
- Core interaction loop is: join lobby -> start game -> roll dice -> take build/trade actions -> end turn -> next player.

## Whole System Design Architecture
### Architecture Principles
- Server-authoritative gameplay: clients send intent, server validates and mutates canonical state.
- Firestore-first durability: game sessions, board, players, turns, and chat persist in Firestore collections/subcollections.
- Realtime fanout by room: Socket.IO room broadcast sends authoritative snapshots to all subscribed sockets.
- Shared contracts: domain and socket types in `src/shared` are used by both client and server.
- Thin client policy: client UI renders state and issues commands; legality is decided on server.

### Runtime Components
| Component | Files | Responsibility |
|---|---|---|
| Client SPA | `src/client/**`, `src/main.ts` | UI screens, map rendering, local session state, socket calls. |
| Shared Contracts | `src/shared/**` | GameState shape, socket event payloads, board ID math, build costs/constants. |
| HTTP API | `src/server/http/**` | Minimal REST surface (health route). |
| Realtime Gateway | `src/server/realtime/socketServer.ts`, `src/server/realtime/registerSocketHandlers.ts` | Socket connection lifecycle, auth/session restore, action routing, broadcasts. |
| Domain Service | `src/server/persistence/GamePersistenceService.ts` | Game rules, validation, turn flow, resource payouts, join/rejoin/hydrate behavior. |
| Persistence Layer | `src/server/persistence/*Repository.ts` | Firestore document/subcollection reads/writes. |
| Win Engine | `src/server/engine/WinConditionEvaluator.ts` | End-of-turn win evaluation. |
| Infra Bootstrapping | `src/server/main.ts`, `src/server/createServer.ts`, `src/server/config/*` | Process startup, Firebase admin init, Express + Socket.IO wiring. |

### Layered Backend Design
1. Transport Layer (`registerSocketHandlers.ts`)
- Receives typed socket events.
- Resolves/attaches socket session to `gameId` + `playerId`.
- Calls domain service methods.
- Emits `GAME_STATE_UPDATE` or action rejection.

2. Domain Layer (`GamePersistenceService.ts`)
- Enforces phase gates (`ROLL` vs `ACTION`).
- Enforces build legality (settlement distance, road connectivity, city upgrade ownership).
- Applies resource accounting, turn progression, and chat append.
- Loads authoritative snapshots from persistence after mutation.

3. Repository Layer (`boardRepository.ts`, `gameSessionsRepository.ts`, `playersRepository.ts`, `turnsRepository.ts`)
- Encapsulates Firestore paths and document conversion.
- Stores timestamps and normalized document fields.
- No game-rule decisions here.

### Socket/Event Architecture
| Direction | Event | Purpose |
|---|---|---|
| Client -> Server | `CREATE_GAME` | Create waiting room and host player. |
| Client -> Server | `JOIN_GAME` | Join waiting room or rejoin existing player by display name. |
| Client -> Server | `HYDRATE_SESSION` | Fetch authoritative latest game snapshot for an attached player. |
| Client -> Server | `START_GAME` | Host starts game and initializes board + turn state. |
| Client -> Server | `ROLL_DICE` | Active player rolls; server computes payouts. |
| Client -> Server | `BUILD_STRUCTURE` | Build road/settlement/city with server validation. |
| Client -> Server | `BANK_TRADE` | Execute fixed 4:1 trade. |
| Client -> Server | `END_TURN` | Advance to next player after ACTION phase. |
| Client -> Server | `SEND_CHAT_MESSAGE` | Append chat then broadcast updated snapshot. |
| Server -> Client | `GAME_STATE_UPDATE` | Full authoritative state snapshot (room broadcast or hydrate sync). |
| Server -> Client | `ACTION_REJECTED` | Typed rejection with error code/message/details. |

### Authoritative State Lifecycle
1. Create
- Host emits `CREATE_GAME`.
- Server creates `/games/{gameId}` and host `/games/{gameId}/players/{playerId}`.
- Initial room status is `waiting`.

2. Join / Rejoin
- Join lookup accepts room code or game ID via `getGameState`.
- Display-name match is trimmed + case-insensitive within target game.
- Unique match => reattach to existing `playerId` (rejoin path).
- No match + `in_progress` => reject as new join.

3. Start
- Host-only `START_GAME`.
- Server sets `roomStatus=in_progress`, creates deterministic board tiles, initializes turn 1 record.

4. Turn Loop
- `ROLL_DICE` allowed only for active player in `ROLL` phase.
- Server computes tile payouts to adjacent settlements/cities and persists updates.
- Turn phase moves to `ACTION`.
- Player may build/trade/chat.
- `END_TURN` closes current turn doc, evaluates winner, starts next turn if no winner.

5. Timeout Loop
- Realtime layer runs a 1s interval and asks service to `advanceTurnIfExpired`.
- If turn expired, server auto-completes turn and broadcasts new authoritative state.

### Rejoin/Hydration/Sync Architecture
1. Socket Connect
- Server attempts handshake session restore using `gameId` + `playerId` from auth/query.
- If valid, socket is joined to game room and receives immediate `GAME_STATE_UPDATE`.

2. Explicit Rejoin
- Client calls `JOIN_GAME` with room code + display name.
- Server resolves same-name player, reattaches identity, calls `rememberSocketSession`, joins socket room.

3. Hydration
- Client calls `HYDRATE_SESSION` to get current authoritative snapshot.
- Server verifies session ownership and returns full `gameState`.

4. Live Sync After Rejoin
- Future actions broadcast to room via `io.to(gameId).emit(GAME_STATE_UPDATE, gameState)`.
- Because rejoined socket is in room, it receives updates immediately with other clients.

### Firestore Data Architecture
| Path | Meaning |
|---|---|
| `/games/{gameId}` | Session root doc: status, config, player order, turn pointers, winner, metadata. |
| `/games/{gameId}/players/{playerId}` | Player identity, resources, stats, goals, presence. |
| `/games/{gameId}/board/state/tiles/{tileId}` | Board tile topology/resource/token data. |
| `/games/{gameId}/board/state/structures/{structureId}` | Built roads/settlements/cities. |
| `/games/{gameId}/turns/{turnId}` | Turn history and action logs. |
| `/games/{gameId}/chat/{chatId}` | Chat messages. |
| `/users/{userId}` and `/users/{userId}/activeGames/{gameId}` | User profile and activity index (optional/supporting). |

### Client State Architecture
- `clientState` holds current screen/session/game snapshot in memory.
- `lobbyState` keeps persisted local session (`roomId`, `playerId`, `playerName`, role) in localStorage for refresh continuity.
- `socketClient` centralizes connect/disconnect + typed command methods + ack handling.
- `registerClientEvents` updates `clientState` on connect/disconnect/game updates/errors.
- `GameBoardScreen` subscribes to `clientState`, triggers `HYDRATE_SESSION` on mount, and redraws map/HUD from authoritative board + turn state.

### Validation/Rules Architecture
- Settlement legality: `validateSettlementPlacement`.
- Road legality: `canPlaceRoad` + vertex blocking logic for opponent structures.
- City legality: `canUpgradeSettlementToCity`.
- Build spend checks: `BUILD_COSTS` + inventory checks.
- Turn/phase legality: enforced before every mutating action.

### Reliability And Continuity Characteristics
- Persistent truth is Firestore; state survives client disconnects/reconnects.
- Server game progression (turn timeout advancement) is independent of a specific client connection.
- Presence uses per-player `connectionId`; stale disconnect events do not override newer connections.
- Rejoin avoids duplicate player creation when same display name uniquely matches existing player in that game.

## Current Rules And Meta (Inferred From Code, Not Rules Screen)
### Turn Flow
- Phase flow in active games is `ROLL` -> `ACTION` (server enforced).
- Active player must roll once before ending turn.
- Server broadcasts full authoritative `GAME_STATE_UPDATE` snapshots after successful actions.

### Economy
- Resource types: `CRYSTAL`, `STONE`, `BLOOM`, `EMBER`, `GOLD`.
- Default starting inventory in host flow is 10 of each resource.
- Settlement payout = 1 resource per matching adjacent tile; city payout = 2.
- Bank trade is fixed 4:1.

### Building Rules (Authoritative)
- Costs:
  - ROAD: 1 STONE + 1 EMBER
  - SETTLEMENT: 1 STONE + 1 BLOOM + 1 EMBER
  - CITY: 3 STONE + 2 BLOOM
- Settlement placement: vertex must be empty, obey distance rule, and (after your first settlement/city) connect to one of your own roads.
- City upgrade: only upgrades your own existing settlement.
- Road placement: edge must be empty and connect to your network (own road or own structure). Opponent structures block pass-through continuation at that vertex.

### Map / Board
- Deterministic map generation from seed (`mapSeed`) and map size (`small|medium|large`).
- Radius by size: small=1, medium=2, large=3 (tile counts 7, 19, 37).
- Tiles are generated server-side at game start and persisted in Firestore.

### Win Model
- Win evaluator supports: `FIRST_TO_X_POINTS` (hardcoded 10 VP), `ALL_GOALS_COMPLETE`, `ANY_X_GOALS_COMPLETE`.
- Current host defaults use `ALL_GOALS_COMPLETE` with `goalCount: 0`; player goals are initialized as empty arrays unless assigned elsewhere.

### Rejoin / Sync / Authority
- Same-name rejoin is scoped to a single game and matched case-insensitively after trimming.
- If a unique same-name player exists, server reattaches to existing `playerId` (no duplicate player creation).
- New players are rejected once game is in progress.
- State authority remains server + Firestore; client sends intent and hydrates from server snapshots.

### Current Meta Implications (From Implementation)
- Expansion tempo is strongly tied to STONE/EMBER/BLOOM due to road + settlement costs and 4:1 bank rate.
- Early placement quality matters heavily because road continuation can be blocked at opponent-occupied intersections.
- VP progression is mostly settlement/city driven in current code; no implemented robber/dev-card pressure loop in authoritative gameplay path.
- Timer advancement is server-side and continues independently of client presence while game remains in active polling set.

## Repository File Inventory
Total tracked files: **122**

| File | Description |
|---|---|
| `.firebaserc` | Firebase CLI project alias/config mapping. |
| `.gitignore` | Git ignore patterns for generated/local files. |
| `Dockerfile` | Container build recipe. |
| `docs/firestore_refactor_plan.md` | Project documentation/planning/analysis note. |
| `docs/images/Demo_1_Instructions.md` | Project documentation/planning/analysis note. |
| `docs/images/Demo_2_First_Actions.md` | Project documentation/planning/analysis note. |
| `docs/images/Demo_2_Plan.md` | Project documentation/planning/analysis note. |
| `docs/images/game-screen.png` | Documentation asset (image/media). |
| `docs/images/HexaHaven_Design_Document (3).pdf` | Design/specification PDF document. |
| `docs/images/HexaHaven_Specification_Document (2).pdf` | Design/specification PDF document. |
| `docs/images/REPOSITORY_ANALYSIS.md` | Project documentation/planning/analysis note. |
| `firebase.json` | Firebase project configuration. |
| `firestore.indexes.json` | Firestore index definitions. |
| `firestore.rules` | Firestore security rules. |
| `index.html` | Vite client entry HTML. |
| `LICENSE` | Repository license terms (MIT). |
| `package-lock.json` | NPM lockfile with exact dependency graph. |
| `package.json` | Node package manifest with scripts and dependencies. |
| `public/audio/build-road.mp3` | Audio asset used in menu/gameplay SFX/music. |
| `public/audio/build-settlement.mp3` | Audio asset used in menu/gameplay SFX/music. |
| `public/audio/dice-roll.mp3` | Audio asset used in menu/gameplay SFX/music. |
| `public/audio/game-board-theme.mp3` | Audio asset used in menu/gameplay SFX/music. |
| `public/audio/menu-music.mp3` | Audio asset used in menu/gameplay SFX/music. |
| `public/avatar/avatar_1.png` | Avatar image asset. |
| `public/avatar/avatar_2.png` | Avatar image asset. |
| `public/avatar/avatar_3.png` | Avatar image asset. |
| `public/avatar/avatar_4.png` | Avatar image asset. |
| `public/favicon.png` | Static public asset served by client. |
| `public/fonts/04B_30__.TTF` | Font asset. |
| `public/fonts/04b_30.ttf` | Font asset. |
| `public/fonts/WonderfulChristmas.otf` | Font asset. |
| `public/images/beach-corner-1.png` | General image asset for map/UI. |
| `public/images/beach-corner-2.png` | General image asset for map/UI. |
| `public/images/beach-corner-3.png` | General image asset for map/UI. |
| `public/images/buildings/city-blue.png` | Building sprite/icon asset. |
| `public/images/buildings/city-green.png` | Building sprite/icon asset. |
| `public/images/buildings/city-red.png` | Building sprite/icon asset. |
| `public/images/buildings/city-yellow.png` | Building sprite/icon asset. |
| `public/images/buildings/city.png` | Building sprite/icon asset. |
| `public/images/buildings/dev-card.png` | Building sprite/icon asset. |
| `public/images/buildings/road.png` | Building sprite/icon asset. |
| `public/images/buildings/settlement-blue.png` | Building sprite/icon asset. |
| `public/images/buildings/settlement-green.png` | Building sprite/icon asset. |
| `public/images/buildings/settlement-red.png` | Building sprite/icon asset. |
| `public/images/buildings/settlement-yellow.png` | Building sprite/icon asset. |
| `public/images/buildings/settlement.png` | Building sprite/icon asset. |
| `public/images/dice-roll-animation.gif` | General image asset for map/UI. |
| `public/images/resources/bloom.png` | Resource icon asset. |
| `public/images/resources/crystal.png` | Resource icon asset. |
| `public/images/resources/ember.png` | Resource icon asset. |
| `public/images/resources/gold.png` | Resource icon asset. |
| `public/images/resources/stone.png` | Resource icon asset. |
| `public/images/test-map-grass.png` | General image asset for map/UI. |
| `public/images/test-map-grass1.png` | General image asset for map/UI. |
| `public/images/test-map-grass2.png` | General image asset for map/UI. |
| `public/images/test-map-water-bg.png` | General image asset for map/UI. |
| `public/videos/.gitkeep` | Video background asset. |
| `public/videos/water-bg.mp4` | Video background asset. |
| `public/videos/welcome-bg.mp4` | Video background asset. |
| `README.md` | Primary project README (existing). |
| `src/client/app/App.ts` | Client app controller: screen registration and navigation. |
| `src/client/app/ScreenRegistry.ts` | Client app bootstrap/navigation helper. |
| `src/client/audio/buildSounds.ts` | Client audio playback/volume logic. |
| `src/client/audio/menuMusic.ts` | Client audio playback/volume logic. |
| `src/client/audio/musicVolume.ts` | Client audio playback/volume logic. |
| `src/client/bootstrap/startClient.ts` | Client startup helper. |
| `src/client/config/env.ts` | Client env/firebase config. |
| `src/client/config/firebaseConfig.ts` | Client env/firebase config. |
| `src/client/input/InputRegistry.ts` | Input registration helper. |
| `src/client/networking/registerClientEvents.ts` | Client socket API wrappers and event listeners. |
| `src/client/networking/socketClient.ts` | Client socket API wrappers and event listeners. |
| `src/client/rendering/CanvasRoot.ts` | Rendering root/helper module. |
| `src/client/rendering/RendererRoot.ts` | Rendering root/helper module. |
| `src/client/screens/EntryScreen.ts` | Client screen controller (EntryScreen). |
| `src/client/screens/GameBoardScreen.ts` | Client screen controller (GameBoardScreen). |
| `src/client/screens/HostGameScreen.ts` | Client screen controller (HostGameScreen). |
| `src/client/screens/JoinGameScreen.ts` | Client screen controller (JoinGameScreen). |
| `src/client/screens/MainMenuScreen.ts` | Client screen controller (MainMenuScreen). |
| `src/client/screens/RulesScreen.ts` | Client screen controller (RulesScreen). |
| `src/client/screens/SettingsScreen.ts` | Client screen controller (SettingsScreen). |
| `src/client/screens/TestMapGenScreen.ts` | Client screen controller (TestMapGenScreen). |
| `src/client/screens/WaitingRoomScreen.ts` | Client screen controller (WaitingRoomScreen). |
| `src/client/settings/gameSettings.ts` | Client settings persistence and events. |
| `src/client/state/clientState.ts` | Client local state/session storage. |
| `src/client/state/lobbyState.ts` | Client local state/session storage. |
| `src/client/styles/index.css` | Global client styles. |
| `src/client/ui/diceRollDisplay.ts` | Reusable UI component module. |
| `src/client/ui/musicToggleButton.ts` | Reusable UI component module. |
| `src/main.ts` | Client bootstrap entrypoint. |
| `src/server/config/env.ts` | Server env/firebase initialization config. |
| `src/server/config/firebaseAdmin.ts` | Server env/firebase initialization config. |
| `src/server/createServer.ts` | Express + Socket.IO server composition. |
| `src/server/engine/WinConditionEvaluator.ts` | Win-condition evaluation logic. |
| `src/server/http/router.ts` | HTTP router wiring. |
| `src/server/http/routes/health.ts` | HTTP route handler. |
| `src/server/main.ts` | Server startup entrypoint. |
| `src/server/persistence/boardRepository.ts` | Firestore data-access repository module. |
| `src/server/persistence/FirestoreRepository.ts` | Firestore data-access repository module. |
| `src/server/persistence/GamePersistenceService.placement.test.ts` | Persistence/gameplay unit test. |
| `src/server/persistence/GamePersistenceService.rejoin.test.ts` | Persistence/gameplay unit test. |
| `src/server/persistence/GamePersistenceService.ts` | Server-authoritative gameplay service and validations. |
| `src/server/persistence/gameSessionsRepository.ts` | Firestore data-access repository module. |
| `src/server/persistence/playersRepository.ts` | Firestore data-access repository module. |
| `src/server/persistence/turnsRepository.ts` | Firestore data-access repository module. |
| `src/server/realtime/registerSocketHandlers.rejoin.test.ts` | Realtime behavior test. |
| `src/server/realtime/registerSocketHandlers.ts` | Realtime event handlers: join/hydrate/actions/broadcast/session mapping. |
| `src/server/realtime/socketServer.ts` | Socket.IO server construction and options. |
| `src/server/utils/logger.ts` | Server utility module (logger/helpers). |
| `src/shared/boardLayout.ts` | Hex topology + deterministic board/tile generation helpers. |
| `src/shared/buildRules.ts` | Build kinds and authoritative resource costs. |
| `src/shared/constants/apiRoutes.ts` | Shared constants used across server/client. |
| `src/shared/constants/playerColors.ts` | Shared constants used across server/client. |
| `src/shared/constants/screenIds.ts` | Shared constants used across server/client. |
| `src/shared/constants/socketEvents.ts` | Shared constants used across server/client. |
| `src/shared/constants/startingResources.ts` | Shared constants used across server/client. |
| `src/shared/types/domain.ts` | Core shared game/domain types (GameState, board, turn, player, resources). |
| `src/shared/types/socket.ts` | Typed socket request/response contracts. |
| `src/vite-env.d.ts` | Vite environment type declarations. |
| `tsconfig.client.json` | TypeScript compiler configuration. |
| `tsconfig.json` | TypeScript compiler configuration. |
| `tsconfig.server.json` | TypeScript compiler configuration. |
| `vite.config.ts` | Vite build/dev configuration. |

---
This document intentionally omits raw file contents so it is upload-friendly for chat tools.
