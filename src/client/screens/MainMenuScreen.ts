import { ScreenId } from '../../shared/constants/screenIds';

export class MainMenuScreen {
  readonly id = ScreenId.MainMenu;
  private container: HTMLElement | null = null;
  private navigate: ((screenId: ScreenId) => void) | null = null;

  render(parentElement: HTMLElement, onComplete?: () => void, navigate?: (screenId: ScreenId) => void): void {
    this.navigate = navigate || null;
    // Clear existing content
    parentElement.innerHTML = '';

    // Create main container
    this.container = document.createElement('div');
    this.container.className = 'flex flex-col items-center justify-center w-full h-full bg-gradient-to-b from-slate-900 to-slate-950';

    // Title
    const title = document.createElement('h1');
    title.className = 'text-6xl font-bold text-white mb-4 drop-shadow-lg';
    title.textContent = 'HexaHaven';

    // Subtitle
    const subtitle = document.createElement('p');
    subtitle.className = 'text-xl text-slate-300 mb-12 drop-shadow-md';
    subtitle.textContent = 'Master the Hexagon Strategy Game';

    // Button container
    const buttonContainer = document.createElement('div');
    buttonContainer.className = 'flex flex-col gap-4 min-w-64';

    // Host Game button
    const hostBtn = this.createButton('Host Game', () => this.onHostGame());
    buttonContainer.appendChild(hostBtn);

    // Join Game button
    const joinBtn = this.createButton('Join Game', () => this.onJoinGame());
    buttonContainer.appendChild(joinBtn);

    // Watch Game button
    const watchBtn = this.createButton('Watch Game', () => this.onWatchGame());
    buttonContainer.appendChild(watchBtn);

    // Settings button
    const settingsBtn = this.createButton('Settings', () => this.onSettings(), 'secondary');
    buttonContainer.appendChild(settingsBtn);

    // Test Map Gen button
    const testMapBtn = this.createButton('Test Map Gen', () => this.onTestMapGen(), 'secondary');
    buttonContainer.appendChild(testMapBtn);

    this.container.appendChild(title);
    this.container.appendChild(subtitle);
    this.container.appendChild(buttonContainer);

    parentElement.appendChild(this.container);
  }

  private createButton(text: string, onClick: () => void, variant: 'primary' | 'secondary' = 'primary'): HTMLButtonElement {
    const button = document.createElement('button');
    const baseClasses = 'px-8 py-3 font-semibold rounded-lg transition-all duration-200 cursor-pointer hover:shadow-lg';
    const variantClasses = variant === 'primary'
      ? 'bg-blue-600 text-white hover:bg-blue-700 active:bg-blue-800'
      : 'bg-slate-700 text-white hover:bg-slate-600 active:bg-slate-800';

    button.className = `${baseClasses} ${variantClasses}`;
    button.textContent = text;
    button.addEventListener('click', onClick);

    return button;
  }

  private onHostGame(): void {
    if (this.navigate) {
      this.navigate(ScreenId.HostGame as any);
    }
  }

  private onJoinGame(): void {
    if (this.navigate) {
      this.navigate(ScreenId.JoinGame as any);
    }
  }

  private onWatchGame(): void {
    if (this.navigate) {
      this.navigate(ScreenId.WatchGame as any);
    }
  }

  private onSettings(): void {
    if (this.navigate) {
      this.navigate(ScreenId.Settings as any);
    }
  }

  private onTestMapGen(): void {
    if (this.navigate) {
      this.navigate(ScreenId.TestMapGen as any);
    }
  }

  destroy(): void {
    if (this.container) {
      this.container.remove();
      this.container = null;
    }
  }
}
