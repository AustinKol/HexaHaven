# HexaHaven — Friday Master Instructions

This document freezes the **Friday playable slice**, the **shared contracts**, the **socket event surface**, the **merge order**, and the **7-person ownership split**.

This plan is intentionally optimized for **speed, low merge conflict risk, and a clean TA demo**.

---

## 0. Source of truth

Use the **Design Document** as the source of truth for:
- architecture
- Firestore persistence
- module boundaries
- room / turn / board / player schemas
- server-authoritative multiplayer flow

Ignore the old JSON persistence parts of the specification document.

For implementation this week, the design doc wins whenever there is a conflict.

---

## 1. Friday goal: what “1/3 playable” means

By Friday, the game is considered successful if the following exact flow works:

1. A player opens the app and hosts a room.
2. The server creates a game session with a unique join code.
3. A second player joins using that join code.
4. Both players can see the waiting room / lobby with the current player list.
5. The host can start the game.
6. Both players transition to the GameBoard.
7. The board renders consistently on both clients.
8. The UI clearly shows whose turn it is.
9. The active player can roll dice exactly once.
10. The roll result is synchronized to all connected players.
11. The active player can end the turn.
12. The next player becomes active on all clients.

That is the frozen Friday scope.

### Explicitly out of scope for Friday

Do **not** spend time trying to finish these before Friday unless the core slice above is already stable:
- build validation
- resource distribution correctness
- goal completion
- winner calculation
- spectator mode
- settings menu logic
- reconnect / disconnect recovery
- finished game / result flow
- security rule hardening beyond what is needed to run
- polished UI / art / animations

The only acceptable exception is extremely small glue work needed to keep the app running.

---

## 2. File ownership rules (top priority)

**Rule 1:** every important file has exactly **one owner**.

**Rule 2:** nobody edits another owner’s files without asking in Discord first.

**Rule 3:** the `shared/` folder is protected. Only the shared-contracts owner edits it directly.

**Rule 4:** if a task needs a shared contract change, the requesting owner asks the shared-contracts owner to make it.

**Rule 5:** if a task needs a new socket event, it must be added in `shared/constants/socketEvents.ts` first before anyone codes against it.

### Protected files

These files are protected and should only be edited by their assigned owner unless explicitly coordinated:

- `src/shared/constants/socketEvents.ts`
- `src/shared/constants/apiRoutes.ts`
- `src/shared/constants/screenIds.ts`
- `src/shared/types/domain.ts`
- `src/shared/types/api.ts`
- `src/shared/types/socket.ts`
- `src/shared/types/persistence.ts`
- `src/client/state/clientState.ts`
- `src/server/realtime/registerSocketHandlers.ts`
- `src/server/engine/GameEngine.ts`
- `src/server/engine/TurnManager.ts`
- `src/server/persistence/*`

### Branch naming convention

Use one branch per owner:

- `feat/shared-contracts`
- `feat/persistence-firestore`
- `feat/session-lobby-server`
- `feat/turn-engine`
- `feat/client-lobby-screens`
- `feat/client-board-rendering`
- `feat/client-networking-state`

No one should work directly on `main`.

---

## 3. Frozen shared contracts

## 3.1 Frozen enums

```ts
export type RoomStatus = 'waiting' | 'in_progress' | 'finished';

export type GamePhase = 'ROLL' | 'COLLECT' | 'ACTION' | 'END';

export type ClientRole = 'PLAYER' | 'SPECTATOR';

export type ResourceType = 'CRYSTAL' | 'STONE' | 'BLOOM' | 'EMBER' | 'GOLD';

export type StructureType = 'ROAD' | 'SETTLEMENT' | 'GARDEN';

export type LocationType = 'EDGE' | 'VERTEX';

export type TurnRecordStatus = 'in_progress' | 'completed';
```

### Important freeze decision

`waiting / in_progress / finished` is the **room status**.

`ROLL / COLLECT / ACTION / END` is the **in-turn phase**.

Do **not** use `LOBBY` as a `GamePhase`. Lobby is represented by `roomStatus = 'waiting'`.

That resolves the design-doc conflict between:
- the formal Firestore schema, which uses `status` for room lifecycle and `phase` for turn state
- the example API payload, which casually uses `phase: "LOBBY"`

For implementation, we are freezing the cleaner interpretation:
- `roomStatus` handles pre-game and post-game session lifecycle
- `phase` only handles an active turn once the game is in progress

---

## 3.2 Frozen GameState shape

This is the exact shared snapshot shape everyone should code against.

```ts
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
  currentTurn: number;              // 0 while waiting, then 1, 2, 3...
  currentPlayerId: string | null;   // null while waiting
  currentPlayerIndex: number | null;
  phase: GamePhase | null;          // null while waiting
  turnStartedAt: string | null;
  turnEndsAt: string | null;
  lastDiceRoll: DiceRoll | null;    // cleared when a new turn starts
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

### Freeze rationale for this shape

- `roomStatus` and `turn.phase` are intentionally separated.
- `playersById` is used for fast lookup.
- `playerOrder` is preserved for authoritative turn order.
- `board` is normalized as dictionaries for simpler updates and lower merge confusion.
- `turn.lastDiceRoll === null` means the current player has not rolled yet.
- `turn.currentTurn = 0` while the room is still waiting.
- when the host starts the game:
  - `roomStatus` becomes `in_progress`
  - `turn.currentTurn` becomes `1`
  - `turn.currentPlayerId` becomes `playerOrder[0]`
  - `turn.currentPlayerIndex` becomes `0`
  - `turn.phase` becomes `ROLL`
  - `turn.lastDiceRoll` becomes `null`

This is the exact shape to freeze in `shared/types/domain.ts`.

---

## 3.3 Frozen Friday socket events

Keep the socket surface as small as possible.

### Client -> Server

```ts
export const CLIENT_EVENTS = {
  CREATE_GAME: 'CREATE_GAME',
  JOIN_GAME: 'JOIN_GAME',
  START_GAME: 'START_GAME',
  ROLL_DICE: 'ROLL_DICE',
  END_TURN: 'END_TURN',
} as const;
```

### Server -> Client

```ts
export const SERVER_EVENTS = {
  GAME_STATE_UPDATE: 'GAME_STATE_UPDATE',
  ACTION_REJECTED: 'ACTION_REJECTED',
} as const;
```

### Why only these?

Because Friday only requires:
- create room
- join room
- start match
- roll dice
- end turn
- sync state
- reject invalid actions

Anything else increases coordination risk.

### All client requests use the same ack shape

```ts
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
```

### Event payloads

```ts
export interface CreateGameRequest {
  displayName: string;
  config: GameConfig;
}

export interface JoinGameRequest {
  joinCode: string;
  displayName: string;
  role: ClientRole; // Friday only uses PLAYER
}

export interface StartGameRequest {
  gameId: string;
}

export interface RollDiceRequest {
  gameId: string;
}

export interface EndTurnRequest {
  gameId: string;
}

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

export interface SimpleActionAckData {
  gameState: GameState;
}

export interface ActionRejectedEvent {
  code: AckError['code'];
  message: string;
  details?: Record<string, unknown>;
}
```

### Frozen event behavior

- `CREATE_GAME` returns ack and then the host receives `GAME_STATE_UPDATE`.
- `JOIN_GAME` returns ack and then everyone in the room receives `GAME_STATE_UPDATE`.
- `START_GAME` returns ack and then everyone in the room receives `GAME_STATE_UPDATE`.
- `ROLL_DICE` returns ack and then everyone in the room receives `GAME_STATE_UPDATE`.
- `END_TURN` returns ack and then everyone in the room receives `GAME_STATE_UPDATE`.
- invalid actions must trigger `ACTION_REJECTED` to the requesting client.

Do not invent additional Friday socket events unless the whole team agrees first.

---

## 4. Frozen server rules for Friday

These are the exact behavioral rules for the Friday slice.

### Room creation
- Host creates a room.
- Server generates a unique `roomCode`.
- New room starts with:
  - `roomStatus = 'waiting'`
  - `playerOrder = [hostPlayerId]`
  - host inside `playersById`
  - deterministic board already generated and stored in state
  - `turn.currentTurn = 0`
  - `turn.currentPlayerId = null`
  - `turn.currentPlayerIndex = null`
  - `turn.phase = null`
  - `turn.lastDiceRoll = null`

### Join room
- Server validates room exists.
- Server validates room is still `waiting`.
- Server validates player count has not exceeded `config.playerCount`.
- Server appends joining player to `playerOrder`.
- Server writes player doc / state and broadcasts the new room snapshot.

### Start game
- Only the host may start.
- Minimum Friday requirement: at least **2 players** in the room.
- On success:
  - `roomStatus = 'in_progress'`
  - `turn.currentTurn = 1`
  - `turn.currentPlayerId = playerOrder[0]`
  - `turn.currentPlayerIndex = 0`
  - `turn.phase = 'ROLL'`
  - `turn.lastDiceRoll = null`
  - `turn.turnStartedAt = now`

### Roll dice
- Only the active player may roll.
- Roll only allowed when `turn.phase === 'ROLL'`.
- Roll only allowed if `turn.lastDiceRoll === null`.
- Server rolls 2 dice.
- Result must always have `sum` between 2 and 12.
- For Friday, the server must store the dice result in `turn.lastDiceRoll`.
- For Friday, resource distribution may be skipped or stubbed out visually, but the roll must sync.
- After a successful roll:
  - `turn.phase = 'ACTION'`

### End turn
- Only the active player may end the turn.
- End turn only allowed after a successful roll.
- On success:
  - compute next player index circularly
  - set next active player
  - increment `turn.currentTurn`
  - clear `turn.lastDiceRoll`
  - `turn.phase = 'ROLL'`
  - refresh timestamps

### Friday validation errors that must exist
- room not found
- room full
- non-host tried to start
- non-active player tried to act
- dice rolled in wrong phase
- end turn before dice roll

---

## 5. Exact merge order

This order is frozen because it minimizes conflicts.

### Merge 1 — shared contracts
Merge first:
- `src/shared/constants/socketEvents.ts`
- `src/shared/constants/screenIds.ts`
- `src/shared/types/domain.ts`
- `src/shared/types/socket.ts`
- `src/shared/types/api.ts`

No one else should merge before this is stable.

### Merge 2 — backend session + engine
Merge second:
- `src/server/sessions/*`
- `src/server/realtime/*`
- `src/server/engine/*`
- `src/server/persistence/*`

At the end of this merge, the backend should be able to:
- create room
- join room
- start game
- roll dice
- end turn
- broadcast game state

### Merge 3 — client networking
Merge third:
- `src/client/networking/*`
- `src/client/state/clientState.ts`
- `src/client/app/App.ts`
- `src/client/app/ScreenRegistry.ts`

At the end of this merge, the client should be able to:
- connect socket
- send the 5 frozen events
- receive `GAME_STATE_UPDATE`
- route between lobby and board

### Merge 4 — screens / rendering
Merge fourth:
- `src/client/screens/*`
- `src/client/rendering/*`
- `src/client/input/*`

At the end of this merge, the UI should visibly demonstrate the Friday flow.

### Merge 5 — integration fixes
Merge last:
- typing fixes
- event payload mismatches
- navigation fixes
- board rendering fixes
- layout bugs
- emulator / persistence fixes

No one should do “cleanup refactors” before Friday.

---

## 6. 7-person ownership split

Assign one real teammate to each role below.

## Person 1 — Shared contracts owner

### Files owned
- `src/shared/constants/socketEvents.ts`
- `src/shared/constants/screenIds.ts`
- `src/shared/types/domain.ts`
- `src/shared/types/socket.ts`
- `src/shared/types/api.ts`
- `src/shared/types/persistence.ts`

### Exact job
1. Implement the frozen enums and interfaces from Section 3.
2. Export all shared event names.
3. Export all ack types and request payload types.
4. Add any tiny utility types needed by the rest of the team.
5. Do **not** add features beyond the frozen Friday surface.

### Friday acceptance criteria
- all teammates import the same exact types
- no duplicate type definitions exist elsewhere
- socket event names are centralized in one place
- no one has to guess payload shapes

### Notes
This role is the most important one. Nothing else should proceed until this owner is done.

---

## Person 2 — Firestore / persistence owner

### Files owned
- `src/server/config/firebaseAdmin.ts`
- `src/server/persistence/FirestoreRepository.ts`
- `src/server/persistence/gameSessionsRepository.ts`
- `src/server/persistence/playersRepository.ts`
- `src/server/persistence/boardRepository.ts`
- `src/server/persistence/turnsRepository.ts`

### Exact job
1. Make Firebase Admin / emulator initialization work safely.
2. Implement repository functions used by Friday only:
   - create game session
   - find game by room code
   - read game by gameId
   - upsert player
   - save board snapshot
   - save full game snapshot
   - create / update current turn record
3. Keep repository functions narrow and boring.
4. Do **not** implement future-only queries.

### Friday acceptance criteria
- room create persists
- join persists
- start game persists
- roll persists `lastDiceRoll`
- end turn persists next active player / next turn
- emulator or staging Firestore works for local testing

### Notes
Do not let persistence logic leak into client files.

---

## Person 3 — Session / lobby backend owner

### Files owned
- `src/server/realtime/socketServer.ts`
- `src/server/realtime/registerSocketHandlers.ts`
- `src/server/sessions/RoomManager.ts`
- `src/server/sessions/Room.ts`

### Exact job
1. Register all frozen socket events.
2. Implement room creation.
3. Implement join-by-code validation.
4. Keep in-memory room registry for active sessions.
5. Coordinate with persistence owner to read/write Firestore.
6. Broadcast room state after every valid session change.

### Friday acceptance criteria
- `CREATE_GAME` works
- `JOIN_GAME` works
- room code uniqueness works
- capacity enforcement works
- host-only `START_GAME` works
- all players in a room get synchronized state

### Notes
This owner should not implement turn rules beyond start-game handoff.

---

## Person 4 — Turn engine owner

### Files owned
- `src/server/engine/GameEngine.ts`
- `src/server/engine/TurnManager.ts`

### Exact job
1. Initialize turn state on start game.
2. Enforce active player.
3. Enforce correct phase.
4. Implement dice roll.
5. Implement end-turn transition.
6. Return updated `GameState` snapshots after successful actions.

### Friday acceptance criteria
- first turn starts correctly
- only active player can roll
- player cannot roll twice in the same turn
- end turn is blocked before rolling
- end turn advances correctly to the next player
- next turn resets to `ROLL`

### Notes
For Friday, do **not** implement full build validation or win conditions.

---

## Person 5 — Client lobby / waiting-room owner

### Files owned
- `src/client/screens/EntryScreen.ts`
- `src/client/screens/MainMenuScreen.ts`
- `src/client/screens/HostGameScreen.ts`
- `src/client/screens/JoinGameScreen.ts`
- `src/client/screens/WaitingRoomScreen.ts`

### Exact job
1. Build the UI flow from entry -> menu -> host/join -> waiting room.
2. Add host form with display name and minimal config.
3. Add join form with display name + room code.
4. Render waiting room player list.
5. Render join code clearly.
6. Render host-only start button.

### Friday acceptance criteria
- host can create room from UI
- joiner can join from UI
- waiting room shows correct players
- start button only appears for host
- state changes visibly when second player joins

### Notes
This owner does not own socket implementation details.

---

## Person 6 — Client board rendering owner

### Files owned
- `src/client/screens/GameBoardScreen.ts`
- `src/client/rendering/CanvasRoot.ts`
- `src/client/rendering/RendererRoot.ts`
- `src/client/input/InputRegistry.ts`

### Exact job
1. Render a deterministic board.
2. Render enough visible tiles that the TA can tell it is a hex board game.
3. Render turn info on screen.
4. Render dice result on screen.
5. Render end-turn button.
6. Make the view update when `GAME_STATE_UPDATE` changes the active player or dice result.

### Friday acceptance criteria
- both clients see the same board
- active player is visually obvious
- dice result is visibly obvious
- board screen does not crash when state updates arrive

### Notes
Do not block on perfect art or animation.

---

## Person 7 — Client networking / local state owner

### Files owned
- `src/client/networking/socketClient.ts`
- `src/client/networking/registerClientEvents.ts`
- `src/client/networking/apiClient.ts`
- `src/client/state/clientState.ts`
- `src/client/app/App.ts`
- `src/client/app/ScreenRegistry.ts`

### Exact job
1. Own the single socket connection.
2. Send the 5 frozen client events.
3. Receive `GAME_STATE_UPDATE`.
4. Update the shared local state mirror.
5. Expose state and actions cleanly to screens.
6. Route between waiting room and game board based on state.

### Friday acceptance criteria
- client can create room from UI
- client can join room from UI
- client transitions to board on start
- client updates correctly on dice roll and end turn
- `ACTION_REJECTED` can be surfaced to UI

### Notes
This owner is the glue between server and screens. Keep it centralized.

---

## 7. Exact dev sequence for the whole team

## Phase A — Freeze DONE
1. Person 1 implements the shared contracts.
2. Team reviews the contracts once.
3. Freeze them.
4. Merge them.
5. Everyone pulls latest main.

## Phase B — Backend core
1. Person 2 implements Firestore access.
2. Person 3 implements room creation / join / start handlers.
3. Person 4 implements turn engine.
4. Persons 2, 3, 4 test together with raw socket calls first if necessary.
5. Merge backend only when create/join/start/roll/end-turn all work.

## Phase C — Client core
1. Person 7 connects socket + local state.
2. Person 5 wires host / join / waiting room screens.
3. Person 6 wires board rendering.
4. Team tests with two browser windows.

## Phase D — Integration
1. Fix payload mismatches.
2. Fix navigation bugs.
3. Fix timing / turn update bugs.
4. Validate that two players see the same board and same turn state.

## Phase E — Demo polish
1. Add minimal labels so the TA can understand what is happening.
2. Make sure the join code is easy to find.
3. Make sure the dice result is easy to find.
4. Make sure the active player indicator is obvious.

---

## 8. Friday demo acceptance checklist

The build is demo-ready only if all of these are true:

- `npm run dev` works
- the site opens locally
- a host can create a room
- a room code is shown
- another client can join the room code
- the waiting room updates for both clients
- the host can start the game
- both clients transition to the board
- the board renders for both clients
- the active player indicator is visible
- only the active player can roll
- the roll result syncs to both clients
- end turn syncs to both clients
- the next active player is correct
- invalid actions are rejected cleanly

If any of these fail, do not spend time on extra features.

---
