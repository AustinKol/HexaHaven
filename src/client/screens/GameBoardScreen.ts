import { BASE_GAME_BOARD_MUSIC_VOLUME, scaledMusicVolume } from '../audio/musicVolume';
import { SETTINGS_CHANGED_EVENT } from '../settings/gameSettings';
import { ScreenId } from '../../shared/constants/screenIds';
import type { DiceRoll, GamePhase, GameState, ResourceBundle } from '../../shared/types/domain';
import { connectSocket, endTurn, rollDice } from '../networking/socketClient';
import { clientState, setClientState, subscribeClientState } from '../state/clientState';
import { clearLobbySession, getLobbySession } from '../state/lobbyState';
import { TestMapGenScreen } from './TestMapGenScreen';

type ResourceKey = keyof ResourceBundle;

/** Bottom bar + UI reserved for Phaser (taller bar needs more clearance). */
const GAME_BOARD_BOTTOM_BAR_PX = 84;
/** ~0.5cm at 96dpi — extra inset so the map sits slightly higher. */
const GAME_BOARD_MAP_LIFT_PX = 20;

/** Matches map biome feel (see TestMapGenScreen BIOME_PALETTE); tuned for UI legibility. */
const RESOURCE_BOX_CONFIG: {
  key: ResourceKey;
  shortLabel: string;
  color: string;
  iconSrc?: string;
  boxBg: string;
  boxBorder: string;
  boxHoverBg: string;
  countColor: string;
}[] = [
  {
    key: 'CRYSTAL',
    shortLabel: 'Cr',
    color: '#93c5fd',
    iconSrc: '/images/resources/crystal.png',
    boxBg: '#e8f4fa',
    boxBorder: '#9ec5d8',
    boxHoverBg: '#dceef6',
    countColor: '#1a3d4d',
  },
  {
    key: 'STONE',
    shortLabel: 'St',
    color: '#a3a3a3',
    iconSrc: '/images/resources/stone.png',
    boxBg: '#c5c9d2',
    boxBorder: '#8b909c',
    boxHoverBg: '#b6bbc6',
    countColor: '#252a32',
  },
  {
    key: 'BLOOM',
    shortLabel: 'Bl',
    color: '#74b95e',
    iconSrc: '/images/resources/bloom.png',
    boxBg: '#d2ebc0',
    boxBorder: '#6fb253',
    boxHoverBg: '#c4e3ae',
    countColor: '#1e3d18',
  },
  {
    key: 'EMBER',
    shortLabel: 'Em',
    color: '#c28d5b',
    iconSrc: '/images/resources/ember.png',
    boxBg: '#3d2818',
    boxBorder: '#6b4a36',
    boxHoverBg: '#4a3224',
    countColor: '#f0e6dc',
  },
  {
    key: 'GOLD',
    shortLabel: 'Go',
    color: '#fde047',
    iconSrc: '/images/resources/gold.png',
    boxBg: '#f0d050',
    boxBorder: '#c49a24',
    boxHoverBg: '#f5dc68',
    countColor: '#3d2e0a',
  },
];

const RESOURCE_KEYS: ResourceKey[] = ['CRYSTAL', 'STONE', 'BLOOM', 'EMBER', 'GOLD'];

function emptyResourceBundle(): ResourceBundle {
  return { CRYSTAL: 0, STONE: 0, BLOOM: 0, EMBER: 0, GOLD: 0 };
}

function resourceBundlesEqual(a: ResourceBundle, b: ResourceBundle): boolean {
  return RESOURCE_KEYS.every((k) => (a[k] ?? 0) === (b[k] ?? 0));
}

/** True when selection equals `cost` (zeros elsewhere) and the player can pay that cost. */
function isBuildOptionReady(
  selection: ResourceBundle,
  cost: ResourceBundle,
  inventory: ResourceBundle,
): boolean {
  if (!resourceBundlesEqual(selection, cost)) {
    return false;
  }
  return RESOURCE_KEYS.every((k) => (inventory[k] ?? 0) >= (cost[k] ?? 0));
}

function cloneGameState(gs: GameState): GameState {
  return JSON.parse(JSON.stringify(gs)) as GameState;
}

type BuildKind = 'ROAD' | 'SETTLEMENT' | 'CITY' | 'DEV_CARD';

/**
 * Costs (selection must match): Road 1E+1St · Settlement 1E+1Bl+1St · City 3St+2Bl · Dev 2Cr+2Go
 */
const BUILD_OPTIONS: { kind: BuildKind; label: string; cost: ResourceBundle; iconSrc?: string }[] = [
  {
    kind: 'ROAD',
    label: 'Road',
    cost: { CRYSTAL: 0, STONE: 1, BLOOM: 0, EMBER: 1, GOLD: 0 },
    iconSrc: '/images/buildings/road.png',
  },
  {
    kind: 'SETTLEMENT',
    label: 'Settlement',
    cost: { CRYSTAL: 0, STONE: 1, BLOOM: 1, EMBER: 1, GOLD: 0 },
    iconSrc: '/images/buildings/settlement.png',
  },
  {
    kind: 'CITY',
    label: 'City',
    cost: { CRYSTAL: 0, STONE: 3, BLOOM: 2, EMBER: 0, GOLD: 0 },
    iconSrc: '/images/buildings/city.png',
  },
  {
    kind: 'DEV_CARD',
    label: 'Dev Card',
    cost: { CRYSTAL: 2, STONE: 0, BLOOM: 0, EMBER: 0, GOLD: 2 },
    iconSrc: '/images/buildings/dev-card.png',
  },
];

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
  private resourceBar: HTMLDivElement | null = null;
  /** Player + resource buttons; cleared on each state refresh. */
  private resourceBarLeft: HTMLDivElement | null = null;
  /** Build actions (right side); rebuilt each refresh. */
  private resourceBarRight: HTMLDivElement | null = null;
  /** Multiset of resources picked for a build (tap a resource to cycle 0…owned). */
  private resourceSelection: ResourceBundle = emptyResourceBundle();
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
  private readonly onSettingsChanged = (): void => {
    this.backgroundMusic.volume = scaledMusicVolume(BASE_GAME_BOARD_MUSIC_VOLUME);
  };

  constructor() {
    this.backgroundMusic.loop = true;
    this.onSettingsChanged();
  }

  setTurnHudBindings(bindings: GameBoardTurnHudBindings | null): void {
    this.turnHudBindings = bindings;
    this.updateTurnHud();
  }

  render(parentElement: HTMLElement, onComplete?: () => void, navigate?: (screenId: ScreenId) => void): void {
    window.addEventListener(SETTINGS_CHANGED_EVENT, this.onSettingsChanged);
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
      compactFit: true,
      reservedBottomPx: GAME_BOARD_BOTTOM_BAR_PX,
      mapLiftPx: GAME_BOARD_MAP_LIFT_PX,
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
    this.mountResourceBar(this.buttonContainer);
    if (roomId) {
      connectSocket({ gameId: roomId, playerId: session?.playerId });
      this.unsubscribe = subscribeClientState((state) => {
        this.liveGameState = state.gameState;
        this.livePlayerId = state.playerId ?? this.livePlayerId;
        this.updateTurnHud();
        this.refreshPlayerUi();
      });
    } else {
      this.liveGameState = clientState.gameState;
      this.refreshPlayerUi();
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
    /** Sits on the bottom bar: overlap ~half the button with the bar; +38px total lift (incl. ~0.2cm @ 96dpi). */
    this.musicToggleButton.style.bottom = `${Math.max(12, GAME_BOARD_BOTTOM_BAR_PX - 32 + 38)}px`;
    this.musicToggleButton.style.right = '16px';
    this.musicToggleButton.style.zIndex = '10';
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
    panel.className = 'absolute top-16 left-4 flex flex-col gap-2';
    panel.style.zIndex = '3';
    panel.style.width = '128px';
    this.playerPanel = panel;
    parent.appendChild(panel);
  }

  private mountResourceBar(parent: HTMLElement): void {
    if (this.resourceBar) {
      this.resourceBar.remove();
    }
    const bar = document.createElement('div');
    bar.className =
      'absolute bottom-0 left-0 right-0 pointer-events-none border-t border-slate-600/90 bg-slate-950/92 shadow-[0_-4px_16px_rgba(0,0,0,0.35)]';
    bar.style.zIndex = '3';

    const row = document.createElement('div');
    row.className =
      'flex w-full flex-row flex-wrap items-stretch justify-between gap-x-2 gap-y-1.5 px-2.5 py-2 min-h-[72px]';

    const left = document.createElement('div');
    left.className =
      'font-hexahaven-ui flex min-h-0 min-w-0 flex-1 flex-row flex-nowrap items-stretch justify-start gap-0.5 self-stretch pointer-events-auto';

    const right = document.createElement('div');
    right.id = 'game-board-bottom-bar-right';
    right.className =
      'flex min-h-0 min-w-0 flex-1 items-stretch justify-end gap-1.5 self-stretch pointer-events-auto';
    right.setAttribute('aria-label', 'Bottom bar — right section');

    row.appendChild(left);
    row.appendChild(right);
    bar.appendChild(row);

    this.resourceBar = bar;
    this.resourceBarLeft = left;
    this.resourceBarRight = right;
    parent.appendChild(bar);
  }

  /** Right side of the bottom bar (build actions). Content is managed by `renderBuildingBarFromGameState`. */
  getBottomBarRightSlot(): HTMLDivElement | null {
    return this.resourceBarRight;
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

  private refreshPlayerUi(): void {
    this.renderPlayerCardsFromGameState();
    this.renderResourceBarFromGameState();
    this.renderBuildingBarFromGameState();
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
      card.className = 'rounded-lg border border-slate-500 bg-slate-900/85 px-2 py-2 text-white shadow-md';

      const avatar = document.createElement('img');
      avatar.src = player.avatarUrl ?? '/avatar/avatar_1.png';
      avatar.alt = `${player.displayName} avatar`;
      avatar.className = 'mx-auto mb-1 h-10 w-10 bg-transparent object-cover rounded-md';

      const name = document.createElement('div');
      name.className = 'font-hexahaven-ui text-[11px] text-center truncate';
      name.textContent = player.displayName;

      const points = document.createElement('div');
      points.className = 'font-hexahaven-ui mt-1 text-[10px] text-slate-200 text-center leading-tight';
      points.textContent = `Victory Points: ${player.stats.publicVP ?? 0}`;

      card.appendChild(avatar);
      card.appendChild(name);
      card.appendChild(points);
      this.playerPanel?.appendChild(card);
    });
  }

  private renderResourceBarFromGameState(): void {
    const gameState = this.liveGameState;
    if (!this.resourceBarLeft || !gameState) {
      return;
    }
    this.resourceBarLeft.innerHTML = '';

    const viewerId = this.livePlayerId;
    if (viewerId === null || viewerId === 'spectator') {
      return;
    }

    const player = gameState.playersById[viewerId];
    if (!player) {
      return;
    }

    this.clampResourceSelectionToInventory(player.resources);

    RESOURCE_BOX_CONFIG.forEach(
      ({ key, shortLabel, color, iconSrc, boxBg, boxBorder, boxHoverBg, countColor }) => {
        const owned = player.resources[key] ?? 0;
        const selected = this.resourceSelection[key] ?? 0;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className =
          'flex w-[42px] shrink-0 flex-col items-center justify-center gap-0.5 self-stretch rounded-md border px-1 py-1.5 shadow-sm transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/80 cursor-pointer';
        btn.style.backgroundColor = boxBg;
        btn.style.borderColor = selected > 0 ? '#34d399' : boxBorder;
        btn.style.borderWidth = selected > 0 ? '2px' : '1px';
        btn.style.boxShadow = selected > 0 ? '0 0 0 1px rgba(52, 211, 153, 0.45)' : '';
        btn.style.borderStyle = 'solid';
        btn.addEventListener('mouseenter', () => {
          btn.style.backgroundColor = boxHoverBg;
        });
        btn.addEventListener('mouseleave', () => {
          btn.style.backgroundColor = boxBg;
        });
        btn.setAttribute('aria-label', `${key}: ${selected} selected of ${owned}`);
        btn.addEventListener('click', () => this.cycleResourceSelection(key));

        if (iconSrc) {
          const img = document.createElement('img');
          img.src = iconSrc;
          img.alt = shortLabel;
          img.className = 'h-8 w-8 max-h-[36px] object-contain pointer-events-none';
          img.draggable = false;
          btn.appendChild(img);
        } else {
          const abbr = document.createElement('span');
          abbr.className = 'font-hexahaven-ui text-[9px] font-bold leading-none pointer-events-none';
          abbr.style.color = color;
          abbr.textContent = shortLabel;
          btn.appendChild(abbr);
        }

        const count = document.createElement('span');
        count.className = 'text-[9px] font-semibold tabular-nums pointer-events-none leading-none';
        count.style.color = countColor;
        count.textContent = owned > 0 ? `${selected}/${owned}` : '0';
        btn.appendChild(count);

        this.resourceBarLeft.appendChild(btn);
      },
    );
  }

  private clampResourceSelectionToInventory(inv: ResourceBundle): void {
    for (const k of RESOURCE_KEYS) {
      const owned = inv[k] ?? 0;
      const sel = this.resourceSelection[k] ?? 0;
      if (sel > owned) {
        this.resourceSelection = { ...this.resourceSelection, [k]: owned };
      }
    }
  }

  private cycleResourceSelection(key: ResourceKey): void {
    const gs = this.liveGameState ?? clientState.gameState;
    const pid = this.livePlayerId;
    if (!gs || !pid) {
      return;
    }
    const player = gs.playersById[pid];
    if (!player) {
      return;
    }
    const owned = player.resources[key] ?? 0;
    if (owned <= 0) {
      return;
    }
    const current = this.resourceSelection[key] ?? 0;
    const next = (current + 1) % (owned + 1);
    this.resourceSelection = { ...this.resourceSelection, [key]: next };
    this.refreshPlayerUi();
  }

  private renderBuildingBarFromGameState(): void {
    if (!this.resourceBarRight) {
      return;
    }
    this.resourceBarRight.innerHTML = '';

    const gameState = this.liveGameState ?? clientState.gameState;
    const viewerId = this.livePlayerId;
    if (!gameState || viewerId === null || viewerId === 'spectator') {
      return;
    }
    const player = gameState.playersById[viewerId];
    if (!player) {
      return;
    }

    this.clampResourceSelectionToInventory(player.resources);

    BUILD_OPTIONS.forEach(({ kind, label, cost, iconSrc }) => {
      const ready = isBuildOptionReady(this.resourceSelection, cost, player.resources);

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className =
        'font-hexahaven-ui flex min-w-[56px] flex-col items-center justify-center self-stretch rounded-md border px-2 py-1.5 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/90';
      if (ready) {
        btn.className +=
          ' cursor-pointer border-emerald-400/80 bg-emerald-100 text-emerald-950 shadow-[0_0_14px_rgba(16,185,129,0.16)]';
        btn.disabled = false;
      } else {
        btn.className +=
          ' cursor-not-allowed border-slate-600 bg-slate-800/80 text-slate-500 opacity-70';
        btn.disabled = true;
      }
      btn.setAttribute('aria-label', label);
      if (iconSrc) {
        const img = document.createElement('img');
        img.src = iconSrc;
        img.alt = label;
        img.className = 'h-11 w-11 max-h-[44px] object-contain pointer-events-none';
        img.draggable = false;
        btn.appendChild(img);
      }
      if (ready) {
        btn.addEventListener('click', () => this.onBuildingClicked(kind, cost));
      }
      this.resourceBarRight?.appendChild(btn);
    });
  }

  private onBuildingClicked(_kind: BuildKind, cost: ResourceBundle): void {
    const gs = this.liveGameState ?? clientState.gameState;
    const pid = this.livePlayerId;
    if (!gs || !pid) {
      return;
    }
    const p0 = gs.playersById[pid];
    if (!p0 || !isBuildOptionReady(this.resourceSelection, cost, p0.resources)) {
      return;
    }
    const next = cloneGameState(gs);
    const p = next.playersById[pid];
    if (!p) {
      return;
    }
    for (const k of RESOURCE_KEYS) {
      if ((p.resources[k] ?? 0) < (cost[k] ?? 0)) {
        return;
      }
    }
    for (const k of RESOURCE_KEYS) {
      p.resources[k] = (p.resources[k] ?? 0) - (cost[k] ?? 0);
    }
    p.updatedAt = new Date().toISOString();
    this.resourceSelection = emptyResourceBundle();
    setClientState({ gameState: next });
    this.liveGameState = next;
    this.refreshPlayerUi();
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
    window.removeEventListener(SETTINGS_CHANGED_EVENT, this.onSettingsChanged);
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
    if (this.resourceBar) {
      this.resourceBar.remove();
      this.resourceBar = null;
    }
    this.resourceBarLeft = null;
    this.resourceBarRight = null;
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
    this.resourceSelection = emptyResourceBundle();
  }
}
