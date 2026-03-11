import { ScreenId } from '../../shared/constants/screenIds';
import { clearLobbySession } from '../state/lobbyState';
import { TestMapGenScreen } from './TestMapGenScreen';

export class GameBoardScreen {
  readonly id = ScreenId.GameBoard;
  private readonly mapScreen = new TestMapGenScreen({ showExitButton: false, enableBackgroundMusic: false });
  private readonly backgroundMusic = new Audio('/audio/game-board-theme.mp3');
  private exitButton: HTMLButtonElement | null = null;
  private musicToggleButton: HTMLButtonElement | null = null;
  private buttonContainer: HTMLElement | null = null;
  private isMusicMuted = false;

  constructor() {
    this.backgroundMusic.loop = true;
    this.backgroundMusic.volume = 0.35;
  }

  render(parentElement: HTMLElement, onComplete?: () => void, navigate?: (screenId: ScreenId) => void): void {
    this.playBackgroundMusic();
    this.mapScreen.render(
      parentElement,
      onComplete,
      navigate ? (screenId: string) => navigate(screenId as ScreenId) : undefined,
    );

    this.buttonContainer = parentElement.firstElementChild as HTMLElement | null;
    if (!this.buttonContainer || !navigate) {
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
    this.musicToggleButton.style.top = '62px';
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
    if (this.exitButton) {
      this.exitButton.remove();
      this.exitButton = null;
    }
    if (this.musicToggleButton) {
      this.musicToggleButton.remove();
      this.musicToggleButton = null;
    }
    this.buttonContainer = null;
    this.mapScreen.destroy();
  }
}
