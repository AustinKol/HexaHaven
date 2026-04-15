import { playBuildPlacementSound, playDiceRollSound } from '../audio/buildSounds';
import { BASE_GAME_BOARD_MUSIC_VOLUME, scaledBoardMusicVolume } from '../audio/musicVolume';
import { ClientEnv } from '../config/env';
import { BUILD_COSTS } from '../../shared/buildRules';
import { loadSettings, saveSettings, SETTINGS_CHANGED_EVENT, type GameSettings } from '../settings/gameSettings';
import { ScreenId } from '../../shared/constants/screenIds';
import type { DiceRoll, GamePhase, GameState, ResourceBundle } from '../../shared/types/domain';
import { bankTrade, buildStructure, connectSocket, disconnectSocket, endTurn, hydrateSession, rollDice, sendChatMessage } from '../networking/socketClient';
import { clientState, resetClientState, subscribeClientState } from '../state/clientState';
import { clearLobbySession, getLobbySession } from '../state/lobbyState';
import { createDiceHud, type DiceHud } from '../ui/diceRollDisplay';
import { TestMapGenScreen, type MapPointerHit } from './TestMapGenScreen';

type ResourceKey = keyof ResourceBundle;

/** Bottom bar + UI reserved for Phaser (taller bar needs more clearance). */
const GAME_BOARD_BOTTOM_BAR_PX = 84;
/** ~0.5cm at 96dpi — extra inset so the map sits slightly higher. */
const GAME_BOARD_MAP_LIFT_PX = 20;
const FIXED_TURN_TIME_SECONDS = 30;
const TURN_TIMER_WARNING_SECONDS = 15;

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

const RESOURCE_LABELS: Record<ResourceKey, string> = {
  CRYSTAL: 'Crystal',
  STONE: 'Stone',
  BLOOM: 'Bloom',
  EMBER: 'Ember',
  GOLD: 'Gold',
};

function costEntriesForRecipe(cost: ResourceBundle): { key: ResourceKey; count: number }[] {
  return RESOURCE_KEYS.filter((k) => (cost[k] ?? 0) > 0).map((k) => ({ key: k, count: cost[k] ?? 0 }));
}

/** Parses `#rgb` / `#rrggbb` for UI accents (player panel borders, etc.). */
function hexToRgbComponents(hex: string): { r: number; g: number; b: number } | null {
  const h = hex.replace(/^#/, '').trim();
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  if (full.length !== 6) return null;
  const n = parseInt(full, 16);
  if (!Number.isFinite(n)) return null;
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function playerCanAffordCost(inventory: ResourceBundle, cost: ResourceBundle): boolean {
  return RESOURCE_KEYS.every((k) => inventoryCount(inventory[k]) >= inventoryCount(cost[k]));
}

function canAffordCost(inventory: ResourceBundle, cost: ResourceBundle): boolean {
  return ClientEnv.devUnlimitedMaterials || playerCanAffordCost(inventory, cost);
}

function emptyResourceBundle(): ResourceBundle {
  return { CRYSTAL: 0, STONE: 0, BLOOM: 0, EMBER: 0, GOLD: 0 };
}

/** Whole-number counts only (no decimals in UI or inventory math). */
function inventoryCount(n: unknown): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? n : 0;
  return Math.max(0, Math.floor(v));
}

type BuildKind = 'ROAD' | 'SETTLEMENT' | 'CITY';

/** Costs (paid from inventory when you can afford): Road 1E+1St · Settlement 1E+1Bl+1St · City 3St+2Bl · Dev 2Cr+2Go */
const BUILD_OPTIONS: { kind: BuildKind; label: string; cost: ResourceBundle; iconSrc?: string }[] = [
  {
    kind: 'ROAD',
    label: 'Road',
    cost: BUILD_COSTS.ROAD,
    iconSrc: '/images/buildings/road.png',
  },
  {
    kind: 'SETTLEMENT',
    label: 'Settlement',
    cost: BUILD_COSTS.SETTLEMENT,
    iconSrc: '/images/buildings/settlement.png',
  },
  {
    kind: 'CITY',
    label: 'City',
    cost: BUILD_COSTS.CITY,
    iconSrc: '/images/buildings/city.png',
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
  private settingsButton: HTMLButtonElement | null = null;
  private gameSettingsBackdrop: HTMLDivElement | null = null;
  private gameSettingsBoardMusicRange: HTMLInputElement | null = null;
  private gameSettingsBoardMusicValueEl: HTMLElement | null = null;
  private gameSettingsGameSfxRange: HTMLInputElement | null = null;
  private gameSettingsGameSfxValueEl: HTMLElement | null = null;
  private gameSettingsKeydown: ((e: KeyboardEvent) => void) | null = null;
  private topRightContainer: HTMLElement | null = null;
  private playerPanel: HTMLDivElement | null = null;
  private resourceBar: HTMLDivElement | null = null;
  /** Player + resource buttons; cleared on each state refresh. */
  private resourceBarLeft: HTMLDivElement | null = null;
  /** Build actions (right side); rebuilt each refresh. */
  private resourceBarRight: HTMLDivElement | null = null;
  /** Left bar: tap counts 0…owned (optional; build actions pay from inventory when you can afford). */
  private resourceSelection: ResourceBundle = emptyResourceBundle();
  private turnHudPanel: HTMLDivElement | null = null;
  /** Dice display — bottom-left, above the resource bar. */
  private diceHudPanel: HTMLDivElement | null = null;
  private currentPlayerValue: HTMLDivElement | null = null;
  private currentPhaseValue: HTMLDivElement | null = null;
  private turnTimerValue: HTMLDivElement | null = null;
  private turnTimerTicker: number | null = null;
  private lastTimerTurnKey: string | null = null;
  private nearTimeoutTickSecond: number | null = null;
  private diceHud: DiceHud | null = null;
  /** Local roll: waiting for server `lastDiceRoll` after clicking Roll. */
  private expectingLocalDiceAck = false;
  private diceRollTicker: number | null = null;
  private diceFailSafeTimer: number | null = null;
  private diceCompleteDelayTimer: number | null = null;
  private localDiceRollStartedAt: number | null = null;
  private rollDiceButton: HTMLButtonElement | null = null;
  private chatPanel: HTMLDivElement | null = null;
  private chatMessagesContainer: HTMLDivElement | null = null;
  private chatInput: HTMLInputElement | null = null;
  private bankTradeButton: HTMLButtonElement | null = null;
  private endTurnButton: HTMLButtonElement | null = null;
  private bankGiveSelection: ResourceKey = 'EMBER';
  private bankReceiveSelection: ResourceKey = 'STONE';
  private bankGiveButtons: Partial<Record<ResourceKey, HTMLButtonElement>> = {};
  private bankReceiveButtons: Partial<Record<ResourceKey, HTMLButtonElement>> = {};
  private buttonContainer: HTMLElement | null = null;
  private isMusicMuted = false;
  private turnHudBindings: GameBoardTurnHudBindings | null = null;
  private unsubscribe: (() => void) | null = null;
  private buildRecipePopoverEl: HTMLDivElement | null = null;
  private buildRecipePopoverAnchor: HTMLElement | null = null;
  private buildRecipePopoverListeners: { onDoc: (e: MouseEvent) => void; onKey: (e: KeyboardEvent) => void } | null =
    null;
  /** Chosen build; resources are spent after the player clicks the map to place. */
  private pendingBuild: { kind: BuildKind; cost: ResourceBundle } | null = null;
  private liveGameState: GameState | null = null;
  private livePlayerId: string | null = null;
  private fallbackLastDiceRoll = 'Not rolled yet';
  private readonly onSettingsChanged = (): void => {
    this.backgroundMusic.volume = scaledBoardMusicVolume(BASE_GAME_BOARD_MUSIC_VOLUME);
    this.syncGameSettingsPanelSliders();
  };

  private resolveTurnEndsAtMs(gameState: GameState | null): number | null {
    const turnEndsAt = gameState?.turn.turnEndsAt;
    if (turnEndsAt) {
      const parsed = Date.parse(turnEndsAt);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
    const turnStartedAt = gameState?.turn.turnStartedAt;
    if (turnStartedAt) {
      const startedMs = Date.parse(turnStartedAt);
      if (Number.isFinite(startedMs)) {
        return startedMs + (FIXED_TURN_TIME_SECONDS * 1000);
      }
    }
    return null;
  }

  private playNearTimeoutTick(): void {
    try {
      const Ctor = window.AudioContext ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) {
        return;
      }
      const context = new Ctor();
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = 'square';
      oscillator.frequency.value = 880;
      gain.gain.value = 0.02;
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start();
      oscillator.stop(context.currentTime + 0.09);
      window.setTimeout(() => {
        void context.close();
      }, 150);
    } catch {
      // Ignore audio failures caused by browser gesture policy or unavailable API.
    }
  }

  private startTurnTimerTicker(): void {
    if (this.turnTimerTicker !== null) {
      return;
    }
    this.turnTimerTicker = window.setInterval(() => {
      this.updateTurnTimerUi();
    }, 250);
  }

  private stopTurnTimerTicker(): void {
    if (this.turnTimerTicker !== null) {
      clearInterval(this.turnTimerTicker);
      this.turnTimerTicker = null;
    }
    this.lastTimerTurnKey = null;
    this.nearTimeoutTickSecond = null;
  }

  private updateTurnTimerUi(): void {
    if (!this.turnTimerValue) {
      return;
    }
    const gameState = this.liveGameState ?? clientState.gameState;
    const activePlayerId = gameState?.turn.currentPlayerId ?? null;
    const turnKey = activePlayerId ? `${gameState?.turn.currentTurn ?? 0}:${activePlayerId}` : null;
    if (turnKey && turnKey !== this.lastTimerTurnKey) {
      this.lastTimerTurnKey = turnKey;
      this.nearTimeoutTickSecond = null;
    }

    const turnEndsAtMs = this.resolveTurnEndsAtMs(gameState);
    if (!Number.isFinite(turnEndsAtMs)) {
      this.turnTimerValue.textContent = '--:--';
      this.turnTimerValue.style.background = 'rgba(15, 23, 42, 0.9)';
      this.turnTimerValue.style.borderColor = 'rgba(148, 163, 184, 0.65)';
      this.turnTimerValue.style.color = '#e2e8f0';
      return;
    }

    const remainingMs = Math.max(0, (turnEndsAtMs as number) - Date.now());
    const remainingSec = Math.ceil(remainingMs / 1000);
    const min = Math.floor(remainingSec / 60);
    const sec = remainingSec % 60;
    this.turnTimerValue.textContent = `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;

    if (remainingSec <= TURN_TIMER_WARNING_SECONDS) {
      this.turnTimerValue.style.background = 'rgba(127, 29, 29, 0.92)';
      this.turnTimerValue.style.borderColor = 'rgba(248, 113, 113, 0.95)';
      this.turnTimerValue.style.color = '#fee2e2';
      if (remainingSec > 0 && remainingSec !== this.nearTimeoutTickSecond) {
        this.nearTimeoutTickSecond = remainingSec;
        this.playNearTimeoutTick();
      }
    } else {
      this.turnTimerValue.style.background = 'rgba(8, 47, 73, 0.9)';
      this.turnTimerValue.style.borderColor = 'rgba(34, 211, 238, 0.85)';
      this.turnTimerValue.style.color = '#cffafe';
    }
  }

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

    const gameState = this.liveGameState ?? clientState.gameState;
    const boardTiles = gameState ? Object.values(gameState.board.tilesById) : [];
    const structures = gameState ? Object.values(gameState.board.structuresById) : [];
    const pendingKind =
      this.pendingBuild?.kind === 'SETTLEMENT'
        ? 'SETTLEMENT'
        : this.pendingBuild?.kind === 'CITY'
          ? 'CITY'
          : this.pendingBuild?.kind === 'ROAD'
            ? 'ROAD'
            : null;
    const livePid = this.livePlayerId;
    const roadHoverColor =
      pendingKind === 'ROAD' && livePid && gameState?.playersById[livePid]?.color
        ? gameState.playersById[livePid].color
        : undefined;

    this.mapScreen = new TestMapGenScreen({
      showExitButton: false,
      enableBackgroundMusic: false,
      showRegenerateButton: false,
      allowPointerRegenerate: false,
      mapSeed: gameState?.config.mapSeed ?? roomId ?? undefined,
      compactFit: true,
      reservedBottomPx: GAME_BOARD_BOTTOM_BAR_PX,
      mapLiftPx: GAME_BOARD_MAP_LIFT_PX,
      onMapPointerDown: (hit) => this.handleMapPlaceClick(hit),
      pendingBuildKind: pendingKind,
      boardTiles,
      roadHoverColor,
      structures: structures.map(s => ({
        type: s.type as 'SETTLEMENT' | 'CITY' | 'ROAD',
        ownerColor: s.ownerColor,
        vertex: s.vertex,
        edge: s.edge,
      })),
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
    this.startTurnTimerTicker();
    this.mountChatPanel(this.buttonContainer);
    this.mountResourceBar(this.buttonContainer);
    if (roomId) {
      connectSocket({ gameId: roomId, playerId: session?.playerId });
      void hydrateSession(roomId).catch((error) => {
        console.error('Failed to hydrate game session:', error);
      });
      this.unsubscribe = subscribeClientState((state) => {
        console.log('[GameBoardScreen] Client state updated. Chat messages count:', state.gameState?.chatMessages?.length);
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

    const topRight = document.createElement('div');
    topRight.style.position = 'absolute';
    topRight.style.top = '16px';
    topRight.style.right = '16px';
    topRight.style.zIndex = '3';
    topRight.style.display = 'flex';
    topRight.style.flexDirection = 'row';
    topRight.style.alignItems = 'center';
    topRight.style.gap = '8px';

    this.settingsButton = document.createElement('button');
    this.settingsButton.type = 'button';
    this.settingsButton.className = 'font-hexahaven-ui';
    this.settingsButton.style.display = 'flex';
    this.settingsButton.style.alignItems = 'center';
    this.settingsButton.style.justifyContent = 'center';
    this.settingsButton.style.width = '40px';
    this.settingsButton.style.height = '40px';
    this.settingsButton.style.padding = '0';
    this.settingsButton.style.color = '#ffffff';
    this.settingsButton.style.background = 'rgba(15, 23, 42, 0.85)';
    this.settingsButton.style.border = '1px solid rgba(255, 255, 255, 0.35)';
    this.settingsButton.style.borderRadius = '8px';
    this.settingsButton.style.cursor = 'pointer';
    this.settingsButton.title = 'Game audio settings';
    this.settingsButton.setAttribute('aria-label', 'Game audio settings');
    this.settingsButton.innerHTML =
      '<svg aria-hidden="true" viewBox="0 0 24 24" style="width:22px;height:22px;fill:currentColor;"><path d="M19.14 12.94c.04-.31.06-.63.06-.94 0-.31-.02-.63-.06-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.488.488 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.31-.09.63-.09.94s.02.63.06.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/></svg>';
    this.settingsButton.addEventListener('click', () => this.toggleGameSettingsPanel());

    this.exitButton = document.createElement('button');
    this.exitButton.textContent = 'Exit to Menu';
    this.exitButton.className = 'font-hexahaven-ui';
    this.exitButton.style.padding = '8px 10px';
    this.exitButton.style.fontSize = '14px';
    this.exitButton.style.fontWeight = '600';
    this.exitButton.style.color = '#ffffff';
    this.exitButton.style.background = 'rgba(15, 23, 42, 0.85)';
    this.exitButton.style.border = '1px solid rgba(255, 255, 255, 0.35)';
    this.exitButton.style.borderRadius = '8px';
    this.exitButton.style.cursor = 'pointer';
    this.exitButton.addEventListener('click', () => {
      disconnectSocket();
      clearLobbySession();
      resetClientState();
      navigateTo(ScreenId.MainMenu);
    });
    topRight.appendChild(this.settingsButton);
    this.musicToggleButton = document.createElement('button');
    this.musicToggleButton.type = 'button';
    this.musicToggleButton.style.display = 'flex';
    this.musicToggleButton.style.alignItems = 'center';
    this.musicToggleButton.style.justifyContent = 'center';
    this.musicToggleButton.style.width = '40px';
    this.musicToggleButton.style.height = '40px';
    this.musicToggleButton.style.padding = '0';
    this.musicToggleButton.style.color = '#ffffff';
    this.musicToggleButton.style.background = 'rgba(15, 23, 42, 0.85)';
    this.musicToggleButton.style.border = '1px solid rgba(255, 255, 255, 0.35)';
    this.musicToggleButton.style.borderRadius = '8px';
    this.musicToggleButton.style.cursor = 'pointer';
    this.musicToggleButton.addEventListener('click', () => this.toggleMusic());
    this.updateMusicButtonIcon();
    topRight.appendChild(this.musicToggleButton);
    topRight.appendChild(this.exitButton);
    this.topRightContainer = topRight;
    this.buttonContainer.appendChild(topRight);
  }

  private mountPlayerPanel(parent: HTMLElement): void {
    if (this.playerPanel) {
      this.playerPanel.remove();
    }
    const panel = document.createElement('div');
    panel.className = 'absolute top-4 left-4 flex flex-col gap-2';
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
    if (this.diceHudPanel) {
      this.diceHudPanel.remove();
    }

    this.bankGiveButtons = {};
    this.bankReceiveButtons = {};

    const panel = document.createElement('div');
    panel.className = 'absolute top-16 right-4 rounded-xl border border-slate-600 bg-slate-900/88 px-3 py-2 text-white shadow-md';
    panel.style.zIndex = '3';
    panel.style.width = '260px';

    const header = document.createElement('div');
    header.className = 'mb-2 flex items-center justify-between gap-2';

    const title = document.createElement('div');
    title.className = 'font-hexahaven-ui text-xs font-semibold';
    title.textContent = 'Turn HUD (DEMO)';
    header.appendChild(title);

    if (ClientEnv.devUnlimitedMaterials) {
      const devBadge = document.createElement('div');
      devBadge.className =
        'font-hexahaven-ui rounded border border-amber-300/80 bg-amber-200/95 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-950';
      devBadge.textContent = 'DEV: Unlimited';
      devBadge.setAttribute('aria-label', 'Developer mode: unlimited materials enabled');
      header.appendChild(devBadge);
    }

    const currentPlayerLabel = document.createElement('div');
    currentPlayerLabel.className = 'font-hexahaven-ui text-[10px] text-slate-300';
    currentPlayerLabel.textContent = 'Current Player';

    const currentPlayerValue = document.createElement('div');
    currentPlayerValue.className = 'font-hexahaven-ui text-xs font-semibold mb-1.5';

    const currentPhaseLabel = document.createElement('div');
    currentPhaseLabel.className = 'font-hexahaven-ui text-[10px] text-slate-300';
    currentPhaseLabel.textContent = 'Current Phase';

    const currentPhaseValue = document.createElement('div');
    currentPhaseValue.className = 'font-hexahaven-ui text-xs font-semibold mb-1.5';

    const turnTimerLabel = document.createElement('div');
    turnTimerLabel.className = 'font-hexahaven-ui text-[10px] text-cyan-200';
    turnTimerLabel.textContent = 'Turn Timer';

    const turnTimerValue = document.createElement('div');
    turnTimerValue.className =
      'font-hexahaven-ui mb-2 rounded-md border px-2 py-1 text-center text-lg font-bold tracking-widest tabular-nums';
    turnTimerValue.textContent = '01:00';

    const diceHud = createDiceHud();
    diceHud.root.style.marginBottom = '0';

    const lastDiceRollLabel = document.createElement('div');
    lastDiceRollLabel.className = 'font-hexahaven-ui text-xs text-slate-300';
    lastDiceRollLabel.textContent = 'Last Dice Roll';

    const dicePanel = document.createElement('div');
    dicePanel.className =
      'absolute left-4 flex flex-col gap-2 rounded-xl border border-slate-600 bg-slate-900/88 px-3 py-2 text-white shadow-md pointer-events-auto';
    dicePanel.style.zIndex = '3';
    dicePanel.style.bottom = `${GAME_BOARD_BOTTOM_BAR_PX + 10}px`;
    dicePanel.setAttribute('aria-label', 'Dice roll');
    dicePanel.appendChild(lastDiceRollLabel);
    dicePanel.appendChild(diceHud.root);

    const rollDiceButton = document.createElement('button');
    rollDiceButton.type = 'button';
    rollDiceButton.className =
      'font-hexahaven-ui w-full rounded-md border border-cyan-400/60 bg-cyan-900/60 px-2 py-2 text-xs font-semibold';
    rollDiceButton.textContent = 'Roll Dice';
    rollDiceButton.addEventListener('click', () => this.handleRollDiceClick());
    dicePanel.appendChild(rollDiceButton);

    const actions = document.createElement('div');
    actions.className = 'flex flex-col gap-1.5';

    const endTurnButton = document.createElement('button');
    endTurnButton.type = 'button';
    endTurnButton.className =
      'font-hexahaven-ui rounded-md border border-emerald-400/60 bg-emerald-900/60 px-2 py-1.5 text-[11px] font-semibold';
    endTurnButton.textContent = 'End Turn';
    endTurnButton.addEventListener('click', () => this.handleEndTurnClick());

    const bankGiveLabel = document.createElement('div');
    bankGiveLabel.className = 'font-hexahaven-ui text-[11px] text-slate-300';
    bankGiveLabel.textContent = 'Give 4';

    const bankGiveRow = document.createElement('div');
    bankGiveRow.className = 'flex flex-wrap gap-1';

    RESOURCE_BOX_CONFIG.forEach(({ key, shortLabel, iconSrc, boxBg, boxBorder, boxHoverBg, countColor }) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'flex h-9 w-9 items-center justify-center rounded-md border transition-colors';
      btn.style.backgroundColor = boxBg;
      btn.style.borderColor = boxBorder;
      btn.style.color = countColor;
      btn.style.cursor = 'pointer';

      btn.addEventListener('mouseenter', () => {
        btn.style.backgroundColor = boxHoverBg;
      });
      btn.addEventListener('mouseleave', () => {
        btn.style.backgroundColor = boxBg;
      });

      btn.addEventListener('click', () => {
        this.bankGiveSelection = key;
        this.refreshBankTradeUi();
        this.updateTurnHud();
      });

      if (iconSrc) {
        const img = document.createElement('img');
        img.src = iconSrc;
        img.alt = shortLabel;
        img.className = 'h-6 w-6 object-contain pointer-events-none';
        img.draggable = false;
        btn.appendChild(img);
      } else {
        btn.textContent = shortLabel;
      }

      this.bankGiveButtons[key] = btn;
      bankGiveRow.appendChild(btn);
    });

    const bankReceiveLabel = document.createElement('div');
    bankReceiveLabel.className = 'font-hexahaven-ui text-[11px] text-slate-300';
    bankReceiveLabel.textContent = 'Receive 1';

    const bankReceiveRow = document.createElement('div');
    bankReceiveRow.className = 'flex flex-wrap gap-1';

    RESOURCE_BOX_CONFIG.forEach(({ key, shortLabel, iconSrc, boxBg, boxBorder, boxHoverBg, countColor }) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'flex h-9 w-9 items-center justify-center rounded-md border transition-colors';
      btn.style.backgroundColor = boxBg;
      btn.style.borderColor = boxBorder;
      btn.style.color = countColor;
      btn.style.cursor = 'pointer';

      btn.addEventListener('mouseenter', () => {
        btn.style.backgroundColor = boxHoverBg;
      });
      btn.addEventListener('mouseleave', () => {
        btn.style.backgroundColor = boxBg;
      });

      btn.addEventListener('click', () => {
        this.bankReceiveSelection = key;
        this.refreshBankTradeUi();
        this.updateTurnHud();
      });

      if (iconSrc) {
        const img = document.createElement('img');
        img.src = iconSrc;
        img.alt = shortLabel;
        img.className = 'h-6 w-6 object-contain pointer-events-none';
        img.draggable = false;
        btn.appendChild(img);
      } else {
        btn.textContent = shortLabel;
      }

      this.bankReceiveButtons[key] = btn;
      bankReceiveRow.appendChild(btn);
    });

    const bankTradeButton = document.createElement('button');
    bankTradeButton.type = 'button';
    bankTradeButton.className =
      'font-hexahaven-ui rounded-md border border-amber-400/60 bg-amber-900/60 px-2 py-2 text-xs font-semibold';
    bankTradeButton.addEventListener('click', () => this.handleBankTradeClick());

    actions.appendChild(endTurnButton);
    actions.appendChild(bankGiveLabel);
    actions.appendChild(bankGiveRow);
    actions.appendChild(bankReceiveLabel);
    actions.appendChild(bankReceiveRow);
    actions.appendChild(bankTradeButton);

    panel.appendChild(header);
    panel.appendChild(currentPlayerLabel);
    panel.appendChild(currentPlayerValue);
    panel.appendChild(currentPhaseLabel);
    panel.appendChild(currentPhaseValue);
    panel.appendChild(turnTimerLabel);
    panel.appendChild(turnTimerValue);
    panel.appendChild(actions);

    this.turnHudPanel = panel;
    this.diceHudPanel = dicePanel;
    this.currentPlayerValue = currentPlayerValue;
    this.currentPhaseValue = currentPhaseValue;
    this.turnTimerValue = turnTimerValue;
    this.diceHud = diceHud;
    this.rollDiceButton = rollDiceButton;
    this.endTurnButton = endTurnButton;
    this.bankTradeButton = bankTradeButton;

    parent.appendChild(panel);
    parent.appendChild(dicePanel);

    this.refreshBankTradeUi();
    this.updateTurnHud();
    this.updateTurnTimerUi();
  }

  private mountChatPanel(parent: HTMLElement): void {
    if (this.chatPanel) {
      this.chatPanel.remove();
    }

    const panel = document.createElement('div');
    panel.className = 'absolute right-4 flex flex-col bg-slate-900/88 border border-slate-700 rounded-lg shadow-lg overflow-hidden pointer-events-auto';
    panel.style.bottom = `${GAME_BOARD_BOTTOM_BAR_PX + 10}px`;
    panel.style.width = '260px';
    panel.style.height = '160px';
    panel.style.zIndex = '100'; // Temporarily increase z-index to rule out layering issues
    this.chatPanel = panel;
    requestAnimationFrame(() => {
      if (this.chatPanel && this.diceHudPanel) {
        this.chatPanel.style.height = `${this.diceHudPanel.offsetHeight}px`;
      }
    });

    const messagesContainer = document.createElement('div');
    messagesContainer.className = 'flex-1 overflow-y-auto p-2 text-xs text-white font-hexahaven-ui';
    messagesContainer.className = 'flex-1 overflow-y-auto p-2 text-xs text-white font-sans';
    messagesContainer.style.scrollbarWidth = 'thin';
    this.chatMessagesContainer = messagesContainer;

    const inputContainer = document.createElement('div');
    inputContainer.className = 'flex border-t border-slate-700 bg-slate-800/50';

    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'Chat...';
    input.className = 'flex-1 bg-transparent border-none px-2 py-1.5 text-xs text-white focus:outline-none';
    input.className = 'flex-1 bg-transparent border-none px-2 py-1.5 text-xs text-white focus:outline-none font-sans';
    this.chatInput = input;

    const sendBtn = document.createElement('button');
    sendBtn.textContent = 'Send';
    sendBtn.className = 'px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-cyan-400 hover:text-cyan-300 transition-colors';

    sendBtn.addEventListener('click', () => this.handleSendChatMessage());
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        this.handleSendChatMessage();
      }
    });

    inputContainer.appendChild(input);
    inputContainer.appendChild(sendBtn);
    panel.appendChild(messagesContainer);
    panel.appendChild(inputContainer);
    parent.appendChild(panel);
  }

  private handleSendChatMessage(): void {
    if (!this.chatInput) return;
    const message = this.chatInput.value.trim();
    if (message.length === 0) return;

    const roomId = getLobbySession()?.roomId ?? null;
    if (roomId) {
      void sendChatMessage(roomId, message);
      this.chatInput.value = '';
    }
  }

  private refreshPlayerUi(): void {
    this.renderPlayerCardsFromGameState();
    this.renderResourceBarFromGameState();
    this.renderBuildingBarFromGameState();
    this.renderChatMessages();
    this.updateMapDisplay();
  }

  private renderChatMessages(): void {
    if (!this.chatMessagesContainer || !this.liveGameState) {
      return;
    }

    const messages = this.liveGameState.chatMessages || [];
    this.chatMessagesContainer.innerHTML = '';

    messages.forEach((msg, index) => {
      try {
        const div = document.createElement('div');
        div.className = 'mb-1 leading-tight text-sm font-hexahaven-ui bg-slate-800/40 p-1 rounded';
        div.className = 'mb-1 leading-tight text-sm font-sans bg-slate-800/40 p-1 rounded';
        
        const sender = this.liveGameState?.playersById[msg.senderId];
        const color = sender?.color || '#cbd5e1';
        const name = msg.senderName || 'Unknown'; // Fallback to 'Unknown' if senderName is missing

        // Format timestamp to [HH:MM]
        const date = new Date(msg.timestamp);
        const timeString = `[${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}]`;

        const nameSpan = document.createElement('span');
        nameSpan.className = 'font-bold';
        nameSpan.style.color = color;
        nameSpan.textContent = `${timeString} ${name}: `; // Prepend timestamp

        const msgSpan = document.createElement('span');
        msgSpan.className = 'text-white';
        msgSpan.textContent = msg.message || '[Empty Message]';

        div.appendChild(nameSpan);
        div.appendChild(msgSpan);
        this.chatMessagesContainer!.appendChild(div);
      } catch (err) {
        console.error(`[Chat] Failed to render message at index ${index}:`, err);
      }
    });

    this.chatMessagesContainer.scrollTop = this.chatMessagesContainer.scrollHeight;
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
      card.className = 'font-hexahaven-ui rounded-lg border-2 border-solid px-2 py-2 text-white shadow-md';
      const accent = player.color || '#94a3b8';
      card.style.borderColor = accent;
      const rgb = hexToRgbComponents(accent);
      if (rgb) {
        // Interior is mostly their color, mixed with slate so labels stay legible.
        card.style.background = `color-mix(in srgb, ${accent} 72%, rgb(15, 23, 42))`;
        card.style.boxShadow = `0 2px 12px rgba(${rgb.r},${rgb.g},${rgb.b},0.45)`;
      } else {
        card.classList.add('bg-slate-900/85');
      }

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
        const owned = inventoryCount(player.resources[key]);
        const selected = inventoryCount(this.resourceSelection[key]);
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
        btn.setAttribute('aria-label', `${key}: ${owned}`);
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
        count.textContent = String(owned);
        btn.appendChild(count);

        this.resourceBarLeft?.appendChild(btn);
      },
    );
  }

  private clampResourceSelectionToInventory(inv: ResourceBundle): void {
    for (const k of RESOURCE_KEYS) {
      const owned = inventoryCount(inv[k]);
      const sel = inventoryCount(this.resourceSelection[k]);
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
    const owned = inventoryCount(player.resources[key]);
    if (owned <= 0) {
      return;
    }
    const current = inventoryCount(this.resourceSelection[key]);
    const next = (current + 1) % (owned + 1);
    this.resourceSelection = { ...this.resourceSelection, [key]: next };
    this.refreshPlayerUi();
  }

  private dismissBuildRecipePopover(): void {
    if (this.buildRecipePopoverListeners) {
      document.removeEventListener('mousedown', this.buildRecipePopoverListeners.onDoc, true);
      document.removeEventListener('keydown', this.buildRecipePopoverListeners.onKey);
      this.buildRecipePopoverListeners = null;
    }
    if (this.buildRecipePopoverEl) {
      this.buildRecipePopoverEl.remove();
      this.buildRecipePopoverEl = null;
    }
    this.buildRecipePopoverAnchor = null;
  }

  private showBuildRecipePopover(
    anchor: HTMLElement,
    label: string,
    cost: ResourceBundle,
    inventory: ResourceBundle,
  ): void {
    this.dismissBuildRecipePopover();

    const panel = document.createElement('div');
    panel.className =
      'font-hexahaven-ui pointer-events-auto max-w-[min(280px,calc(100vw-24px))] rounded-lg border border-slate-500 bg-slate-900/98 px-3 py-2.5 text-left text-white shadow-[0_8px_28px_rgba(0,0,0,0.55)]';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', `${label} recipe`);

    const title = document.createElement('div');
    title.className = 'font-semibold text-sm text-slate-100';
    title.textContent = label;
    panel.appendChild(title);

    const warn = document.createElement('div');
    warn.className =
      'mt-2 rounded-md border border-amber-500/55 bg-amber-950/45 px-2 py-1.5 text-[11px] leading-snug text-amber-100';
    warn.textContent =
      "You can't build this yet — you don't have enough resources. Dimmed slots are what you're missing.";
    panel.appendChild(warn);

    const sub = document.createElement('div');
    sub.className = 'mt-2 text-[11px] leading-snug text-slate-400';
    sub.textContent =
      'Bright = you have enough in your inventory for that resource; dim = need more.';
    panel.appendChild(sub);

    const row = document.createElement('div');
    row.className = 'mt-2 flex flex-wrap items-center gap-2';
    const entries = costEntriesForRecipe(cost);
    entries.forEach(({ key, count }) => {
      const owned = inventory[key] ?? 0;
      const hasEnough = owned >= count;
      const cfg = RESOURCE_BOX_CONFIG.find((c) => c.key === key);
      const chip = document.createElement('div');
      chip.className = hasEnough
        ? 'flex items-center gap-1 rounded-md border border-emerald-400/90 bg-emerald-100/95 px-1.5 py-1 text-[11px] text-emerald-950 shadow-[0_0_10px_rgba(16,185,129,0.28)]'
        : 'flex items-center gap-1 rounded-md border border-slate-600/90 bg-slate-900/90 px-1.5 py-1 text-[11px] text-slate-500 opacity-75';
      if (cfg?.iconSrc) {
        const img = document.createElement('img');
        img.src = cfg.iconSrc;
        img.alt = '';
        img.className = hasEnough
          ? 'h-6 w-6 object-contain'
          : 'h-6 w-6 object-contain opacity-55 grayscale';
        img.draggable = false;
        chip.appendChild(img);
      }
      const text = document.createElement('span');
      text.className = 'tabular-nums';
      text.textContent = `${RESOURCE_LABELS[key]} ×${count}`;
      chip.appendChild(text);
      row.appendChild(chip);
    });
    panel.appendChild(row);

    panel.addEventListener('mousedown', (e) => e.stopPropagation());
    panel.addEventListener('click', (e) => e.stopPropagation());

    document.body.appendChild(panel);
    this.buildRecipePopoverEl = panel;
    this.buildRecipePopoverAnchor = anchor;

    const place = (): void => {
      const rect = anchor.getBoundingClientRect();
      const w = panel.offsetWidth;
      const h = panel.offsetHeight;
      let left = rect.left + rect.width / 2 - w / 2;
      left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
      let top = rect.top - 8 - h;
      if (top < 8) {
        top = rect.bottom + 8;
      }
      panel.style.position = 'fixed';
      panel.style.left = `${left}px`;
      panel.style.top = `${top}px`;
      panel.style.zIndex = '100';
    };
    requestAnimationFrame(() => {
      place();
    });

    const onDoc = (e: MouseEvent): void => {
      if (panel.contains(e.target as Node) || anchor.contains(e.target as Node)) {
        return;
      }
      this.dismissBuildRecipePopover();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        this.dismissBuildRecipePopover();
      }
    };

    this.buildRecipePopoverListeners = { onDoc, onKey };
    setTimeout(() => {
      document.addEventListener('mousedown', onDoc, true);
      document.addEventListener('keydown', onKey);
    }, 0);
  }

  private renderBuildingBarFromGameState(): void {
    if (!this.resourceBarRight) {
      return;
    }
    this.dismissBuildRecipePopover();
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

    if (this.pendingBuild && !canAffordCost(player.resources, this.pendingBuild.cost)) {
      this.pendingBuild = null;
    }

    BUILD_OPTIONS.forEach(({ kind, label, cost, iconSrc }) => {
      const ready = canAffordCost(player.resources, cost);
      const selected = this.pendingBuild?.kind === kind;

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className =
        'font-hexahaven-ui flex min-w-[56px] flex-col items-center justify-center self-stretch rounded-md border px-2 py-1.5 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/90';
      if (ready) {
        btn.className +=
          ' cursor-pointer border-emerald-400/80 bg-emerald-100 text-emerald-950 shadow-[0_0_14px_rgba(16,185,129,0.16)]';
        if (selected) {
          btn.className +=
            ' ring-2 ring-cyan-400 ring-offset-2 ring-offset-slate-950 shadow-[0_0_16px_rgba(34,211,238,0.45)]';
        }
      } else {
        btn.className +=
          ' cursor-pointer border-slate-600 bg-slate-800/80 text-slate-400 opacity-90';
      }
      btn.disabled = false;
      btn.setAttribute(
        'aria-label',
        selected && ready ? `${label} — selected, tap the map to place` : label,
      );
      if (iconSrc) {
        const img = document.createElement('img');
        img.src = iconSrc;
        img.alt = label;
        img.className = 'h-11 w-11 max-h-[44px] object-contain pointer-events-none';
        img.draggable = false;
        btn.appendChild(img);
      }
      btn.addEventListener('click', () => {
        if (ready) {
          this.togglePendingBuild(kind, cost);
        } else if (this.buildRecipePopoverEl && this.buildRecipePopoverAnchor === btn) {
          this.dismissBuildRecipePopover();
        } else {
          this.showBuildRecipePopover(btn, label, cost, player.resources);
        }
      });
      this.resourceBarRight?.appendChild(btn);
    });
  }

  private togglePendingBuild(kind: BuildKind, cost: ResourceBundle): void {
    this.dismissBuildRecipePopover();
    if (this.pendingBuild?.kind === kind) {
      this.pendingBuild = null;
    } else {
      this.pendingBuild = { kind, cost };
    }
    console.log('[Settlement] Toggle pending build:', this.pendingBuild);
    this.refreshPlayerUi();
    this.updateMapDisplay();
  }

  private handleMapPlaceClick(hit: MapPointerHit): void {
    console.log('[Settlement] Map click:', hit);
    if (!this.pendingBuild) {
      console.log('[Settlement] No pending build');
      return;
    }
    const { kind, cost } = this.pendingBuild;
    const gs = this.liveGameState ?? clientState.gameState;
    const pid = this.livePlayerId;
    if (!gs || !pid) {
      console.log('[Settlement] Missing gameState or playerId');
      return;
    }
    const p0 = gs.playersById[pid];
    if (!p0 || !canAffordCost(p0.resources, cost)) {
      console.log('[Settlement] Cannot afford or player missing:', { canAfford: p0 ? canAffordCost(p0.resources, cost) : false, playerExists: !!p0 });
      this.refreshPlayerUi();
      return;
    }

    const roomId = getLobbySession()?.roomId ?? null;
    if (!roomId) {
      return;
    }

    if (kind === 'SETTLEMENT' || kind === 'CITY') {
      if (!hit.vertex) {
        return;
      }
      this.pendingBuild = null;
      this.dismissBuildRecipePopover();
      void buildStructure({
        gameId: roomId,
        kind,
        vertexId: hit.vertex.id,
      }).then(() => {
        playBuildPlacementSound(kind);
      }).catch((error) => {
        console.error('Structure build failed:', error);
      });
      return;
    }

    if (!hit.edge) {
      return;
    }

    this.pendingBuild = null;
    this.dismissBuildRecipePopover();
    void buildStructure({
      gameId: roomId,
      kind,
      edgeId: hit.edge.id,
    }).then(() => {
      playBuildPlacementSound(kind);
    }).catch((error) => {
      console.error('Structure build failed:', error);
    });
  }

  private updateMapDisplay(): void {
    if (!this.mapScreen) return;
    
    const gameState = this.liveGameState ?? clientState.gameState;
    if (!gameState) return;
    
    const structures = Object.values(gameState.board.structuresById);
    const pendingBuildKind = this.pendingBuild?.kind === 'SETTLEMENT' ? 'SETTLEMENT' : this.pendingBuild?.kind === 'CITY' ? 'CITY' : this.pendingBuild?.kind === 'ROAD' ? 'ROAD' : null;
    const pid = this.livePlayerId;
    const roadHoverColor =
      pendingBuildKind === 'ROAD' && pid && gameState.playersById[pid]?.color
        ? gameState.playersById[pid].color
        : undefined;

    const scene = this.mapScreen.getPhaser3Scene?.();
    if (scene) {
      scene.updateMap(
        pendingBuildKind,
        structures.map(s => ({
          type: s.type as 'SETTLEMENT' | 'CITY' | 'ROAD',
          ownerColor: s.ownerColor,
          vertex: s.vertex,
          edge: s.edge,
        })),
        roadHoverColor,
      );
    }
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
    const lastDiceRollRaw = liveValues?.lastDiceRoll ?? gameState?.turn.lastDiceRoll;
    const lastDiceRollObj = this.asDiceRoll(lastDiceRollRaw);

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

    if (this.expectingLocalDiceAck && lastDiceRollObj && this.diceRollTicker !== null) {
      this.completeLocalDiceRoll(lastDiceRollObj);
    }

    if (this.diceHud && this.diceRollTicker === null) {
      this.syncDiceHudFromRollData(lastDiceRollRaw);
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
    if (this.bankTradeButton) {
      const canBankTrade =
        Boolean(isActivePlayer && currentPhase === 'ACTION') &&
        this.canCurrentPlayerUseSelectedBankTrade();

      this.bankTradeButton.textContent =
        `Trade 4 ${RESOURCE_LABELS[this.bankGiveSelection]} → 1 ${RESOURCE_LABELS[this.bankReceiveSelection]}`;

      this.bankTradeButton.disabled = !canBankTrade;
      this.bankTradeButton.style.opacity = this.bankTradeButton.disabled ? '0.55' : '1';
      this.bankTradeButton.style.cursor = this.bankTradeButton.disabled ? 'not-allowed' : 'pointer';
    }
    this.updateTurnTimerUi();
  }

  private asDiceRoll(raw: unknown): DiceRoll | null {
    if (raw && typeof raw === 'object' && 'd1Val' in raw && 'd2Val' in raw && 'sum' in raw) {
      return raw as DiceRoll;
    }
    return null;
  }

  private syncDiceHudFromRollData(lastDiceRoll: DiceRoll | string | null | undefined): void {
    if (!this.diceHud) {
      return;
    }
    if (typeof lastDiceRoll === 'string') {
      this.diceHud.setFromStringMessage(lastDiceRoll);
      return;
    }
    if (lastDiceRoll) {
      this.diceHud.setFromRoll(lastDiceRoll);
      return;
    }
    this.diceHud.setPlaceholder(this.fallbackLastDiceRoll);
  }

  private startLocalDiceRollAnimation(): void {
    if (this.diceRollTicker !== null) {
      return;
    }
    if (this.diceCompleteDelayTimer !== null) {
      clearTimeout(this.diceCompleteDelayTimer);
      this.diceCompleteDelayTimer = null;
    }
    this.expectingLocalDiceAck = true;
    this.localDiceRollStartedAt = Date.now();
    playDiceRollSound();
    this.diceHud?.setRollingShake(true);
    this.diceHud?.setRandomRollingFrame();
    this.diceRollTicker = window.setInterval(() => {
      this.diceHud?.setRandomRollingFrame();
    }, 72);
    this.diceFailSafeTimer = window.setTimeout(() => {
      this.cancelLocalDiceRollAnimation();
    }, 5000);
  }

  private completeLocalDiceRoll(roll: DiceRoll): void {
    const startedAt = this.localDiceRollStartedAt;
    if (startedAt !== null) {
      const elapsedMs = Date.now() - startedAt;
      const remainingMs = Math.max(0, 1000 - elapsedMs);
      if (remainingMs > 0) {
        if (this.diceCompleteDelayTimer === null) {
          this.diceCompleteDelayTimer = window.setTimeout(() => {
            this.diceCompleteDelayTimer = null;
            this.completeLocalDiceRoll(roll);
          }, remainingMs);
        }
        return;
      }
    }
    if (this.diceRollTicker !== null) {
      clearInterval(this.diceRollTicker);
      this.diceRollTicker = null;
    }
    if (this.diceFailSafeTimer !== null) {
      clearTimeout(this.diceFailSafeTimer);
      this.diceFailSafeTimer = null;
    }
    this.localDiceRollStartedAt = null;
    this.expectingLocalDiceAck = false;
    this.diceHud?.setRollingShake(false);
    this.diceHud?.setFromRoll(roll);
    this.diceHud?.playSettle();
  }

  private cancelLocalDiceRollAnimation(): void {
    if (this.diceRollTicker !== null) {
      clearInterval(this.diceRollTicker);
      this.diceRollTicker = null;
    }
    if (this.diceFailSafeTimer !== null) {
      clearTimeout(this.diceFailSafeTimer);
      this.diceFailSafeTimer = null;
    }
    if (this.diceCompleteDelayTimer !== null) {
      clearTimeout(this.diceCompleteDelayTimer);
      this.diceCompleteDelayTimer = null;
    }
    this.localDiceRollStartedAt = null;
    this.expectingLocalDiceAck = false;
    this.diceHud?.setRollingShake(false);
    const gameState = this.liveGameState;
    const liveValues = this.turnHudBindings?.getValues?.() ?? null;
    const lastDiceRollRaw = liveValues?.lastDiceRoll ?? gameState?.turn.lastDiceRoll;
    this.syncDiceHudFromRollData(lastDiceRollRaw);
  }

  private handleRollDiceClick(): void {
    if (this.turnHudBindings?.onRollDice) {
      this.startLocalDiceRollAnimation();
      this.turnHudBindings.onRollDice();
      this.updateTurnHud();
      return;
    }
    const roomId = getLobbySession()?.roomId ?? null;
    if (roomId) {
      this.startLocalDiceRollAnimation();
      void rollDice(roomId);
    }
  }

  private refreshBankTradeUi(): void {
    RESOURCE_KEYS.forEach((key) => {
      const giveBtn = this.bankGiveButtons[key];
      if (giveBtn) {
        giveBtn.style.outline = this.bankGiveSelection === key ? '2px solid #22c55e' : 'none';
        giveBtn.style.outlineOffset = '1px';
        giveBtn.style.opacity = '1';
      }

      const receiveBtn = this.bankReceiveButtons[key];
      if (receiveBtn) {
        receiveBtn.style.outline = this.bankReceiveSelection === key ? '2px solid #22c55e' : 'none';
        receiveBtn.style.outlineOffset = '1px';
        receiveBtn.style.opacity = '1';
      }
    });

    if (this.bankTradeButton) {
      this.bankTradeButton.textContent =
        `Trade 4 ${RESOURCE_LABELS[this.bankGiveSelection]} → 1 ${RESOURCE_LABELS[this.bankReceiveSelection]}`;
    }
  }

  private canCurrentPlayerUseSelectedBankTrade(): boolean {
    const gs = this.liveGameState ?? clientState.gameState;
    const pid = this.livePlayerId;
    if (!gs || !pid) {
      return false;
    }

    const player = gs.playersById[pid];
    if (!player) {
      return false;
    }

    if (this.bankGiveSelection === this.bankReceiveSelection) {
      return false;
    }

    return inventoryCount(player.resources[this.bankGiveSelection]) >= 4;
  }
  
  private handleBankTradeClick(): void {
    const roomId = getLobbySession()?.roomId ?? null;
    if (!roomId) {
      return;
    }

    if (this.bankGiveSelection === this.bankReceiveSelection) {
      console.error('Bank trade failed: give and receive resource cannot be the same.');
      return;
    }

    const gs = this.liveGameState ?? clientState.gameState;
    const pid = this.livePlayerId;
    if (!gs || !pid) {
      return;
    }

    const player = gs.playersById[pid];
    if (!player) {
      return;
    }

    if (inventoryCount(player.resources[this.bankGiveSelection]) < 4) {
      console.error(`Bank trade failed: need at least 4 ${RESOURCE_LABELS[this.bankGiveSelection]}.`);
      return;
    }

    void bankTrade({
      gameId: roomId,
      giveResource: this.bankGiveSelection,
      receiveResource: this.bankReceiveSelection,
    }).catch((error) => {
      console.error('Bank trade failed:', error);
    });
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

  private toggleGameSettingsPanel(): void {
    if (!this.gameSettingsBackdrop || this.gameSettingsBackdrop.style.display === 'none') {
      this.openGameSettingsPanel();
    } else {
      this.closeGameSettingsPanel();
    }
  }

  private openGameSettingsPanel(): void {
    this.ensureGameSettingsPanel();
    if (!this.gameSettingsBackdrop) {
      return;
    }
    this.syncGameSettingsPanelSliders();
    this.gameSettingsBackdrop.style.display = 'flex';
    this.bindGameSettingsKeydown();
  }

  private closeGameSettingsPanel(): void {
    if (this.gameSettingsBackdrop) {
      this.gameSettingsBackdrop.style.display = 'none';
    }
    this.unbindGameSettingsKeydown();
  }

  private bindGameSettingsKeydown(): void {
    if (this.gameSettingsKeydown) {
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        this.closeGameSettingsPanel();
      }
    };
    document.addEventListener('keydown', onKey);
    this.gameSettingsKeydown = onKey;
  }

  private unbindGameSettingsKeydown(): void {
    if (this.gameSettingsKeydown) {
      document.removeEventListener('keydown', this.gameSettingsKeydown);
      this.gameSettingsKeydown = null;
    }
  }

  private syncGameSettingsPanelSliders(): void {
    const s = loadSettings();
    if (this.gameSettingsBoardMusicRange) {
      this.gameSettingsBoardMusicRange.value = String(s.boardMusicVolume);
    }
    if (this.gameSettingsBoardMusicValueEl) {
      this.gameSettingsBoardMusicValueEl.textContent = `${s.boardMusicVolume}%`;
    }
    if (this.gameSettingsGameSfxRange) {
      this.gameSettingsGameSfxRange.value = String(s.gameSfxVolume);
    }
    if (this.gameSettingsGameSfxValueEl) {
      this.gameSettingsGameSfxValueEl.textContent = `${s.gameSfxVolume}%`;
    }
  }

  private applyGameSettingsPartial(partial: Partial<GameSettings>): void {
    saveSettings({ ...loadSettings(), ...partial });
  }

  private ensureGameSettingsPanel(): void {
    if (this.gameSettingsBackdrop) {
      return;
    }

    const backdrop = document.createElement('div');
    backdrop.style.display = 'none';
    backdrop.style.position = 'fixed';
    backdrop.style.inset = '0';
    backdrop.style.zIndex = '100';
    backdrop.style.background = 'rgba(15, 23, 42, 0.65)';
    backdrop.style.alignItems = 'center';
    backdrop.style.justifyContent = 'center';
    backdrop.style.padding = '16px';

    const panel = document.createElement('div');
    panel.className = 'font-hexahaven-ui';
    panel.style.maxWidth = '380px';
    panel.style.width = '100%';
    panel.style.background = 'rgba(15, 23, 42, 0.96)';
    panel.style.border = '1px solid rgba(255, 255, 255, 0.25)';
    panel.style.borderRadius = '12px';
    panel.style.padding = '20px';
    panel.style.boxShadow = '0 20px 50px rgba(0,0,0,0.45)';
    panel.addEventListener('click', (e) => e.stopPropagation());

    const title = document.createElement('h2');
    title.style.margin = '0 0 12px 0';
    title.style.fontSize = '18px';
    title.style.fontWeight = '700';
    title.style.color = '#ffffff';
    title.textContent = 'Audio';

    const row1 = this.createGameSettingsSliderRow('Board music', (range, valueEl) => {
      this.gameSettingsBoardMusicRange = range;
      this.gameSettingsBoardMusicValueEl = valueEl;
      range.addEventListener('input', () => {
        const v = Math.max(0, Math.min(100, Math.round(Number(range.value))));
        valueEl.textContent = `${v}%`;
        this.applyGameSettingsPartial({ boardMusicVolume: v });
      });
    });

    const row2 = this.createGameSettingsSliderRow('Game sounds', (range, valueEl) => {
      this.gameSettingsGameSfxRange = range;
      this.gameSettingsGameSfxValueEl = valueEl;
      range.addEventListener('input', () => {
        const v = Math.max(0, Math.min(100, Math.round(Number(range.value))));
        valueEl.textContent = `${v}%`;
        this.applyGameSettingsPartial({ gameSfxVolume: v });
      });
    });

    const closeRow = document.createElement('div');
    closeRow.style.marginTop = '16px';
    closeRow.style.display = 'flex';
    closeRow.style.justifyContent = 'flex-end';

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.textContent = 'Done';
    closeBtn.style.padding = '8px 16px';
    closeBtn.style.fontSize = '14px';
    closeBtn.style.fontWeight = '600';
    closeBtn.style.color = '#ffffff';
    closeBtn.style.background = 'rgba(51, 65, 85, 0.95)';
    closeBtn.style.border = '1px solid rgba(255, 255, 255, 0.35)';
    closeBtn.style.borderRadius = '8px';
    closeBtn.style.cursor = 'pointer';
    closeBtn.addEventListener('click', () => this.closeGameSettingsPanel());

    closeRow.appendChild(closeBtn);

    panel.appendChild(title);
    panel.appendChild(row1);
    panel.appendChild(row2);
    panel.appendChild(closeRow);

    backdrop.appendChild(panel);
    backdrop.addEventListener('click', () => this.closeGameSettingsPanel());

    document.body.appendChild(backdrop);
    this.gameSettingsBackdrop = backdrop;
  }

  private createGameSettingsSliderRow(
    label: string,
    wire: (range: HTMLInputElement, valueEl: HTMLElement) => void,
  ): HTMLElement {
    const wrap = document.createElement('div');
    wrap.style.marginBottom = '12px';

    const top = document.createElement('div');
    top.style.display = 'flex';
    top.style.justifyContent = 'space-between';
    top.style.alignItems = 'baseline';
    top.style.marginBottom = '6px';

    const lab = document.createElement('span');
    lab.style.fontSize = '13px';
    lab.style.fontWeight = '600';
    lab.style.color = '#fde68a';
    lab.textContent = label;

    const valueEl = document.createElement('span');
    valueEl.style.fontSize = '13px';
    valueEl.style.color = '#e2e8f0';
    valueEl.textContent = '100%';

    top.appendChild(lab);
    top.appendChild(valueEl);

    const range = document.createElement('input');
    range.type = 'range';
    range.min = '0';
    range.max = '100';
    range.step = '5';
    range.setAttribute('aria-label', label);
    range.className = 'w-full h-2 cursor-pointer accent-sky-500 rounded-full bg-slate-700/80';
    range.style.width = '100%';

    wire(range, valueEl);

    wrap.appendChild(top);
    wrap.appendChild(range);
    return wrap;
  }

  destroy(): void {
    this.dismissBuildRecipePopover();
    this.closeGameSettingsPanel();
    if (this.gameSettingsBackdrop) {
      this.gameSettingsBackdrop.remove();
      this.gameSettingsBackdrop = null;
    }
    this.gameSettingsBoardMusicRange = null;
    this.gameSettingsBoardMusicValueEl = null;
    this.gameSettingsGameSfxRange = null;
    this.gameSettingsGameSfxValueEl = null;
    window.removeEventListener(SETTINGS_CHANGED_EVENT, this.onSettingsChanged);
    this.stopBackgroundMusic();
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    if (this.topRightContainer) {
      this.topRightContainer.remove();
      this.topRightContainer = null;
    }
    this.exitButton = null;
    this.settingsButton = null;
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
    this.cancelLocalDiceRollAnimation();
    this.stopTurnTimerTicker();
    if (this.diceHudPanel) {
      this.diceHudPanel.remove();
      this.diceHudPanel = null;
    }
    if (this.turnHudPanel) {
      this.turnHudPanel.remove();
      this.turnHudPanel = null;
    }
    this.currentPlayerValue = null;
    this.currentPhaseValue = null;
    this.turnTimerValue = null;
    this.diceHud = null;
    this.rollDiceButton = null;
    this.endTurnButton = null;
    this.bankTradeButton = null;
    this.bankGiveButtons = {};
    this.bankReceiveButtons = {};
    this.bankGiveSelection = 'EMBER';
    this.bankReceiveSelection = 'STONE';
    this.buttonContainer = null;
    if (this.chatPanel) {
      this.chatPanel.remove();
      this.chatPanel = null;
    }
    this.chatMessagesContainer = null;
    this.chatInput = null;
    this.mapScreen?.destroy();
    this.mapScreen = null;
    this.liveGameState = null;
    this.livePlayerId = null;
    this.pendingBuild = null;
    this.resourceSelection = emptyResourceBundle();
  }
}
