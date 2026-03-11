import { ScreenId } from '../../shared/constants/screenIds';
import { clearLobbySession } from '../state/lobbyState';
import { TestMapGenScreen } from './TestMapGenScreen';

export class GameBoardScreen {
  readonly id = ScreenId.GameBoard;
  private readonly mapScreen = new TestMapGenScreen();
  private exitButton: HTMLButtonElement | null = null;
  private buttonContainer: HTMLElement | null = null;

  render(parentElement: HTMLElement, onComplete?: () => void, navigate?: (screenId: ScreenId) => void): void {
    this.mapScreen.render(parentElement, onComplete, navigate);
    this.buttonContainer = parentElement.firstElementChild as HTMLElement | null;
    if (!this.buttonContainer || !navigate) {
      return;
    }

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
      navigate(ScreenId.MainMenu);
    });
    this.buttonContainer.appendChild(this.exitButton);
  }

  destroy(): void {
    if (this.exitButton) {
      this.exitButton.remove();
      this.exitButton = null;
    }
    this.buttonContainer = null;
    this.mapScreen.destroy();
  }
}
