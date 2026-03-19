import { SETTINGS_CHANGED_EVENT } from '../settings/gameSettings';
import { BASE_MENU_MUSIC_VOLUME, scaledMusicVolume } from './musicVolume';

let menuMusic: HTMLAudioElement | null = null;
let listenersBound = false;
let shouldBePlayingForScreen = false;
let isEnabledByUser = true;
let settingsListenerBound = false;

function syncMenuMusicGain(): void {
  if (!menuMusic) {
    return;
  }
  menuMusic.volume = scaledMusicVolume(BASE_MENU_MUSIC_VOLUME);
}

function getMenuMusic(): HTMLAudioElement {
  if (!menuMusic) {
    menuMusic = new Audio('/audio/menu-music.mp3');
    menuMusic.loop = true;
    syncMenuMusicGain();
    if (!settingsListenerBound) {
      settingsListenerBound = true;
      window.addEventListener(SETTINGS_CHANGED_EVENT, syncMenuMusicGain);
    }
  }
  return menuMusic;
}

function tryPlay(): void {
  if (!shouldBePlayingForScreen || !isEnabledByUser) {
    return;
  }
  const audio = getMenuMusic();
  void audio.play().catch(() => {
    // Autoplay can be blocked until user interaction.
  });
}

function bindInteractionRetry(): void {
  if (listenersBound) {
    return;
  }
  listenersBound = true;
  const retry = () => {
    tryPlay();
  };
  window.addEventListener('pointerdown', retry);
  window.addEventListener('keydown', retry);
}

export function startMenuMusic(): void {
  shouldBePlayingForScreen = true;
  bindInteractionRetry();
  tryPlay();
}

export function stopMenuMusic(): void {
  shouldBePlayingForScreen = false;
  if (!menuMusic) {
    return;
  }
  menuMusic.pause();
  menuMusic.currentTime = 0;
}

export function isMenuMusicEnabled(): boolean {
  return isEnabledByUser;
}

export function setMenuMusicEnabled(enabled: boolean): void {
  isEnabledByUser = enabled;
  if (isEnabledByUser) {
    bindInteractionRetry();
    tryPlay();
    return;
  }
  if (!menuMusic) {
    return;
  }
  menuMusic.pause();
  menuMusic.currentTime = 0;
}
