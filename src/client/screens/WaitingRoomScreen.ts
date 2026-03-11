import { ScreenId } from '../../shared/constants/screenIds';
import { ApiRoutes } from '../../shared/constants/apiRoutes';
import type { ApiResponse, RoomSnapshot } from '../../shared/types/api';
import { apiFetch } from '../networking/apiClient';
import { clearLobbySession, getLobbySession } from '../state/lobbyState';

export class WaitingRoomScreen {
  readonly id = ScreenId.WaitingRoom;
  private container: HTMLElement | null = null;
  private navigate: ((screenId: ScreenId) => void) | null = null;
  private pollTimer: number | null = null;

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
    statusText.textContent = 'Waiting for another player to join...';

    const playerList = document.createElement('div');
    playerList.className = 'flex flex-col gap-2 text-left mb-4';

    const leaveButton = document.createElement('button');
    leaveButton.className = 'w-full font-hexahaven-ui px-4 py-3 bg-slate-700 rounded-lg hover:bg-slate-600 transition-colors';
    leaveButton.textContent = 'Leave';
    leaveButton.addEventListener('click', () => {
      clearLobbySession();
      this.navigate?.(ScreenId.MainMenu);
    });

    card.appendChild(title);
    card.appendChild(keyLabel);
    card.appendChild(keyValue);
    card.appendChild(statusText);
    card.appendChild(playerList);
    card.appendChild(leaveButton);
    this.container.appendChild(card);
    parentElement.appendChild(this.container);

    const renderPlayers = (room: RoomSnapshot) => {
      playerList.innerHTML = '';
      room.players.forEach((player, index) => {
        const row = document.createElement('div');
        row.className = 'font-hexahaven-ui px-3 py-2 rounded-md bg-slate-800 border border-slate-700';
        row.textContent = `${index + 1}. ${player.name}`;
        playerList.appendChild(row);
      });
    };

    const poll = async () => {
      try {
        const response = await apiFetch<ApiResponse<{ room: RoomSnapshot }>>(`${ApiRoutes.RoomStatus}/${session.roomId}`);
        if (!response.success || !response.data) {
          throw new Error(response.error ?? 'Room no longer available.');
        }
        renderPlayers(response.data.room);
        if (response.data.room.players.length >= 2) {
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
