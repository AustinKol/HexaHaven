import { ScreenId } from '../../shared/constants/screenIds';
import { ApiRoutes } from '../../shared/constants/apiRoutes';
import type { ApiResponse, RoomSnapshot } from '../../shared/types/api';
import { apiFetch } from '../networking/apiClient';
import { clearLobbySession, getLobbySession } from '../state/lobbyState';
import { createMusicToggleButton } from '../ui/musicToggleButton';

export class WaitingRoomScreen {
  readonly id = ScreenId.WaitingRoom;
  private container: HTMLElement | null = null;
  private navigate: ((screenId: ScreenId) => void) | null = null;
  private pollTimer: number | null = null;
  private isStarting = false;

  render(parentElement: HTMLElement, _onComplete?: () => void, navigate?: (screenId: ScreenId) => void): void {
    this.navigate = navigate ?? null;
    const session = getLobbySession();
    if (!session) {
      this.navigate?.(ScreenId.MainMenu);
      return;
    }

    parentElement.innerHTML = '';
    this.container = document.createElement('div');
    this.container.className = 'relative flex flex-col items-center justify-center w-full h-full overflow-hidden bg-slate-950 text-white';

    const card = document.createElement('div');
    card.className = 'w-full max-w-lg rounded-xl bg-slate-900/90 border border-slate-700 p-6 text-center shadow-2xl';

    const title = document.createElement('h2');
    title.className = 'font-hexahaven-title text-3xl mb-2';
    title.textContent = 'Waiting Room';

    const keyLabel = document.createElement('p');
    keyLabel.className = 'font-hexahaven-ui text-slate-300 mb-1';
    keyLabel.textContent = 'Share this game key:';

    const keyValue = document.createElement('button');
    keyValue.className = 'font-mono text-2xl tracking-widest bg-slate-800 border border-slate-600 rounded-lg px-4 py-2 mb-4 hover:bg-slate-700 transition-colors';
    keyValue.textContent = session.roomId;
    keyValue.title = 'Click to copy key';
    keyValue.addEventListener('click', async () => {
      await window.navigator.clipboard.writeText(session.roomId);
      keyValue.textContent = `${session.roomId} (copied)`;
      window.setTimeout(() => {
        keyValue.textContent = session.roomId;
      }, 1000);
    });

    const statusText = document.createElement('p');
    statusText.className = 'font-hexahaven-ui text-slate-200 mb-3';
    statusText.textContent = 'Loading room...';

    const playerList = document.createElement('div');
    playerList.className = 'flex flex-col gap-2 text-left mb-4';

    const capacityText = document.createElement('p');
    capacityText.className = 'font-hexahaven-ui text-slate-300 mb-3';
    capacityText.textContent = '0/0';

    const startButton = document.createElement('button');
    startButton.className =
      'w-full mb-2 font-hexahaven-ui px-4 py-3 bg-emerald-600 rounded-lg hover:bg-emerald-700 transition-colors disabled:opacity-60 disabled:cursor-not-allowed';
    startButton.textContent = 'Start Game';
    startButton.disabled = true;
    startButton.style.display = session.role === 'host' ? 'block' : 'none';

    const leaveButton = document.createElement('button');
    leaveButton.className = 'w-full font-hexahaven-ui px-4 py-3 bg-slate-700 rounded-lg hover:bg-slate-600 transition-colors';
    leaveButton.textContent = 'Leave';
    leaveButton.addEventListener('click', async () => {
      try {
        console.error('Leave button clicked', {
          roomId: session.roomId,
          playerId: session.playerId,
          route: ApiRoutes.LeaveRoom,
        });

        const response = await apiFetch(ApiRoutes.LeaveRoom, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            roomId: session.roomId,
            playerId: session.playerId,
          }),
        });

        console.error('Leave response:', response);
      } catch (error) {
        console.error('Leave request failed:', error);
      } finally {
        clearLobbySession();
        this.navigate?.(ScreenId.MainMenu);
      }
    });

    card.appendChild(title);
    card.appendChild(keyLabel);
    card.appendChild(keyValue);
    card.appendChild(statusText);
    card.appendChild(capacityText);
    card.appendChild(playerList);
    card.appendChild(startButton);
    card.appendChild(leaveButton);
    this.container.appendChild(card);
    this.container.appendChild(createMusicToggleButton());
    parentElement.appendChild(this.container);

    const renderPlayers = (room: RoomSnapshot) => {
      playerList.innerHTML = '';
      room.players.forEach((player, index) => {
        const row = document.createElement('div');
        row.className = 'font-hexahaven-ui px-3 py-2 rounded-md bg-slate-800 border border-slate-700 flex items-center gap-3';
        const isHost = player.id === room.players[0]?.id;
        const avatar = document.createElement('img');
        avatar.src = player.avatar;
        avatar.alt = `${player.name} avatar`;
        avatar.className = 'h-12 w-12 bg-transparent object-cover';

        const playerText = document.createElement('span');
        playerText.textContent = `${index + 1}. ${player.name}${isHost ? ' (Host)' : ''}`;

        row.appendChild(avatar);
        row.appendChild(playerText);
        playerList.appendChild(row);
      });
    };

    const updateStatusText = (room: RoomSnapshot) => {
      if (room.status === 'in_progress') {
        statusText.textContent = 'Game is starting...';
        return;
      }
      if (session.role === 'host') {
        statusText.textContent =
          room.players.length < 2 ? 'Waiting for at least one more player to join...' : 'Players joined. Click "Start Game" when ready.';
        return;
      }
      statusText.textContent =
        room.players.length < 2 ? 'Waiting for host...' : 'Waiting for host to start the game...';
    };

    const updateStartButtonState = (room: RoomSnapshot) => {
      if (session.role !== 'host') {
        return;
      }
      if (this.isStarting) {
        startButton.disabled = true;
        startButton.textContent = 'Starting...';
        return;
      }
      const canStart = room.status === 'waiting' && room.players.length >= 2;
      startButton.disabled = !canStart;
      startButton.textContent = 'Start Game';
    };

    startButton.addEventListener('click', async () => {
      if (session.role !== 'host' || this.isStarting) {
        return;
      }
      this.isStarting = true;
      startButton.disabled = true;
      startButton.textContent = 'Starting...';
      try {
        const response = await apiFetch<ApiResponse<{ room: RoomSnapshot }>>(ApiRoutes.StartRoom, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ roomId: session.roomId, playerId: session.playerId }),
        });
        if (!response.success) {
          throw new Error(response.error ?? 'Unable to start game.');
        }
        statusText.textContent = 'Game is starting...';
      } catch (error) {
        statusText.textContent = error instanceof Error ? error.message : 'Unable to start game.';
      } finally {
        this.isStarting = false;
      }
    });

    const poll = async () => {
      try {
        const response = await apiFetch<ApiResponse<{ room: RoomSnapshot }>>(`${ApiRoutes.RoomStatus}/${session.roomId}`);
        if (!response.success || !response.data) {
          throw new Error(response.error ?? 'Room no longer available.');
        }
        const room = response.data.room;
        capacityText.textContent = `${room.players.length}/${room.maxPlayers}`;
        renderPlayers(room);
        updateStatusText(room);
        updateStartButtonState(room);
        if (room.status === 'in_progress') {
          this.navigate?.(ScreenId.GameBoard);
          return;
        }
      } catch {
        statusText.textContent = 'Room not found. Returning to menu...';
        window.setTimeout(() => {
          clearLobbySession();
          this.navigate?.(ScreenId.MainMenu);
        }, 1200);
        return;
      }
      this.pollTimer = window.setTimeout(() => {
        void poll();
      }, 1200);
    };

    void poll();
  }

  destroy(): void {
    if (this.pollTimer !== null) {
      window.clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.container) {
      this.container.remove();
      this.container = null;
    }
  }
}
