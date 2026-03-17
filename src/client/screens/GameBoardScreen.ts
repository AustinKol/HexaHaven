import { ScreenId } from '../../shared/constants/screenIds';
import { ApiRoutes } from '../../shared/constants/apiRoutes';
import type { ApiResponse, RoomSnapshot } from '../../shared/types/api';
import type { DiceRoll, GamePhase } from '../../shared/types/domain';
import { apiFetch } from '../networking/apiClient';
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
  private playersPollTimer: number | null = null;
  private isMusicMuted = false;
  private turnHudBindings: GameBoardTurnHudBindings | null = null;
  private fallbackPlayerOrder: string[] = [];
  private fallbackCurrentPlayerIndex = 0;
  private fallbackPhase: 'ROLL' | 'ACTION' = 'ROLL';
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
      void this.pollPlayers(roomId);
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
    this.musicToggleButton.className = 'font-hexahaven-ui';
    this.musicToggleButton.style.position = 'absolute';
    this.musicToggleButton.style.top = '16px';
    this.musicToggleButton.style.left = '16px';
    this.musicToggleButton.style.zIndex = '3';
    this.musicToggleButton.style.padding = '8px 10px';
    this.musicToggleButton.style.fontSize = '14px';
    this.musicToggleButton.style.fontWeight = '600';
    this.musicToggleButton.style.color = '#ffffff';
    this.musicToggleButton.style.background = 'rgba(15, 23, 42, 0.85)';
    this.musicToggleButton.style.border = '1px solid rgba(255, 255, 255, 0.35)';
    this.musicToggleButton.style.borderRadius = '8px';
    this.musicToggleButton.style.cursor = 'pointer';
    this.musicToggleButton.addEventListener('click', () => this.toggleMusic());
    this.updateMusicButtonText();
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

  private async pollPlayers(roomId: string): Promise<void> {
    try {
      const response = await apiFetch<ApiResponse<{ room: RoomSnapshot }>>(`${ApiRoutes.RoomStatus}/${roomId}`);
      if (!response.success || !response.data) {
        throw new Error(response.error ?? 'Unable to load players.');
      }
      this.renderPlayerCards(response.data.room);
    } catch {
      this.renderPlayerCards(null);
    }

    if (this.playerPanel) {
      this.playersPollTimer = window.setTimeout(() => {
        void this.pollPlayers(roomId);
      }, 1500);
    }
  }

  private renderPlayerCards(room: RoomSnapshot | null): void {
    if (!this.playerPanel) {
      return;
    }
    this.playerPanel.innerHTML = '';
    this.syncFallbackPlayers(room);
    if (!room || room.players.length === 0) {
      const placeholder = document.createElement('div');
      placeholder.className =
        'font-hexahaven-ui text-xs text-slate-200 rounded-lg border border-slate-600 bg-slate-900/85 px-3 py-2';
      placeholder.textContent = 'Players unavailable';
      this.playerPanel.appendChild(placeholder);
      this.updateTurnHud();
      return;
    }

    room.players.forEach((player) => {
      const card = document.createElement('div');
      card.className = 'rounded-xl border border-slate-500 bg-slate-900/85 px-3 py-3 text-white shadow-md';

      const avatar = document.createElement('img');
      avatar.src = player.avatar;
      avatar.alt = `${player.name} avatar`;
      avatar.className = 'mx-auto mb-2 h-16 w-16 bg-transparent object-cover';

      const name = document.createElement('div');
      name.className = 'font-hexahaven-ui text-sm text-center truncate';
      name.textContent = player.name;

      const points = document.createElement('div');
      points.className = 'font-hexahaven-ui mt-2 text-xs text-slate-200 text-center';
      points.textContent = `Points: ${player.points}`;

      const resources = document.createElement('div');
      resources.className = 'font-hexahaven-ui mt-2 text-xs leading-5';
      resources.innerHTML = [
        `<span style="color: #c28d5b;">Ember: ${player.resources?.ember ?? 0}</span>`,
        `<span style="color: #fde047;">Gold: ${player.resources?.gold ?? 0}</span>`,
        `<span style="color: #a3a3a3;">Stone: ${player.resources?.stone ?? 0}</span>`,
        `<span style="color: #74b95e;">Bloom: ${player.resources?.bloom ?? 0}</span>`,
        `<span style="color: #ffffff;">Crystal: ${player.resources?.crystal ?? 0}</span>`,
      ].join('<br>');

      card.appendChild(avatar);
      card.appendChild(name);
      card.appendChild(points);
      card.appendChild(resources);
      this.playerPanel?.appendChild(card);
    });

    this.updateTurnHud();
  }

  private syncFallbackPlayers(room: RoomSnapshot | null): void {
    if (!room || room.players.length === 0) {
      this.fallbackPlayerOrder = [];
      this.fallbackCurrentPlayerIndex = 0;
      return;
    }

    const nextOrder = room.players.map((player) => player.name || player.id);
    const previousCurrent = this.fallbackPlayerOrder[this.fallbackCurrentPlayerIndex] ?? null;
    this.fallbackPlayerOrder = nextOrder;

    if (!previousCurrent) {
      this.fallbackCurrentPlayerIndex = 0;
      return;
    }

    const updatedIndex = nextOrder.indexOf(previousCurrent);
    this.fallbackCurrentPlayerIndex = updatedIndex >= 0 ? updatedIndex : 0;
  }

  private updateTurnHud(): void {
    const liveValues = this.turnHudBindings?.getValues?.() ?? null;
    const currentPlayer = liveValues?.currentPlayer ?? this.fallbackPlayerOrder[this.fallbackCurrentPlayerIndex] ?? 'Waiting for player state';
    const currentPhase: GamePhase | 'ROLL' | 'ACTION' = liveValues?.currentPhase ?? this.fallbackPhase;
    const lastDiceRollText = this.formatLastDiceRollDisplay(liveValues?.lastDiceRoll);

    const canRoll = typeof liveValues?.canRollDice === 'boolean'
      ? liveValues.canRollDice
      : currentPhase === 'ROLL';
    const canEnd = typeof liveValues?.canEndTurn === 'boolean'
      ? liveValues.canEndTurn
      : currentPhase === 'ACTION';

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

    this.handleDemoRollDice();
  }

  private handleEndTurnClick(): void {
    if (this.turnHudBindings?.onEndTurn) {
      this.turnHudBindings.onEndTurn();
      this.updateTurnHud();
      return;
    }

    this.handleDemoEndTurn();
  }

  private handleDemoRollDice(): void {
    if (this.fallbackPhase !== 'ROLL') {
      return;
    }

    const d1 = Math.floor(Math.random() * 6) + 1;
    const d2 = Math.floor(Math.random() * 6) + 1;
    this.fallbackLastDiceRoll = `${d1} + ${d2} = ${d1 + d2}`;
    this.fallbackPhase = 'ACTION';
    this.updateTurnHud();
  }

  private handleDemoEndTurn(): void {
    if (this.fallbackPhase !== 'ACTION') {
      return;
    }

    if (this.fallbackPlayerOrder.length > 0) {
      this.fallbackCurrentPlayerIndex = (this.fallbackCurrentPlayerIndex + 1) % this.fallbackPlayerOrder.length;
    }
    this.fallbackLastDiceRoll = 'Not rolled yet';
    this.fallbackPhase = 'ROLL';
    this.updateTurnHud();
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
    this.updateMusicButtonText();
  }

  private updateMusicButtonText(): void {
    if (!this.musicToggleButton) return;
    this.musicToggleButton.textContent = this.isMusicMuted ? 'Music: Off' : 'Music: On';
  }

  destroy(): void {
    this.stopBackgroundMusic();
    if (this.playersPollTimer !== null) {
      window.clearTimeout(this.playersPollTimer);
      this.playersPollTimer = null;
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
  }
}
