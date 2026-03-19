# Person 7 — Client networking + local state (Demo 1)

This document explains the **Person 7** work for Demo 1: the “glue” between the UI screens and the Socket.IO backend.

It covers:
- the client’s **single socket connection**
- the **frozen Friday socket events** being sent/received
- the **local state mirror** that screens consume
- how the lobby → waiting room → board navigation is driven by state
- which files were changed and why

> Source of truth: `Demo_1_Instructions.md` (frozen scope + contracts + event surface).

---

## Goals (Friday playable slice)

For the Friday slice, the client must be able to:
- host a room (create a game + receive join code)
- join a room by code
- see the lobby update as players join
- start the game as host
- transition both clients to the board
- show whose turn it is
- allow the active player to roll once
- allow the active player to end turn
- keep both clients synchronized via `GAME_STATE_UPDATE`

---

## Architecture summary

At a high level:

- **Socket is authoritative** for game session state.
  - The server broadcasts `GAME_STATE_UPDATE` whenever state changes.
  - Clients treat `GameState` as the source of truth for turn/phase/dice.

- **Client maintains a small local state mirror** that holds:
  - who this client is (`clientId`, `playerId`, `role`)
  - the latest `gameState` snapshot
  - the last action rejection (optional UX surface)

- **Screens do not own socket logic directly.**
  - Screens call a small set of exported networking functions (create/join/start/roll/end).
  - Screens subscribe to the local mirror for updates and render accordingly.

---

## Files owned by Person 7 (and what changed)

### `src/client/networking/socketClient.ts`

**Purpose**: Own the single Socket.IO connection and provide a typed API for the 5 Friday actions.

Key behaviors:
- Creates **one shared socket instance** (singleton) via `connectSocket()`.
- Registers client listeners once via `registerClientEvents(socket)`.
- Exposes Promise-based action helpers that emit frozen events and wait for the ack:
  - `createGame(request)`
  - `joinGame(request)`
  - `startGame(gameId)`
  - `rollDice(gameId)`
  - `endTurn(gameId)`
- Updates the local state mirror (`clientState`) after successful `createGame` / `joinGame`.

### `src/client/networking/registerClientEvents.ts`

**Purpose**: Central place to register inbound socket event handlers.

Listens for:
- `connect` / `disconnect`: updates `clientId` in the local state mirror
- `connect_error`: surfaces a failure message via local state (so UI can show something reasonable)
- `GAME_STATE_UPDATE`: stores the latest `gameState` in the local mirror
- `ACTION_REJECTED`: stores the last rejection in the local mirror (useful for UI messaging)

### `src/client/state/clientState.ts`

**Purpose**: Minimal, shared state container for networking-driven UI.

What it contains:
- `clientId`: socket id from Socket.IO (helps debugging / identity)
- `playerId`: server-assigned player id for this client’s player
- `role`: `PLAYER` / `SPECTATOR` (Friday primarily uses `PLAYER`)
- `gameState`: latest authoritative snapshot (`GameState`)
- `lastActionRejected`: last rejection payload from the server

How screens use it:
- call `subscribeClientState(listener)` to react to updates
- do not mutate directly; use `setClientState(patch)` (used by networking layer)

### `src/client/app/App.ts` and `src/client/app/ScreenRegistry.ts`

**Purpose**: These provide screen registration and navigation.

Person 7’s work relies on their existing behavior:
- screens navigate by calling the `navigate(screenId)` callback passed into `render()`

---

## Screen integration (how UI consumes Person 7 work)

Even though these screens are “owned” by other people, Person 7’s job is only complete once screens are correctly consuming the centralized networking/state layer.

### Host flow — `HostGameScreen`

What happens:
- User enters name + player count.
- Screen calls `createGame({ displayName, config })`.
- On success:
  - local lobby session is stored (for minimal continuity between screens)
  - navigates to `WaitingRoom`

### Join flow — `JoinGameScreen`

What happens:
- User enters name + join code.
- Screen calls `joinGame({ joinCode, displayName, role: 'PLAYER' })`.
- On success:
  - local lobby session is stored
  - navigates to `WaitingRoom`

### Waiting room — `WaitingRoomScreen`

What happens:
- Screen calls `connectSocket({ gameId, playerId })` for the room.
- Screen subscribes to `clientState`:
  - renders player list from `gameState.playerOrder` / `playersById`
  - shows capacity using `gameState.config.playerCount`
  - host-only Start button calls `startGame(roomId)`
  - when `gameState.roomStatus === 'in_progress'`, navigates to `GameBoard`

### Board — `GameBoardScreen`

What happens:
- Screen subscribes to `clientState` and renders HUD from `gameState.turn`.
- The “Turn HUD” buttons call:
  - `rollDice(roomId)` when enabled
  - `endTurn(roomId)` when enabled
- Button enable/disable is derived from the authoritative state:
  - only the **active player** gets enabled buttons
  - roll is only enabled during `phase === 'ROLL'` and `lastDiceRoll === null`
  - end turn is only enabled during `phase === 'ACTION'` and `lastDiceRoll !== null`

---

## Socket event contract (Friday surface)

This work assumes the frozen contract from `src/shared/constants/socketEvents.ts` and `src/shared/types/socket.ts`.

### Client → Server
- `CREATE_GAME`
- `JOIN_GAME`
- `START_GAME`
- `ROLL_DICE`
- `END_TURN`

### Server → Client
- `GAME_STATE_UPDATE`
- `ACTION_REJECTED`

### Ack pattern

Every client request uses a standardized ack:
- success: `{ ok: true, data: ... }`
- failure: `{ ok: false, error: { code, message, details? } }`

The client helpers in `socketClient.ts`:
- resolve the Promise on `{ ok: true }`
- reject the Promise on `{ ok: false }` (and also copy the error into `clientState.lastActionRejected`)

---

## Debugging and common failure modes

### Roll/End buttons never enable

Likely causes:
- `clientState.playerId` is missing (create/join didn’t complete)
- `gameState` is missing (no `GAME_STATE_UPDATE` received)
- server did not initialize turn state on start (`turn.phase` should become `ROLL`)

Quick checks:
- Verify `START_GAME` results in a `GAME_STATE_UPDATE` where:
  - `roomStatus === 'in_progress'`
  - `turn.currentTurn === 1`
  - `turn.currentPlayerId === playerOrder[0]`
  - `turn.phase === 'ROLL'`

### Actions rejected as NOT_ACTIVE_PLAYER

Expected for non-active clients. For the Friday slice, the UI should:
- disable Roll/End for non-active clients
- allow active client to proceed

### Actions rejected as SESSION_NOT_FOUND

Usually means the wrong `gameId` was used:
- ensure you use the room code returned from `createGame` (stored in `gameState.roomCode`)
- ensure the joiner uses that same code in `joinGame({ joinCode })`

---

## How to run a 2-client test (recommended)

1. Start dev servers:

```bash
npm run dev
```

2. Open two windows at the client URL (from `README.md`, usually `http://localhost:8080`).
3. In window A: Host Game → create a code.
4. In window B: Join Game → enter name + that code.
5. In window A: Start Game.
6. On the board:
   - active player: Roll Dice (once), then End Turn
   - other player: buttons remain disabled until it becomes their turn

---

## Non-goals (explicitly not implemented here)

Per the Friday scope freeze, this work intentionally does **not** implement:
- reconnect recovery / resume
- persistence integration (Firestore writes/reads)
- resource distribution correctness
- build/trade actions
- win conditions / goals completion

Those are either out of scope for the slice or owned by other roles.

