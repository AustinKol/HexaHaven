import { ScreenId } from '../../shared/constants/screenIds';
import { refreshMenuMusicVolume } from '../audio/menuMusic';
import { loadSettings, saveSettings } from '../settings/gameSettings';
import { createMusicToggleButton } from '../ui/musicToggleButton';
import type { GameSettings } from '../settings/gameSettings';

export class SettingsScreen {
  readonly id = ScreenId.Settings;
  private container: HTMLElement | null = null;
  private navigate: ((screenId: ScreenId) => void) | null = null;
  private settings: GameSettings = loadSettings();

  private volumeValueEl: HTMLElement | null = null;
  private volumeRangeEl: HTMLInputElement | null = null;
  private sfxValueEl: HTMLElement | null = null;

  render(parentElement: HTMLElement, _onComplete?: () => void, navigate?: (screenId: ScreenId) => void): void {
    this.navigate = navigate ?? null;
    this.settings = loadSettings();
    parentElement.innerHTML = '';

    this.container = document.createElement('div');
    this.container.className =
      'relative flex flex-col items-center justify-center w-full h-full overflow-hidden bg-gradient-to-b from-slate-900 to-slate-950';

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
    content.className =
      'relative z-10 flex flex-col items-center justify-center w-full h-full px-4 py-8 min-h-0';

    const panel = document.createElement('div');
    panel.className =
      'flex flex-col w-full max-w-lg rounded-2xl border border-slate-600/40 bg-slate-900/75 backdrop-blur-md shadow-2xl';

    const header = document.createElement('div');
    header.className = 'flex-shrink-0 px-8 pt-8 pb-4 border-b border-slate-600/40';

    const title = document.createElement('h1');
    title.className =
      'font-hexahaven-title text-3xl sm:text-4xl font-bold text-white tracking-wide text-center drop-shadow-md';
    title.textContent = 'Settings';
    header.appendChild(title);
    panel.appendChild(header);

    const body = document.createElement('div');
    body.className = 'px-8 py-8 flex flex-col gap-8';

    body.appendChild(this.createVolumeRow());
    body.appendChild(this.createSfxRow());

    panel.appendChild(body);

    const footer = document.createElement('div');
    footer.className = 'flex-shrink-0 flex justify-center px-8 py-5 border-t border-slate-600/40';

    const goBackBtn = document.createElement('button');
    goBackBtn.className =
      'font-hexahaven-ui px-8 py-3 font-semibold rounded-lg transition-all duration-200 cursor-pointer hover:shadow-lg bg-slate-700 text-white hover:bg-slate-600 active:bg-slate-800';
    goBackBtn.textContent = 'Go back';
    goBackBtn.addEventListener('click', () => {
      this.navigate?.(ScreenId.MainMenu);
    });

    footer.appendChild(goBackBtn);
    panel.appendChild(footer);

    content.appendChild(panel);

    this.container.appendChild(backgroundVideo);
    this.container.appendChild(overlay);
    this.container.appendChild(content);
    this.container.appendChild(createMusicToggleButton());
    parentElement.appendChild(this.container);
  }

  private applyMasterVolume(next: number): void {
    const v = Math.max(0, Math.min(100, Math.round(next / 5) * 5));
    this.settings.masterVolume = v;
    if (this.volumeValueEl) {
      this.volumeValueEl.textContent = `${v}%`;
    }
    if (this.volumeRangeEl) {
      this.volumeRangeEl.value = String(v);
    }
    saveSettings(this.settings);
    refreshMenuMusicVolume();
  }

  private createVolumeRow(): HTMLElement {
    const row = document.createElement('div');
    row.className = 'flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-8';

    const label = document.createElement('span');
    label.className = 'font-hexahaven-ui text-sm font-bold text-amber-100/95 uppercase tracking-wide shrink-0';
    label.textContent = 'Volume';

    const control = document.createElement('div');
    control.className = 'flex flex-1 flex-wrap items-center justify-end gap-2 min-w-0';

    const leftBtn = this.createArrowButton('‹', () => {
      this.applyMasterVolume(this.settings.masterVolume - 5);
    });

    const range = document.createElement('input');
    range.type = 'range';
    range.min = '0';
    range.max = '100';
    range.step = '5';
    range.value = String(this.settings.masterVolume);
    range.setAttribute('aria-label', 'Master volume');
    range.className =
      'min-w-[100px] flex-1 max-w-[220px] h-2 cursor-pointer accent-sky-500 rounded-full bg-slate-700/80';
    this.volumeRangeEl = range;
    range.addEventListener('input', () => {
      this.applyMasterVolume(Number(range.value));
    });

    const rightBtn = this.createArrowButton('›', () => {
      this.applyMasterVolume(this.settings.masterVolume + 5);
    });

    const pill = this.createPill(`${this.settings.masterVolume}%`, false);
    this.volumeValueEl = pill;

    control.appendChild(leftBtn);
    control.appendChild(range);
    control.appendChild(rightBtn);
    control.appendChild(pill);

    row.appendChild(label);
    row.appendChild(control);
    return row;
  }

  private createSfxRow(): HTMLElement {
    const row = this.createRowShell();

    const label = document.createElement('span');
    label.className = 'font-hexahaven-ui text-sm font-bold text-amber-100/95 uppercase tracking-wide';
    label.textContent = 'SFX';

    const pill = this.createPill(this.settings.sfxEnabled ? 'ON' : 'OFF');
    this.sfxValueEl = pill;

    pill.addEventListener('click', () => {
      this.settings.sfxEnabled = !this.settings.sfxEnabled;
      this.sfxValueEl!.textContent = this.settings.sfxEnabled ? 'ON' : 'OFF';
      saveSettings(this.settings);
    });

    row.appendChild(label);
    row.appendChild(pill);
    return row;
  }

  private createRowShell(): HTMLElement {
    const row = document.createElement('div');
    row.className = 'flex items-center justify-between gap-8';
    return row;
  }

  private createPill(text: string, interactive = true): HTMLElement {
    const pill = document.createElement('div');
    const base =
      'font-hexahaven-ui text-sm font-medium text-slate-100 bg-slate-700/90 rounded-full px-5 py-1.5 min-w-[80px] text-center border border-slate-600/50 transition-colors duration-150';
    pill.className = interactive
      ? `${base} cursor-pointer select-none hover:bg-slate-600/90`
      : `${base} cursor-default`;
    pill.textContent = text;
    return pill;
  }

  private createArrowButton(symbol: string, onClick: () => void): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className =
      'font-hexahaven-ui w-8 h-8 shrink-0 flex items-center justify-center rounded-full bg-slate-700 text-slate-100 text-xl font-bold border border-slate-600/50 hover:bg-slate-600 active:bg-slate-800 transition-all duration-150 cursor-pointer leading-none';
    btn.textContent = symbol;
    btn.addEventListener('click', onClick);
    return btn;
  }

  destroy(): void {
    if (this.container) {
      this.container.remove();
      this.container = null;
    }
    this.volumeRangeEl = null;
    this.volumeValueEl = null;
    this.sfxValueEl = null;
  }
}
