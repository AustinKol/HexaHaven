import { ScreenId } from '../../shared/constants/screenIds';

export class SettingsScreen {
  readonly id = ScreenId.Settings;
  private container: HTMLElement | null = null;
  private navigate: ((screenId: ScreenId) => void) | null = null;

  render(parentElement: HTMLElement, _onComplete?: () => void, navigate?: (screenId: ScreenId) => void): void {
    this.navigate = navigate ?? null;
    parentElement.innerHTML = '';

    this.container = document.createElement('div');
    this.container.className = 'relative w-full h-full bg-black';

    const backButton = document.createElement('button');
    backButton.className = 'absolute top-6 right-6 font-hexahaven-ui px-8 py-3 font-semibold rounded-lg transition-all duration-200 cursor-pointer bg-slate-700 text-white hover:bg-slate-600 active:bg-slate-800';
    backButton.textContent = 'Return to Menu';
    backButton.addEventListener('click', () => {
      this.navigate?.(ScreenId.MainMenu);
    });

    this.container.appendChild(backButton);
    parentElement.appendChild(this.container);
  }

  destroy(): void {
    if (this.container) {
      this.container.remove();
      this.container = null;
    }
  }
}
