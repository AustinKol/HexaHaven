import { ScreenId } from '../../shared/constants/screenIds';
import { loadSettings, saveSettings } from '../settings/gameSettings';
import { createMusicToggleButton } from '../ui/musicToggleButton';
import type { GameSettings, TextSpeed } from '../settings/gameSettings';

const TEXT_SPEEDS: TextSpeed[] = ['Slow', 'Medium', 'Fast'];

export class SettingsScreen {
  readonly id = ScreenId.Settings;
  private container: HTMLElement | null = null;
  private navigate: ((screenId: ScreenId) => void) | null = null;
  private settings: GameSettings = loadSettings();

  // Live UI refs
  private volumeValueEl: HTMLElement | null = null;
  private sfxValueEl: HTMLElement | null = null;
  private textSpeedValueEl: HTMLElement | null = null;

  render(parentElement: HTMLElement, _onComplete?: () => void, navigate?: (screenId: ScreenId) => void): void {
    this.navigate = navigate ?? null;
    this.settings = loadSettings();
    parentElement.innerHTML = '';

    this.container = document.createElement('div');
    this.container.className =
      'relative flex items-center justify-center w-full h-full bg-gradient-to-b from-slate-900 to-slate-950';

    const panel = document.createElement('div');
    panel.className =
      'relative flex flex-col items-center bg-white rounded-2xl shadow-2xl px-16 py-12 min-w-[480px]';

    // Title
    const title = document.createElement('h1');
    title.className = 'font-hexahaven-ui text-3xl font-bold text-slate-900 mb-10 tracking-wide uppercase';
    title.textContent = 'Settings';
    panel.appendChild(title);

    const rows = document.createElement('div');
    rows.className = 'flex flex-col gap-6 w-full';

    // Volume row
    rows.appendChild(this.createVolumeRow());

    // SFX row
    rows.appendChild(this.createSfxRow());

    // Text speed row
    rows.appendChild(this.createTextSpeedRow());

    panel.appendChild(rows);

    const footer = document.createElement('div');
    footer.className = 'flex justify-end w-full mt-10';

    const goBackBtn = document.createElement('button');
    goBackBtn.className =
      'font-hexahaven-ui px-6 py-2 text-sm font-semibold rounded-lg bg-slate-200 text-slate-700 hover:bg-slate-300 active:bg-slate-400 transition-all duration-150 cursor-pointer';
    goBackBtn.textContent = 'Go back';
    goBackBtn.addEventListener('click', () => {
      this.navigate?.(ScreenId.MainMenu);
    });

    footer.appendChild(goBackBtn);
    panel.appendChild(footer);

    this.container.appendChild(panel);
    this.container.appendChild(createMusicToggleButton());
    parentElement.appendChild(this.container);
  }


  private createVolumeRow(): HTMLElement {
    const row = this.createRow('Volume:');

    const control = document.createElement('div');
    control.className = 'flex items-center gap-2';

    const leftBtn = this.createArrowButton('‹', () => {
      this.settings.masterVolume = Math.max(0, this.settings.masterVolume - 5);
      this.volumeValueEl!.textContent = `${this.settings.masterVolume}%`;
      saveSettings(this.settings);
    });

    const pill = this.createPill(`${this.settings.masterVolume}%`);
    this.volumeValueEl = pill;

    const rightBtn = this.createArrowButton('›', () => {
      this.settings.masterVolume = Math.min(100, this.settings.masterVolume + 5);
      this.volumeValueEl!.textContent = `${this.settings.masterVolume}%`;
      saveSettings(this.settings);
    });

    control.appendChild(leftBtn);
    control.appendChild(pill);
    control.appendChild(rightBtn);
    row.appendChild(control);
    return row;
  }

  private createSfxRow(): HTMLElement {
    const row = this.createRow('SFX:');

    const pill = this.createPill(this.settings.sfxEnabled ? 'ON' : 'OFF');
    pill.classList.add('cursor-pointer', 'select-none', 'hover:bg-slate-300', 'transition-colors', 'duration-150');
    this.sfxValueEl = pill;

    pill.addEventListener('click', () => {
      this.settings.sfxEnabled = !this.settings.sfxEnabled;
      this.sfxValueEl!.textContent = this.settings.sfxEnabled ? 'ON' : 'OFF';
      saveSettings(this.settings);
    });

    row.appendChild(pill);
    return row;
  }

  private createTextSpeedRow(): HTMLElement {
    const row = this.createRow('Text speed:');

    const pill = this.createPill(this.settings.textSpeed);
    pill.classList.add('cursor-pointer', 'select-none', 'hover:bg-slate-300', 'transition-colors', 'duration-150');
    this.textSpeedValueEl = pill;

    pill.addEventListener('click', () => {
      const currentIndex = TEXT_SPEEDS.indexOf(this.settings.textSpeed);
      this.settings.textSpeed = TEXT_SPEEDS[(currentIndex + 1) % TEXT_SPEEDS.length];
      this.textSpeedValueEl!.textContent = this.settings.textSpeed;
      saveSettings(this.settings);
    });

    row.appendChild(pill);
    return row;
  }


  private createRow(labelText: string): HTMLElement {
    const row = document.createElement('div');
    row.className = 'flex items-center justify-between gap-8';

    const label = document.createElement('span');
    label.className = 'font-hexahaven-ui text-lg text-slate-700 whitespace-nowrap';
    label.textContent = labelText;

    row.appendChild(label);
    return row;
  }

  private createPill(text: string): HTMLElement {
    const pill = document.createElement('div');
    pill.className =
      'font-hexahaven-ui text-sm font-medium text-slate-700 bg-slate-200 rounded-full px-5 py-1.5 min-w-[80px] text-center';
    pill.textContent = text;
    return pill;
  }

  private createArrowButton(symbol: string, onClick: () => void): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.className =
      'font-hexahaven-ui w-8 h-8 flex items-center justify-center rounded-full bg-slate-200 text-slate-600 text-xl font-bold hover:bg-slate-300 active:bg-slate-400 transition-all duration-150 cursor-pointer leading-none';
    btn.textContent = symbol;
    btn.addEventListener('click', onClick);
    return btn;
  }

  destroy(): void {
    if (this.container) {
      this.container.remove();
      this.container = null;
    }
  }
}
