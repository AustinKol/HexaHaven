import { isMenuMusicEnabled, setMenuMusicEnabled } from '../audio/menuMusic';

function setButtonIcon(button: HTMLButtonElement, isEnabled: boolean): void {
  const speakerOnIcon = '<svg aria-hidden="true" viewBox="0 0 24 24" class="h-5 w-5 fill-current"><path d="M14 3.23a1 1 0 0 0-1.65-.76L7.88 6H4a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h3.88l4.47 3.53A1 1 0 0 0 14 20.77zM19.07 4.93a1 1 0 1 0-1.41 1.41 8 8 0 0 1 0 11.32 1 1 0 1 0 1.41 1.41 10 10 0 0 0 0-14.14m-2.83 2.83a1 1 0 0 0-1.41 1.41 4 4 0 0 1 0 5.66 1 1 0 1 0 1.41 1.41 6 6 0 0 0 0-8.48"/></svg>';
  const speakerOffIcon = '<svg aria-hidden="true" viewBox="0 0 24 24" class="h-5 w-5 fill-current"><path d="M14 3.23a1 1 0 0 0-1.65-.76L7.88 6H4a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h3.88l4.47 3.53A1 1 0 0 0 14 20.77zM21.71 7.71a1 1 0 0 0-1.42-1.42L18 8.59l-2.29-2.3a1 1 0 0 0-1.42 1.42L16.59 10l-2.3 2.29a1 1 0 1 0 1.42 1.42L18 11.41l2.29 2.3a1 1 0 0 0 1.42-1.42L19.41 10z"/></svg>';
  button.innerHTML = isEnabled ? speakerOnIcon : speakerOffIcon;
  button.setAttribute('aria-label', isEnabled ? 'Stop music' : 'Start music');
  button.title = isEnabled ? 'Stop music' : 'Start music';
}

export function createMusicToggleButton(): HTMLButtonElement {
  const musicToggleBtn = document.createElement('button');
  musicToggleBtn.type = 'button';
  musicToggleBtn.className =
    'absolute bottom-6 right-6 z-20 flex h-11 w-11 items-center justify-center rounded-full bg-slate-700/90 text-white shadow-lg transition-all duration-200 hover:bg-slate-600 active:scale-95';
  setButtonIcon(musicToggleBtn, isMenuMusicEnabled());

  musicToggleBtn.addEventListener('click', () => {
    const nextEnabledState = !isMenuMusicEnabled();
    setMenuMusicEnabled(nextEnabledState);
    setButtonIcon(musicToggleBtn, nextEnabledState);
  });

  return musicToggleBtn;
}
