# Firestore Refactor Plan

## 1. Executive summary

The current branch is not yet fully Firestore-first. Firestore exists, but canonical gameplay still depends on hybrid in-memory state (`GameStateStore`), legacy in-memory room flow (`roomManager`), and client-local mutation patterns (`SYNC_GAME_STATE`, local build placement, room-code-seeded board generation). That hybrid model is the main architectural problem.

The immediate runtime blocker in the dice path is real and localized: `FieldValue.serverTimestamp()` is being placed inside an array element in `turnsRepository.recordDiceRoll()`. That is invalid Firestore usage and is the direct cause of the `ROLL_DICE` failure.

Beyond that hotfix, the bigger correctness issues are:

- `ROLL_DICE` does not actually distribute resources.
- `END_TURN` is under-validated on the server.
- setup/build flow is still client-local and not authoritative.
- board tiles are not durably persisted and are regenerated from a client-side seed.
- hydration/recovery reconstructs only part of the game snapshot correctly.
- reconnect/session restoration relies on stale socket/localStorage behavior.
- legacy `roomManager` and `/api/rooms/*` still coexist with the Firestore path.

The refactor target should be a single authoritative path:

1. client sends a minimal request
2. server resolves the player/session
3. server loads the current Firestore-backed state
4. server validates and computes the next authoritative state
5. server persists the transition successfully
6. only then does the server broadcast

Dev reset is acceptable, so this should favor deletion and simplification over compatibility shims for old Firestore documents.

## 2. Root cause of the dice roll Firestore bug

### Exact offending code path

The failing runtime path is:

`src/server/realtime/registerSocketHandlers.ts`
-> `CLIENT_EVENTS.ROLL_DICE`
-> `gamePersistenceService.rollDice(session.gameId, session.playerId)`
-> `src/server/persistence/turnsRepository.ts`
-> `recordDiceRoll()`

Inside `recordDiceRoll()`, the current write is effectively:

```ts
await this.turnsCol(gameId).doc(turnId).update({
  diceRoll: {
    d1: roll.d1,
    d2: roll.d2,
    sum: roll.sum,
    rolledAt: FieldValue.serverTimestamp(),
  },
  actions: FieldValue.arrayUnion({
    actionId: `dice_${Date.now()}`,
    type: 'DICE_ROLL',
    timestamp: FieldValue.serverTimestamp(),
    result: { d1: roll.d1, d2: roll.d2, sum: roll.sum },
  }),
});
```

### True root cause

The error is not caused by the top-level `diceRoll.rolledAt` field. The true failure is that `actions` is an array field, and the object being appended into that array contains `timestamp: FieldValue.serverTimestamp()`.

Firestore does not allow transform sentinels like `FieldValue.serverTimestamp()` inside array elements. The error message points to `timestamp` because that is the offending field inside the `arrayUnion(...)` payload.

### Similar timestamp/array bugs elsewhere

A repo-wide search did not find another direct `FieldValue.serverTimestamp()`-inside-array usage.

However, `src/server/persistence/turnsRepository.ts` still has a related design problem in `appendAction()`:

- it also writes action objects into an array via `arrayUnion`
- it relies on array order even though `arrayUnion` is not the right ordered log primitive
- it performs a brittle timestamp coercion with `new Date(action.timestamp as unknown as string)`

So the dice bug is localized, but the underlying action-log pattern still needs to be replaced.

## 3. Minimal dice fix plan

### Minimal correct fix

Change `src/server/persistence/turnsRepository.ts` so `recordDiceRoll()` uses a concrete timestamp value instead of a Firestore transform sentinel inside the action array element.

Recommended hotfix:

```ts
import { FieldValue, Timestamp } from 'firebase-admin/firestore';

async recordDiceRoll(
  gameId: string,
  turnId: string,
  roll: { d1: number; d2: number; sum: number },
): Promise<void> {
  const now = Timestamp.now();

  await this.turnsCol(gameId).doc(turnId).update({
    diceRoll: {
      d1: roll.d1,
      d2: roll.d2,
      sum: roll.sum,
      rolledAt: now,
    },
    actions: FieldValue.arrayUnion({
      actionId: `dice_${Date.now()}`,
      type: 'DICE_ROLL',
      timestamp: now,
      result: { d1: roll.d1, d2: roll.d2, sum: roll.sum },
    }),
  });
}
```

### Why this is the right minimal fix

- It removes the invalid Firestore usage immediately.
- It keeps the existing document shape intact.
- It does not widen the hotfix into a larger turn-log redesign.
- It uses one concrete timestamp for both `diceRoll.rolledAt` and the action entry, so the data remains internally consistent.

### Important follow-up note

This hotfix should be treated as a tactical fix only. The longer-term direction should be to stop using an `actions` array as the canonical turn log and move action entries to their own ordered docs/subcollection.

## 4. Current architecture assessment

### What is already moving in the right direction

- Firestore repositories exist for games, players, board state, and turns.
- Socket handlers already gate several actions through the server instead of trusting direct client Firestore writes.
- Chat already persists before broadcast.
- `ROLL_DICE`, `BANK_TRADE`, `END_TURN`, and `SEND_CHAT_MESSAGE` are already wired as server-side actions.
- The client does not directly write to Firestore.

### What is still fundamentally wrong

#### 1. Firestore is not the sole source of truth

`GameStateStore` is still treated as the first read source and post-write truth inside `GamePersistenceService`. That makes the architecture hybrid and multi-instance unsafe.

#### 2. A second, legacy authority model still exists

`roomManager`, `RoomManager`, `Room`, and `src/server/http/routes/rooms.ts` still implement an in-memory room/game flow that is unrelated to the Firestore-backed socket path.

#### 3. The client still performs local gameplay mutation

`GameBoardScreen` creates and mutates local `GameState`, updates the UI immediately, and then calls `SYNC_GAME_STATE`. That is the exact opposite of the desired architecture.

#### 4. The server gameplay path is incomplete

- dice roll does not distribute resources
- build/setup are not wired authoritatively
- end-turn validation is incomplete
- board generation is not persisted
- trade flow is half-present and duplicated

#### 5. Hydration is inconsistent

`loadGame()` only normalizes some timestamps. Player docs and board docs are loaded back into app-layer types with raw Firestore `Timestamp` values cast as strings.

#### 6. Shared contracts still expose demo-era assumptions

- `SYNC_GAME_STATE` still exists
- `JOIN_GAME` lets the client send its own role
- there is no real hydrate/recovery event
- there are no authoritative setup/build events
- spectator/watch is half-modeled but not real

### Bottom line

The repo has a usable Firestore foundation, but the gameplay architecture is still hybrid. The right move is not to patch around that hybrid state; it is to make Firestore-backed server commands the only authoritative path and delete the room-manager/client-push leftovers.

## 5. File-by-file / subsystem classification table

### Server realtime / session management

| Path | Classification | Why / migration direction |
| --- | --- | --- |
| `src/server/realtime/socketServer.ts` | KEEP | Thin Socket.IO bootstrap; structurally fine. |
| `src/server/realtime/registerSocketHandlers.ts` | REWRITE | Keep as the single realtime entrypoint, but remove `SYNC_GAME_STATE`, stop echoing client role, add hydrate/setup/build flows, and tighten session/leave/reconnect handling. |
| `src/server/sessions/GameStateStore.ts` | DELETE | Canonical gameplay state must not live in a shared in-memory cache. |
| `src/server/sessions/RoomManager.ts` | DELETE | Legacy room authority conflicts with Firestore-first architecture. |
| `src/server/sessions/Room.ts` | DELETE | Only used by the obsolete `roomManager` path. |
| `src/server/sessions/roomManagerSingleton.ts` | DELETE | Legacy singleton for obsolete room authority. |
| `src/server/sessions/presence.ts` | REWRITE | Current file is a stub; either implement transient presence/session tracking for reconnects or remove it until real. |

### Server persistence / command layer

| Path | Classification | Why / migration direction |
| --- | --- | --- |
| `src/server/persistence/FirestoreRepository.ts` | KEEP | Good low-level base for repository access. |
| `src/server/persistence/gameSessionsRepository.ts` | REWRITE | Root doc contains stale/duplicate fields (`playerStats`, optional `chatMessages`), comments are outdated, and helper surface should support transactional authoritative commands. |
| `src/server/persistence/playersRepository.ts` | REWRITE | Raw Firestore docs are cast directly to app-layer `PlayerState`; timestamp normalization and clearer persistence DTOs are needed. |
| `src/server/persistence/boardRepository.ts` | REWRITE | Board tile init exists but is unused; upgrade/build semantics and timestamp normalization are incomplete. |
| `src/server/persistence/turnsRepository.ts` | REWRITE | Immediate dice bug lives here; action arrays are also the wrong long-term persistence shape. |
| `src/server/persistence/GamePersistenceService.ts` | REWRITE | This is the main hybrid service today; it should become the sole Firestore-backed server command service and stop depending on `GameStateStore` as authority. |

### Server engine / HTTP

| Path | Classification | Why / migration direction |
| --- | --- | --- |
| `src/server/engine/GameEngine.ts` | MIGRATE | Keep only if reused as a pure reducer/validator library behind Firestore-loaded state; do not keep it as a room-manager engine path. |
| `src/server/engine/TurnManager.ts` | MIGRATE | Useful turn-rule helpers can survive, but only as pure validation/transition logic. |
| `src/server/engine/TradeManager.ts` | DELETE | Duplicate orphan logic; consolidate trade rules into the single authoritative command path. |
| `src/server/http/routes/health.ts` | KEEP | Fine as-is. |
| `src/server/http/routes/rooms.ts` | DELETE | Legacy in-memory room flow; wrong source of truth and currently powers the broken watch path. |
| `src/server/http/router.ts` | REWRITE | Remove legacy rooms route or replace it with narrow read-only recovery endpoints if still needed. |
| `src/server/createServer.ts` | KEEP | Fine once routing/socket handlers are updated. |
| `src/server/main.ts` | KEEP | Fine once the authoritative services are updated. |
| `src/server/config/firebaseAdmin.ts` | KEEP | Firestore initialization is fine. |

### Shared contracts / constants

| Path | Classification | Why / migration direction |
| --- | --- | --- |
| `src/shared/types/domain.ts` | MIGRATE | Keep the core snapshot idea, but remove demo-era frozen assumptions, normalize naming (`GARDEN` vs city), and model authoritative setup/trade state clearly. |
| `src/shared/types/socket.ts` | REWRITE | Remove `SYNC_GAME_STATE`, remove client-chosen role, add hydrate/setup/build/upgrade events, and keep request payloads minimal. |
| `src/shared/constants/socketEvents.ts` | MIGRATE | Update alongside socket contract rewrite. |
| `src/shared/types/api.ts` | REWRITE | Current `RoomSnapshot` is a legacy room-manager shape, not a Firestore-authoritative session/read model. |
| `src/shared/constants/apiRoutes.ts` | REWRITE | Remove legacy room routes; keep only health and any future narrow recovery/read endpoints. |
| `src/shared/types/persistence.ts` | DELETE | Explicitly marked deprecated and not appropriate for new code. |
| `src/shared/constants/playerColors.ts` | MIGRATE | Useful shared palette/hue helpers should remain, but duplicate color assignment logic in `GamePersistenceService` should be consolidated here. |
| `src/shared/constants/startingResources.ts` | KEEP | Fine as a helper, but its values must be sanitized server-side during game creation. |
| `src/shared/constants/screenIds.ts` | KEEP | Fine. |
| `src/shared/schemas/*` | DELETE | Repo search found no live references; these appear to be dead leftovers. |

### Client networking / state

| Path | Classification | Why / migration direction |
| --- | --- | --- |
| `src/client/networking/socketClient.ts` | REWRITE | Current socket auth lifecycle is wrong for reconnect/recovery and still carries obsolete `syncGameState`. |
| `src/client/networking/registerClientEvents.ts` | MIGRATE | Keep as a thin event listener layer, but add hydrate/recovery behavior and remove debug-only assumptions. |
| `src/client/networking/apiClient.ts` | DELETE | Only used by the broken watch/spectator path; reintroduce later only if a real read API is needed. |
| `src/client/state/lobbyState.ts` | MIGRATE | Keep only as a persisted session hint (`gameId`, `playerId`); role must not be authoritative. |
| `src/client/state/clientState.ts` | MIGRATE | Keep as local UI state, but remove dead fields and use reset/cleanup consistently on exit/reconnect. |

### Client screens / rendering

| Path | Classification | Why / migration direction |
| --- | --- | --- |
| `src/client/app/App.ts` | MIGRATE | Add recovery-aware startup instead of always booting fresh to main menu. |
| `src/client/screens/HostGameScreen.ts` | KEEP | Basic host flow is fine once socket contracts are cleaned up. |
| `src/client/screens/JoinGameScreen.ts` | MIGRATE | Keep UI, but stop sending client-selected role and rely on server-authoritative session identity. |
| `src/client/screens/WaitingRoomScreen.ts` | MIGRATE | Needs real hydrate/reconnect/leave behavior instead of local-only cleanup. |
| `src/client/screens/GameBoardScreen.ts` | REWRITE | This is the biggest client-side authority problem: local state mutation, local build legality, local resource spending, and seed-based board authority must all be removed. |
| `src/client/screens/WatchGameScreen.ts` | DELETE | Spectator/watch is deferred and the current implementation is broken. |
| `src/client/screens/TestMapGenScreen.ts` | MIGRATE | Keep the renderer if useful, but feed it authoritative board data instead of treating `roomId`/seed as the board source of truth. |
| `src/client/screens/ResultScreen.ts` | DELETE | Empty and not registered in `App`; dead code today. |

## 6. Exact in-memory flow problems still present

1. **`GameStateStore` is still treated as canonical live state.**  
   `GamePersistenceService` reads from it first and writes back to it after persistence. That keeps a second source of truth alive.

2. **`getGameState()` prefers cache over Firestore.**  
   A stale in-memory game can shadow newer persisted truth, which can allow illegal joins/actions after the real Firestore state changed.

3. **`joinGame()` mutates cached state in place.**  
   `playersById` and `playerOrder` are updated locally after Firestore writes, which is race-prone under concurrent joins and not transaction-safe.

4. **`startGame()`, `rollDice()`, `buildStructure()`, `trade()`, `endTurn()`, and `finalizeGame()` all depend on cache-backed state.**  
   They are not loading the authoritative pre-action state directly from Firestore for validation and transition.

5. **`roomManager` still owns a separate room/game world.**  
   `src/server/http/routes/rooms.ts` creates, joins, starts, and leaves in-memory rooms completely outside Firestore.

6. **The client still performs local authoritative mutation in `GameBoardScreen`.**  
   `applyBuildPurchase()` clones `GameState`, mutates structures/resources/stats locally, updates UI, and then calls `SYNC_GAME_STATE`.

7. **`SYNC_GAME_STATE` is an anti-pattern and does not actually persist client mutations.**  
   The server ignores the client-provided `gameState` and simply returns the current persisted snapshot.

8. **There is no authoritative setup/build socket path.**  
   `GamePersistenceService.setupPlacement()` and `buildStructure()` exist, but `registerSocketHandlers.ts` does not expose any setup/build events.

9. **The existing server build/setup method signatures are wrong for authority.**  
   Accepting a full `StructureState` from the caller would trust client-provided owner/color/cost/timestamp/adjacency data. The server should accept only minimal placement intent and compute the rest itself.

10. **`ROLL_DICE` is architecturally incomplete.**  
    It records the roll and flips phase to `ACTION`, but it does not compute or persist resource collection.

11. **The board is not durably authoritative.**  
    `boardRepository.initTiles()` is never called, so Firestore does not own canonical board tiles. The client recreates the map from `roomId`/seed.

12. **`END_TURN` is under-validated on the server.**  
    `GamePersistenceService.endTurn()` only checks active player; it does not enforce “must have rolled” or `ACTION` phase, even though `TurnManager` already models those rules.

13. **Hydration only partially reconstructs the typed snapshot.**  
    `loadGame()` converts some root timestamps, but player docs and board docs still come back as raw Firestore `Timestamp` objects cast into string fields.

14. **Socket recovery is not truly session-safe.**  
    `connectSocket()` reuses a single socket without updating auth, so a client can reconnect with stale `{gameId, playerId}` and stale room membership.

15. **Sockets join rooms but do not reliably leave old ones.**  
    The server keeps joining `socket.io` rooms, but the client’s “Exit to Menu” path does not disconnect. A reused socket can remain subscribed to the previous game.

16. **Role/session authority is still partially client-chosen.**  
    `JOIN_GAME` echoes `request.role`, and `WatchGameScreen` invents `playerId: 'spectator'` locally. Neither is acceptable for server-authoritative state.

17. **Server-side config authority is weak at game creation.**  
    Only `playerCount` is sanitized; other config fields still come from the client with little or no validation.

18. **Join-code uniqueness is not guaranteed.**  
    `generateRoomCode()` exists, and `roomCodeExists()` exists, but the creation flow never retries on collision.

19. **Duplicate authoritative surfaces still exist in parallel.**  
    `GameEngine`, `TurnManager`, `TradeManager`, `GamePersistenceService`, `roomManager`, and client-local gameplay logic overlap in responsibility and make the true source of truth unclear.

## 7. Recommended target architecture

### Core authority rule

Firestore-backed server commands must become the only gameplay authority. No action should depend on a shared in-memory `GameState` cache, and no client should ever send a whole `GameState` or prebuilt structure as truth.

### Recommended command pipeline

For every gameplay action:

1. client sends a minimal request payload
2. server resolves `{gameId, playerId}` from transient session state
3. server loads the current authoritative Firestore docs needed for that action
4. server validates legality
5. server computes the next authoritative state
6. server persists the write set successfully
7. server emits the updated snapshot

### Recommended request surface

Keep the client request payloads minimal. Examples:

- `CREATE_GAME({ displayName, config })`
- `JOIN_GAME({ joinCode, displayName })`
- `HYDRATE_SESSION({ gameId })` or immediate server-push snapshot after session restore
- `START_GAME({ gameId })`
- `ROLL_DICE({ gameId })`
- `PLACE_SETUP({ gameId, placementType, locationId })`
- `BUILD_ROAD({ gameId, edgeId })`
- `BUILD_SETTLEMENT({ gameId, vertexId })`
- `UPGRADE_SETTLEMENT({ gameId, vertexId })`
- `BANK_TRADE({ gameId, giveResource, receiveResource })`
- `SEND_CHAT_MESSAGE({ gameId, message })`
- `END_TURN({ gameId })`

Do not accept:

- whole `GameState`
- whole `StructureState`
- client-computed resource deltas
- client-chosen authoritative role/session state

### Recommended Firestore data layout

Use Firestore as the durable state store with a compact root game doc plus subcollections:

#### `games/{gameId}`

Keep only compact authoritative session summary fields here:

- `gameId`
- `roomCode`
- `status`
- sanitized `config`
- `playerOrder`
- `createdBy`
- `winnerPlayerId`
- `currentTurn`
- `currentPlayerId`
- `currentPlayerIndex`
- `phase`
- `turnStartedAt`
- `turnEndsAt`
- `lastDiceRoll`
- explicit setup/trade summary state if those features are live
- `createdAt`
- `updatedAt`
- `isDeleted`

Do not keep ambiguous duplicates like root-level `playerStats` or `chatMessages` unless there is a concrete, maintained reason.

#### `games/{gameId}/players/{playerId}`

Canonical per-player durable data:

- display name
- color
- host flag
- resources
- goals
- stats
- presence
- join/update timestamps

#### `games/{gameId}/board/state/tiles/{tileId}`

Canonical board layout.  
The board must be generated once on the server and persisted here at game start. `mapSeed` may still exist as metadata, but it must not be the client’s source of truth.

#### `games/{gameId}/board/state/structures/{structureId}`

Canonical built/upgraded structures.  
Settlement-to-city upgrade should update the existing persisted structure cleanly instead of relying on client aliasing.

#### `games/{gameId}/turns/{turnId}`

Turn summary:

- turn number
- player
- status
- dice roll summary
- start/end timestamps
- duration

#### `games/{gameId}/turns/{turnId}/actions/{actionId}` (preferred end state)

Canonical ordered action log per turn:

- `type`
- `timestamp`
- `actorPlayerId`
- action-specific payload

This is preferable to the current `actions` array because it avoids array-transform pitfalls and removes ordering ambiguity.

#### `games/{gameId}/chat/{messageId}`

Canonical chat messages.

### In-memory helpers that are still acceptable

Small transient helpers are fine:

- `socketId -> { gameId, playerId }`
- player/socket lookup maps
- socket.io room membership
- transient presence bookkeeping

What is not acceptable:

- shared in-memory canonical `GameState`
- room-manager-owned room lifecycle as truth
- client-local gameplay state as the primary path

### Snapshot normalization rule

Repository DTOs may use Firestore `Timestamp`, but the emitted/shared `GameState` snapshot should be normalized before leaving the server:

- all timestamps -> ISO strings
- no raw Firestore classes in socket payloads
- no mixed `Date` / `Timestamp` / `string` values for the same field across different load paths

### Spectator/watch policy

Defer spectator support entirely for now.

That means:

- remove the current `WatchGameScreen` flow
- remove the room-manager-based watch API dependency
- do not keep fake spectator local sessions alive
- reintroduce later only with a real read-only server-authoritative spectator contract

## 8. Phased implementation plan

### Phase 1 — urgent runtime correctness fixes

1. **Fix the dice-roll Firestore write bug**
   - update `turnsRepository.recordDiceRoll()` to use `Timestamp.now()`
   - remove `FieldValue.serverTimestamp()` from array element payloads

2. **Tighten immediate server-side legality checks**
   - add missing `END_TURN` validation (`must be active player`, `must have rolled`, `must be in ACTION`)
   - ensure `ROLL_DICE` still rejects if the turn is already rolled or phase is wrong

3. **Stop trusting client-controlled role/config fields more than necessary**
   - stop echoing `request.role` from `JOIN_GAME`
   - sanitize the full create-game config on the server, not just `playerCount`

4. **Make join-code generation deterministic enough for correctness**
   - either retry until `roomCodeExists()` is false
   - or simplify the design so the join code is guaranteed unique by construction

5. **Quarantine obviously wrong flows until authoritative replacements land**
   - mark `SYNC_GAME_STATE` as deprecated immediately
   - if needed during the migration window, disable the fake local-only build path rather than continuing to show non-persisted gameplay state as if it were real
   - hide/remove the current watch/spectator entry from the core flow

6. **Run focused smoke checks after the hotfix**
   - create
   - join
   - start
   - roll
   - bank trade
   - chat
   - end turn

### Phase 2 — remove remaining incorrect in-memory gameplay flow

1. **Rewrite `GamePersistenceService` into the sole authoritative command service**
   - keep the file/class name if that reduces churn, but replace the internals
   - stop reading `GameStateStore` as authoritative input
   - load current action state from Firestore instead

2. **Delete `GameStateStore` from gameplay authority**
   - remove cache-first reads
   - remove post-write “canonical” cache updates
   - if a read-through cache is ever reintroduced later, keep it explicitly non-authoritative and optional

3. **Delete the legacy room-manager path**
   - remove `RoomManager`, `Room`, `roomManagerSingleton`
   - remove `src/server/http/routes/rooms.ts`
   - stop carrying a second room/game lifecycle model

4. **Replace `SYNC_GAME_STATE` with real authoritative actions**
   - add socket events for setup/build/upgrade
   - have the client send only intent + location ids
   - compute cost, legality, adjacency, ownership, timestamps, and resulting structures on the server

5. **Make build/setup fully server-authoritative**
   - do not accept a full `StructureState` from the client
   - do not let the client spend resources locally first
   - do not update UI optimistically as if persistence already succeeded

6. **Persist the board as durable game state**
   - generate tiles server-side at game start
   - call `boardRepository.initTiles()`
   - store canonical tiles in Firestore before the match becomes live
   - treat `mapSeed` as generation input only, not as the board authority

7. **Make dice authoritative and functionally complete**
   - load the canonical board/structures
   - determine which tiles match the roll
   - determine which players collect which resources
   - update affected player docs
   - record both the dice roll and resource collection in turn history
   - persist before broadcast

8. **Standardize transactional write sets**
   - `START_GAME`: root game doc + board init + first turn doc
   - `ROLL_DICE`: root game doc + affected player docs + current turn doc/action log
   - `BUILD_*`: player doc + structure doc + turn action log + any summary fields
   - `BANK_TRADE`: player doc + action log
   - `END_TURN`: current turn completion + player stats + next turn doc + root game turn summary

9. **Consolidate validation logic**
   - either migrate `GameEngine` / `TurnManager` into pure reducer helpers used by the command service
   - or inline that logic into the command service
   - but do not leave duplicate validation surfaces in parallel

10. **Decide player-trade scope cleanly**
    - if player-to-player trade is in scope now, model it explicitly as a durable proposal/accept lifecycle
    - if not, delete the orphan `trade()` path and keep only bank trade for this pass

### Phase 3 — Firestore hydration / recovery hardening

1. **Add a real hydration path**
   - on socket connect with persisted `{gameId, playerId}`, resolve the session from Firestore
   - immediately send the authoritative snapshot or expose an explicit `HYDRATE_SESSION` event

2. **Fix client socket lifecycle**
   - recreate the socket when session identity changes
   - do not keep a single stale socket forever
   - explicitly disconnect/leave on exit to menu or leave game

3. **Normalize every persisted timestamp before emitting**
   - player timestamps
   - presence timestamps
   - tile timestamps
   - structure timestamps
   - turn timestamps

4. **Make `App` recovery-aware**
   - if local storage contains a persisted session, boot into recovery/hydration instead of always starting fresh
   - route to waiting room or game board only after Firestore hydration succeeds

5. **Track presence consistently**
   - update player presence on connect/disconnect if desired for UX
   - keep presence logic small and transient
   - do not turn presence tracking into another gameplay authority cache

6. **Define dev-reset handling explicitly**
   - because backward compatibility is not the goal, old incomplete Firestore documents should be cleared rather than migrated with complex fallback logic

### Phase 4 — cleanup / dead code / simplification

1. **Delete obsolete files and surfaces**
   - `src/server/sessions/GameStateStore.ts`
   - `src/server/sessions/RoomManager.ts`
   - `src/server/sessions/Room.ts`
   - `src/server/sessions/roomManagerSingleton.ts`
   - `src/server/http/routes/rooms.ts`
   - `src/shared/types/persistence.ts`
   - `src/client/screens/WatchGameScreen.ts`
   - `src/client/networking/apiClient.ts`
   - `src/client/screens/ResultScreen.ts` if it remains unused
   - `src/shared/schemas/*` if they remain unreferenced

2. **Remove dead contract surface**
   - `SYNC_GAME_STATE`
   - client-supplied join role
   - legacy room-manager API routes/types

3. **Remove ambiguous duplicate data**
   - drop root-level `playerStats` unless it becomes a real maintained projection
   - drop root-level/optional `chatMessages` if chat lives only in subcollection

4. **Normalize naming**
   - resolve `GARDEN` vs city naming
   - either rename canonical structure type to `CITY` everywhere or explicitly document why it is not

5. **Consolidate shared constants/helpers**
   - remove duplicate hard-coded player color arrays from `GamePersistenceService`
   - keep one shared color assignment source

6. **Remove or fix outdated assumptions in code comments**
   - comments that still assume `gameId === roomCode`
   - comments that assume GameEngine sequential append order is safe for array-based action logs
   - frozen demo-era guidance that no longer matches the authoritative target

### Phase 5 — optimization opportunities

1. **Move turn actions out of arrays**
   - use `turns/{turnId}/actions/{actionId}` or another ordered doc strategy
   - avoid `arrayUnion` for ordered authoritative logs

2. **Shrink per-action Firestore reads**
   - do not call a full `loadGame()` shape for every command forever
   - use command-specific loaders for only the docs needed to validate and persist each action

3. **Keep the root game doc small**
   - root doc = session summary and live turn/setup/trade summary only
   - chat, board, turns, and action logs stay in subcollections

4. **Centralize snapshot building**
   - one mapper that converts repository docs to emitted `GameState`
   - one normalization rule for all timestamps

5. **Keep only safe transient caches**
   - roomCode -> gameId lookup cache if useful
   - socket/player session maps
   - never canonical gameplay state

6. **Optimize chat and large snapshots only after correctness is stable**
   - if full-state broadcasts become heavy, split chat into a dedicated persisted/broadcast path
   - do not optimize into deltas until the authoritative full-snapshot flow is correct

## 9. Risks / migration hazards

1. **Removing `SYNC_GAME_STATE` before authoritative build/setup events exist will break the current build UI.**  
   Sequence matters: add authoritative actions first, then delete the fake sync path, or temporarily disable the client build flow during the transition.

2. **Deleting the room-manager path will break current watch/spectator behavior immediately.**  
   That is acceptable only because spectator support is explicitly deferred.

3. **Board canonicalization must be chosen once and followed everywhere.**  
   This plan assumes persisted Firestore board tiles are the canonical board. Keeping both persisted tiles and client-side room-code generation as parallel truth would recreate the same hybrid problem.

4. **Old/incomplete Firestore docs will not hydrate cleanly after the refactor.**  
   That is acceptable under the stated dev-reset assumption; do not spend the refactor preserving broken dev documents unless absolutely necessary.

5. **Changing socket contracts will require client/server lockstep rollout.**  
   Old clients that still emit `SYNC_GAME_STATE` or spectator-role joins should be considered incompatible during the refactor window.

6. **If `GameEngine` / `TurnManager` are partly reused and partly bypassed, duplication will continue.**  
   Choose one clear ownership model for validation/reduction logic.

7. **Action transactions must be designed carefully to avoid partial writes.**  
   Today many commands update multiple docs sequentially. That is a correctness risk that the refactor must remove.

8. **Full snapshot hydration can be slightly heavier after removing cache-first memory reads.**  
   That is acceptable initially; correctness and simplicity come first. Optimize reads later, not before the authority model is fixed.

## 10. Final prioritized checklist

1. Fix `turnsRepository.recordDiceRoll()` to stop using `FieldValue.serverTimestamp()` inside `actions` array elements.
2. Add missing server-side `END_TURN` validation.
3. Stop echoing client-controlled join roles and sanitize full create-game config server-side.
4. Guarantee unique room codes during game creation.
5. Disable or quarantine the fake `SYNC_GAME_STATE`/local-build path until authoritative build actions exist.
6. Remove spectator/watch from the core flow for now.
7. Rewrite `GamePersistenceService` so Firestore, not `GameStateStore`, is the authoritative pre-action read source.
8. Delete `GameStateStore` as canonical gameplay authority.
9. Delete the legacy `roomManager`/HTTP room flow.
10. Add authoritative socket events for setup/build/upgrade and stop accepting full `StructureState` from callers.
11. Generate and persist canonical board tiles at game start.
12. Implement real dice resource distribution from persisted board + structures.
13. Normalize all persisted timestamps before emitting snapshots.
14. Add a real hydrate/recovery flow for refresh/reconnect using `{gameId, playerId}`.
15. Fix socket lifecycle so session changes recreate/disconnect the socket cleanly.
16. Clean up duplicate root doc fields (`playerStats`, legacy `chatMessages`) and dead shared/persistence types.
17. Resolve `GARDEN` vs city naming and remove other outdated helpers/comments.
18. Move turn action logs out of arrays and into ordered Firestore docs/subcollections.
