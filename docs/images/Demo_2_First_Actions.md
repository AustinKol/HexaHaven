# Demo 2 — First Actions Tonight

## Austin Wang — `feat/gameplay-engine`

- Create the branch.
- Stub `SetupManager.ts`, `PlacementValidator.ts`, `ResourceManager.ts`, `VictoryManager.ts`, and `LongestRoadManager.ts`.
- Define the engine entry points for:
  - setup settlement placement
  - setup road placement
  - build road
  - build settlement
  - upgrade settlement to city
  - recompute VP / longest road / winner
- Lock down the exact server-side legality rules before wiring UI.

## Nathan Hu — `feat/contracts-realtime`

- Create the branch.
- Update shared contracts for `CITY`, setup state, trade state, and the new Demo 2 actions.
- Add the new event names in `socketEvents.ts`.
- Stub the new realtime handler branches in `registerSocketHandlers.ts`.
- Add a reload path for `SYNC_GAME_STATE`.

## Helena Clifford — `feat/firestore-live`

- Create the branch.
- Verify Firebase Admin init works cleanly in local dev.
- Add `GamePersistenceService.ts`.
- Define the exact Firestore write steps for:
  - create
  - join
  - start
  - setup placement
  - roll
  - build
  - trade
  - end turn
  - finish game
- Decide how `RoomManager` reloads from Firestore when state is missing in memory.

## Brandon Lee Felix — `feat/board-interactions`

- Create the branch.
- Add a clickable overlay layer on top of the rendered board.
- Map board vertices and edges to stable IDs that match the server board state.
- Implement a basic hover state for valid vs invalid targets.
- Get one clickable setup vertex and one clickable setup edge visually working first.

## Emily Zhang — `feat/gameboard-ui`

- Create the branch.
- Reserve layout space in `GameBoardScreen.ts` for:
  - resource tray
  - VP panel
  - build panel
  - trade panel
  - result state
- Stub the UI components in `src/client/ui/`.
- Make the screen ready to consume live resource, VP, and action state.

## Barry Lu — `feat/trading`

- Create the branch.
- Freeze the one-offer-at-a-time player trade flow with Nathan.
- Stub `TradeManager.ts`.
- Add client networking helpers for:
  - bank trade
  - offer trade
  - accept trade
  - reject trade
  - cancel trade
- Define the minimum client trade state Emily will render.

## James Huang — `feat/dice-timer`

- Create the branch.
- Stub `DiceManager.ts` and `TimerManager.ts`.
- Isolate the dice roll generator from the rest of the turn logic.
- Add the Firestore turn-log methods needed for turn start, roll, and turn end.
- Build a minimal `DiceRollBanner.ts` and `TurnTimer.ts` that Emily can mount later.
