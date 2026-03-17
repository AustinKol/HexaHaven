let menuMusic: HTMLAudioElement | null = null;
let listenersBound = false;
let shouldBePlaying = false;

function getMenuMusic(): HTMLAudioElement {
  if (!menuMusic) {
    menuMusic = new Audio('/audio/menu-music.mp3');
    menuMusic.loop = true;
    menuMusic.volume = 0.5;
  }
  return menuMusic;
}

function tryPlay(): void {
  if (!shouldBePlaying) {
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
  shouldBePlaying = true;
  bindInteractionRetry();
  tryPlay();
}

export function stopMenuMusic(): void {
  shouldBePlaying = false;
  if (!menuMusic) {
    return;
  }
  menuMusic.pause();
  menuMusic.currentTime = 0;
}
