import { ScreenId } from '../../shared/constants/screenIds';
import { defaultStartingResourceBundle } from '../../shared/constants/startingResources';
import { createGame } from '../networking/socketClient';
import { setLobbySession } from '../state/lobbyState';
import { createMusicToggleButton } from '../ui/musicToggleButton';

export class HostGameScreen {
  readonly id = ScreenId.HostGame;
  private container: HTMLElement | null = null;
  private navigate: ((screenId: ScreenId) => void) | null = null;
  private isSubmitting = false;

  render(parentElement: HTMLElement, _onComplete?: () => void, navigate?: (screenId: ScreenId) => void): void {
    this.navigate = navigate ?? null;
    parentElement.innerHTML = '';
    this.container = document.createElement('div');
    this.container.className = 'relative flex flex-col items-center justify-center w-full h-full overflow-hidden bg-slate-950';

    const card = document.createElement('div');
    card.className = 'w-full max-w-md rounded-xl bg-slate-900/90 border border-slate-700 p-6 text-white shadow-2xl';

    const title = document.createElement('h2');
    title.className = 'font-hexahaven-title text-3xl mb-2';
    title.textContent = 'Host Game';

    const subtitle = document.createElement('p');
    subtitle.className = 'font-hexahaven-ui text-slate-300 mb-5';
    subtitle.textContent = 'Enter your name to create a game key.';

    const nameInput = document.createElement('input');
    nameInput.className = 'w-full px-4 py-3 rounded-lg bg-slate-800 border border-slate-600 text-white mb-3';
    nameInput.placeholder = 'Your name';
    nameInput.maxLength = 24;

    const sizeLabel = document.createElement('p');
    sizeLabel.className = 'font-hexahaven-ui text-slate-300 mb-2';
    sizeLabel.textContent = 'Select game size';

    const sizeSelect = document.createElement('select');
    sizeSelect.className = 'w-full px-4 py-3 rounded-lg bg-slate-800 border border-slate-600 text-white mb-3';

    [2, 3, 4].forEach((size) => {
      const option = document.createElement('option');
      option.value = String(size);
      option.textContent = `${size} Players`;
      sizeSelect.appendChild(option);
    });

    const errorText = document.createElement('p');
    errorText.className = 'font-hexahaven-ui text-sm text-red-300 min-h-5 mb-3';

    const startButton = document.createElement('button');
    startButton.className = 'w-full font-hexahaven-ui px-4 py-3 bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-60';
    startButton.textContent = 'Create Game Key';

    const backButton = document.createElement('button');
    backButton.className = 'w-full mt-2 font-hexahaven-ui px-4 py-3 bg-slate-700 rounded-lg hover:bg-slate-600 transition-colors';
    backButton.textContent = 'Back';

    const submit = async () => {
      if (this.isSubmitting) {
        return;
      }
      const name = nameInput.value.trim();
      if (!name) {
        errorText.textContent = 'Please enter your name.';
        return;
      }
      this.isSubmitting = true;
      startButton.disabled = true;
      startButton.textContent = 'Creating...';
      errorText.textContent = '';

      try {
        const ack = await createGame({
          displayName: name,
          config: {
            playerCount: Number(sizeSelect.value),
            goalCount: 0,
            winRule: 'ALL_GOALS_COMPLETE',
            mapSeed: 0,
            mapSize: 'medium',
            timerEnabled: false,
            turnTimeSec: null,
            allowReroll: false,
            startingResources: defaultStartingResourceBundle(),
          },
        });
        setLobbySession({
          roomId: ack.gameState.roomCode,
          playerId: ack.playerId,
          playerName: name,
          role: 'host',
        });
        this.navigate?.(ScreenId.WaitingRoom);
      } catch (error) {
        errorText.textContent = error instanceof Error ? error.message : 'Unable to create room.';
      } finally {
        this.isSubmitting = false;
        startButton.disabled = false;
        startButton.textContent = 'Create Game Key';
      }
    };

    startButton.addEventListener('click', () => {
      void submit();
    });
    nameInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        void submit();
      }
    });
    backButton.addEventListener('click', () => {
      this.navigate?.(ScreenId.MainMenu);
    });

    card.appendChild(title);
    card.appendChild(subtitle);
    card.appendChild(nameInput);
    card.appendChild(sizeLabel);
    card.appendChild(sizeSelect);
    card.appendChild(errorText);
    card.appendChild(startButton);
    card.appendChild(backButton);
    this.container.appendChild(card);
    this.container.appendChild(createMusicToggleButton());
    parentElement.appendChild(this.container);
    nameInput.focus();
  }

  destroy(): void {
    if (this.container) {
      this.container.remove();
      this.container = null;
    }
  }
}
