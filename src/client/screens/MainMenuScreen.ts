import { ScreenId } from '../../shared/constants/screenIds';
import { createMusicToggleButton } from '../ui/musicToggleButton';

export class MainMenuScreen {
  readonly id = ScreenId.MainMenu;
  private container: HTMLElement | null = null;
  private navigate: ((screenId: ScreenId) => void) | null = null;

  render(parentElement: HTMLElement, onComplete?: () => void, navigate?: (screenId: ScreenId) => void): void {
    this.navigate = navigate || null;
    parentElement.innerHTML = '';

    this.container = document.createElement('div');
    this.container.className = 'relative flex flex-col items-center justify-center w-full h-full overflow-hidden bg-gradient-to-b from-slate-900 to-slate-950';

    // Background video
    const backgroundVideo = document.createElement('video');
    backgroundVideo.className = 'absolute inset-0 w-full h-full object-cover';
    backgroundVideo.autoplay = true;
    backgroundVideo.loop = true;
    backgroundVideo.muted = true;
    backgroundVideo.playsInline = true;
    backgroundVideo.setAttribute('aria-hidden', 'true');

    const videoSource = document.createElement('source');
    videoSource.src = '/videos/welcome-bg.mp4';
    videoSource.type = 'video/mp4';
    backgroundVideo.appendChild(videoSource);

    const overlay = document.createElement('div');
    overlay.className = 'absolute inset-0 bg-slate-950/50';

    const content = document.createElement('div');
    content.className = 'relative z-10 flex flex-col items-center justify-center w-full h-full';

    const title = document.createElement('h1');
    title.className = 'font-hexahaven-title text-6xl font-bold text-white mb-4 drop-shadow-lg';
    title.textContent = 'HexaHaven';

    const subtitle = document.createElement('p');
    subtitle.className = 'font-hexahaven-ui text-xl text-slate-300 mb-12 drop-shadow-md';
    subtitle.textContent = 'Shape your haven, one turn at a time!';

    const buttonContainer = document.createElement('div');
    buttonContainer.className = 'flex flex-col gap-4 min-w-64';

    // Primary buttons
    const hostBtn = this.createButton('Host Game', () => this.navigate?.(ScreenId.HostGame as any));
    const joinBtn = this.createButton('Join Game', () => this.navigate?.(ScreenId.JoinGame as any));
    const watchBtn = this.createButton('Watch Game', () => this.navigate?.(ScreenId.WatchGame as any));
    buttonContainer.appendChild(hostBtn);
    buttonContainer.appendChild(joinBtn);
    buttonContainer.appendChild(watchBtn);

    // Secondary buttons
    const rulesBtn = this.createButton('How to Play', () => this.navigate?.(ScreenId.Rules as any), 'secondary');
    const settingsBtn = this.createButton('Settings', () => this.navigate?.(ScreenId.Settings as any), 'secondary');
    const testMapBtn = this.createButton('Test Map Gen', () => this.navigate?.(ScreenId.TestMapGen as any), 'secondary');
    buttonContainer.appendChild(rulesBtn);
    buttonContainer.appendChild(settingsBtn);
    buttonContainer.appendChild(testMapBtn);

    content.appendChild(title);
    content.appendChild(subtitle);
    content.appendChild(buttonContainer);

    const musicToggleBtn = createMusicToggleButton();

    this.container.appendChild(backgroundVideo);
    this.container.appendChild(overlay);
    this.container.appendChild(content);
    this.container.appendChild(musicToggleBtn);

    parentElement.appendChild(this.container);
  }

  private createButton(text: string, onClick: () => void, variant: 'primary' | 'secondary' = 'primary'): HTMLButtonElement {
    const button = document.createElement('button');
    const baseClasses = 'font-hexahaven-ui px-8 py-3 font-semibold rounded-lg transition-all duration-200 cursor-pointer hover:shadow-lg';
    const variantClasses = variant === 'primary'
      ? 'bg-blue-600 text-white hover:bg-blue-700 active:bg-blue-800'
      : 'bg-slate-700 text-white hover:bg-slate-600 active:bg-slate-800';

    button.className = `${baseClasses} ${variantClasses}`;
    button.textContent = text;
    button.addEventListener('click', onClick);
    return button;
  }

  destroy(): void {
    if (this.container) {
      this.container.remove();
      this.container = null;
    }
  }
}
