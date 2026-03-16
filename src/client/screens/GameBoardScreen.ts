import { ScreenId } from '../../shared/constants/screenIds';
import { ApiRoutes } from '../../shared/constants/apiRoutes';
import type { ApiResponse, RoomSnapshot } from '../../shared/types/api';
import { apiFetch } from '../networking/apiClient';
import { clearLobbySession, getLobbySession } from '../state/lobbyState';
import { TestMapGenScreen } from './TestMapGenScreen';

export class GameBoardScreen {
  readonly id = ScreenId.GameBoard;
  private mapScreen: TestMapGenScreen | null = null;
  private readonly backgroundMusic = new Audio('/audio/game-board-theme.mp3');
  private exitButton: HTMLButtonElement | null = null;
  private musicToggleButton: HTMLButtonElement | null = null;
  private playerPanel: HTMLDivElement | null = null;
  private buttonContainer: HTMLElement | null = null;
  private playersPollTimer: number | null = null;
  private isMusicMuted = false;

  constructor() {
    this.backgroundMusic.loop = true;
    this.backgroundMusic.volume = 0.35;
  }

  render(parentElement: HTMLElement, onComplete?: () => void, navigate?: (screenId: ScreenId) => void): void {
    this.playBackgroundMusic();
    const session = getLobbySession();
    const roomId = session?.roomId ?? null;
    this.mapScreen = new TestMapGenScreen({
      showExitButton: false,
      enableBackgroundMusic: false,
      showRegenerateButton: false,
      allowPointerRegenerate: false,
      mapSeed: roomId ?? undefined,
    });
    this.mapScreen.render(
      parentElement,
      onComplete,
      navigate ? (screenId: string) => navigate(screenId as ScreenId) : undefined,
    );

    this.buttonContainer = parentElement.firstElementChild as HTMLElement | null;
    if (!this.buttonContainer) {
      return;
    }
    this.mountPlayerPanel(this.buttonContainer);
    if (roomId) {
      void this.pollPlayers(roomId);
    }

    if (!navigate) {
      return;
    }
    const navigateTo = navigate;

    this.exitButton = document.createElement('button');
    this.exitButton.textContent = 'Exit to Menu';
    this.exitButton.className = 'font-hexahaven-ui';
    this.exitButton.style.position = 'absolute';
    this.exitButton.style.top = '16px';
    this.exitButton.style.right = '16px';
    this.exitButton.style.zIndex = '3';
    this.exitButton.style.padding = '8px 10px';
    this.exitButton.style.fontSize = '14px';
    this.exitButton.style.fontWeight = '600';
    this.exitButton.style.color = '#ffffff';
    this.exitButton.style.background = 'rgba(15, 23, 42, 0.85)';
    this.exitButton.style.border = '1px solid rgba(255, 255, 255, 0.35)';
    this.exitButton.style.borderRadius = '8px';
    this.exitButton.style.cursor = 'pointer';
    this.exitButton.addEventListener('click', () => {
      clearLobbySession();
      navigateTo(ScreenId.MainMenu);
    });
    this.buttonContainer.appendChild(this.exitButton);

    this.musicToggleButton = document.createElement('button');
    this.musicToggleButton.className = 'font-hexahaven-ui';
    this.musicToggleButton.style.position = 'absolute';
    this.musicToggleButton.style.top = '16px';
    this.musicToggleButton.style.left = '16px';
    this.musicToggleButton.style.zIndex = '3';
    this.musicToggleButton.style.padding = '8px 10px';
    this.musicToggleButton.style.fontSize = '14px';
    this.musicToggleButton.style.fontWeight = '600';
    this.musicToggleButton.style.color = '#ffffff';
    this.musicToggleButton.style.background = 'rgba(15, 23, 42, 0.85)';
    this.musicToggleButton.style.border = '1px solid rgba(255, 255, 255, 0.35)';
    this.musicToggleButton.style.borderRadius = '8px';
    this.musicToggleButton.style.cursor = 'pointer';
    this.musicToggleButton.addEventListener('click', () => this.toggleMusic());
    this.updateMusicButtonText();
    this.buttonContainer.appendChild(this.musicToggleButton);
  }

  private mountPlayerPanel(parent: HTMLElement): void {
    if (this.playerPanel) {
      this.playerPanel.remove();
    }
    const panel = document.createElement('div');
    panel.className = 'absolute top-16 left-4 flex flex-col gap-3';
    panel.style.zIndex = '3';
    panel.style.width = '180px';
    this.playerPanel = panel;
    parent.appendChild(panel);
  }

  private async pollPlayers(roomId: string): Promise<void> {
    try {
      const response = await apiFetch<ApiResponse<{ room: RoomSnapshot }>>(`${ApiRoutes.RoomStatus}/${roomId}`);
      if (!response.success || !response.data) {
        throw new Error(response.error ?? 'Unable to load players.');
      }
      this.renderPlayerCards(response.data.room);
    } catch {
      this.renderPlayerCards(null);
    }

    if (this.playerPanel) {
      this.playersPollTimer = window.setTimeout(() => {
        void this.pollPlayers(roomId);
      }, 1500);
    }
  }

  private renderPlayerCards(room: RoomSnapshot | null): void {
    if (!this.playerPanel) {
      return;
    }
    this.playerPanel.innerHTML = '';
    if (!room || room.players.length === 0) {
      const placeholder = document.createElement('div');
      placeholder.className =
        'font-hexahaven-ui text-xs text-slate-200 rounded-lg border border-slate-600 bg-slate-900/85 px-3 py-2';
      placeholder.textContent = 'Players unavailable';
      this.playerPanel.appendChild(placeholder);
      return;
    }

    room.players.forEach((player) => {
      const card = document.createElement('div');
      card.className = 'rounded-xl border border-slate-500 bg-slate-900/85 px-3 py-3 text-white shadow-md';

      const avatar = document.createElement('img');
      avatar.src = player.avatar;
      avatar.alt = `${player.name} avatar`;
      avatar.className = 'mx-auto mb-2 h-16 w-16 bg-transparent object-cover';

      const name = document.createElement('div');
      name.className = 'font-hexahaven-ui text-sm text-center truncate';
      name.textContent = player.name;

      const points = document.createElement('div');
      points.className = 'font-hexahaven-ui mt-2 text-xs text-slate-200 text-center';
      points.textContent = `Points: ${player.points}`;

      const resources = document.createElement('div');
      resources.className = 'font-hexahaven-ui mt-2 text-xs leading-5';
      resources.innerHTML = [
        `<span style="color: #c28d5b;">Ember: ${player.resources?.ember ?? 0}</span>`,
        `<span style="color: #fde047;">Gold: ${player.resources?.gold ?? 0}</span>`,
        `<span style="color: #a3a3a3;">Stone: ${player.resources?.stone ?? 0}</span>`,
        `<span style="color: #74b95e;">Bloom: ${player.resources?.bloom ?? 0}</span>`,
        `<span style="color: #ffffff;">Crystal: ${player.resources?.crystal ?? 0}</span>`,
      ].join('<br>');

      card.appendChild(avatar);
      card.appendChild(name);
      card.appendChild(points);
      card.appendChild(resources);
      this.playerPanel?.appendChild(card);
    });
  }

  private playBackgroundMusic(): void {
    this.backgroundMusic.currentTime = 0;
    this.backgroundMusic
      .play()
      .catch(() => {
        // Browser autoplay policies may block playback before user interaction.
      });
  }

  private stopBackgroundMusic(): void {
    this.backgroundMusic.pause();
    this.backgroundMusic.currentTime = 0;
  }

  private toggleMusic(): void {
    this.isMusicMuted = !this.isMusicMuted;
    this.backgroundMusic.muted = this.isMusicMuted;
    this.updateMusicButtonText();
  }

  private updateMusicButtonText(): void {
    if (!this.musicToggleButton) return;
    this.musicToggleButton.textContent = this.isMusicMuted ? 'Music: Off' : 'Music: On';
  }

  destroy(): void {
    this.stopBackgroundMusic();
    if (this.playersPollTimer !== null) {
      window.clearTimeout(this.playersPollTimer);
      this.playersPollTimer = null;
    }
    if (this.exitButton) {
      this.exitButton.remove();
      this.exitButton = null;
    }
    if (this.musicToggleButton) {
      this.musicToggleButton.remove();
      this.musicToggleButton = null;
    }
    if (this.playerPanel) {
      this.playerPanel.remove();
      this.playerPanel = null;
    }
    this.buttonContainer = null;
    this.mapScreen?.destroy();
    this.mapScreen = null;
  }
}
