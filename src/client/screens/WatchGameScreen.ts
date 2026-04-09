import { ScreenId } from '../../shared/constants/screenIds';
import { createMusicToggleButton } from '../ui/musicToggleButton';

export class WatchGameScreen {
  readonly id = ScreenId.WatchGame;
  private container: HTMLElement | null = null;
  private navigate: ((screenId: ScreenId) => void) | null = null;
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
    subtitle.textContent = 'Spectator mode is deferred while the Firestore-authoritative player flow is being finalized.';

    const backButton = document.createElement('button');
    backButton.className = 'w-full mt-4 font-hexahaven-ui px-4 py-3 bg-slate-700 rounded-lg hover:bg-slate-600 transition-colors';
    backButton.textContent = 'Back';
    backButton.addEventListener('click', () => {
      this.navigate?.(ScreenId.MainMenu);
    });

    card.appendChild(title);
    card.appendChild(subtitle);
    card.appendChild(backButton);
    this.container.appendChild(card);
    this.container.appendChild(createMusicToggleButton());
    parentElement.appendChild(this.container);
  }

  destroy(): void {
    if (this.container) {
      this.container.remove();
      this.container = null;
    }
  }
}
