# HexaHaven

HexaHaven is a turn-based strategy hex game built with Phaser, Vite, and Socket.IO.  
Players share a room key, join a lobby, and compete on a hexagonal map where tile outcomes and resources are driven by dice rolls.

🌐 Deployed on: https://hexa-haven.vercel.app/  
☁️ Backend deployed on Google Cloud Run

## Game Screen

![HexaHaven gameplay screenshot](https://github.com/user-attachments/assets/50dad0e4-dbd9-465b-8afb-30784e531860)


## Rules

1. **Player count:** games are played with 2-4 players.
2. **Map:** the board is a hexagonal map of resource tiles with number tokens.
3. **Dice and resources:** each turn, dice are rolled and tiles matching the roll generate resources.
4. **Turn actions:** on your turn, collect resources and spend them to:
   - Build roads
   - Place settlements
   - Upgrade settlements
   - Construct special structures
5. **Win condition:** the first player to achieve 10 victory points (VP).

## How to Build
Run all commands below from the project root folder:

### Prerequisites

- Node.js 18+ (recommended: latest LTS)
- npm

### Install dependencies

```bash
npm install
```

### Build production client

```bash
npm run build
```

## How to Run and Play (Local)

### Start the game

```bash
npm run dev
```

This starts:
- Client (Vite): `http://localhost:8080`
- Server (Express + Socket.IO): `http://localhost:3000`

### Play flow

2. Choose **Host Game**, enter your name, and pick a game size (**2**, **3**, or **4** players).
3. Click **Create Game Key** and share the 6-character key with other players.
4. Other players choose **Join Game**, enter their name + key, and join the waiting room.
5. The host clicks **Start Game** once at least 2 players are in the room.
6. During your turn:
   - **ROLL** phase: click **Roll Dice**.
   - **ACTION** phase: build, bank trade (`4:1`), chat, then click **End Turn**.
