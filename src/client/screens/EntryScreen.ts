import { ScreenId } from '../../shared/constants/screenIds';

export class EntryScreen {
  readonly id = ScreenId.Entry;
  private container: HTMLElement | null = null;
  private timeout: NodeJS.Timeout | null = null;

  render(parentElement: HTMLElement, onComplete?: () => void, _navigate?: (screenId: string) => void): void {
    // Clear existing content
    parentElement.innerHTML = '';

    // Create splash container
    this.container = document.createElement('div');
    this.container.className = 'flex flex-col items-center justify-center w-full h-full bg-gradient-to-b from-blue-950 via-slate-900 to-slate-950 gap-8';

    // Logo/Icon area
    const logoContainer = document.createElement('div');
    logoContainer.className = 'text-8xl mb-4 animate-pulse';
    logoContainer.textContent = '⬡';

    // Title
    const title = document.createElement('h1');
    title.className = 'text-5xl font-bold text-white drop-shadow-lg';
    title.textContent = 'HexaHaven';

    // Loading indicator
    const loadingContainer = document.createElement('div');
    loadingContainer.className = 'flex gap-2 mt-8';

    for (let i = 0; i < 3; i++) {
      const dot = document.createElement('div');
      dot.className = 'w-3 h-3 bg-blue-500 rounded-full animate-bounce';
      dot.style.animationDelay = `${i * 0.2}s`;
      loadingContainer.appendChild(dot);
    }

    // Subtitle
    const subtitle = document.createElement('p');
    subtitle.className = 'text-sm text-slate-400 mt-8';
    subtitle.textContent = 'Loading...';

    this.container.appendChild(logoContainer);
    this.container.appendChild(title);
    this.container.appendChild(loadingContainer);
    this.container.appendChild(subtitle);

    parentElement.appendChild(this.container);

    // Transition to main menu after 2 seconds
    if (onComplete) {
      this.timeout = setTimeout(() => {
        onComplete();
      }, 2000);
    }
  }

  destroy(): void {
    if (this.timeout) {
      clearTimeout(this.timeout);
      this.timeout = null;
    }
    if (this.container) {
      this.container.remove();
      this.container = null;
    }
  }
}
