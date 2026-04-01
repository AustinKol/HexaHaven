# HexaHaven — Demo 2 Plan

## Demo 2 Goal

By the end of Demo 2, the game should support a full Firestore-backed multiplayer slice:

1. A host creates a room and a live game session is written to Firestore.
2. A second player joins from another browser and both players see the same waiting room.
3. The host starts the game and both players transition into manual setup.
4. Each player places 2 settlements and 2 roads using legal board positions.
5. The second setup settlement grants starting resources from adjacent tiles.
6. The main turn loop works end to end: roll, collect, trade, build, end turn.
7. Roads, settlements, cities, resources, turn state, and victory points stay synchronized on both clients.
8. Every successful action is persisted to Firestore before the server updates in-memory state and broadcasts.
9. The first player to 10 VP wins, the game is marked finished, and both clients see the result screen.
10. A player can refresh and recover the latest persisted game state.

## Frozen Gameplay Scope

- Host, join, waiting room, and start-game flow
- Live Firestore persistence for create, join, start, setup placement, roll, build, trade, end turn, and game finish
- Manual initial placement on the board
- Server-authoritative `GameState.board` with synced roads, settlements, and cities
- Dice roll and resource distribution
- Road, settlement, and city building
- Bank trade and player-to-player trade
- Victory point tracking, longest road, win detection, and result screen
- No robber
- No development cards

## Frozen Rules for Demo 2

### Win Condition

- First player to reach `10 VP` on their own turn wins immediately.
- When a player wins, the server sets `winnerPlayerId`, marks the room `finished`, persists the final state, and broadcasts the finished snapshot.

### Setup Rules

- After `START_GAME`, the match enters setup instead of the normal turn loop.
- Each player places `1 settlement + 1 road`, then the same player order repeats once more.
- Setup order is the same in both rounds.
- A setup settlement must be placed on a legal empty vertex.
- A setup road must be placed on a legal empty edge adjacent to the settlement placed in that setup step.
- After a player finishes their second setup settlement and second setup road, they gain `1` resource from each adjacent non-desert tile.
- Setup settlements count toward victory points immediately.
- After the last player finishes the second setup road, turn `1` begins with the first player in `ROLL`.

### Turn Rules

- Only the active player may take turn actions.
- Turn flow is `ROLL -> ACTION -> END TURN -> next player ROLL`.
- The active player must roll exactly once before ending the turn.
- After a valid roll, resource distribution happens immediately, then the turn moves to `ACTION`.
- During `ACTION`, the active player may:
  - build
  - bank trade
  - offer a player trade
  - accept/reject/cancel the current player trade offer if applicable
- The turn cannot end while the active player still has an unresolved outgoing trade offer.

### Resource Distribution

- The server rolls `2` dice.
- The total must always be between `2` and `12`.
- Every non-desert tile with a matching number produces resources.
- A settlement collects `1` resource per adjacent matching tile.
- A city collects `2` resources per adjacent matching tile.
- There is no robber, no discard step, and no stealing in Demo 2.

### Build Costs

| Build | Cost |
|---|---|
| Road | `1 EMBER + 1 STONE` |
| Settlement | `1 EMBER + 1 BLOOM + 1 STONE` |
| City | `3 STONE + 2 BLOOM` |

Development cards are not part of Demo 2.

### Building Legality

#### Road

- Must be placed on an empty edge.
- Must connect to the active player's existing road network or one of their settlements/cities.
- A road path cannot continue through another player's settlement or city.

#### Settlement

- Must be placed on an empty vertex.
- Must connect to one of the active player's roads, except during setup.
- Must follow the distance rule: no adjacent occupied settlement/city vertex within one edge.

#### City

- Upgrades the active player's existing settlement in place.
- Cannot be built directly onto an empty vertex.

### Trade Rules

#### Bank Trade

- Only the active player may bank trade.
- Bank trade is `4:1` only.
- The player gives `4` of one resource type and receives `1` of any one resource type.
- No ports are included in Demo 2.

#### Player Trade

- Only the active player may create a player trade offer.
- One offer may be active at a time.
- The offer targets one other player.
- The target player may `accept` or `reject`.
- The active player may `cancel`.
- No counteroffers.
- On accept, both players' resources are revalidated and then exchanged atomically.

### Victory Points

- Each settlement is worth `1 VP`.
- Each city is worth `2 VP`.
- Longest road is worth `2 VP`.
- Longest road is awarded only when a player has a continuous road length of at least `5`.
- If there is a tie, the current holder keeps longest road until another player exceeds that length.

## Frozen Socket / Action Surface for Demo 2

### Existing Client Actions Retained

- `CREATE_GAME`
- `JOIN_GAME`
- `START_GAME`
- `ROLL_DICE`
- `END_TURN`

### New Client Actions Frozen for Demo 2

- `SYNC_GAME_STATE` — load the latest persisted game snapshot for a player session
- `PLACE_SETUP_SETTLEMENT` — place the current setup settlement
- `PLACE_SETUP_ROAD` — place the current setup road
- `BUILD_ROAD` — build a road during `ACTION`
- `BUILD_SETTLEMENT` — build a settlement during `ACTION`
- `UPGRADE_SETTLEMENT` — upgrade a settlement to a city during `ACTION`
- `BANK_TRADE` — perform a `4:1` bank trade
- `OFFER_TRADE` — create a direct player trade offer
- `ACCEPT_TRADE` — accept the current trade offer
- `REJECT_TRADE` — reject the current trade offer
- `CANCEL_TRADE` — cancel the current trade offer

### Required Broadcast Updates

- `GAME_STATE_UPDATE` remains the main room broadcast.
- Every successful action above must follow this order:
  1. validate
  2. compute next state
  3. persist to Firestore
  4. update in-memory room state
  5. broadcast `GAME_STATE_UPDATE`
- `ACTION_REJECTED` is sent only to the requesting client when validation fails or Firestore persistence fails.
- No extra broadcast event is required for trade state, setup state, or win state; those all travel inside `GAME_STATE_UPDATE`.

## 7-Person Task Split

### Austin Wang — `feat/demo2-gameplay-engine`

**Files**
- `src/server/engine/GameEngine.ts`
- `src/server/engine/TurnManager.ts`
- `src/server/engine/SetupManager.ts`
- `src/server/engine/PlacementValidator.ts`
- `src/server/engine/ResourceManager.ts`
- `src/server/engine/VictoryManager.ts`
- `src/server/engine/LongestRoadManager.ts`

**Exact job**
- Own the server gameplay rules.
- Implement manual setup progression.
- Implement placement validation for setup and normal building.
- Implement resource distribution after dice rolls.
- Implement VP recomputation, longest road, and win detection.
- Expose clear engine calls for the realtime and persistence layers to use.

**Acceptance criteria**
- Illegal setup placements are rejected.
- Illegal build placements are rejected.
- Dice/resource/build/win logic works server-side without client-side rule authority.
- Longest road and VP totals update correctly.
- Reaching `10 VP` produces a finished authoritative state.

### Nathan Hu — `feat/demo2-contracts-realtime`

**Files**
- `src/shared/types/domain.ts`
- `src/shared/types/socket.ts`
- `src/shared/constants/socketEvents.ts`
- `src/server/realtime/registerSocketHandlers.ts`
- `src/server/sessions/RoomManager.ts`
- `src/server/http/routes/rooms.ts`

**Exact job**
- Freeze the Demo 2 shared contracts.
- Replace `GARDEN` with `CITY`.
- Add the setup and trade state needed by Demo 2.
- Add the new socket actions and wire them to the engine and persistence path.
- Make join/reload pull the latest game state instead of relying on client-local assumptions.

**Acceptance criteria**
- The shared types match the Demo 2 ruleset.
- All retained and new socket actions are wired end to end.
- Joining or reloading can recover the latest active game snapshot.
- No duplicate client-only or server-only payload shapes remain.

### Helena Clifford — `feat/demo2-firestore-live`

**Files**
- `src/server/config/firebaseAdmin.ts`
- `src/server/persistence/FirestoreRepository.ts`
- `src/server/persistence/gameSessionsRepository.ts`
- `src/server/persistence/playersRepository.ts`
- `src/server/persistence/boardRepository.ts`
- `src/server/persistence/turnsRepository.ts`
- `src/server/persistence/GamePersistenceService.ts`

**Exact job**
- Make Firestore the live persistence layer for Demo 2.
- Implement the write path for create, join, start, setup placement, roll, build, trade, end turn, and game finish.
- Implement loading the latest saved game snapshot from Firestore.
- Ensure failed writes prevent the server from mutating local room state.

**Acceptance criteria**
- Every successful gameplay action is written to Firestore before broadcast.
- Persisted Firestore state matches the broadcast state.
- A saved room can be loaded back into server memory from Firestore.
- Firestore failures block invalid partial updates.

### Brandon Lee Felix — `feat/demo2-board-interactions`

**Files**
- `src/client/screens/TestMapGenScreen.ts`
- `src/client/rendering/CanvasRoot.ts`
- `src/client/rendering/RendererRoot.ts`
- `src/client/input/InputRegistry.ts`
- `src/client/rendering/BoardInteractionOverlay.ts`
- `src/client/rendering/BoardStructureRenderer.ts`

**Exact job**
- Own board interaction on the client.
- Map live vertex IDs and edge IDs onto the rendered board.
- Render placed roads, settlements, and cities from `GameState.board`.
- Implement hover/select/click handling for setup and building.

**Acceptance criteria**
- The player can click legal vertices and edges during setup/build flow.
- Invalid targets are visibly blocked.
- Roads, settlements, and cities render in the right positions on both clients.
- The board remains stable while live updates arrive.

### Emily Zhang — `feat/demo2-gameboard-ui`

**Files**
- `src/client/screens/GameBoardScreen.ts`
- `src/client/screens/ResultScreen.ts`
- `src/client/ui/ResourceTray.ts`
- `src/client/ui/BuildPanel.ts`
- `src/client/ui/TradePanel.ts`
- `src/client/ui/VictoryPanel.ts`

**Exact job**
- Own the main gameplay HUD and result screen.
- Show active player, phase, dice result, resources, VP, and available actions.
- Build the UI for build actions and trade actions.
- Show win state and final result when the game ends.
- Connect board selections from Brandon's overlay into the visible gameplay UI.

**Acceptance criteria**
- Resources and VP are always visible.
- Players can submit build and trade actions from the UI.
- Turn state and last roll are clear to all players.
- The result screen appears correctly when the game finishes.

### Barry Lu — `feat/demo2-trading`

**Files**
- `src/server/engine/TradeManager.ts`
- `src/client/networking/socketClient.ts`
- `src/client/networking/registerClientEvents.ts`
- `src/client/state/tradeState.ts`

**Exact job**
- Own Demo 2 trading.
- Implement bank trade validation and execution.
- Implement one-offer-at-a-time player trade flow.
- Wire trade actions into the client networking layer so Emily's UI can call them cleanly.

**Acceptance criteria**
- Bank trade works only for the active player and deducts/adds the correct resources.
- Player trade supports offer, accept, reject, and cancel.
- Accepted trades update both players atomically.
- Trade state stays synchronized across both clients.

### James Huang — `feat/demo2-dice-timer`

**Files**
- `src/server/engine/DiceManager.ts`
- `src/server/engine/TimerManager.ts`
- `src/server/persistence/turnsRepository.ts`
- `src/client/ui/DiceRollBanner.ts`
- `src/client/ui/TurnTimer.ts`

**Exact job**
- Own the dice roll service and turn timing helpers.
- Keep dice generation isolated and reusable.
- Persist turn start/end and dice roll records to Firestore turn docs.
- Provide dice/timer UI pieces that Emily can mount into the board screen.

**Acceptance criteria**
- Dice results are always valid and only happen once per turn.
- Turn timing and dice logs persist correctly.
- The latest roll is clearly displayed on the client.
- Timer UI resets correctly when a new turn begins if timer display is enabled.

## Phases

### Phase 1 — Contracts and Persistence Path

- Nathan freezes the shared types and action surface.
- Helena finalizes the Firestore write/load path.
- Austin aligns the engine interfaces to those contracts.

### Phase 2 — Server Gameplay Core

- Austin implements setup, legality, resources, VP, longest road, and win logic.
- Barry implements trade logic.
- James implements dice and turn timing helpers.

### Phase 3 — Client Board and Gameplay UI

- Brandon lands board interaction and structure rendering.
- Emily lands the gameplay HUD, build UI, trade UI, and result screen.

### Phase 4 — End-to-End Integration

- Nathan wires every action through realtime handlers.
- Helena connects persistence before broadcast.
- The team gets create, join, setup, roll, build, trade, and finish running across two browsers.

### Phase 5 — Hardening and Demo Polish

- Fix sync issues, persistence issues, legality bugs, and UI clarity issues.
- Run the full demo flow until it is stable without manual intervention.

## Full Demo 2 Gameplay Runthrough

When Demo 2 is done, the live demo should look like this:

1. The host opens the app, enters a name, chooses player count, and creates a room.
2. Firestore stores the game session immediately and the host sees a room code.
3. A second player joins from another browser using the room code.
4. Both clients show the same waiting room and player list.
5. The host starts the game.
6. Both clients enter the same board and the game enters manual setup.
7. Player 1 clicks a legal vertex and places a settlement.
8. Player 1 clicks a legal adjacent edge and places a road.
9. Player 2 does the same.
10. The same player order repeats for the second settlement and second road.
11. After each player's second settlement is finished, that player gains starting resources from adjacent non-desert tiles.
12. Setup ends and turn 1 begins with player 1 in `ROLL`.
13. The active player rolls dice.
14. The server writes the roll to Firestore, distributes resources, and both clients update instantly.
15. The active player can now build, bank trade, or offer a direct player trade.
16. If the active player builds a road, settlement, or city, the structure appears on both boards and resources are deducted on both clients.
17. If the active player makes a trade offer, the target player can accept or reject, and the resource totals update on both clients if accepted.
18. Longest road updates automatically when a player reaches a valid path length of at least `5`.
19. The active player ends the turn and the next player's HUD becomes active.
20. The match continues like this until a player reaches `10 VP`.
21. The server marks the game finished, stores the winner in Firestore, and broadcasts the final state.
22. Both clients transition to the result screen and show the winner and final state.
23. If a player refreshes during the match, the latest Firestore-backed game state can be loaded and the match resumes from the saved snapshot.

## Final Demo 2 Acceptance Checklist

- `npx tsc --noEmit -p tsconfig.server.json` passes
- `npx tsc --noEmit -p tsconfig.client.json` passes
- `npm run build` passes
- A host can create a Firestore-backed room
- A second player can join by room code
- Both clients show the same waiting room state
- The host can start the game
- Both clients enter manual setup
- Setup settlement placement enforces the distance rule
- Setup road placement enforces adjacency to the just-placed settlement
- Second setup settlement grants starting resources
- Only the active player can roll
- Dice rolls are synchronized and resource distribution is correct
- Only legal roads, settlements, and cities can be built
- Build costs are deducted correctly
- Bank trade works at `4:1`
- Player trade supports offer, accept, reject, and cancel
- Longest road awards and reassigns correctly
- VP totals update correctly on both clients
- First player to `10 VP` wins immediately on their turn
- The game becomes `finished` and no further gameplay actions are accepted
- The result screen shows the winner correctly
- Refresh/load can recover the latest persisted Firestore state
- No robber flow appears anywhere in the demo
- No development card action appears anywhere in the demo
