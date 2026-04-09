import { ScreenId } from '../../shared/constants/screenIds';
import { ApiRoutes } from '../../shared/constants/apiRoutes';
import type { ApiResponse, RoomSnapshot } from '../../shared/types/api';
import { apiFetch } from '../networking/apiClient';
import { setLobbySession } from '../state/lobbyState';
import { createMusicToggleButton } from '../ui/musicToggleButton';

export class WatchGameScreen {
  readonly id = ScreenId.WatchGame;
  private container: HTMLElement | null = null;
  private navigate: ((screenId: ScreenId) => void) | null = null;
  private isSubmitting = false;

  render(parentElement: HTMLElement, _onComplete?: () => void, navigate?: (screenId: ScreenId) => void): void {
    this.navigate = navigate ?? null;
    parentElement.innerHTML = '';
    this.container = document.createElement('div');
    this.container.className = 'relative flex flex-col items-center justify-center w-full h-full overflow-hidden bg-slate-950';

    const card = document.createElement('div');
    card.className = 'w-full max-w-md rounded-xl bg-slate-900/90 border border-slate-700 p-6 text-white shadow-2xl';

    const title = document.createElement('h2');
    title.className = 'font-hexahaven-title text-3xl mb-2';
    title.textContent = 'Watch Game';

    const subtitle = document.createElement('p');
    subtitle.className = 'font-hexahaven-ui text-slate-300 mb-5';
    subtitle.textContent = 'Enter a game key to spectate.';

    const keyInput = document.createElement('input');
    keyInput.className = 'w-full px-4 py-3 rounded-lg bg-slate-800 border border-slate-600 text-white mb-3 uppercase tracking-widest';
    keyInput.placeholder = 'Game key (e.g. AB12CD)';
    keyInput.maxLength = 6;

    const errorText = document.createElement('p');
    errorText.className = 'font-hexahaven-ui text-sm text-red-300 min-h-5 mb-3';

    const watchButton = document.createElement('button');
    watchButton.className = 'w-full font-hexahaven-ui px-4 py-3 bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-60';
    watchButton.textContent = 'Watch';

    const backButton = document.createElement('button');
    backButton.className = 'w-full mt-2 font-hexahaven-ui px-4 py-3 bg-slate-700 rounded-lg hover:bg-slate-600 transition-colors';
    backButton.textContent = 'Back';

    const submit = async () => {
      if (this.isSubmitting) {
        return;
      }
      const roomId = keyInput.value.trim().toUpperCase();
      if (!roomId) {
        errorText.textContent = 'Please enter a game key.';
        return;
      }

      this.isSubmitting = true;
      watchButton.disabled = true;
      watchButton.textContent = 'Checking...';
      errorText.textContent = '';

      try {
        const response = await apiFetch<ApiResponse<{ room: RoomSnapshot }>>(`${ApiRoutes.RoomStatus}/${roomId}`);
        if (!response.success || !response.data) {
          throw new Error(response.error ?? 'Game key not found.');
        }
        if (response.data.room.players.length < 2) {
          throw new Error('Game has not started yet. Try again once a second player joins.');
        }

        setLobbySession({
          roomId: response.data.room.roomId,
          playerId: 'spectator',
          playerName: 'Spectator',
          role: 'spectator',
        });
        this.navigate?.(ScreenId.GameBoard);
      } catch (error) {
        errorText.textContent = error instanceof Error ? error.message : 'Unable to watch game.';
      } finally {
        this.isSubmitting = false;
        watchButton.disabled = false;
        watchButton.textContent = 'Watch';
      }
    };

    keyInput.addEventListener('input', () => {
      keyInput.value = keyInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    });
    keyInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        void submit();
      }
    });
    watchButton.addEventListener('click', () => {
      void submit();
    });
    backButton.addEventListener('click', () => {
      this.navigate?.(ScreenId.MainMenu);
    });

    card.appendChild(title);
    card.appendChild(subtitle);
    card.appendChild(keyInput);
    card.appendChild(errorText);
    card.appendChild(watchButton);
    card.appendChild(backButton);
    this.container.appendChild(card);
    this.container.appendChild(createMusicToggleButton());
    parentElement.appendChild(this.container);
    keyInput.focus();
  }

  destroy(): void {
    if (this.container) {
      this.container.remove();
      this.container = null;
    }
  }
}
