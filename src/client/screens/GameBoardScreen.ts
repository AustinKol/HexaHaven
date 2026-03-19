import { ScreenId } from '../../shared/constants/screenIds';
import type { DiceRoll, GamePhase, GameState } from '../../shared/types/domain';
import { connectSocket, endTurn, rollDice } from '../networking/socketClient';
import { subscribeClientState } from '../state/clientState';
import { clearLobbySession, getLobbySession } from '../state/lobbyState';
import { TestMapGenScreen } from './TestMapGenScreen';

export interface GameBoardTurnHudLiveValues {
  currentPlayer?: string | null;
  currentPhase?: GamePhase | null;
  lastDiceRoll?: DiceRoll | string | null;
  canRollDice?: boolean;
  canEndTurn?: boolean;
}

export interface GameBoardTurnHudBindings {
  getValues?: () => GameBoardTurnHudLiveValues | null;
  onRollDice?: () => void;
  onEndTurn?: () => void;
}

export class GameBoardScreen {
  readonly id = ScreenId.GameBoard;
  private mapScreen: TestMapGenScreen | null = null;
  private readonly backgroundMusic = new Audio('/audio/game-board-theme.mp3');
  private exitButton: HTMLButtonElement | null = null;
  private musicToggleButton: HTMLButtonElement | null = null;
  private playerPanel: HTMLDivElement | null = null;
  private turnHudPanel: HTMLDivElement | null = null;
  private currentPlayerValue: HTMLDivElement | null = null;
  private currentPhaseValue: HTMLDivElement | null = null;
  private lastDiceRollValue: HTMLDivElement | null = null;
  private rollDiceButton: HTMLButtonElement | null = null;
  private endTurnButton: HTMLButtonElement | null = null;
  private buttonContainer: HTMLElement | null = null;
  private isMusicMuted = false;
  private turnHudBindings: GameBoardTurnHudBindings | null = null;
  private unsubscribe: (() => void) | null = null;
  private liveGameState: GameState | null = null;
  private livePlayerId: string | null = null;
  private fallbackLastDiceRoll = 'Not rolled yet';

  constructor() {
    this.backgroundMusic.loop = true;
    this.backgroundMusic.volume = 0.35;
  }

  setTurnHudBindings(bindings: GameBoardTurnHudBindings | null): void {
    this.turnHudBindings = bindings;
    this.updateTurnHud();
  }

  render(parentElement: HTMLElement, onComplete?: () => void, navigate?: (screenId: ScreenId) => void): void {
    this.playBackgroundMusic();
    const session = getLobbySession();
    const roomId = session?.roomId ?? null;
    this.livePlayerId = session?.playerId ?? null;
    this.mapScreen = new TestMapGenScreen({
      showExitButton: false,
      enableBackgroundMusic: false,
      showRegenerateButton: false,
      allowPointerRegenerate: false,
      mapSeed: roomId ?? undefined,
    });
    this.mapScreen.render(
      parentElement,
      onComplete,
      navigate ? (screenId: string) => navigate(screenId as ScreenId) : undefined,
    );

    this.buttonContainer = parentElement.firstElementChild as HTMLElement | null;
    if (!this.buttonContainer) {
      return;
    }
    this.mountPlayerPanel(this.buttonContainer);
    this.mountTurnHud(this.buttonContainer);
    if (roomId) {
      connectSocket({ gameId: roomId, playerId: session?.playerId });
      this.unsubscribe = subscribeClientState((state) => {
        this.liveGameState = state.gameState;
        this.livePlayerId = state.playerId ?? this.livePlayerId;
        this.updateTurnHud();
        this.renderPlayerCardsFromGameState();
      });
    }

    if (!navigate) {
      return;
    }
    const navigateTo = navigate;

    this.exitButton = document.createElement('button');
    this.exitButton.textContent = 'Exit to Menu';
    this.exitButton.className = 'font-hexahaven-ui';
    this.exitButton.style.position = 'absolute';
    this.exitButton.style.top = '16px';
    this.exitButton.style.right = '16px';
    this.exitButton.style.zIndex = '3';
    this.exitButton.style.padding = '8px 10px';
    this.exitButton.style.fontSize = '14px';
    this.exitButton.style.fontWeight = '600';
    this.exitButton.style.color = '#ffffff';
    this.exitButton.style.background = 'rgba(15, 23, 42, 0.85)';
    this.exitButton.style.border = '1px solid rgba(255, 255, 255, 0.35)';
    this.exitButton.style.borderRadius = '8px';
    this.exitButton.style.cursor = 'pointer';
    this.exitButton.addEventListener('click', () => {
      clearLobbySession();
      navigateTo(ScreenId.MainMenu);
    });
    this.buttonContainer.appendChild(this.exitButton);

    this.musicToggleButton = document.createElement('button');
    this.musicToggleButton.type = 'button';
    this.musicToggleButton.style.position = 'absolute';
    this.musicToggleButton.style.bottom = '16px';
    this.musicToggleButton.style.right = '16px';
    this.musicToggleButton.style.zIndex = '3';
    this.musicToggleButton.style.display = 'flex';
    this.musicToggleButton.style.alignItems = 'center';
    this.musicToggleButton.style.justifyContent = 'center';
    this.musicToggleButton.style.width = '44px';
    this.musicToggleButton.style.height = '44px';
    this.musicToggleButton.style.color = '#ffffff';
    this.musicToggleButton.style.background = 'rgba(15, 23, 42, 0.85)';
    this.musicToggleButton.style.border = '1px solid rgba(255, 255, 255, 0.35)';
    this.musicToggleButton.style.borderRadius = '9999px';
    this.musicToggleButton.style.cursor = 'pointer';
    this.musicToggleButton.addEventListener('click', () => this.toggleMusic());
    this.updateMusicButtonIcon();
    this.buttonContainer.appendChild(this.musicToggleButton);
  }

  private mountPlayerPanel(parent: HTMLElement): void {
    if (this.playerPanel) {
      this.playerPanel.remove();
    }
    const panel = document.createElement('div');
    panel.className = 'absolute top-16 left-4 flex flex-col gap-3';
    panel.style.zIndex = '3';
    panel.style.width = '180px';
    this.playerPanel = panel;
    parent.appendChild(panel);
  }

  private mountTurnHud(parent: HTMLElement): void {
    if (this.turnHudPanel) {
      this.turnHudPanel.remove();
    }

    const panel = document.createElement('div');
    panel.className = 'absolute top-16 right-4 rounded-xl border border-slate-600 bg-slate-900/88 px-4 py-3 text-white shadow-md';
    panel.style.zIndex = '3';
    panel.style.width = '230px';

    const title = document.createElement('div');
    title.className = 'font-hexahaven-ui text-sm font-semibold mb-2';
    title.textContent = 'Turn HUD (DEMO)';

    const currentPlayerLabel = document.createElement('div');
    currentPlayerLabel.className = 'font-hexahaven-ui text-xs text-slate-300';
    currentPlayerLabel.textContent = 'Current Player';

    const currentPlayerValue = document.createElement('div');
    currentPlayerValue.className = 'font-hexahaven-ui text-sm font-semibold mb-2';

    const currentPhaseLabel = document.createElement('div');
    currentPhaseLabel.className = 'font-hexahaven-ui text-xs text-slate-300';
    currentPhaseLabel.textContent = 'Current Phase';

    const currentPhaseValue = document.createElement('div');
    currentPhaseValue.className = 'font-hexahaven-ui text-sm font-semibold mb-2';

    const lastDiceRollLabel = document.createElement('div');
    lastDiceRollLabel.className = 'font-hexahaven-ui text-xs text-slate-300';
    lastDiceRollLabel.textContent = 'Last Dice Roll';

    const lastDiceRollValue = document.createElement('div');
    lastDiceRollValue.className = 'font-hexahaven-ui text-sm font-semibold mb-3';

    const actions = document.createElement('div');
    actions.className = 'grid grid-cols-2 gap-2';

    const rollDiceButton = document.createElement('button');
    rollDiceButton.className = 'font-hexahaven-ui rounded-md border border-cyan-400/60 bg-cyan-900/60 px-2 py-2 text-xs font-semibold';
    rollDiceButton.textContent = 'Roll Dice';
    rollDiceButton.addEventListener('click', () => this.handleRollDiceClick());

    const endTurnButton = document.createElement('button');
    endTurnButton.className = 'font-hexahaven-ui rounded-md border border-emerald-400/60 bg-emerald-900/60 px-2 py-2 text-xs font-semibold';
    endTurnButton.textContent = 'End Turn';
    endTurnButton.addEventListener('click', () => this.handleEndTurnClick());

    actions.appendChild(rollDiceButton);
    actions.appendChild(endTurnButton);

    panel.appendChild(title);
    panel.appendChild(currentPlayerLabel);
    panel.appendChild(currentPlayerValue);
    panel.appendChild(currentPhaseLabel);
    panel.appendChild(currentPhaseValue);
    panel.appendChild(lastDiceRollLabel);
    panel.appendChild(lastDiceRollValue);
    panel.appendChild(actions);

    this.turnHudPanel = panel;
    this.currentPlayerValue = currentPlayerValue;
    this.currentPhaseValue = currentPhaseValue;
    this.lastDiceRollValue = lastDiceRollValue;
    this.rollDiceButton = rollDiceButton;
    this.endTurnButton = endTurnButton;

    parent.appendChild(panel);
    this.updateTurnHud();
  }

  private renderPlayerCardsFromGameState(): void {
    const gameState = this.liveGameState;
    if (!this.playerPanel || !gameState) {
      return;
    }
    this.playerPanel.innerHTML = '';
    gameState.playerOrder.forEach((playerId) => {
      const player = gameState.playersById[playerId];
      if (!player) {
        return;
      }

      const card = document.createElement('div');
      card.className = 'rounded-xl border border-slate-500 bg-slate-900/85 px-3 py-3 text-white shadow-md';

      const avatar = document.createElement('img');
      avatar.src = player.avatarUrl ?? '/avatar/avatar_1.png';
      avatar.alt = `${player.displayName} avatar`;
      avatar.className = 'mx-auto mb-2 h-16 w-16 bg-transparent object-cover';

      const name = document.createElement('div');
      name.className = 'font-hexahaven-ui text-sm text-center truncate';
      name.textContent = player.displayName;

      const points = document.createElement('div');
      points.className = 'font-hexahaven-ui mt-2 text-xs text-slate-200 text-center';
      points.textContent = `Points: ${player.stats.publicVP ?? 0}`;

      const resources = document.createElement('div');
      resources.className = 'font-hexahaven-ui mt-2 text-xs leading-5 text-center';
      resources.innerHTML = [
        `<span style="color: #c28d5b;">Ember: ${player.resources.EMBER ?? 0}</span>`,
        `<span style="color: #a3a3a3;">Stone: ${player.resources.STONE ?? 0}</span>`,
        `<span style="color: #74b95e;">Bloom: ${player.resources.BLOOM ?? 0}</span>`,
        `<span style="color: #fde047;">Gold: ${player.resources.GOLD ?? 0}</span>`,
      ].join('<br>');

      card.appendChild(avatar);
      card.appendChild(name);
      card.appendChild(points);
      card.appendChild(resources);
      this.playerPanel?.appendChild(card);
    });
  }

  private updateTurnHud(): void {
    const gameState = this.liveGameState;
    const liveValues = this.turnHudBindings?.getValues?.() ?? null;

    const activePlayerId = gameState?.turn.currentPlayerId ?? null;
    const activePlayerName = activePlayerId && gameState?.playersById[activePlayerId]
      ? gameState.playersById[activePlayerId].displayName
      : null;

    const currentPlayer = liveValues?.currentPlayer ?? activePlayerName ?? activePlayerId ?? 'Waiting';
    const currentPhase: GamePhase | null = liveValues?.currentPhase ?? gameState?.turn.phase ?? null;
    const lastDiceRollText = this.formatLastDiceRollDisplay(liveValues?.lastDiceRoll ?? gameState?.turn.lastDiceRoll);

    const isActivePlayer = Boolean(activePlayerId && this.livePlayerId && activePlayerId === this.livePlayerId);
    const canRoll = typeof liveValues?.canRollDice === 'boolean'
      ? liveValues.canRollDice
      : Boolean(isActivePlayer && currentPhase === 'ROLL' && (gameState?.turn.lastDiceRoll ?? null) === null);
    const canEnd = typeof liveValues?.canEndTurn === 'boolean'
      ? liveValues.canEndTurn
      : Boolean(isActivePlayer && currentPhase === 'ACTION' && (gameState?.turn.lastDiceRoll ?? null) !== null);

    if (this.currentPlayerValue) {
      this.currentPlayerValue.textContent = currentPlayer;
    }

    if (this.currentPhaseValue) {
      this.currentPhaseValue.textContent = currentPhase ?? 'Waiting';
      this.currentPhaseValue.style.color = currentPhase === 'ROLL' ? '#67e8f9' : '#86efac';
    }

    if (this.lastDiceRollValue) {
      this.lastDiceRollValue.textContent = lastDiceRollText;
    }

    if (this.rollDiceButton) {
      this.rollDiceButton.disabled = !canRoll;
      this.rollDiceButton.style.opacity = this.rollDiceButton.disabled ? '0.55' : '1';
      this.rollDiceButton.style.cursor = this.rollDiceButton.disabled ? 'not-allowed' : 'pointer';
    }

    if (this.endTurnButton) {
      this.endTurnButton.disabled = !canEnd;
      this.endTurnButton.style.opacity = this.endTurnButton.disabled ? '0.55' : '1';
      this.endTurnButton.style.cursor = this.endTurnButton.disabled ? 'not-allowed' : 'pointer';
    }
  }

  private formatLastDiceRollDisplay(lastDiceRoll: DiceRoll | string | null | undefined): string {
    if (typeof lastDiceRoll === 'string') {
      return lastDiceRoll;
    }

    if (lastDiceRoll) {
      return `${lastDiceRoll.d1Val} + ${lastDiceRoll.d2Val} = ${lastDiceRoll.sum}`;
    }

    return this.fallbackLastDiceRoll;
  }

  private handleRollDiceClick(): void {
    if (this.turnHudBindings?.onRollDice) {
      this.turnHudBindings.onRollDice();
      this.updateTurnHud();
      return;
    }
    const roomId = getLobbySession()?.roomId ?? null;
    if (roomId) {
      void rollDice(roomId);
    }
  }

  private handleEndTurnClick(): void {
    if (this.turnHudBindings?.onEndTurn) {
      this.turnHudBindings.onEndTurn();
      this.updateTurnHud();
      return;
    }
    const roomId = getLobbySession()?.roomId ?? null;
    if (roomId) {
      void endTurn(roomId);
    }
  }

  private playBackgroundMusic(): void {
    this.backgroundMusic.currentTime = 0;
    this.backgroundMusic
      .play()
      .catch(() => {
        // Browser autoplay policies may block playback before user interaction.
      });
  }

  private stopBackgroundMusic(): void {
    this.backgroundMusic.pause();
    this.backgroundMusic.currentTime = 0;
  }

  private toggleMusic(): void {
    this.isMusicMuted = !this.isMusicMuted;
    this.backgroundMusic.muted = this.isMusicMuted;
    this.updateMusicButtonIcon();
  }

  private updateMusicButtonIcon(): void {
    if (!this.musicToggleButton) return;
    const speakerOnIcon = '<svg aria-hidden="true" viewBox="0 0 24 24" style="width:20px;height:20px;fill:currentColor;"><path d="M14 3.23a1 1 0 0 0-1.65-.76L7.88 6H4a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h3.88l4.47 3.53A1 1 0 0 0 14 20.77zM19.07 4.93a1 1 0 1 0-1.41 1.41 8 8 0 0 1 0 11.32 1 1 0 1 0 1.41 1.41 10 10 0 0 0 0-14.14m-2.83 2.83a1 1 0 0 0-1.41 1.41 4 4 0 0 1 0 5.66 1 1 0 1 0 1.41 1.41 6 6 0 0 0 0-8.48"/></svg>';
    const speakerOffIcon = '<svg aria-hidden="true" viewBox="0 0 24 24" style="width:20px;height:20px;fill:currentColor;"><path d="M14 3.23a1 1 0 0 0-1.65-.76L7.88 6H4a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h3.88l4.47 3.53A1 1 0 0 0 14 20.77zM21.71 7.71a1 1 0 0 0-1.42-1.42L18 8.59l-2.29-2.3a1 1 0 0 0-1.42 1.42L16.59 10l-2.3 2.29a1 1 0 1 0 1.42 1.42L18 11.41l2.29 2.3a1 1 0 0 0 1.42-1.42L19.41 10z"/></svg>';
    const isEnabled = !this.isMusicMuted;
    this.musicToggleButton.innerHTML = isEnabled ? speakerOnIcon : speakerOffIcon;
    this.musicToggleButton.title = isEnabled ? 'Stop music' : 'Start music';
    this.musicToggleButton.setAttribute('aria-label', isEnabled ? 'Stop music' : 'Start music');
  }

  destroy(): void {
    this.stopBackgroundMusic();
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    if (this.exitButton) {
      this.exitButton.remove();
      this.exitButton = null;
    }
    if (this.musicToggleButton) {
      this.musicToggleButton.remove();
      this.musicToggleButton = null;
    }
    if (this.playerPanel) {
      this.playerPanel.remove();
      this.playerPanel = null;
    }
    if (this.turnHudPanel) {
      this.turnHudPanel.remove();
      this.turnHudPanel = null;
    }
    this.currentPlayerValue = null;
    this.currentPhaseValue = null;
    this.lastDiceRollValue = null;
    this.rollDiceButton = null;
    this.endTurnButton = null;
    this.buttonContainer = null;
    this.mapScreen?.destroy();
    this.mapScreen = null;
    this.liveGameState = null;
    this.livePlayerId = null;
  }
}
