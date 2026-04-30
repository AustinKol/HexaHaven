import { playBuildPlacementSound, playDiceRollSound, playVictoryFanfareSound } from '../audio/buildSounds';
import { BASE_GAME_BOARD_MUSIC_VOLUME, scaledBoardMusicVolume } from '../audio/musicVolume';
import { ClientEnv } from '../config/env';
import { BUILD_COSTS } from '../../shared/buildRules';
import { SERVER_EVENTS } from '../../shared/constants/socketEvents';
import { loadSettings, saveSettings, SETTINGS_CHANGED_EVENT, type GameSettings } from '../settings/gameSettings';
import { ScreenId } from '../../shared/constants/screenIds';
import type { ActionRejectedEvent, PlayerTradeRequest, PlayerTradeRequestUpdateEvent } from '../../shared/types/socket';
import type { DiceRoll, GamePhase, GameState, ResourceBundle } from '../../shared/types/domain';
import {
  bankTrade,
  buildStructure,
  connectSocket,
  disconnectSocket,
  endTurn,
  getSocket,
  hydrateSession,
  respondPlayerTradeRequest,
  rollDice,
  sendChatMessage,
  sendPlayerTradeRequest,
} from '../networking/socketClient';
import { clientState, resetClientState, subscribeClientState } from '../state/clientState';
import { clearLobbySession, getLobbySession } from '../state/lobbyState';

import { TestMapGenScreen, type MapPointerHit } from './TestMapGenScreen';
import { createDiceHud, type DiceHud } from '../ui/diceRollDisplay';


type ResourceKey = keyof ResourceBundle;

/** Bottom bar + UI reserved for Phaser (taller bar needs more clearance). */
const GAME_BOARD_BOTTOM_BAR_PX = 84;
/** ~0.5cm at 96dpi — extra inset so the map sits slightly higher. */
const GAME_BOARD_MAP_LIFT_PX = 20;
const FIXED_TURN_TIME_SECONDS = 30;
const TURN_TIMER_WARNING_SECONDS = 15;
const CLIENT_WIN_VP_FALLBACK = 10;
const TUTORIAL_MODE_STORAGE_KEY = 'hexahaven.tutorialModeEnabled';
const YOUR_TURN_TOAST_MS = 3000;
const PLAYER_TRADE_REQUEST_TTL_MS = 10_000;
const TRADE_NOTICE_MS = 3200;
const TRADE_PANEL_CHAT_GUARD_PX = 190;

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

function normalizeRejectedMessage(message: string): string {
  return message.trim().toLowerCase();
}

function toFriendlyBuildRejectionMessage(
  rejection: Pick<ActionRejectedEvent, 'code' | 'message'>,
): string {
  const msg = normalizeRejectedMessage(rejection.message);
  if (msg.includes('two roads apart') || msg.includes('distance')) {
    return 'Illegal move! Settlements must be at least two roads apart.';
  }
  if (msg.includes('already occupied')) {
    return 'Illegal move! That spot is already occupied.';
  }
  if (msg.includes('road must connect') || msg.includes('connect to one of your existing roads or structures')) {
    return 'Illegal move! Roads must connect to your existing road or settlement.';
  }
  if (msg.includes('settlements must connect to one of your existing roads')) {
    return 'Illegal move! Settlements must connect to your road network.';
  }
  if (rejection.code === 'INSUFFICIENT_RESOURCES' || msg.includes('insufficient resources') || msg.includes('need ')) {
    return 'Not enough resources to build that.';
  }
  if (rejection.code === 'NOT_ACTIVE_PLAYER' || msg.includes('active player') || msg.includes('your turn')) {
    return 'You can only build during your turn.';
  }
  if (
    rejection.code === 'INVALID_PHASE'
    || msg.includes('action phase')
    || msg.includes('after rolling')
    || msg.includes('builds are only allowed during the action phase')
  ) {
    return 'You can only build after rolling.';
  }
  return 'Illegal move! You cannot build there.';
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

function pickMessage(messages: readonly string[], seed: string): string {
  if (messages.length === 0) {
    return '';
  }
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = ((hash << 5) - hash + seed.charCodeAt(i)) | 0;
  }
  const index = Math.abs(hash) % messages.length;
  return messages[index] ?? messages[0];
}

function emptyResourceBundle(): ResourceBundle {
  return { CRYSTAL: 0, STONE: 0, BLOOM: 0, EMBER: 0, GOLD: 0 };
}

function resourceBundleTotal(bundle: ResourceBundle): number {
  return RESOURCE_KEYS.reduce((sum, key) => sum + inventoryCount(bundle[key]), 0);
}

function hasRequiredResources(available: ResourceBundle, required: ResourceBundle): boolean {
  return RESOURCE_KEYS.every((key) => inventoryCount(available[key]) >= inventoryCount(required[key]));
}

function isEmptyResourceBundle(bundle: ResourceBundle): boolean {
  return resourceBundleTotal(bundle) <= 0;
}

/** Whole-number counts only (no decimals in UI or inventory math). */
function inventoryCount(n: unknown): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? n : 0;
  return Math.max(0, Math.floor(v));
}

type BuildKind = 'ROAD' | 'SETTLEMENT' | 'CITY';
type TutorialTarget = 'ROLL' | 'SETTLEMENT' | 'ROAD' | 'CITY' | 'BANK_TRADE' | 'END_TURN';
type TutorialPlacement = 'above' | 'below';
type TradePanelTab = 'BANK' | 'PLAYER';
type TradeNoticeTone = 'info' | 'success' | 'error';

interface TutorialPrompt {
  key: string;
  target: TutorialTarget;
  message: string;
  placement: TutorialPlacement;
}

const ROLL_TUTORIAL_MESSAGES = [
  'Roll the dice!',
  'Start your turn by rolling.',
  'Roll to collect resources.',
];

const SETTLEMENT_TUTORIAL_MESSAGES = [
  'Build a settlement to earn more resources.',
  'Place a house on a valid corner.',
  'Settlements must be spaced apart, so choose carefully.',
];

const ROAD_TUTORIAL_MESSAGES = [
  'Build roads to expand your territory.',
  'Roads help you reach new settlement spots.',
];

const CITY_TUTORIAL_MESSAGES = [
  'Upgrade a settlement into a city for stronger payouts.',
  'Cities collect more resources from nearby tiles.',
];

const BANK_TRADE_TUTORIAL_MESSAGES = [
  'Missing resources? Trade with the bank.',
  'You can trade 4 of one resource for 1 you need.',
  'Use bank trade to fix your resource hand.',
];

const END_TURN_TUTORIAL_MESSAGES = [
  'No strong moves? End your turn.',
  'You can pass the turn when you are done.',
  'End your turn to keep the game moving.',
];

const YOUR_TURN_MESSAGES = [
  "It's your turn! Roll the dice.",
  'Your turn! Start by rolling.',
  "You're up! Roll to collect resources.",
];

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
  private navigateToScreen: ((screenId: ScreenId) => void) | null = null;
  private mapScreen: TestMapGenScreen | null = null;
  private readonly backgroundMusic = new Audio('/audio/game-board-theme.mp3');
  private exitButton: HTMLButtonElement | null = null;
  private musicToggleButton: HTMLButtonElement | null = null;
  private settingsButton: HTMLButtonElement | null = null;
  private tutorialToggleButton: HTMLButtonElement | null = null;
  private tutorialModeEnabled = true;
  private gameSettingsBackdrop: HTMLDivElement | null = null;
  private gameSettingsBoardMusicRange: HTMLInputElement | null = null;
  private gameSettingsBoardMusicValueEl: HTMLElement | null = null;
  private gameSettingsGameSfxRange: HTMLInputElement | null = null;
  private gameSettingsGameSfxValueEl: HTMLElement | null = null;
  private gameSettingsKeydown: ((e: KeyboardEvent) => void) | null = null;
  private gameRulesBackdrop: HTMLDivElement | null = null;
  private gameRulesKeydown: ((e: KeyboardEvent) => void) | null = null;
  private winnerBackdrop: HTMLDivElement | null = null;
  private winnerKeydown: ((e: KeyboardEvent) => void) | null = null;
  private lastAnnouncedWinnerPlayerId: string | null = null;
  private isGameOver = false;
  private buildRejectToastEl: HTMLDivElement | null = null;
  private buildRejectToastTextEl: HTMLDivElement | null = null;
  private buildRejectToastHideTimer: number | null = null;
  private buildRejectToastCleanupTimer: number | null = null;
  private yourTurnToastEl: HTMLDivElement | null = null;
  private yourTurnToastTextEl: HTMLDivElement | null = null;
  private yourTurnToastHideTimer: number | null = null;
  private yourTurnToastCleanupTimer: number | null = null;
  private lastYourTurnToastKey: string | null = null;
  private tutorialOverlayEl: HTMLDivElement | null = null;
  private tutorialPromptEl: HTMLDivElement | null = null;
  private tutorialPromptArrowEl: HTMLDivElement | null = null;
  private tutorialPromptBubbleEl: HTMLDivElement | null = null;
  private tutorialPromptBubbleTextEl: HTMLDivElement | null = null;
  private tutorialPromptCleanupTimer: number | null = null;
  private shownTutorialPromptKey: string | null = null;
  private shownTutorialPromptTarget: TutorialTarget | null = null;
  private dismissedTutorialPromptKey: string | null = null;
  private lastRejectedBuildToastKey: string | null = null;
  private lastBuildAttemptedAtMs = 0;
  private awaitingBuildAck = false;
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
  private autoEndTurnRequestedKey: string | null = null;
  private diceHud: DiceHud | null = null;
  /** Local roll: waiting for server `lastDiceRoll` after clicking Roll. */
  private expectingLocalDiceAck = false;
  private diceRollTicker: number | null = null;
  private diceFailSafeTimer: number | null = null;
  private diceCompleteDelayTimer: number | null = null;
  private localDiceRollStartedAt: number | null = null;
  private rollDiceButton: HTMLButtonElement | null = null;
  private buildButtons: Partial<Record<BuildKind, HTMLButtonElement>> = {};
  private chatPanel: HTMLDivElement | null = null;
  private chatMessagesContainer: HTMLDivElement | null = null;
  private chatInput: HTMLInputElement | null = null;
  private statusChatLog: { timestampMs: number; text: string; activePlayerId: string | null }[] = [];
  private lastStatusLogKey: string | null = null;
  private bankTradeButton: HTMLButtonElement | null = null;
  private endTurnButton: HTMLButtonElement | null = null;
  private bankGiveSelection: ResourceKey = 'EMBER';
  private bankReceiveSelection: ResourceKey = 'STONE';
  private bankGiveButtons: Partial<Record<ResourceKey, HTMLButtonElement>> = {};
  private bankReceiveButtons: Partial<Record<ResourceKey, HTMLButtonElement>> = {};
  private tradePanelTab: TradePanelTab = 'BANK';
  private tradeTabsBankButton: HTMLButtonElement | null = null;
  private tradeTabsPlayerButton: HTMLButtonElement | null = null;
  private tradeBankContent: HTMLDivElement | null = null;
  private tradePlayerContent: HTMLDivElement | null = null;
  private tradePlayerBody: HTMLDivElement | null = null;
  private tradeNoticeEl: HTMLDivElement | null = null;
  private tradeNoticeHideTimer: number | null = null;
  private playerTradeTargetPlayerId: string | null = null;
  private playerTradeOfferSelection: ResourceBundle = emptyResourceBundle();
  private playerTradeRequestSelection: ResourceBundle = emptyResourceBundle();
  private pendingOutgoingTradeIds = new Set<string>();
  private isSendingPlayerTradeRequest = false;
  private tradeEventSocket: ReturnType<typeof getSocket> = null;
  private incomingTradeRequest: PlayerTradeRequest | null = null;
  private incomingTradeCard: HTMLDivElement | null = null;
  private incomingTradeSenderTextEl: HTMLDivElement | null = null;
  private incomingTradeOfferTextEl: HTMLDivElement | null = null;
  private incomingTradeRequestTextEl: HTMLDivElement | null = null;
  private incomingTradeProgressFillEl: HTMLDivElement | null = null;
  private incomingTradeAcceptButton: HTMLButtonElement | null = null;
  private incomingTradeDenyButton: HTMLButtonElement | null = null;
  private incomingTradeCountdownTimer: number | null = null;
  private isRespondingToTradeRequest = false;
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
  private lastRenderedResourceCounts: Partial<Record<ResourceKey, number>> | null = null;
  private resourceFxLayer: HTMLDivElement | null = null;
  private activeResourceFxTimers: number[] = [];
  private pendingResourceBarPops: ResourceKey[] = [];
  private fallbackLastDiceRoll = '';
  private readonly onWindowResize = (): void => {
    this.repositionYourTurnToast();
    this.repositionTutorialPrompt();
    this.repositionIncomingTradeCard();
  };
  private readonly onSettingsChanged = (): void => {
    this.backgroundMusic.volume = scaledBoardMusicVolume(BASE_GAME_BOARD_MUSIC_VOLUME);
    this.syncGameSettingsPanelSliders();
  };
  private readonly onPlayerTradeRequestReceived = (tradeRequest: PlayerTradeRequest): void => {
    this.handlePlayerTradeRequestReceived(tradeRequest);
  };
  private readonly onPlayerTradeRequestUpdated = (event: PlayerTradeRequestUpdateEvent): void => {
    this.handlePlayerTradeRequestUpdated(event);
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
      this.autoEndTurnRequestedKey = null;
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

    // Client-side fallback: ensure timeout hands off turn once at 00:00.
    if (remainingMs === 0 && turnKey && turnKey !== this.autoEndTurnRequestedKey) {
      const isActivePlayer = Boolean(activePlayerId && this.livePlayerId && activePlayerId === this.livePlayerId);
      const canAutoEndTurn = Boolean(
        isActivePlayer
        && gameState?.turn.phase === 'ACTION'
        && gameState.turn.lastDiceRoll !== null,
      );
      if (canAutoEndTurn) {
        this.autoEndTurnRequestedKey = turnKey;
        this.handleEndTurnClick();
      }
    }
  }

  constructor() {
    this.tutorialModeEnabled = this.loadTutorialModePreference();
    this.backgroundMusic.loop = true;
    this.onSettingsChanged();
  }

  setTurnHudBindings(bindings: GameBoardTurnHudBindings | null): void {
    this.turnHudBindings = bindings;
    this.updateTurnHud();
  }

  private loadTutorialModePreference(): boolean {
    try {
      const raw = window.localStorage.getItem(TUTORIAL_MODE_STORAGE_KEY);
      if (raw === null) {
        return true;
      }
      return raw !== 'off';
    } catch {
      return true;
    }
  }

  private persistTutorialModePreference(): void {
    try {
      window.localStorage.setItem(TUTORIAL_MODE_STORAGE_KEY, this.tutorialModeEnabled ? 'on' : 'off');
    } catch {
      // Storage access can fail in some embedded browser contexts.
    }
  }

  private syncTutorialToggleButtonUi(): void {
    if (!this.tutorialToggleButton) {
      return;
    }
    this.tutorialToggleButton.classList.toggle('is-enabled', this.tutorialModeEnabled);
    this.tutorialToggleButton.textContent = this.tutorialModeEnabled ? 'Guide On' : 'Guide Off';
    this.tutorialToggleButton.setAttribute(
      'aria-label',
      this.tutorialModeEnabled ? 'Turn tutorial guidance off' : 'Turn tutorial guidance on',
    );
    this.tutorialToggleButton.title = this.tutorialModeEnabled ? 'Tutorial guidance is on' : 'Tutorial guidance is off';
  }

  private setTutorialModeEnabled(enabled: boolean): void {
    if (this.tutorialModeEnabled === enabled) {
      return;
    }
    this.tutorialModeEnabled = enabled;
    this.persistTutorialModePreference();
    this.syncTutorialToggleButtonUi();
    if (!enabled) {
      this.hideTutorialPrompt();
      return;
    }
    this.dismissedTutorialPromptKey = null;
    this.syncTutorialPrompt();
  }

  render(parentElement: HTMLElement, onComplete?: () => void, navigate?: (screenId: ScreenId) => void): void {
    this.navigateToScreen = navigate ?? null;
    window.addEventListener(SETTINGS_CHANGED_EVENT, this.onSettingsChanged);
    window.addEventListener('resize', this.onWindowResize);
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
    this.ensureResourceFxLayer(this.buttonContainer);
    this.mountBuildRejectToast(this.buttonContainer);
    this.mountYourTurnToast(this.buttonContainer);
    this.mountTutorialOverlay(this.buttonContainer);
    this.mountPlayerPanel(this.buttonContainer);
    this.mountIncomingTradeCard(this.buttonContainer);
    this.mountTurnHud(this.buttonContainer);
    this.startTurnTimerTicker();
    this.mountChatPanel(this.buttonContainer);
    this.mountResourceBar(this.buttonContainer);
    if (roomId) {
      connectSocket({ gameId: roomId, playerId: session?.playerId });
      this.bindPlayerTradeSocketEvents();
      void hydrateSession(roomId).catch((error) => {
        console.error('Failed to hydrate game session:', error);
      });
      this.unsubscribe = subscribeClientState((state) => {
        console.log('[GameBoardScreen] Client state updated. Chat messages count:', state.gameState?.chatMessages?.length);
        const previousState = this.liveGameState;
        this.liveGameState = state.gameState;
        this.livePlayerId = state.playerId ?? this.livePlayerId;
        if (state.lastActionRejected) {
          this.handleRejectedBuildAction(state.lastActionRejected);
        }
        this.updateTurnHud();
        this.refreshPlayerUi();
        this.maybeHandleWinnerState(previousState, state.gameState);
        this.maybeAnimateResourceDistribution(previousState, state.gameState);
        this.maybeShowYourTurnToast(previousState, state.gameState);
        this.syncTutorialPrompt();
      });
    } else {
      this.unbindPlayerTradeSocketEvents();
      this.liveGameState = clientState.gameState;
      this.refreshPlayerUi();
      this.maybeHandleWinnerState(null, this.liveGameState);
      this.maybeShowYourTurnToast(null, this.liveGameState);
      this.syncTutorialPrompt();
    }

    if (!this.navigateToScreen) {
      return;
    }

    const topRight = document.createElement('div');
    topRight.style.position = 'absolute';
    topRight.style.top = '16px';
    topRight.style.right = '16px';
    topRight.style.zIndex = '3';
    topRight.style.display = 'flex';
    topRight.style.flexDirection = 'row';
    topRight.style.alignItems = 'center';
    topRight.style.gap = '8px';

    this.tutorialToggleButton = document.createElement('button');
    this.tutorialToggleButton.type = 'button';
    this.tutorialToggleButton.className = 'hexahaven-tutorial-toggle font-hexahaven-ui';
    this.tutorialToggleButton.style.height = '40px';
    this.tutorialToggleButton.style.padding = '0 10px';
    this.tutorialToggleButton.style.fontSize = '11px';
    this.tutorialToggleButton.style.fontWeight = '600';
    this.tutorialToggleButton.style.borderRadius = '8px';
    this.tutorialToggleButton.style.cursor = 'pointer';
    this.tutorialToggleButton.addEventListener('click', () => {
      this.setTutorialModeEnabled(!this.tutorialModeEnabled);
    });
    this.syncTutorialToggleButtonUi();

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
      this.returnToMainMenu();
    });
    topRight.appendChild(this.tutorialToggleButton);
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
    this.syncTutorialPrompt();
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

  private mountIncomingTradeCard(parent: HTMLElement): void {
    if (this.incomingTradeCard) {
      this.incomingTradeCard.remove();
    }

    const card = document.createElement('div');
    card.className = 'hexahaven-incoming-trade-card';

    const title = document.createElement('div');
    title.className = 'hexahaven-incoming-trade-title';
    title.textContent = 'Incoming Trade';
    card.appendChild(title);

    const senderText = document.createElement('div');
    senderText.className = 'hexahaven-incoming-trade-sender';
    card.appendChild(senderText);

    const offerText = document.createElement('div');
    offerText.className = 'hexahaven-incoming-trade-line';
    card.appendChild(offerText);

    const requestText = document.createElement('div');
    requestText.className = 'hexahaven-incoming-trade-line';
    card.appendChild(requestText);

    const actions = document.createElement('div');
    actions.className = 'hexahaven-incoming-trade-actions';

    const acceptButton = document.createElement('button');
    acceptButton.type = 'button';
    acceptButton.className = 'hexahaven-incoming-trade-btn is-accept font-hexahaven-ui';
    acceptButton.textContent = 'Accept';
    acceptButton.addEventListener('click', () => {
      this.handleRespondToIncomingTrade('accepted');
    });

    const denyButton = document.createElement('button');
    denyButton.type = 'button';
    denyButton.className = 'hexahaven-incoming-trade-btn is-deny font-hexahaven-ui';
    denyButton.textContent = 'Deny';
    denyButton.addEventListener('click', () => {
      this.handleRespondToIncomingTrade('declined');
    });

    actions.appendChild(acceptButton);
    actions.appendChild(denyButton);
    card.appendChild(actions);

    const progress = document.createElement('div');
    progress.className = 'hexahaven-incoming-trade-progress';
    const fill = document.createElement('div');
    fill.className = 'hexahaven-incoming-trade-progress-fill';
    progress.appendChild(fill);
    card.appendChild(progress);

    this.incomingTradeCard = card;
    this.incomingTradeSenderTextEl = senderText;
    this.incomingTradeOfferTextEl = offerText;
    this.incomingTradeRequestTextEl = requestText;
    this.incomingTradeProgressFillEl = fill;
    this.incomingTradeAcceptButton = acceptButton;
    this.incomingTradeDenyButton = denyButton;
    parent.appendChild(card);
    this.refreshIncomingTradeCardUi();
    this.repositionIncomingTradeCard();
  }

  private mountBuildRejectToast(parent: HTMLElement): void {
    if (this.buildRejectToastEl) {
      this.buildRejectToastEl.remove();
    }
    const toast = document.createElement('div');
    toast.className = 'hexahaven-build-reject-toast';
    toast.style.bottom = `${GAME_BOARD_BOTTOM_BAR_PX + 14}px`;
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');

    const text = document.createElement('div');
    text.className = 'hexahaven-build-reject-toast-text';
    toast.appendChild(text);

    this.buildRejectToastEl = toast;
    this.buildRejectToastTextEl = text;
    parent.appendChild(toast);
  }

  private clearBuildRejectToastTimers(): void {
    if (this.buildRejectToastHideTimer !== null) {
      clearTimeout(this.buildRejectToastHideTimer);
      this.buildRejectToastHideTimer = null;
    }
    if (this.buildRejectToastCleanupTimer !== null) {
      clearTimeout(this.buildRejectToastCleanupTimer);
      this.buildRejectToastCleanupTimer = null;
    }
  }

  private showBuildRejectToast(message: string): void {
    if (!this.buildRejectToastEl || !this.buildRejectToastTextEl) {
      return;
    }
    this.clearBuildRejectToastTimers();
    this.buildRejectToastTextEl.textContent = message;
    this.buildRejectToastEl.classList.remove('is-hiding');
    this.buildRejectToastEl.classList.remove('is-visible');
    void this.buildRejectToastEl.offsetWidth;
    this.buildRejectToastEl.classList.add('is-visible');
    this.buildRejectToastHideTimer = window.setTimeout(() => {
      if (!this.buildRejectToastEl) {
        return;
      }
      this.buildRejectToastEl.classList.remove('is-visible');
      this.buildRejectToastEl.classList.add('is-hiding');
      this.buildRejectToastCleanupTimer = window.setTimeout(() => {
        this.buildRejectToastEl?.classList.remove('is-hiding');
        this.buildRejectToastCleanupTimer = null;
      }, 240);
      this.buildRejectToastHideTimer = null;
    }, 3000);
  }

  private mountYourTurnToast(parent: HTMLElement): void {
    if (this.yourTurnToastEl) {
      this.yourTurnToastEl.remove();
    }
    const toast = document.createElement('div');
    toast.className = 'hexahaven-your-turn-toast';
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');
    const text = document.createElement('div');
    text.className = 'hexahaven-your-turn-toast-text';
    toast.appendChild(text);
    this.yourTurnToastEl = toast;
    this.yourTurnToastTextEl = text;
    parent.appendChild(toast);
    this.repositionYourTurnToast();
  }

  private clearYourTurnToastTimers(): void {
    if (this.yourTurnToastHideTimer !== null) {
      clearTimeout(this.yourTurnToastHideTimer);
      this.yourTurnToastHideTimer = null;
    }
    if (this.yourTurnToastCleanupTimer !== null) {
      clearTimeout(this.yourTurnToastCleanupTimer);
      this.yourTurnToastCleanupTimer = null;
    }
  }

  private repositionYourTurnToast(): void {
    if (!this.yourTurnToastEl) {
      return;
    }
    const dicePanelHeight = this.diceHudPanel?.offsetHeight ?? 84;
    const bottomOffset = GAME_BOARD_BOTTOM_BAR_PX + Math.max(76, dicePanelHeight + 16);
    this.yourTurnToastEl.style.left = '16px';
    this.yourTurnToastEl.style.bottom = `${bottomOffset}px`;
  }

  private showYourTurnToast(message: string): void {
    if (!this.yourTurnToastEl || !this.yourTurnToastTextEl) {
      return;
    }
    this.clearYourTurnToastTimers();
    this.repositionYourTurnToast();
    this.yourTurnToastTextEl.textContent = message;
    this.yourTurnToastEl.classList.remove('is-hiding');
    this.yourTurnToastEl.classList.remove('is-visible');
    void this.yourTurnToastEl.offsetWidth;
    this.yourTurnToastEl.classList.add('is-visible');
    this.yourTurnToastHideTimer = window.setTimeout(() => {
      if (!this.yourTurnToastEl) {
        return;
      }
      this.yourTurnToastEl.classList.remove('is-visible');
      this.yourTurnToastEl.classList.add('is-hiding');
      this.yourTurnToastCleanupTimer = window.setTimeout(() => {
        this.yourTurnToastEl?.classList.remove('is-hiding');
        this.yourTurnToastCleanupTimer = null;
      }, 240);
      this.yourTurnToastHideTimer = null;
    }, YOUR_TURN_TOAST_MS);
  }

  private maybeShowYourTurnToast(previousState: GameState | null, nextState: GameState | null): void {
    const localPlayerId = this.livePlayerId;
    if (!nextState || !localPlayerId || localPlayerId === 'spectator') {
      return;
    }
    const activePlayerId = nextState.turn.currentPlayerId;
    if (!activePlayerId || activePlayerId !== localPlayerId) {
      return;
    }
    const toastKey = `${nextState.gameId}|${nextState.turn.currentTurn}|${activePlayerId}`;
    if (toastKey === this.lastYourTurnToastKey) {
      return;
    }
    const activeChangedToLocal = previousState?.turn.currentPlayerId !== localPlayerId;
    const turnChanged = previousState?.turn.currentTurn !== nextState.turn.currentTurn;
    const firstLocalState = previousState === null;
    if (!activeChangedToLocal && !turnChanged && !firstLocalState) {
      return;
    }
    this.lastYourTurnToastKey = toastKey;
    const messageSeed = `${toastKey}|your-turn`;
    this.showYourTurnToast(pickMessage(YOUR_TURN_MESSAGES, messageSeed));
  }

  private mountTutorialOverlay(parent: HTMLElement): void {
    if (this.tutorialOverlayEl) {
      this.tutorialOverlayEl.remove();
    }
    const overlay = document.createElement('div');
    overlay.className = 'hexahaven-tutorial-overlay';

    const prompt = document.createElement('div');
    prompt.className = 'hexahaven-tutorial-tip';

    const arrow = document.createElement('div');
    arrow.className = 'hexahaven-tutorial-arrow';

    const bubble = document.createElement('div');
    bubble.className = 'hexahaven-tutorial-bubble font-hexahaven-ui';

    const text = document.createElement('div');
    text.className = 'hexahaven-tutorial-bubble-text';

    bubble.appendChild(text);
    prompt.appendChild(arrow);
    prompt.appendChild(bubble);
    overlay.appendChild(prompt);
    parent.appendChild(overlay);

    this.tutorialOverlayEl = overlay;
    this.tutorialPromptEl = prompt;
    this.tutorialPromptArrowEl = arrow;
    this.tutorialPromptBubbleEl = bubble;
    this.tutorialPromptBubbleTextEl = text;
    this.hideTutorialPrompt();
  }

  private resolveTutorialAnchor(target: TutorialTarget): HTMLElement | null {
    switch (target) {
      case 'ROLL':
        return this.rollDiceButton;
      case 'SETTLEMENT':
        return this.buildButtons.SETTLEMENT ?? null;
      case 'ROAD':
        return this.buildButtons.ROAD ?? null;
      case 'CITY':
        return this.buildButtons.CITY ?? null;
      case 'BANK_TRADE':
        if (this.tradePanelTab !== 'BANK') {
          return null;
        }
        return this.bankTradeButton;
      case 'END_TURN':
        return this.endTurnButton;
      default:
        return null;
    }
  }

  private getTutorialPlacementForTarget(target: TutorialTarget, anchor: HTMLElement): TutorialPlacement {
    const rect = anchor.getBoundingClientRect();
    if (target === 'BANK_TRADE' || target === 'END_TURN') {
      return 'below';
    }
    if (rect.top < 120) {
      return 'below';
    }
    return 'above';
  }

  private hideTutorialPrompt(): void {
    if (!this.tutorialPromptEl) {
      return;
    }
    this.shownTutorialPromptKey = null;
    this.shownTutorialPromptTarget = null;
    const isVisible = this.tutorialPromptEl.classList.contains('is-visible');
    const isHiding = this.tutorialPromptEl.classList.contains('is-hiding');
    if (!isVisible && !isHiding) {
      return;
    }
    if (this.tutorialPromptCleanupTimer !== null) {
      clearTimeout(this.tutorialPromptCleanupTimer);
      this.tutorialPromptCleanupTimer = null;
    }
    this.tutorialPromptEl.classList.remove('is-visible');
    this.tutorialPromptEl.classList.add('is-hiding');
    this.tutorialPromptCleanupTimer = window.setTimeout(() => {
      this.tutorialPromptEl?.classList.remove('is-hiding');
      this.tutorialPromptCleanupTimer = null;
    }, 220);
  }

  private repositionTutorialPrompt(): void {
    if (
      !this.tutorialOverlayEl
      || !this.tutorialPromptEl
      || !this.shownTutorialPromptTarget
      || !this.shownTutorialPromptKey
    ) {
      return;
    }
    const anchor = this.resolveTutorialAnchor(this.shownTutorialPromptTarget);
    if (!anchor || !this.tutorialPromptBubbleEl || !this.tutorialPromptArrowEl) {
      this.hideTutorialPrompt();
      return;
    }
    const overlayRect = this.tutorialOverlayEl.getBoundingClientRect();
    const anchorRect = anchor.getBoundingClientRect();
    const placement = this.getTutorialPlacementForTarget(this.shownTutorialPromptTarget, anchor);
    this.tutorialPromptEl.dataset.placement = placement;

    const bubbleWidth = this.tutorialPromptBubbleEl.offsetWidth || 260;
    const bubbleHeight = this.tutorialPromptBubbleEl.offsetHeight || 52;
    const arrowSize = this.tutorialPromptArrowEl.offsetWidth || 16;
    const gap = 10;

    let left = anchorRect.left - overlayRect.left + (anchorRect.width / 2) - (bubbleWidth / 2);
    const maxLeft = overlayRect.width - bubbleWidth - 8;
    left = Math.max(8, Math.min(left, Math.max(8, maxLeft)));

    let top: number;
    if (placement === 'above') {
      top = anchorRect.top - overlayRect.top - bubbleHeight - arrowSize - gap;
    } else {
      top = anchorRect.bottom - overlayRect.top + arrowSize + gap;
    }
    const maxTop = overlayRect.height - bubbleHeight - arrowSize - 8;
    top = Math.max(8, Math.min(top, Math.max(8, maxTop)));

    this.tutorialPromptEl.style.left = `${left}px`;
    this.tutorialPromptEl.style.top = `${top}px`;
  }

  private showTutorialPrompt(prompt: TutorialPrompt): void {
    if (!this.tutorialPromptEl || !this.tutorialPromptBubbleTextEl) {
      return;
    }
    const anchor = this.resolveTutorialAnchor(prompt.target);
    if (!anchor) {
      this.hideTutorialPrompt();
      return;
    }
    if (this.tutorialPromptCleanupTimer !== null) {
      clearTimeout(this.tutorialPromptCleanupTimer);
      this.tutorialPromptCleanupTimer = null;
    }
    this.shownTutorialPromptKey = prompt.key;
    this.shownTutorialPromptTarget = prompt.target;
    this.tutorialPromptEl.dataset.placement = prompt.placement;
    this.tutorialPromptBubbleTextEl.textContent = prompt.message;
    this.tutorialPromptEl.classList.remove('is-hiding');
    this.tutorialPromptEl.classList.remove('is-visible');
    void this.tutorialPromptEl.offsetWidth;
    this.tutorialPromptEl.classList.add('is-visible');
    this.repositionTutorialPrompt();
  }

  private dismissTutorialPromptFromInteraction(target: TutorialTarget): void {
    if (!this.shownTutorialPromptKey || this.shownTutorialPromptTarget !== target) {
      return;
    }
    this.dismissedTutorialPromptKey = this.shownTutorialPromptKey;
    this.hideTutorialPrompt();
  }

  private canUseAnyBankTrade(resources: ResourceBundle): boolean {
    return RESOURCE_KEYS.some((key) => inventoryCount(resources[key]) >= 4);
  }

  private resolveTutorialPrompt(gameState: GameState | null, playerId: string | null): TutorialPrompt | null {
    if (!gameState || !playerId || playerId === 'spectator') {
      return null;
    }
    const activePlayerId = gameState.turn.currentPlayerId;
    const phase = gameState.turn.phase;
    if (!activePlayerId || activePlayerId !== playerId) {
      return null;
    }

    const player = gameState.playersById[playerId];
    if (!player) {
      return null;
    }

    const turnSeed = `${gameState.gameId}|${gameState.turn.currentTurn}|${phase ?? 'NONE'}|${playerId}`;
    const isRollPhase = phase === 'ROLL' && gameState.turn.lastDiceRoll === null;
    if (isRollPhase) {
      return {
        key: `${turnSeed}|ROLL`,
        target: 'ROLL',
        message: pickMessage(ROLL_TUTORIAL_MESSAGES, `${turnSeed}|ROLL`),
        placement: 'above',
      };
    }
    if (phase !== 'ACTION') {
      return null;
    }

    const canSettlement = canAffordCost(player.resources, BUILD_COSTS.SETTLEMENT);
    if (canSettlement) {
      return {
        key: `${turnSeed}|SETTLEMENT`,
        target: 'SETTLEMENT',
        message: pickMessage(SETTLEMENT_TUTORIAL_MESSAGES, `${turnSeed}|SETTLEMENT`),
        placement: 'above',
      };
    }
    const canRoad = canAffordCost(player.resources, BUILD_COSTS.ROAD);
    if (canRoad) {
      return {
        key: `${turnSeed}|ROAD`,
        target: 'ROAD',
        message: pickMessage(ROAD_TUTORIAL_MESSAGES, `${turnSeed}|ROAD`),
        placement: 'above',
      };
    }
    const canCity = canAffordCost(player.resources, BUILD_COSTS.CITY);
    if (canCity) {
      return {
        key: `${turnSeed}|CITY`,
        target: 'CITY',
        message: pickMessage(CITY_TUTORIAL_MESSAGES, `${turnSeed}|CITY`),
        placement: 'above',
      };
    }
    if (this.canUseAnyBankTrade(player.resources)) {
      return {
        key: `${turnSeed}|BANK_TRADE`,
        target: 'BANK_TRADE',
        message: pickMessage(BANK_TRADE_TUTORIAL_MESSAGES, `${turnSeed}|BANK_TRADE`),
        placement: 'below',
      };
    }
    return {
      key: `${turnSeed}|END_TURN`,
      target: 'END_TURN',
      message: pickMessage(END_TURN_TUTORIAL_MESSAGES, `${turnSeed}|END_TURN`),
      placement: 'below',
    };
  }

  private syncTutorialPrompt(): void {
    if (!this.tutorialModeEnabled) {
      this.hideTutorialPrompt();
      return;
    }
    const prompt = this.resolveTutorialPrompt(this.liveGameState, this.livePlayerId);
    const nextKey = prompt?.key ?? null;
    if (nextKey === null) {
      this.dismissedTutorialPromptKey = null;
      this.hideTutorialPrompt();
      return;
    }
    if (this.dismissedTutorialPromptKey && this.dismissedTutorialPromptKey !== nextKey) {
      this.dismissedTutorialPromptKey = null;
    }
    if (this.dismissedTutorialPromptKey === nextKey) {
      this.hideTutorialPrompt();
      return;
    }
    if (this.shownTutorialPromptKey === nextKey && this.shownTutorialPromptTarget === prompt?.target) {
      this.repositionTutorialPrompt();
      return;
    }
    if (prompt) {
      this.showTutorialPrompt(prompt);
    }
  }

  private handleRejectedBuildAction(rejection: ActionRejectedEvent): void {
    const rejectionKey = `${rejection.code}|${rejection.message}`;
    if (this.lastRejectedBuildToastKey === rejectionKey) {
      return;
    }
    const buildAttemptIsRecent = this.awaitingBuildAck || (Date.now() - this.lastBuildAttemptedAtMs) <= 5000;
    if (!buildAttemptIsRecent) {
      return;
    }
    this.lastRejectedBuildToastKey = rejectionKey;
    this.showBuildRejectToast(toFriendlyBuildRejectionMessage(rejection));
  }

  private bindPlayerTradeSocketEvents(): void {
    const socket = getSocket();
    if (!socket || this.tradeEventSocket === socket) {
      return;
    }
    this.unbindPlayerTradeSocketEvents();
    socket.on(SERVER_EVENTS.PLAYER_TRADE_REQUEST_RECEIVED, this.onPlayerTradeRequestReceived);
    socket.on(SERVER_EVENTS.PLAYER_TRADE_REQUEST_UPDATED, this.onPlayerTradeRequestUpdated);
    this.tradeEventSocket = socket;
  }

  private unbindPlayerTradeSocketEvents(): void {
    if (!this.tradeEventSocket) {
      return;
    }
    this.tradeEventSocket.off(SERVER_EVENTS.PLAYER_TRADE_REQUEST_RECEIVED, this.onPlayerTradeRequestReceived);
    this.tradeEventSocket.off(SERVER_EVENTS.PLAYER_TRADE_REQUEST_UPDATED, this.onPlayerTradeRequestUpdated);
    this.tradeEventSocket = null;
  }

  private resolveLocalPlayerId(): string | null {
    const localPlayerId = this.livePlayerId ?? clientState.playerId;
    if (!localPlayerId || localPlayerId === 'spectator') {
      return null;
    }
    return localPlayerId;
  }

  private resolvePlayerDisplayName(playerId: string): string {
    return this.liveGameState?.playersById[playerId]?.displayName ?? 'Player';
  }

  private formatResourceBundleSummary(bundle: ResourceBundle): string {
    const parts = RESOURCE_KEYS
      .filter((key) => inventoryCount(bundle[key]) > 0)
      .map((key) => `${inventoryCount(bundle[key])} ${RESOURCE_LABELS[key]}`);
    return parts.length > 0 ? parts.join(', ') : 'None';
  }

  private clearTradeNoticeTimers(): void {
    if (this.tradeNoticeHideTimer !== null) {
      clearTimeout(this.tradeNoticeHideTimer);
      this.tradeNoticeHideTimer = null;
    }
  }

  private showTradeNotice(message: string, tone: TradeNoticeTone = 'info'): void {
    if (!this.tradeNoticeEl) {
      return;
    }
    this.clearTradeNoticeTimers();
    this.tradeNoticeEl.textContent = message;
    this.tradeNoticeEl.dataset.tone = tone;
    this.tradeNoticeEl.classList.remove('is-hiding');
    this.tradeNoticeEl.classList.remove('is-visible');
    void this.tradeNoticeEl.offsetWidth;
    this.tradeNoticeEl.classList.add('is-visible');
    this.tradeNoticeHideTimer = window.setTimeout(() => {
      if (!this.tradeNoticeEl) {
        return;
      }
      this.tradeNoticeEl.classList.remove('is-visible');
      this.tradeNoticeEl.classList.add('is-hiding');
      this.tradeNoticeHideTimer = null;
    }, TRADE_NOTICE_MS);
  }

  private resetPlayerTradeDraft(resetTarget: boolean): void {
    if (resetTarget) {
      this.playerTradeTargetPlayerId = null;
    }
    this.playerTradeOfferSelection = emptyResourceBundle();
    this.playerTradeRequestSelection = emptyResourceBundle();
  }

  private setTradePanelTab(tab: TradePanelTab): void {
    if (this.tradePanelTab === tab) {
      return;
    }
    this.tradePanelTab = tab;
    this.syncTradePanelTabs();
    this.refreshPlayerTradeUi();
  }

  private syncTradePanelTabs(): void {
    const isBank = this.tradePanelTab === 'BANK';
    if (this.tradeTabsBankButton) {
      this.tradeTabsBankButton.classList.toggle('is-active', isBank);
      this.tradeTabsBankButton.setAttribute('aria-pressed', isBank ? 'true' : 'false');
    }
    if (this.tradeTabsPlayerButton) {
      this.tradeTabsPlayerButton.classList.toggle('is-active', !isBank);
      this.tradeTabsPlayerButton.setAttribute('aria-pressed', !isBank ? 'true' : 'false');
    }
    if (this.tradeBankContent) {
      this.tradeBankContent.style.display = isBank ? 'flex' : 'none';
    }
    if (this.tradePlayerContent) {
      this.tradePlayerContent.style.display = isBank ? 'none' : 'flex';
    }
  }

  private clampPlayerTradeSelections(): void {
    const gameState = this.liveGameState ?? clientState.gameState;
    const localPlayerId = this.resolveLocalPlayerId();
    if (!gameState || !localPlayerId) {
      this.resetPlayerTradeDraft(true);
      return;
    }

    const localPlayer = gameState.playersById[localPlayerId];
    if (!localPlayer) {
      this.resetPlayerTradeDraft(true);
      return;
    }

    if (!this.playerTradeTargetPlayerId || !gameState.playersById[this.playerTradeTargetPlayerId]) {
      this.playerTradeTargetPlayerId = null;
      this.playerTradeRequestSelection = emptyResourceBundle();
    }

    const target = this.playerTradeTargetPlayerId ? gameState.playersById[this.playerTradeTargetPlayerId] : null;
    RESOURCE_KEYS.forEach((resourceKey) => {
      const offerMax = inventoryCount(localPlayer.resources[resourceKey]);
      const requestMax = target ? inventoryCount(target.resources[resourceKey]) : 0;
      this.playerTradeOfferSelection[resourceKey] = Math.min(
        inventoryCount(this.playerTradeOfferSelection[resourceKey]),
        offerMax,
      );
      this.playerTradeRequestSelection[resourceKey] = Math.min(
        inventoryCount(this.playerTradeRequestSelection[resourceKey]),
        requestMax,
      );
    });
  }

  private appendTradeSelectionChips(parent: HTMLElement, bundle: ResourceBundle, emptyLabel: string): void {
    const entries = RESOURCE_KEYS.filter((resourceKey) => inventoryCount(bundle[resourceKey]) > 0);
    if (entries.length === 0) {
      const empty = document.createElement('span');
      empty.className = 'hexahaven-trade-summary-empty';
      empty.textContent = emptyLabel;
      parent.appendChild(empty);
      return;
    }
    entries.forEach((resourceKey) => {
      const chip = document.createElement('span');
      chip.className = 'hexahaven-trade-summary-chip';
      chip.textContent = `${inventoryCount(bundle[resourceKey])} ${RESOURCE_LABELS[resourceKey]}`;
      parent.appendChild(chip);
    });
  }

  private resolvePlayerTradeAvailability(): { allowed: boolean; reason: string | null } {
    const gameState = this.liveGameState ?? clientState.gameState;
    const localPlayerId = this.resolveLocalPlayerId();
    if (!gameState || !localPlayerId) {
      return { allowed: false, reason: 'Waiting for game state.' };
    }
    const localPlayer = gameState.playersById[localPlayerId];
    if (!localPlayer) {
      return { allowed: false, reason: 'Local player not found.' };
    }
    if (gameState.roomStatus !== 'in_progress') {
      return { allowed: false, reason: 'Trades are only available during active games.' };
    }
    if (!this.playerTradeTargetPlayerId) {
      return { allowed: false, reason: 'Select a player to trade with.' };
    }
    const targetPlayer = gameState.playersById[this.playerTradeTargetPlayerId];
    if (!targetPlayer) {
      return { allowed: false, reason: 'Selected player is unavailable.' };
    }
    if (gameState.turn.currentPlayerId !== localPlayerId) {
      return { allowed: false, reason: 'You can only send trades during your turn.' };
    }
    if (gameState.turn.phase !== 'ACTION') {
      return { allowed: false, reason: 'You can only send trades during ACTION phase.' };
    }
    if (isEmptyResourceBundle(this.playerTradeOfferSelection)) {
      return { allowed: false, reason: 'Add resources to your offer.' };
    }
    if (isEmptyResourceBundle(this.playerTradeRequestSelection)) {
      return { allowed: false, reason: 'Add resources to your request.' };
    }
    if (!hasRequiredResources(localPlayer.resources, this.playerTradeOfferSelection)) {
      return { allowed: false, reason: 'You no longer have enough resources for this offer.' };
    }
    if (!hasRequiredResources(targetPlayer.resources, this.playerTradeRequestSelection)) {
      return { allowed: false, reason: `${targetPlayer.displayName} no longer has enough requested resources.` };
    }
    if (this.isSendingPlayerTradeRequest) {
      return { allowed: false, reason: 'Sending trade request...' };
    }
    return { allowed: true, reason: null };
  }

  private incrementPlayerTradeSelection(
    side: 'offer' | 'request',
    resourceKey: ResourceKey,
  ): void {
    const gameState = this.liveGameState ?? clientState.gameState;
    const localPlayerId = this.resolveLocalPlayerId();
    if (!gameState || !localPlayerId) {
      return;
    }
    const localPlayer = gameState.playersById[localPlayerId];
    if (!localPlayer) {
      return;
    }

    if (side === 'offer') {
      const available = inventoryCount(localPlayer.resources[resourceKey]);
      const selected = inventoryCount(this.playerTradeOfferSelection[resourceKey]);
      if (selected >= available) {
        return;
      }
      this.playerTradeOfferSelection = {
        ...this.playerTradeOfferSelection,
        [resourceKey]: selected + 1,
      };
      this.refreshPlayerTradeUi();
      return;
    }

    if (!this.playerTradeTargetPlayerId) {
      return;
    }
    const targetPlayer = gameState.playersById[this.playerTradeTargetPlayerId];
    if (!targetPlayer) {
      return;
    }
    const available = inventoryCount(targetPlayer.resources[resourceKey]);
    const selected = inventoryCount(this.playerTradeRequestSelection[resourceKey]);
    if (selected >= available) {
      return;
    }
    this.playerTradeRequestSelection = {
      ...this.playerTradeRequestSelection,
      [resourceKey]: selected + 1,
    };
    this.refreshPlayerTradeUi();
  }

  private clearPlayerTradeSelection(side: 'offer' | 'request' | 'all'): void {
    if (side === 'all') {
      this.playerTradeOfferSelection = emptyResourceBundle();
      this.playerTradeRequestSelection = emptyResourceBundle();
      this.refreshPlayerTradeUi();
      return;
    }
    if (side === 'offer') {
      this.playerTradeOfferSelection = emptyResourceBundle();
      this.refreshPlayerTradeUi();
      return;
    }
    this.playerTradeRequestSelection = emptyResourceBundle();
    this.refreshPlayerTradeUi();
  }

  private refreshPlayerTradeUi(): void {
    this.clampPlayerTradeSelections();
    this.renderPlayerTradeBody();
  }

  private renderPlayerTradeBody(): void {
    if (!this.tradePlayerBody) {
      return;
    }
    this.tradePlayerBody.innerHTML = '';
    const gameState = this.liveGameState ?? clientState.gameState;
    const localPlayerId = this.resolveLocalPlayerId();
    if (!gameState || !localPlayerId) {
      const waiting = document.createElement('div');
      waiting.className = 'hexahaven-trade-empty-hint';
      waiting.textContent = 'Waiting for game state...';
      this.tradePlayerBody.appendChild(waiting);
      return;
    }
    const localPlayer = gameState.playersById[localPlayerId];
    if (!localPlayer) {
      const waiting = document.createElement('div');
      waiting.className = 'hexahaven-trade-empty-hint';
      waiting.textContent = 'Player data unavailable.';
      this.tradePlayerBody.appendChild(waiting);
      return;
    }

    const otherPlayers = gameState.playerOrder
      .filter((playerId) => playerId !== localPlayerId)
      .map((playerId) => gameState.playersById[playerId])
      .filter((player): player is NonNullable<typeof player> => Boolean(player));

    const targetsSection = document.createElement('div');
    targetsSection.className = 'hexahaven-trade-section';
    const targetsTitle = document.createElement('div');
    targetsTitle.className = 'hexahaven-trade-section-title';
    targetsTitle.textContent = 'Trade With';
    targetsSection.appendChild(targetsTitle);

    const targetsRow = document.createElement('div');
    targetsRow.className = 'hexahaven-trade-target-row';
    otherPlayers.forEach((player) => {
      const targetButton = document.createElement('button');
      targetButton.type = 'button';
      targetButton.className = 'hexahaven-trade-target-btn font-hexahaven-ui';
      targetButton.classList.toggle('is-active', this.playerTradeTargetPlayerId === player.playerId);
      targetButton.setAttribute('aria-pressed', this.playerTradeTargetPlayerId === player.playerId ? 'true' : 'false');
      targetButton.addEventListener('click', () => {
        if (this.playerTradeTargetPlayerId !== player.playerId) {
          this.playerTradeTargetPlayerId = player.playerId;
          this.resetPlayerTradeDraft(false);
        }
        this.refreshPlayerTradeUi();
      });

      const avatar = document.createElement('img');
      avatar.src = player.avatarUrl ?? '/avatar/avatar_1.png';
      avatar.alt = `${player.displayName} avatar`;
      avatar.className = 'hexahaven-trade-target-avatar';
      targetButton.appendChild(avatar);

      const name = document.createElement('span');
      name.className = 'hexahaven-trade-target-name';
      name.textContent = player.displayName;
      name.style.color = player.color || '#e2e8f0';
      targetButton.appendChild(name);

      const presence = document.createElement('span');
      presence.className = `hexahaven-trade-target-presence ${player.presence?.isConnected ? 'is-online' : 'is-offline'}`;
      targetButton.appendChild(presence);

      targetsRow.appendChild(targetButton);
    });
    targetsSection.appendChild(targetsRow);
    this.tradePlayerBody.appendChild(targetsSection);

    const targetPlayer = this.playerTradeTargetPlayerId ? gameState.playersById[this.playerTradeTargetPlayerId] : null;
    if (!targetPlayer) {
      const selectHint = document.createElement('div');
      selectHint.className = 'hexahaven-trade-empty-hint';
      selectHint.textContent = 'Choose a target player to build a trade.';
      this.tradePlayerBody.appendChild(selectHint);
      return;
    }

    const createResourcePicker = (
      title: string,
      source: ResourceBundle,
      selected: ResourceBundle,
      side: 'offer' | 'request',
    ): HTMLDivElement => {
      const section = document.createElement('div');
      section.className = 'hexahaven-trade-section';
      const heading = document.createElement('div');
      heading.className = 'hexahaven-trade-section-title';
      heading.textContent = title;
      section.appendChild(heading);

      const grid = document.createElement('div');
      grid.className = 'hexahaven-trade-resource-grid';
      RESOURCE_BOX_CONFIG.forEach(({ key, iconSrc, shortLabel, boxBg, boxBorder, countColor }) => {
        const available = inventoryCount(source[key]);
        const selectedCount = inventoryCount(selected[key]);
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'hexahaven-trade-resource-btn';
        button.style.backgroundColor = boxBg;
        button.style.borderColor = selectedCount > 0 ? '#34d399' : boxBorder;
        button.style.color = countColor;
        button.disabled = available <= 0 || selectedCount >= available;
        button.setAttribute('aria-label', `${RESOURCE_LABELS[key]} (${available})`);
        button.addEventListener('click', () => this.incrementPlayerTradeSelection(side, key));

        const iconWrap = document.createElement('span');
        iconWrap.className = 'hexahaven-trade-resource-icon';
        if (iconSrc) {
          const img = document.createElement('img');
          img.src = iconSrc;
          img.alt = shortLabel;
          img.draggable = false;
          img.className = 'h-6 w-6 object-contain';
          iconWrap.appendChild(img);
        } else {
          iconWrap.textContent = shortLabel;
        }
        button.appendChild(iconWrap);

        const amount = document.createElement('span');
        amount.className = 'hexahaven-trade-resource-count';
        amount.textContent = `${selectedCount}/${available}`;
        button.appendChild(amount);
        grid.appendChild(button);
      });
      section.appendChild(grid);
      return section;
    };

    this.tradePlayerBody.appendChild(
      createResourcePicker(`${targetPlayer.displayName}'s Resources (You Request)`, targetPlayer.resources, this.playerTradeRequestSelection, 'request'),
    );
    this.tradePlayerBody.appendChild(
      createResourcePicker('Your Resources (You Offer)', localPlayer.resources, this.playerTradeOfferSelection, 'offer'),
    );

    const summary = document.createElement('div');
    summary.className = 'hexahaven-trade-summary';

    const offerRow = document.createElement('div');
    offerRow.className = 'hexahaven-trade-summary-row';
    const offerLabel = document.createElement('span');
    offerLabel.className = 'hexahaven-trade-summary-label';
    offerLabel.textContent = 'You offer:';
    offerRow.appendChild(offerLabel);
    const offerValues = document.createElement('div');
    offerValues.className = 'hexahaven-trade-summary-values';
    this.appendTradeSelectionChips(offerValues, this.playerTradeOfferSelection, 'None');
    offerRow.appendChild(offerValues);
    summary.appendChild(offerRow);

    const requestRow = document.createElement('div');
    requestRow.className = 'hexahaven-trade-summary-row';
    const requestLabel = document.createElement('span');
    requestLabel.className = 'hexahaven-trade-summary-label';
    requestLabel.textContent = 'You request:';
    requestRow.appendChild(requestLabel);
    const requestValues = document.createElement('div');
    requestValues.className = 'hexahaven-trade-summary-values';
    this.appendTradeSelectionChips(requestValues, this.playerTradeRequestSelection, 'None');
    requestRow.appendChild(requestValues);
    summary.appendChild(requestRow);
    this.tradePlayerBody.appendChild(summary);

    const clearRow = document.createElement('div');
    clearRow.className = 'hexahaven-trade-clear-row';
    const clearOffer = document.createElement('button');
    clearOffer.type = 'button';
    clearOffer.className = 'hexahaven-trade-clear-btn font-hexahaven-ui';
    clearOffer.textContent = 'Clear Offer';
    clearOffer.addEventListener('click', () => this.clearPlayerTradeSelection('offer'));
    const clearRequest = document.createElement('button');
    clearRequest.type = 'button';
    clearRequest.className = 'hexahaven-trade-clear-btn font-hexahaven-ui';
    clearRequest.textContent = 'Clear Request';
    clearRequest.addEventListener('click', () => this.clearPlayerTradeSelection('request'));
    const clearAll = document.createElement('button');
    clearAll.type = 'button';
    clearAll.className = 'hexahaven-trade-clear-btn font-hexahaven-ui';
    clearAll.textContent = 'Clear All';
    clearAll.addEventListener('click', () => this.clearPlayerTradeSelection('all'));
    clearRow.appendChild(clearOffer);
    clearRow.appendChild(clearRequest);
    clearRow.appendChild(clearAll);
    this.tradePlayerBody.appendChild(clearRow);

    const sendState = this.resolvePlayerTradeAvailability();
    const sendButton = document.createElement('button');
    sendButton.type = 'button';
    sendButton.className = 'hexahaven-trade-send-btn font-hexahaven-ui';
    sendButton.textContent = this.isSendingPlayerTradeRequest ? 'Sending...' : 'Send Trade Request';
    sendButton.disabled = !sendState.allowed;
    sendButton.addEventListener('click', () => {
      void this.handleSendPlayerTradeRequest();
    });
    this.tradePlayerBody.appendChild(sendButton);

    const helper = document.createElement('div');
    helper.className = 'hexahaven-trade-send-helper';
    if (!sendState.allowed && sendState.reason) {
      helper.textContent = sendState.reason;
    } else if (this.pendingOutgoingTradeIds.size > 0) {
      helper.textContent = `Pending trade requests: ${this.pendingOutgoingTradeIds.size}`;
    } else {
      helper.textContent = 'Trade requests expire after 10 seconds.';
    }
    this.tradePlayerBody.appendChild(helper);
  }

  private async handleSendPlayerTradeRequest(): Promise<void> {
    const gameState = this.liveGameState ?? clientState.gameState;
    const roomId = getLobbySession()?.roomId ?? null;
    const localPlayerId = this.resolveLocalPlayerId();
    if (!gameState || !roomId || !localPlayerId || !this.playerTradeTargetPlayerId) {
      return;
    }
    const sendState = this.resolvePlayerTradeAvailability();
    if (!sendState.allowed) {
      if (sendState.reason) {
        this.showTradeNotice(sendState.reason, 'error');
      }
      return;
    }

    const offeredResources: ResourceBundle = { ...this.playerTradeOfferSelection };
    const requestedResources: ResourceBundle = { ...this.playerTradeRequestSelection };
    const targetName = this.resolvePlayerDisplayName(this.playerTradeTargetPlayerId);

    this.isSendingPlayerTradeRequest = true;
    this.refreshPlayerTradeUi();
    try {
      const ack = await sendPlayerTradeRequest({
        gameId: roomId,
        receiverPlayerId: this.playerTradeTargetPlayerId,
        offeredResources,
        requestedResources,
      });
      this.pendingOutgoingTradeIds.add(ack.tradeRequest.id);
      this.playerTradeOfferSelection = emptyResourceBundle();
      this.playerTradeRequestSelection = emptyResourceBundle();
      this.showTradeNotice(`Trade request sent to ${targetName}.`, 'info');
    } catch (error) {
      this.showTradeNotice(error instanceof Error ? error.message : 'Failed to send trade request.', 'error');
    } finally {
      this.isSendingPlayerTradeRequest = false;
      this.refreshPlayerTradeUi();
    }
  }

  private setIncomingTradeRequest(tradeRequest: PlayerTradeRequest | null): void {
    this.incomingTradeRequest = tradeRequest;
    if (!tradeRequest) {
      this.isRespondingToTradeRequest = false;
      this.clearIncomingTradeCountdownTimer();
    } else {
      this.startIncomingTradeCountdownTimer();
    }
    this.refreshIncomingTradeCardUi();
    this.repositionIncomingTradeCard();
  }

  private clearIncomingTradeCountdownTimer(): void {
    if (this.incomingTradeCountdownTimer !== null) {
      clearInterval(this.incomingTradeCountdownTimer);
      this.incomingTradeCountdownTimer = null;
    }
  }

  private startIncomingTradeCountdownTimer(): void {
    this.clearIncomingTradeCountdownTimer();
    this.updateIncomingTradeCountdownUi();
    this.incomingTradeCountdownTimer = window.setInterval(() => {
      this.updateIncomingTradeCountdownUi();
    }, 120);
  }

  private updateIncomingTradeCountdownUi(): void {
    if (!this.incomingTradeRequest || !this.incomingTradeProgressFillEl) {
      return;
    }
    const expiresAtMs = Date.parse(this.incomingTradeRequest.expiresAt);
    if (!Number.isFinite(expiresAtMs)) {
      this.incomingTradeProgressFillEl.style.width = '0%';
      return;
    }
    const createdAtMs = Date.parse(this.incomingTradeRequest.createdAt);
    const fallbackDurationMs = PLAYER_TRADE_REQUEST_TTL_MS;
    const durationMs = Number.isFinite(createdAtMs) && (expiresAtMs as number) > createdAtMs
      ? (expiresAtMs as number) - createdAtMs
      : fallbackDurationMs;
    const remainingMs = Math.max(0, (expiresAtMs as number) - Date.now());
    const percent = Math.max(0, Math.min(100, (remainingMs / durationMs) * 100));
    this.incomingTradeProgressFillEl.style.width = `${percent}%`;
    if (remainingMs <= 0) {
      this.clearIncomingTradeCountdownTimer();
      this.incomingTradeRequest = null;
      this.refreshIncomingTradeCardUi();
      this.repositionIncomingTradeCard();
    }
  }

  private refreshIncomingTradeCardUi(): void {
    if (!this.incomingTradeCard) {
      return;
    }
    const localPlayerId = this.resolveLocalPlayerId();
    const incoming = this.incomingTradeRequest;
    const isVisible = Boolean(incoming && localPlayerId && incoming.receiverPlayerId === localPlayerId);
    this.incomingTradeCard.classList.toggle('is-visible', isVisible);
    if (!isVisible || !incoming) {
      this.clearIncomingTradeCountdownTimer();
      return;
    }

    const senderName = this.resolvePlayerDisplayName(incoming.senderPlayerId);
    if (this.incomingTradeSenderTextEl) {
      this.incomingTradeSenderTextEl.textContent = `${senderName} sent an offer`;
    }
    if (this.incomingTradeOfferTextEl) {
      this.incomingTradeOfferTextEl.textContent = `They offer: ${this.formatResourceBundleSummary(incoming.offeredResources)}`;
    }
    if (this.incomingTradeRequestTextEl) {
      this.incomingTradeRequestTextEl.textContent = `They want: ${this.formatResourceBundleSummary(incoming.requestedResources)}`;
    }
    if (this.incomingTradeAcceptButton) {
      this.incomingTradeAcceptButton.disabled = this.isRespondingToTradeRequest;
    }
    if (this.incomingTradeDenyButton) {
      this.incomingTradeDenyButton.disabled = this.isRespondingToTradeRequest;
    }
    this.updateIncomingTradeCountdownUi();
  }

  private repositionIncomingTradeCard(): void {
    if (!this.incomingTradeCard || !this.buttonContainer || !this.incomingTradeRequest) {
      return;
    }
    if (!this.incomingTradeCard.classList.contains('is-visible')) {
      return;
    }
    const containerRect = this.buttonContainer.getBoundingClientRect();
    const senderCard = this.playerPanel?.querySelector(
      `[data-player-id="${this.incomingTradeRequest.senderPlayerId}"]`,
    ) as HTMLDivElement | null;

    let left = 148;
    let top = 14;
    if (senderCard) {
      const senderRect = senderCard.getBoundingClientRect();
      left = senderRect.right - containerRect.left + 10;
      top = senderRect.top - containerRect.top;
    }

    const cardWidth = this.incomingTradeCard.offsetWidth || 252;
    const cardHeight = this.incomingTradeCard.offsetHeight || 164;
    const maxLeft = containerRect.width - cardWidth - 8;
    const maxTop = containerRect.height - GAME_BOARD_BOTTOM_BAR_PX - cardHeight - 8;
    left = Math.max(8, Math.min(left, Math.max(8, maxLeft)));
    top = Math.max(8, Math.min(top, Math.max(8, maxTop)));

    this.incomingTradeCard.style.left = `${left}px`;
    this.incomingTradeCard.style.top = `${top}px`;
  }

  private async handleRespondToIncomingTrade(response: 'accepted' | 'declined'): Promise<void> {
    const incoming = this.incomingTradeRequest;
    const roomId = getLobbySession()?.roomId ?? null;
    if (!incoming || !roomId) {
      return;
    }
    this.isRespondingToTradeRequest = true;
    this.refreshIncomingTradeCardUi();
    try {
      await respondPlayerTradeRequest({
        gameId: roomId,
        tradeRequestId: incoming.id,
        response,
      });
    } catch (error) {
      this.showTradeNotice(error instanceof Error ? error.message : 'Failed to respond to trade.', 'error');
    } finally {
      this.isRespondingToTradeRequest = false;
      this.refreshIncomingTradeCardUi();
    }
  }

  private handlePlayerTradeRequestReceived(tradeRequest: PlayerTradeRequest): void {
    const localPlayerId = this.resolveLocalPlayerId();
    if (!localPlayerId || tradeRequest.receiverPlayerId !== localPlayerId) {
      return;
    }
    this.setIncomingTradeRequest(tradeRequest);
  }

  private handlePlayerTradeRequestUpdated(event: PlayerTradeRequestUpdateEvent): void {
    const localPlayerId = this.resolveLocalPlayerId();
    if (!localPlayerId) {
      return;
    }

    const tradeRequest = event.tradeRequest;
    const isSender = tradeRequest.senderPlayerId === localPlayerId;
    const isReceiver = tradeRequest.receiverPlayerId === localPlayerId;
    if (!isSender && !isReceiver) {
      return;
    }

    if (event.outcome === 'pending' && isSender) {
      this.pendingOutgoingTradeIds.add(tradeRequest.id);
    } else if (event.outcome !== 'pending') {
      this.pendingOutgoingTradeIds.delete(tradeRequest.id);
    }

    if (isReceiver) {
      if (event.outcome === 'pending') {
        this.setIncomingTradeRequest(tradeRequest);
      } else if (this.incomingTradeRequest?.id === tradeRequest.id) {
        this.setIncomingTradeRequest(null);
      }
    }

    const senderName = this.resolvePlayerDisplayName(tradeRequest.senderPlayerId);
    const receiverName = this.resolvePlayerDisplayName(tradeRequest.receiverPlayerId);
    if (isSender) {
      if (event.outcome === 'accepted') {
        this.showTradeNotice(`${receiverName} accepted your trade.`, 'success');
      } else if (event.outcome === 'declined') {
        this.showTradeNotice(`${receiverName} denied your trade.`, 'info');
      } else if (event.outcome === 'expired') {
        this.showTradeNotice('Trade request expired.', 'info');
      } else if (event.outcome === 'failed') {
        this.showTradeNotice(event.message || 'Trade request failed.', 'error');
      } else if (event.outcome === 'pending') {
        this.showTradeNotice(`Trade request sent to ${receiverName}.`, 'info');
      }
    } else if (isReceiver) {
      if (event.outcome === 'accepted') {
        this.showTradeNotice(`Trade accepted with ${senderName}.`, 'success');
      } else if (event.outcome === 'expired') {
        this.showTradeNotice('Trade request expired.', 'info');
      } else if (event.outcome === 'failed') {
        this.showTradeNotice(event.message || 'Trade request failed.', 'error');
      }
    }

    this.refreshPlayerTradeUi();
    this.refreshIncomingTradeCardUi();
    this.repositionIncomingTradeCard();
  }

  private ensureResourceFxLayer(parent: HTMLElement): void {
    if (this.resourceFxLayer) {
      this.resourceFxLayer.remove();
    }
    const layer = document.createElement('div');
    layer.style.position = 'absolute';
    layer.style.inset = '0';
    layer.style.zIndex = '6';
    layer.style.pointerEvents = 'none';
    this.resourceFxLayer = layer;
    parent.appendChild(layer);
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
    this.tradeTabsBankButton = null;
    this.tradeTabsPlayerButton = null;
    this.tradeBankContent = null;
    this.tradePlayerContent = null;
    this.tradePlayerBody = null;
    this.tradeNoticeEl = null;
    this.clearTradeNoticeTimers();

    const panel = document.createElement('div');
    panel.className = 'absolute top-16 right-4 rounded-xl border border-slate-600 bg-slate-900/88 px-3 py-2 text-white shadow-md';
    panel.style.zIndex = '3';
    panel.style.width = '260px';
    panel.style.maxHeight = `calc(100vh - ${GAME_BOARD_BOTTOM_BAR_PX + TRADE_PANEL_CHAT_GUARD_PX}px)`;
    panel.style.display = 'flex';
    panel.style.flexDirection = 'column';
    panel.style.overflow = 'hidden';

    const header = document.createElement('div');
    header.className = 'mb-2 flex items-center justify-between gap-2';

    const title = document.createElement('div');
    title.className = 'font-hexahaven-ui text-xs font-semibold';
    title.textContent = 'Trading';
    header.appendChild(title);

    if (ClientEnv.devUnlimitedMaterials) {
      const devBadge = document.createElement('div');
      devBadge.className =
        'font-hexahaven-ui rounded border border-amber-300/80 bg-amber-200/95 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-950';
      devBadge.textContent = 'DEV: Unlimited';
      devBadge.setAttribute('aria-label', 'Developer mode: unlimited materials enabled');
      header.appendChild(devBadge);
    }

    const turnTimerValue = document.createElement('div');
    turnTimerValue.className =
      'font-hexahaven-ui flex h-9 w-[76px] shrink-0 items-center justify-center rounded-md border px-2 text-center text-sm font-bold tracking-widest tabular-nums';
    turnTimerValue.textContent = '01:00';

    const diceHud = createDiceHud();
    diceHud.root.style.marginBottom = '-4px';
    diceHud.root.style.alignSelf = 'flex-start';

    const dicePanel = document.createElement('div');
    dicePanel.className =
      'absolute left-4 flex flex-col gap-1 text-white pointer-events-auto';
    dicePanel.style.zIndex = '3';
    dicePanel.style.bottom = `${GAME_BOARD_BOTTOM_BAR_PX + 4}px`;
    dicePanel.setAttribute('aria-label', 'Dice roll');
    dicePanel.appendChild(diceHud.root);

    const rollDiceButton = document.createElement('button');
    rollDiceButton.type = 'button';
    rollDiceButton.dataset.tutorialAnchor = 'roll';
    rollDiceButton.className =
      'font-hexahaven-ui h-9 rounded-md border border-cyan-400 bg-cyan-900 px-3 text-xs font-semibold text-white';
    rollDiceButton.textContent = 'Roll Dice';
    rollDiceButton.addEventListener('click', () => this.handleRollDiceClick());
    const rollControls = document.createElement('div');
    rollControls.className = 'flex items-center gap-2';
    rollControls.appendChild(rollDiceButton);
    rollControls.appendChild(turnTimerValue);
    dicePanel.appendChild(rollControls);

    const actions = document.createElement('div');
    actions.className = 'flex min-h-0 flex-1 flex-col gap-1.5';

    const tabs = document.createElement('div');
    tabs.className = 'hexahaven-trade-tabs';
    const bankTabButton = document.createElement('button');
    bankTabButton.type = 'button';
    bankTabButton.className = 'hexahaven-trade-tab font-hexahaven-ui';
    bankTabButton.textContent = 'Bank';
    bankTabButton.addEventListener('click', () => this.setTradePanelTab('BANK'));
    const playerTabButton = document.createElement('button');
    playerTabButton.type = 'button';
    playerTabButton.className = 'hexahaven-trade-tab font-hexahaven-ui';
    playerTabButton.textContent = 'Player';
    playerTabButton.addEventListener('click', () => this.setTradePanelTab('PLAYER'));
    tabs.appendChild(bankTabButton);
    tabs.appendChild(playerTabButton);

    const tradeNotice = document.createElement('div');
    tradeNotice.className = 'hexahaven-trade-notice font-hexahaven-ui';
    tradeNotice.textContent = 'Select a trade mode.';

    const tabContent = document.createElement('div');
    tabContent.className = 'hexahaven-trade-tab-content';

    const bankContent = document.createElement('div');
    bankContent.className = 'hexahaven-trade-bank-content';

    const endTurnButton = document.createElement('button');
    endTurnButton.type = 'button';
    endTurnButton.dataset.tutorialAnchor = 'end-turn';
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
    bankTradeButton.dataset.tutorialAnchor = 'bank-trade';
    bankTradeButton.className =
      'font-hexahaven-ui rounded-md border border-amber-400/60 bg-amber-900/60 px-2 py-2 text-xs font-semibold';
    bankTradeButton.addEventListener('click', () => this.handleBankTradeClick());

    bankContent.appendChild(bankGiveLabel);
    bankContent.appendChild(bankGiveRow);
    bankContent.appendChild(bankReceiveLabel);
    bankContent.appendChild(bankReceiveRow);
    bankContent.appendChild(bankTradeButton);

    const playerContent = document.createElement('div');
    playerContent.className = 'hexahaven-trade-player-content';
    const playerBody = document.createElement('div');
    playerBody.className = 'hexahaven-trade-player-body';
    playerContent.appendChild(playerBody);

    const actionsFooter = document.createElement('div');
    actionsFooter.className = 'hexahaven-trade-footer';
    actionsFooter.appendChild(endTurnButton);

    tabContent.appendChild(bankContent);
    tabContent.appendChild(playerContent);
    actions.appendChild(tabs);
    actions.appendChild(tradeNotice);
    actions.appendChild(tabContent);
    actions.appendChild(actionsFooter);

    panel.appendChild(header);
    panel.appendChild(actions);

    this.turnHudPanel = panel;
    this.diceHudPanel = dicePanel;
    this.currentPlayerValue = null;
    this.currentPhaseValue = null;
    this.turnTimerValue = turnTimerValue;
    this.diceHud = diceHud;
    this.rollDiceButton = rollDiceButton;
    this.endTurnButton = endTurnButton;
    this.bankTradeButton = bankTradeButton;
    this.tradeTabsBankButton = bankTabButton;
    this.tradeTabsPlayerButton = playerTabButton;
    this.tradeBankContent = bankContent;
    this.tradePlayerContent = playerContent;
    this.tradePlayerBody = playerBody;
    this.tradeNoticeEl = tradeNotice;

    parent.appendChild(panel);
    parent.appendChild(dicePanel);

    this.syncTradePanelTabs();
    this.refreshBankTradeUi();
    this.refreshPlayerTradeUi();
    this.refreshIncomingTradeCardUi();
    this.updateTurnHud();
    this.updateTurnTimerUi();
    this.repositionYourTurnToast();
    this.repositionTutorialPrompt();
    this.repositionIncomingTradeCard();
  }

  private mountChatPanel(parent: HTMLElement): void {
    if (this.chatPanel) {
      this.chatPanel.remove();
    }

    const panel = document.createElement('div');
    panel.className = 'absolute right-4 flex flex-col bg-slate-900/88 border border-slate-700 rounded-lg shadow-lg overflow-hidden pointer-events-auto';
    panel.style.bottom = `${GAME_BOARD_BOTTOM_BAR_PX + 10}px`;
    panel.style.width = '260px';
    panel.style.height = '170px';
    panel.style.zIndex = '4';
    this.chatPanel = panel;

    const messagesContainer = document.createElement('div');
    messagesContainer.className = 'flex-1 overflow-y-auto p-2 text-xs text-white font-hexahaven-ui';
    messagesContainer.style.scrollbarWidth = 'thin';
    this.chatMessagesContainer = messagesContainer;

    const inputContainer = document.createElement('div');
    inputContainer.className = 'flex border-t border-slate-700 bg-slate-800/50';

    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'Chat...';
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
    this.refreshBottomBarThemeFromGameState();
    this.renderResourceBarFromGameState();
    this.renderBuildingBarFromGameState();
    this.refreshPlayerTradeUi();
    this.renderChatMessages();
    this.refreshIncomingTradeCardUi();
    this.repositionIncomingTradeCard();
    this.updateMapDisplay();
  }

  private maybeHandleWinnerState(previousState: GameState | null, nextState: GameState | null): void {
    const inferredWinnerId = this.resolveFallbackWinnerId(nextState);
    const nextWinnerId = nextState?.winnerPlayerId ?? inferredWinnerId;
    if (!nextWinnerId) {
      if (nextState?.roomStatus !== 'finished') {
        this.lastAnnouncedWinnerPlayerId = null;
      }
      this.closeWinnerOverlay();
      return;
    }
    const previousWinnerId = previousState?.winnerPlayerId ?? null;
    const winnerChanged = previousWinnerId !== nextWinnerId || this.lastAnnouncedWinnerPlayerId !== nextWinnerId;
    if (!winnerChanged) {
      return;
    }
    if (!nextState) {
      return;
    }
    this.lastAnnouncedWinnerPlayerId = nextWinnerId;
    this.enterGameOverMode();
    this.openWinnerOverlay(nextState, nextWinnerId);
    playVictoryFanfareSound();
    this.spawnVictoryConfetti(80);
  }

  private enterGameOverMode(): void {
    if (this.isGameOver) {
      return;
    }
    this.isGameOver = true;
    this.pendingBuild = null;
    this.dismissBuildRecipePopover();
    this.hideTutorialPrompt();
    this.stopTurnTimerTicker();
    this.cancelLocalDiceRollAnimation();
    this.stopBackgroundMusic();
    if (this.resourceBar) {
      this.resourceBar.style.pointerEvents = 'none';
      this.resourceBar.style.filter = 'grayscale(0.55)';
      this.resourceBar.style.opacity = '0.55';
    }
    if (this.turnHudPanel) {
      this.turnHudPanel.style.pointerEvents = 'none';
      this.turnHudPanel.style.opacity = '0.5';
    }
    if (this.chatPanel) {
      this.chatPanel.style.pointerEvents = 'none';
      this.chatPanel.style.opacity = '0.55';
    }
    if (this.settingsButton) {
      this.settingsButton.style.display = 'none';
    }
    if (this.musicToggleButton) {
      this.musicToggleButton.style.display = 'none';
    }
    if (this.exitButton) {
      this.exitButton.style.display = 'none';
    }
    this.updateMapDisplay();
  }

  private resolveFallbackWinnerId(gameState: GameState | null): string | null {
    if (!gameState) {
      return null;
    }
    const ranked = gameState.playerOrder
      .map((playerId) => gameState.playersById[playerId])
      .filter((player): player is NonNullable<typeof player> => Boolean(player))
      .sort((a, b) => (b.stats.publicVP ?? 0) - (a.stats.publicVP ?? 0));
    const leader = ranked[0];
    if (!leader) {
      return null;
    }
    if (gameState.roomStatus === 'finished') {
      return leader.playerId;
    }
    return (leader.stats.publicVP ?? 0) >= CLIENT_WIN_VP_FALLBACK ? leader.playerId : null;
  }

  private openWinnerOverlay(gameState: GameState, winnerPlayerId: string): void {
    this.closeWinnerOverlay();
    const winner = gameState.playersById[winnerPlayerId];
    if (!winner) {
      return;
    }
    const sortedPlayers = gameState.playerOrder
      .map((playerId) => gameState.playersById[playerId])
      .filter((player): player is NonNullable<typeof player> => Boolean(player))
      .sort((a, b) => {
        const vpDelta = (b.stats.publicVP ?? 0) - (a.stats.publicVP ?? 0);
        if (vpDelta !== 0) {
          return vpDelta;
        }
        return a.displayName.localeCompare(b.displayName);
      });

    const backdrop = document.createElement('div');
    backdrop.style.position = 'fixed';
    backdrop.style.inset = '0';
    backdrop.style.zIndex = '80';
    backdrop.style.display = 'flex';
    backdrop.style.alignItems = 'center';
    backdrop.style.justifyContent = 'center';
    backdrop.style.background = 'rgba(2, 6, 23, 0.75)';
    backdrop.style.padding = '16px';
    backdrop.style.backdropFilter = 'blur(2px)';

    const panel = document.createElement('div');
    panel.className = 'font-hexahaven-ui';
    panel.style.width = 'min(560px, 94vw)';
    panel.style.maxHeight = 'min(82vh, 640px)';
    panel.style.overflowY = 'auto';
    panel.style.borderRadius = '16px';
    panel.style.border = '1px solid rgba(251, 191, 36, 0.65)';
    panel.style.background = 'linear-gradient(180deg, rgba(15, 23, 42, 0.97), rgba(30, 41, 59, 0.97))';
    panel.style.boxShadow = '0 20px 60px rgba(0, 0, 0, 0.5), 0 0 24px rgba(251, 191, 36, 0.25)';
    panel.style.color = '#f8fafc';
    panel.style.padding = '18px';
    panel.addEventListener('click', (event) => event.stopPropagation());

    const heading = document.createElement('h2');
    heading.textContent = 'Victory!';
    heading.style.margin = '0';
    heading.style.textAlign = 'center';
    heading.style.fontSize = '36px';
    heading.style.letterSpacing = '0.08em';
    heading.style.color = '#fcd34d';

    const winnerCard = document.createElement('div');
    winnerCard.style.marginTop = '12px';
    winnerCard.style.display = 'grid';
    winnerCard.style.gridTemplateColumns = '84px 1fr';
    winnerCard.style.gap = '12px';
    winnerCard.style.alignItems = 'center';
    winnerCard.style.padding = '12px';
    winnerCard.style.border = '1px solid rgba(251, 191, 36, 0.45)';
    winnerCard.style.borderRadius = '12px';
    winnerCard.style.background = 'rgba(15, 23, 42, 0.62)';

    const winnerAvatar = document.createElement('img');
    winnerAvatar.src = winner.avatarUrl ?? '/avatar/avatar_1.png';
    winnerAvatar.alt = `${winner.displayName} avatar`;
    winnerAvatar.style.width = '80px';
    winnerAvatar.style.height = '80px';
    winnerAvatar.style.borderRadius = '10px';
    winnerAvatar.style.objectFit = 'cover';
    winnerAvatar.style.border = `2px solid ${winner.color || '#fcd34d'}`;

    const winnerTextWrap = document.createElement('div');
    const winnerName = document.createElement('div');
    winnerName.textContent = winner.displayName;
    winnerName.style.fontSize = '24px';
    winnerName.style.fontWeight = '700';
    winnerName.style.color = winner.color || '#f8fafc';
    const winnerVp = document.createElement('div');
    winnerVp.textContent = `${winner.stats.publicVP ?? 0} Victory Points`;
    winnerVp.style.marginTop = '4px';
    winnerVp.style.fontSize = '14px';
    winnerVp.style.color = '#e2e8f0';
    winnerTextWrap.appendChild(winnerName);
    winnerTextWrap.appendChild(winnerVp);

    winnerCard.appendChild(winnerAvatar);
    winnerCard.appendChild(winnerTextWrap);

    const leaderboardTitle = document.createElement('div');
    leaderboardTitle.textContent = 'Leaderboard';
    leaderboardTitle.style.marginTop = '16px';
    leaderboardTitle.style.marginBottom = '8px';
    leaderboardTitle.style.fontSize = '14px';
    leaderboardTitle.style.textTransform = 'uppercase';
    leaderboardTitle.style.letterSpacing = '0.06em';
    leaderboardTitle.style.color = '#fde68a';

    const leaderboard = document.createElement('div');
    leaderboard.style.display = 'grid';
    leaderboard.style.gap = '8px';
    sortedPlayers.forEach((player, index) => {
      const row = document.createElement('div');
      row.style.display = 'grid';
      row.style.gridTemplateColumns = '28px 38px 1fr auto';
      row.style.alignItems = 'center';
      row.style.gap = '8px';
      row.style.padding = '7px 9px';
      row.style.borderRadius = '8px';
      row.style.border = '1px solid rgba(148, 163, 184, 0.35)';
      row.style.background = player.playerId === winnerPlayerId ? 'rgba(251, 191, 36, 0.2)' : 'rgba(15, 23, 42, 0.42)';

      const rank = document.createElement('span');
      rank.textContent = `#${index + 1}`;
      rank.style.color = '#cbd5e1';
      rank.style.fontSize = '13px';

      const avatar = document.createElement('img');
      avatar.src = player.avatarUrl ?? '/avatar/avatar_1.png';
      avatar.alt = `${player.displayName} avatar`;
      avatar.style.width = '34px';
      avatar.style.height = '34px';
      avatar.style.objectFit = 'cover';
      avatar.style.borderRadius = '6px';

      const name = document.createElement('span');
      name.textContent = player.displayName;
      name.style.color = player.color || '#f8fafc';
      name.style.fontSize = '14px';
      name.style.fontWeight = '600';

      const points = document.createElement('span');
      points.textContent = `${player.stats.publicVP ?? 0} VP`;
      points.style.color = '#e2e8f0';
      points.style.fontSize = '13px';

      row.appendChild(rank);
      row.appendChild(avatar);
      row.appendChild(name);
      row.appendChild(points);
      leaderboard.appendChild(row);
    });

    const menuBtn = document.createElement('button');
    menuBtn.type = 'button';
    menuBtn.textContent = 'Back to Menu';
    menuBtn.style.marginTop = '14px';
    menuBtn.style.padding = '8px 14px';
    menuBtn.style.borderRadius = '8px';
    menuBtn.style.border = '1px solid rgba(255,255,255,0.32)';
    menuBtn.style.background = 'rgba(30, 41, 59, 0.92)';
    menuBtn.style.color = '#f8fafc';
    menuBtn.style.cursor = 'pointer';
    menuBtn.addEventListener('click', () => this.returnToMainMenu());

    panel.appendChild(heading);
    panel.appendChild(winnerCard);
    panel.appendChild(leaderboardTitle);
    panel.appendChild(leaderboard);
    panel.appendChild(menuBtn);
    backdrop.appendChild(panel);
    document.body.appendChild(backdrop);
    this.winnerBackdrop = backdrop;
  }

  private closeWinnerOverlay(): void {
    if (this.winnerBackdrop) {
      this.winnerBackdrop.remove();
      this.winnerBackdrop = null;
    }
    if (this.winnerKeydown) {
      document.removeEventListener('keydown', this.winnerKeydown);
      this.winnerKeydown = null;
    }
  }

  private returnToMainMenu(): void {
    disconnectSocket();
    clearLobbySession();
    resetClientState();
    this.navigateToScreen?.(ScreenId.MainMenu);
  }

  private spawnVictoryConfetti(pieceCount: number): void {
    if (!this.buttonContainer) {
      return;
    }
    const layer = document.createElement('div');
    layer.style.position = 'absolute';
    layer.style.inset = '0';
    layer.style.zIndex = '35';
    layer.style.pointerEvents = 'none';
    this.buttonContainer.appendChild(layer);

    const colors = ['#f43f5e', '#f59e0b', '#84cc16', '#22d3ee', '#818cf8', '#facc15'];
    for (let i = 0; i < pieceCount; i += 1) {
      const piece = document.createElement('div');
      piece.style.position = 'absolute';
      piece.style.top = '-16px';
      piece.style.left = `${Math.random() * 100}%`;
      piece.style.width = `${6 + Math.random() * 7}px`;
      piece.style.height = `${8 + Math.random() * 8}px`;
      piece.style.opacity = '0.95';
      piece.style.borderRadius = '1px';
      piece.style.background = colors[i % colors.length];
      layer.appendChild(piece);
      const drift = (Math.random() - 0.5) * 180;
      const rotate = (Math.random() - 0.5) * 680;
      const fallDuration = 1400 + Math.random() * 1600;
      piece.animate(
        [
          { transform: 'translate3d(0, 0, 0) rotate(0deg)', opacity: 1 },
          { transform: `translate3d(${drift}px, ${window.innerHeight * 0.75}px, 0) rotate(${rotate}deg)`, opacity: 0.1 },
        ],
        {
          duration: fallDuration,
          delay: Math.random() * 450,
          easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
          fill: 'forwards',
        },
      ).onfinish = () => piece.remove();
    }
    const cleanupTimer = window.setTimeout(() => layer.remove(), 2600);
    this.activeResourceFxTimers.push(cleanupTimer);
  }

  private refreshBottomBarThemeFromGameState(): void {
    if (!this.resourceBar) {
      return;
    }
    const gameState = this.liveGameState ?? clientState.gameState;
    const viewerId = this.livePlayerId;
    const viewerColor =
      gameState && viewerId && viewerId !== 'spectator' ? gameState.playersById[viewerId]?.color ?? null : null;
    if (!viewerColor) {
      this.resourceBar.style.background = 'rgba(2, 6, 23, 0.97)';
      this.resourceBar.style.borderTopColor = 'rgba(71, 85, 105, 0.9)';
      this.resourceBar.style.boxShadow = '0 -2px 8px rgba(0,0,0,0.22)';
      return;
    }
    const rgb = hexToRgbComponents(viewerColor);
    if (!rgb) {
      this.resourceBar.style.background = 'rgba(2, 6, 23, 0.97)';
      this.resourceBar.style.borderTopColor = 'rgba(71, 85, 105, 0.9)';
      this.resourceBar.style.boxShadow = '0 -2px 8px rgba(0,0,0,0.22)';
      return;
    }
    this.resourceBar.style.background = `color-mix(in srgb, ${viewerColor} 52%, rgb(2, 6, 23))`;
    this.resourceBar.style.borderTopColor = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.78)`;
    this.resourceBar.style.boxShadow = `0 -2px 8px rgba(${rgb.r},${rgb.g},${rgb.b},0.14)`;
  }

  private renderChatMessages(): void {
    if (!this.chatMessagesContainer || !this.liveGameState) {
      return;
    }

    const gameState = this.liveGameState;
    const messages = gameState.chatMessages || [];
    const statusEntry = this.buildStatusInfoLine(gameState);
    const statusKey = `${gameState.turn.currentTurn ?? 0}|${statusEntry.activePlayerId ?? ''}|${gameState.turn.phase}|${statusEntry.text}`;
    if (this.lastStatusLogKey !== statusKey) {
      this.lastStatusLogKey = statusKey;
      this.statusChatLog.push({ timestampMs: Date.now(), text: statusEntry.text, activePlayerId: statusEntry.activePlayerId });
    }

    const combinedEntries: Array<
      | { kind: 'player'; timestampMs: number; message: typeof messages[number] }
      | { kind: 'info'; timestampMs: number; text: string; activePlayerId: string | null }
    > = [];
    messages.forEach((msg) => {
      const ts = Date.parse(msg.timestamp);
      combinedEntries.push({
        kind: 'player',
        timestampMs: Number.isFinite(ts) ? ts : 0,
        message: msg,
      });
    });
    this.statusChatLog.forEach((entry) => {
      combinedEntries.push({
        kind: 'info',
        timestampMs: entry.timestampMs,
        text: entry.text,
        activePlayerId: entry.activePlayerId,
      });
    });
    combinedEntries.sort((a, b) => a.timestampMs - b.timestampMs);

    this.chatMessagesContainer.innerHTML = '';
    combinedEntries.forEach((entry) => {
      const div = document.createElement('div');
      div.className = 'mb-1 leading-tight text-sm font-sans bg-slate-800/40 p-1 rounded';

      const timeString = this.formatChatTimestamp(entry.timestampMs);
      if (entry.kind === 'player') {
        const nameSpan = document.createElement('span');
        nameSpan.className = 'font-bold';
        const msgSpan = document.createElement('span');
        msgSpan.className = 'text-white';
        const sender = gameState.playersById[entry.message.senderId];
        const color = sender?.color || '#cbd5e1';
        const name = entry.message.senderName || 'Unknown';
        nameSpan.style.color = color;
        nameSpan.textContent = `${timeString} ${name}: `;
        msgSpan.textContent = entry.message.message || '[Empty Message]';
        div.appendChild(nameSpan);
        div.appendChild(msgSpan);
      } else {
        const infoPrefixSpan = document.createElement('span');
        infoPrefixSpan.className = 'font-bold';
        infoPrefixSpan.style.color = '#67e8f9';
        infoPrefixSpan.textContent = `${timeString} INFO: `;
        div.appendChild(infoPrefixSpan);

        const infoParts = this.formatStatusInfoForChat(entry.text);
        const beforeName = document.createElement('span');
        beforeName.className = 'text-white';
        beforeName.textContent = infoParts.beforeName;
        div.appendChild(beforeName);

        if (infoParts.playerName.length > 0) {
          const infoNameSpan = document.createElement('span');
          infoNameSpan.className = 'font-semibold';
          const infoPlayerColor = entry.activePlayerId ? gameState.playersById[entry.activePlayerId]?.color : null;
          infoNameSpan.style.color = infoPlayerColor || '#cbd5e1';
          infoNameSpan.textContent = infoParts.playerName;
          div.appendChild(infoNameSpan);
        }

        const afterName = document.createElement('span');
        afterName.className = 'text-white';
        afterName.textContent = infoParts.afterName;
        div.appendChild(afterName);
      }
      this.chatMessagesContainer?.appendChild(div);
    });

    this.chatMessagesContainer.scrollTop = this.chatMessagesContainer.scrollHeight;
  }

  private formatChatTimestamp(timestampMs: number): string {
    const date = Number.isFinite(timestampMs) ? new Date(timestampMs) : new Date();
    return `[${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}]`;
  }

  private buildStatusInfoLine(gameState: GameState): { text: string; activePlayerId: string | null } {
    const activePlayerId = gameState.turn.currentPlayerId;
    const activePlayer = activePlayerId ? gameState.playersById[activePlayerId] : null;
    const activeName = activePlayer?.displayName ?? 'Unknown player';
    const phase = gameState.turn.phase;
    const turnPrefix = `Turn ${gameState.turn.currentTurn ?? 0}: `;
    if (phase === 'ROLL') {
      return { text: `${turnPrefix}${activeName}'s turn to roll dice.`, activePlayerId: activePlayerId ?? null };
    }
    if (phase === 'ACTION') {
      return { text: `${turnPrefix}${activeName}'s action phase (build, trade, or end turn).`, activePlayerId: activePlayerId ?? null };
    }
    return { text: `${turnPrefix}${activeName} is in ${phase} phase.`, activePlayerId: activePlayerId ?? null };
  }

  private formatStatusInfoForChat(text: string): { beforeName: string; playerName: string; afterName: string } {
    const m = text.match(/^(Turn \d+:\s+)(.+?)(?:'s turn to roll dice\.|'s action phase \(build, trade, or end turn\)\.| is in .+ phase\.)$/);
    if (!m) {
      return { beforeName: text, playerName: '', afterName: '' };
    }
    const beforeName = m[1] ?? '';
    const playerName = m[2] ?? '';
    const afterName = text.slice((beforeName + playerName).length);
    return { beforeName, playerName, afterName };
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
      card.dataset.playerId = player.playerId;
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

  private getTileScreenPosition(tileId: string): { x: number; y: number } | null {
    const scene = this.mapScreen?.getPhaser3Scene?.();
    if (!scene || !this.buttonContainer) {
      return null;
    }
    const anyScene = scene as unknown as {
      cameras?: { main?: { worldView: { x: number; y: number }; zoom: number } };
      game?: { canvas?: HTMLCanvasElement };
    };
    const camera = anyScene.cameras?.main;
    const canvas = anyScene.game?.canvas;
    const tile = (this.liveGameState ?? clientState.gameState)?.board.tilesById[tileId];
    if (!camera || !canvas || !tile) {
      return null;
    }
    // Matches compact-fit map rendering in TestMapGenScreen/MapGenTest.
    const size = 34;
    const worldX = size * (1.5 * tile.coord.q);
    const worldY = size * ((Math.sqrt(3) / 2) * tile.coord.q + Math.sqrt(3) * tile.coord.r);
    const canvasX = (worldX - camera.worldView.x) * camera.zoom;
    const canvasY = (worldY - camera.worldView.y) * camera.zoom;
    const canvasRect = canvas.getBoundingClientRect();
    const parentRect = this.buttonContainer.getBoundingClientRect();
    return {
      x: canvasRect.left - parentRect.left + canvasX,
      y: canvasRect.top - parentRect.top + canvasY,
    };
  }

  private getPlayerCardScreenPosition(playerId: string): { x: number; y: number } | null {
    if (!this.playerPanel || !this.buttonContainer) {
      return null;
    }
    const card = this.playerPanel.querySelector(`[data-player-id="${playerId}"]`) as HTMLDivElement | null;
    if (!card) {
      return null;
    }
    const rect = card.getBoundingClientRect();
    const parentRect = this.buttonContainer.getBoundingClientRect();
    return {
      x: rect.left - parentRect.left + (rect.width / 2),
      y: rect.top - parentRect.top + (rect.height / 2),
    };
  }

  private maybeAnimateResourceDistribution(previousState: GameState | null, nextState: GameState | null): void {
    if (!previousState || !nextState) {
      return;
    }
    const previousRollAt = previousState.turn.lastDiceRoll?.rolledAt ?? null;
    const nextRoll = nextState.turn.lastDiceRoll;
    if (!nextRoll || nextRoll.rolledAt === previousRollAt) {
      return;
    }

    const gainsByPlayer = new Map<string, Partial<Record<ResourceKey, number>>>();
    nextState.playerOrder.forEach((playerId) => {
      const nextResources = nextState.playersById[playerId]?.resources;
      const prevResources = previousState.playersById[playerId]?.resources;
      if (!nextResources || !prevResources) {
        return;
      }
      RESOURCE_KEYS.forEach((resourceKey) => {
        const delta = inventoryCount(nextResources[resourceKey]) - inventoryCount(prevResources[resourceKey]);
        if (delta > 0) {
          const entry = gainsByPlayer.get(playerId) ?? {};
          entry[resourceKey] = (entry[resourceKey] ?? 0) + delta;
          gainsByPlayer.set(playerId, entry);
        }
      });
    });
    if (gainsByPlayer.size === 0) {
      return;
    }

    const grants = this.resolveResourceGrantsFromBoard(nextState, nextRoll.sum);
    console.log('[ResourcePopDebug] Grant resolution', {
      livePlayerId: this.livePlayerId,
      grantCount: grants.length,
      matchingLocalGrantCount: grants.filter((g) => g.playerId === this.livePlayerId).length,
    });
    let staggerIndex = 0;
    grants.forEach((grant) => {
      const playerTotals = gainsByPlayer.get(grant.playerId);
      if (!playerTotals) {
        return;
      }
      if ((playerTotals[grant.resource] ?? 0) <= 0) {
        return;
      }
      playerTotals[grant.resource] = Math.max(0, (playerTotals[grant.resource] ?? 0) - 1);
      const start = this.getTileScreenPosition(grant.tileId);
      const end = this.getPlayerCardScreenPosition(grant.playerId);
      if (!start || !end) {
        return;
      }
      this.spawnResourceParticle(grant.resource, start, end, staggerIndex);
      if (grant.playerId === this.livePlayerId) {
        this.queueResourceBarPop(grant.resource);
      }
      staggerIndex += 1;
    });
  }

  private queueResourceBarPop(resource: ResourceKey): void {
    this.pendingResourceBarPops.push(resource);
    requestAnimationFrame(() => this.flushPendingResourceBarPops());
  }

  private flushPendingResourceBarPops(): void {
    if (!this.resourceBarLeft || this.pendingResourceBarPops.length === 0) {
      return;
    }
    const queued = [...this.pendingResourceBarPops];
    this.pendingResourceBarPops = [];
    queued.forEach((resourceKey) => {
      const button = this.resourceBarLeft?.querySelector(
        `[data-resource-key="${resourceKey}"]`,
      ) as HTMLButtonElement | null;
      if (button) {
        console.log('[ResourcePopDebug] Popping resource button from grant event', { resource: resourceKey });
        this.animateResourceGainButton(button);
      }
    });
  }

  private resolveResourceGrantsFromBoard(
    gameState: GameState,
    diceSum: number,
  ): Array<{ tileId: string; playerId: string; resource: ResourceKey }> {
    const grants: Array<{ tileId: string; playerId: string; resource: ResourceKey }> = [];
    Object.values(gameState.board.tilesById).forEach((tile) => {
      if (tile.numberToken !== diceSum || tile.resourceType === 'DESERT') {
        return;
      }
      const resource = tile.resourceType as ResourceKey;
      const vertexIds = new Set(tile.vertices);
      Object.values(gameState.board.structuresById).forEach((structure) => {
        if (structure.type !== 'SETTLEMENT' && structure.type !== 'CITY') {
          return;
        }
        const vertexId = structure.vertex?.id;
        if (!vertexId || !vertexIds.has(vertexId)) {
          return;
        }
        const amount = structure.type === 'CITY' ? 2 : 1;
        for (let i = 0; i < amount; i += 1) {
          grants.push({ tileId: tile.tileId, playerId: structure.ownerPlayerId, resource });
        }
      });
    });
    return grants;
  }

  private spawnResourceParticle(
    resource: ResourceKey,
    start: { x: number; y: number },
    end: { x: number; y: number },
    staggerIndex: number,
  ): void {
    if (!this.resourceFxLayer) {
      return;
    }
    const cfg = RESOURCE_BOX_CONFIG.find((item) => item.key === resource);
    if (!cfg) {
      return;
    }

    const token = document.createElement('div');
    token.style.position = 'absolute';
    token.style.left = `${start.x}px`;
    token.style.top = `${start.y}px`;
    token.style.width = '24px';
    token.style.height = '24px';
    token.style.transform = 'translate(-50%, -50%) scale(0.75)';
    token.style.opacity = '0';
    token.style.filter = `drop-shadow(0 0 7px ${cfg.color})`;
    if (cfg.iconSrc) {
      const img = document.createElement('img');
      img.src = cfg.iconSrc;
      img.alt = '';
      img.draggable = false;
      img.style.width = '100%';
      img.style.height = '100%';
      img.style.objectFit = 'contain';
      token.appendChild(img);
    } else {
      token.style.borderRadius = '999px';
      token.style.border = `1px solid ${cfg.boxBorder}`;
      token.style.background = cfg.boxBg;
    }
    this.resourceFxLayer.appendChild(token);

    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const delayMs = Math.min(220, staggerIndex * 45);
    const timerId = window.setTimeout(() => {
      token.animate(
        [
          { transform: 'translate(-50%, -50%) scale(0.75)', opacity: 0 },
          { transform: 'translate(-50%, -50%) scale(1)', opacity: 1, offset: 0.15 },
          { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(0.95)`, opacity: 1, offset: 0.85 },
          { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(1.1)`, opacity: 0 },
        ],
        {
          duration: 3000,
          easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
          fill: 'forwards',
        },
      ).onfinish = () => token.remove();
    }, delayMs);
    this.activeResourceFxTimers.push(timerId);
  }

  private animateResourceGainButton(button: HTMLButtonElement): void {
    button.getAnimations().forEach((anim) => anim.cancel());
    button.style.transformOrigin = 'center center';
    button.style.transition =
      'transform 220ms cubic-bezier(0.16, 1, 0.3, 1), filter 220ms cubic-bezier(0.16, 1, 0.3, 1), box-shadow 220ms cubic-bezier(0.16, 1, 0.3, 1)';
    // Fallback visual pulse path: apply styles immediately, then settle back.
    button.style.transform = 'scale(1.4)';
    button.style.filter = 'brightness(1.35)';
    button.style.boxShadow = '0 0 0 2px rgba(250, 204, 21, 0.45), 0 0 16px rgba(250, 204, 21, 0.85)';
    const settleTimer = window.setTimeout(() => {
      button.style.transform = 'scale(1)';
      button.style.filter = 'brightness(1)';
      button.style.boxShadow = '0 0 0 rgba(0,0,0,0)';
    }, 260);
    this.activeResourceFxTimers.push(settleTimer);

    button.animate(
      [
        { transform: 'scale(1)', filter: 'brightness(1)', boxShadow: '0 0 0 rgba(0,0,0,0)' },
        {
          transform: 'scale(1.4)',
          filter: 'brightness(1.35)',
          boxShadow: '0 0 0 2px rgba(250, 204, 21, 0.45), 0 0 16px rgba(250, 204, 21, 0.85)',
          offset: 0.28,
        },
        {
          transform: 'scale(1.18)',
          filter: 'brightness(1.15)',
          boxShadow: '0 0 0 1px rgba(250, 204, 21, 0.32), 0 0 10px rgba(250, 204, 21, 0.45)',
          offset: 0.6,
        },
        { transform: 'scale(1)', filter: 'brightness(1)', boxShadow: '0 0 0 rgba(0,0,0,0)' },
      ],
      {
        duration: 950,
        easing: 'cubic-bezier(0.16, 1, 0.3, 1)',
      },
    );

    const iconEl = button.querySelector('img') as HTMLImageElement | null;
    if (iconEl) {
      iconEl.getAnimations().forEach((anim) => anim.cancel());
      iconEl.style.transition = 'transform 220ms cubic-bezier(0.16, 1, 0.3, 1)';
      iconEl.style.transform = 'scale(1.18) rotate(-7deg)';
      const iconSettleTimer = window.setTimeout(() => {
        iconEl.style.transform = 'scale(1) rotate(0deg)';
      }, 240);
      this.activeResourceFxTimers.push(iconSettleTimer);
      iconEl.animate(
        [
          { transform: 'scale(1) rotate(0deg)' },
          { transform: 'scale(1.18) rotate(-7deg)', offset: 0.3 },
          { transform: 'scale(1.08) rotate(5deg)', offset: 0.62 },
          { transform: 'scale(1) rotate(0deg)' },
        ],
        {
          duration: 900,
          easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
        },
      );
    }
  }

  private renderResourceBarFromGameState(): void {
    const gameState = this.liveGameState;
    if (!this.resourceBarLeft || !gameState) {
      return;
    }
    const previousRenderedCounts: Partial<Record<ResourceKey, number>> = this.lastRenderedResourceCounts ?? {};
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
    const gainedButtons: HTMLButtonElement[] = [];

    RESOURCE_BOX_CONFIG.forEach(
      ({ key, shortLabel, color, iconSrc, boxBg, boxBorder, boxHoverBg, countColor }) => {
        const owned = inventoryCount(player.resources[key]);
        const selected = inventoryCount(this.resourceSelection[key]);
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.dataset.resourceKey = key;
        btn.dataset.resourceCount = String(owned);
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
        const previousOwned = inventoryCount(previousRenderedCounts[key]);
        const delta = owned - previousOwned;
        console.log('[ResourcePopDebug] Resource bar delta check', {
          resource: key,
          previousOwned,
          owned,
          delta,
          shouldPop: delta > 0,
          playerId: viewerId,
        });
        if (delta > 0) {
          gainedButtons.push(btn);
        }
      },
    );
    this.lastRenderedResourceCounts = RESOURCE_KEYS.reduce((acc, key) => {
      acc[key] = inventoryCount(player.resources[key]);
      return acc;
    }, {} as Partial<Record<ResourceKey, number>>);
    if (gainedButtons.length > 0) {
      console.log('[ResourcePopDebug] Triggering pop animation for resource buttons', {
        count: gainedButtons.length,
        resources: gainedButtons.map((btn) => btn.dataset.resourceKey),
      });
      requestAnimationFrame(() => {
        gainedButtons.forEach((btn) => this.animateResourceGainButton(btn));
        this.flushPendingResourceBarPops();
      });
    } else {
      console.log('[ResourcePopDebug] No resource button pop triggered this render');
      this.flushPendingResourceBarPops();
    }
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
    const canBuildNow = canAffordCost(inventory, cost);

    const panel = document.createElement('div');
    panel.className =
      'font-hexahaven-ui pointer-events-auto max-w-[min(280px,calc(100vw-24px))] rounded-lg border border-slate-500 bg-slate-900/98 px-3 py-2.5 text-left text-white shadow-[0_8px_28px_rgba(0,0,0,0.55)]';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', `${label} recipe`);

    const title = document.createElement('div');
    title.className = 'font-semibold text-sm text-slate-100';
    title.textContent = label;
    panel.appendChild(title);

    const status = document.createElement('div');
    status.className = canBuildNow
      ? 'mt-2 rounded-md border border-emerald-500/60 bg-emerald-950/45 px-2 py-1.5 text-[11px] leading-snug text-emerald-100'
      : 'mt-2 rounded-md border border-amber-500/55 bg-amber-950/45 px-2 py-1.5 text-[11px] leading-snug text-amber-100';
    status.textContent = canBuildNow ? 'Ready to build!' : 'Not enough resources.';
    panel.appendChild(status);

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
    this.buildButtons = {};

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
      btn.dataset.tutorialAnchor = `build-${kind.toLowerCase()}`;
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
        if (kind === 'SETTLEMENT') {
          this.dismissTutorialPromptFromInteraction('SETTLEMENT');
        } else if (kind === 'ROAD') {
          this.dismissTutorialPromptFromInteraction('ROAD');
        } else if (kind === 'CITY') {
          this.dismissTutorialPromptFromInteraction('CITY');
        }
        const clickedSamePopoverButton = this.buildRecipePopoverEl && this.buildRecipePopoverAnchor === btn;
        if (clickedSamePopoverButton) {
          this.dismissBuildRecipePopover();
          return;
        }
        if (ready) {
          this.pendingBuild = this.pendingBuild?.kind === kind ? null : { kind, cost };
          this.updateMapDisplay();
        } else if (this.pendingBuild?.kind === kind) {
          this.pendingBuild = null;
          this.updateMapDisplay();
        }
        this.showBuildRecipePopover(btn, label, cost, player.resources);
      });
      this.buildButtons[kind] = btn;
      this.resourceBarRight?.appendChild(btn);
    });
    this.repositionTutorialPrompt();
  }

  private handleMapPlaceClick(hit: MapPointerHit): void {
    if (this.isGameOver) {
      return;
    }
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
      this.awaitingBuildAck = true;
      this.lastBuildAttemptedAtMs = Date.now();
      this.lastRejectedBuildToastKey = null;
      void buildStructure({
        gameId: roomId,
        kind,
        vertexId: hit.vertex.id,
      }).then(() => {
        playBuildPlacementSound(kind);
      }).catch((error) => {
        console.error('Structure build failed:', error);
        const rejected = clientState.lastActionRejected ?? {
          code: 'INTERNAL_ERROR' as const,
          message: error instanceof Error ? error.message : 'Illegal move! You cannot build there.',
        };
        this.handleRejectedBuildAction(rejected);
      }).finally(() => {
        this.awaitingBuildAck = false;
      });
      return;
    }

    if (!hit.edge) {
      return;
    }

    this.pendingBuild = null;
    this.dismissBuildRecipePopover();
    this.awaitingBuildAck = true;
    this.lastBuildAttemptedAtMs = Date.now();
    this.lastRejectedBuildToastKey = null;
    void buildStructure({
      gameId: roomId,
      kind,
      edgeId: hit.edge.id,
    }).then(() => {
      playBuildPlacementSound(kind);
    }).catch((error) => {
      console.error('Structure build failed:', error);
      const rejected = clientState.lastActionRejected ?? {
        code: 'INTERNAL_ERROR' as const,
        message: error instanceof Error ? error.message : 'Illegal move! You cannot build there.',
      };
      this.handleRejectedBuildAction(rejected);
    }).finally(() => {
      this.awaitingBuildAck = false;
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
        Object.values(gameState.board.tilesById),
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
      this.rollDiceButton.style.opacity = '1';
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
    this.refreshPlayerTradeUi();
    this.updateTurnTimerUi();
    this.repositionYourTurnToast();
    this.repositionTutorialPrompt();
    this.repositionIncomingTradeCard();
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
    if (this.isGameOver) {
      return;
    }
    this.dismissTutorialPromptFromInteraction('ROLL');
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
    if (this.isGameOver) {
      return;
    }
    this.dismissTutorialPromptFromInteraction('BANK_TRADE');
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
    if (this.isGameOver) {
      return;
    }
    this.dismissTutorialPromptFromInteraction('END_TURN');
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

  private openGameRulesPanel(): void {
    this.ensureGameRulesPanel();
    if (!this.gameRulesBackdrop) {
      return;
    }
    this.gameRulesBackdrop.style.display = 'flex';
    this.bindGameRulesKeydown();
  }

  private closeGameRulesPanel(): void {
    if (this.gameRulesBackdrop) {
      this.gameRulesBackdrop.style.display = 'none';
    }
    this.unbindGameRulesKeydown();
  }

  private bindGameRulesKeydown(): void {
    if (this.gameRulesKeydown) {
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        this.closeGameRulesPanel();
      }
    };
    document.addEventListener('keydown', onKey);
    this.gameRulesKeydown = onKey;
  }

  private unbindGameRulesKeydown(): void {
    if (this.gameRulesKeydown) {
      document.removeEventListener('keydown', this.gameRulesKeydown);
      this.gameRulesKeydown = null;
    }
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

    const rulesRow = document.createElement('div');
    rulesRow.style.marginTop = '16px';
    rulesRow.style.display = 'flex';

    const rulesBtn = document.createElement('button');
    rulesBtn.type = 'button';
    rulesBtn.textContent = 'Game Rules';
    rulesBtn.style.padding = '10px 16px';
    rulesBtn.style.fontSize = '14px';
    rulesBtn.style.fontWeight = '600';
    rulesBtn.style.color = '#ffffff';
    rulesBtn.style.background = 'rgba(30, 41, 59, 0.95)';
    rulesBtn.style.border = '1px solid rgba(255, 255, 255, 0.28)';
    rulesBtn.style.borderRadius = '8px';
    rulesBtn.style.cursor = 'pointer';
    rulesBtn.style.width = '100%';
    rulesBtn.addEventListener('click', () => {
      this.openGameRulesPanel();
    });
    rulesRow.appendChild(rulesBtn);

    const closeRow = document.createElement('div');
    closeRow.style.marginTop = '12px';
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
    panel.appendChild(rulesRow);
    panel.appendChild(closeRow);

    backdrop.appendChild(panel);
    backdrop.addEventListener('click', () => this.closeGameSettingsPanel());

    document.body.appendChild(backdrop);
    this.gameSettingsBackdrop = backdrop;
  }

  private ensureGameRulesPanel(): void {
    if (this.gameRulesBackdrop) {
      return;
    }

    const backdrop = document.createElement('div');
    backdrop.style.display = 'none';
    backdrop.style.position = 'fixed';
    backdrop.style.inset = '0';
    backdrop.style.zIndex = '110';
    backdrop.style.background = 'rgba(15, 23, 42, 0.72)';
    backdrop.style.alignItems = 'center';
    backdrop.style.justifyContent = 'center';
    backdrop.style.padding = '16px';

    const panel = document.createElement('div');
    panel.className = 'font-hexahaven-ui';
    panel.style.maxWidth = '820px';
    panel.style.width = '100%';
    panel.style.maxHeight = '86vh';
    panel.style.display = 'flex';
    panel.style.flexDirection = 'column';
    panel.style.background = 'rgba(15, 23, 42, 0.97)';
    panel.style.border = '1px solid rgba(148, 163, 184, 0.45)';
    panel.style.borderRadius = '12px';
    panel.style.boxShadow = '0 20px 50px rgba(0,0,0,0.45)';
    panel.addEventListener('click', (e) => e.stopPropagation());

    const title = document.createElement('h2');
    title.style.margin = '0';
    title.style.padding = '16px 20px 12px 20px';
    title.style.fontSize = '20px';
    title.style.fontWeight = '700';
    title.style.color = '#ffffff';
    title.style.borderBottom = '1px solid rgba(148, 163, 184, 0.35)';
    title.textContent = 'HexaHaven - Game Rules';

    const body = document.createElement('div');
    body.style.padding = '16px 20px';
    body.style.overflowY = 'auto';
    body.style.display = 'grid';
    body.style.gap = '14px';
    body.style.color = '#e2e8f0';
    body.style.fontSize = '16px';
    body.style.lineHeight = '1.65';
    body.style.fontFamily = '"CSRobert Mono Demo", monospace';

    const buildCostRows: { item: string; cost: string; iconSrc: string }[] = [
      { item: 'Road', cost: 'ember + stone', iconSrc: '/images/buildings/road.png' },
      { item: 'Settlement', cost: 'ember + bloom + stone', iconSrc: '/images/buildings/settlement.png' },
      { item: 'City', cost: '3 stone + 2 bloom', iconSrc: '/images/buildings/city.png' },
      { item: 'Dev Card', cost: '2 crystal + 2 gold', iconSrc: '/images/buildings/dev-card.png' },
    ];

    const buildingRuleRows: { label: string; text: string; iconSrc: string }[] = [
      {
        label: 'Roads',
        text: "Must connect to your network and cannot pass through another player's settlement.",
        iconSrc: '/images/buildings/road.png',
      },
      {
        label: 'Settlements',
        text: 'Must connect to your road and follow the distance rule.',
        iconSrc: '/images/buildings/settlement.png',
      },
      {
        label: 'Cities',
        text: 'Replace settlements and produce 2 resources.',
        iconSrc: '/images/buildings/city.png',
      },
    ];

    const resources: { label: string; iconSrc: string }[] = [
      { label: 'Ember', iconSrc: '/images/resources/ember.png' },
      { label: 'Stone', iconSrc: '/images/resources/stone.png' },
      { label: 'Bloom', iconSrc: '/images/resources/bloom.png' },
      { label: 'Crystal', iconSrc: '/images/resources/crystal.png' },
      { label: 'Gold', iconSrc: '/images/resources/gold.png' },
    ];

    const victoryPointRows: { label: string; value: string; iconSrc: string }[] = [
      { label: 'Settlement', value: '1 VP', iconSrc: '/images/buildings/settlement.png' },
      { label: 'City', value: '2 VP', iconSrc: '/images/buildings/city.png' },
      { label: 'Longest Road', value: '2 VP (minimum 5 roads)', iconSrc: '/images/buildings/road.png' },
      { label: 'VP Card', value: '1 VP each', iconSrc: '/images/buildings/dev-card.png' },
    ];

    const sections: { heading: string; lines: string[] }[] = [
      { heading: 'Objective', lines: ['First to 10 Victory Points (VP) wins.'] },
      {
        heading: 'Rolling',
        lines: [
          'Roll 2 dice at the start of your turn.',
          'Tiles matching the rolled number produce resources for adjacent buildings.',
          'Settlements produce 1 resource; cities produce 2 resources.',
        ],
      },
      {
        heading: 'Trading',
        lines: [
          'Trade with other players if they agree.',
          'Trade with the bank at 4 of the same resource for 1 of any resource.',
          'Complete trades before or after building during your turn.',
        ],
      },
    ];

    sections.forEach(({ heading, lines }) => {
      const section = document.createElement('section');
      const h = document.createElement('h3');
      h.style.margin = '0 0 6px 0';
      h.style.fontSize = '15px';
      h.style.fontWeight = '700';
      h.style.fontFamily = '"04B_30__", monospace';
      h.style.textTransform = 'uppercase';
      h.style.letterSpacing = '0.06em';
      h.style.color = '#fde68a';
      h.textContent = heading;
      section.appendChild(h);
      const ul = document.createElement('ul');
      ul.style.margin = '0';
      ul.style.paddingLeft = '18px';
      ul.style.display = 'grid';
      ul.style.gap = '4px';
      lines.forEach((line) => {
        const li = document.createElement('li');
        li.textContent = line;
        ul.appendChild(li);
      });
      section.appendChild(ul);
      body.appendChild(section);
    });

    const buildCostsSection = document.createElement('section');
    const buildCostsHeading = document.createElement('h3');
    buildCostsHeading.style.margin = '0 0 6px 0';
    buildCostsHeading.style.fontSize = '15px';
    buildCostsHeading.style.fontWeight = '700';
    buildCostsHeading.style.fontFamily = '"04B_30__", monospace';
    buildCostsHeading.style.textTransform = 'uppercase';
    buildCostsHeading.style.letterSpacing = '0.06em';
    buildCostsHeading.style.color = '#fde68a';
    buildCostsHeading.textContent = 'Build Costs';
    buildCostsSection.appendChild(buildCostsHeading);
    const buildCostsList = document.createElement('div');
    buildCostsList.style.display = 'grid';
    buildCostsList.style.gap = '8px';
    buildCostRows.forEach(({ item, cost, iconSrc }) => {
      const row = document.createElement('div');
      row.style.display = 'flex';
      row.style.alignItems = 'center';
      row.style.gap = '10px';
      const icon = document.createElement('img');
      icon.src = iconSrc;
      icon.alt = `${item} icon`;
      icon.style.width = '24px';
      icon.style.height = '24px';
      icon.style.objectFit = 'contain';
      const text = document.createElement('span');
      text.textContent = `${item}: ${cost}`;
      row.appendChild(icon);
      row.appendChild(text);
      buildCostsList.appendChild(row);
    });
    buildCostsSection.appendChild(buildCostsList);
    body.appendChild(buildCostsSection);

    const buildingRulesVisualSection = document.createElement('section');
    const buildingRulesVisualHeading = document.createElement('h3');
    buildingRulesVisualHeading.style.margin = '0 0 6px 0';
    buildingRulesVisualHeading.style.fontSize = '15px';
    buildingRulesVisualHeading.style.fontWeight = '700';
    buildingRulesVisualHeading.style.fontFamily = '"04B_30__", monospace';
    buildingRulesVisualHeading.style.textTransform = 'uppercase';
    buildingRulesVisualHeading.style.letterSpacing = '0.06em';
    buildingRulesVisualHeading.style.color = '#fde68a';
    buildingRulesVisualHeading.textContent = 'Building Rules';
    buildingRulesVisualSection.appendChild(buildingRulesVisualHeading);
    const buildingRuleList = document.createElement('div');
    buildingRuleList.style.display = 'grid';
    buildingRuleList.style.gap = '8px';
    buildingRuleRows.forEach(({ label, text, iconSrc }) => {
      const row = document.createElement('div');
      row.style.display = 'flex';
      row.style.alignItems = 'flex-start';
      row.style.gap = '10px';
      const icon = document.createElement('img');
      icon.src = iconSrc;
      icon.alt = `${label} icon`;
      icon.style.width = '24px';
      icon.style.height = '24px';
      icon.style.objectFit = 'contain';
      const line = document.createElement('span');
      line.textContent = `${label}: ${text}`;
      row.appendChild(icon);
      row.appendChild(line);
      buildingRuleList.appendChild(row);
    });
    buildingRulesVisualSection.appendChild(buildingRuleList);
    body.appendChild(buildingRulesVisualSection);

    const resourcesSection = document.createElement('section');
    const resourcesHeading = document.createElement('h3');
    resourcesHeading.style.margin = '0 0 6px 0';
    resourcesHeading.style.fontSize = '15px';
    resourcesHeading.style.fontWeight = '700';
    resourcesHeading.style.fontFamily = '"04B_30__", monospace';
    resourcesHeading.style.textTransform = 'uppercase';
    resourcesHeading.style.letterSpacing = '0.06em';
    resourcesHeading.style.color = '#fde68a';
    resourcesHeading.textContent = 'Resources';
    resourcesSection.appendChild(resourcesHeading);
    const resourcesGrid = document.createElement('div');
    resourcesGrid.style.display = 'grid';
    resourcesGrid.style.gridTemplateColumns = 'repeat(auto-fit, minmax(120px, 1fr))';
    resourcesGrid.style.gap = '8px';
    resources.forEach(({ label, iconSrc }) => {
      const tile = document.createElement('div');
      tile.style.display = 'flex';
      tile.style.alignItems = 'center';
      tile.style.gap = '8px';
      tile.style.padding = '6px 8px';
      tile.style.border = '1px solid rgba(148, 163, 184, 0.35)';
      tile.style.borderRadius = '8px';
      tile.style.background = 'rgba(30, 41, 59, 0.55)';
      const icon = document.createElement('img');
      icon.src = iconSrc;
      icon.alt = `${label} resource icon`;
      icon.style.width = '20px';
      icon.style.height = '20px';
      icon.style.objectFit = 'contain';
      const text = document.createElement('span');
      text.textContent = label;
      tile.appendChild(icon);
      tile.appendChild(text);
      resourcesGrid.appendChild(tile);
    });
    resourcesSection.appendChild(resourcesGrid);
    body.appendChild(resourcesSection);

    const vpVisualSection = document.createElement('section');
    const vpHeading = document.createElement('h3');
    vpHeading.style.margin = '0 0 6px 0';
    vpHeading.style.fontSize = '15px';
    vpHeading.style.fontWeight = '700';
    vpHeading.style.fontFamily = '"04B_30__", monospace';
    vpHeading.style.textTransform = 'uppercase';
    vpHeading.style.letterSpacing = '0.06em';
    vpHeading.style.color = '#fde68a';
    vpHeading.textContent = 'Victory Points';
    vpVisualSection.appendChild(vpHeading);
    const vpList = document.createElement('div');
    vpList.style.display = 'grid';
    vpList.style.gap = '8px';
    victoryPointRows.forEach(({ label, value, iconSrc }) => {
      const row = document.createElement('div');
      row.style.display = 'flex';
      row.style.alignItems = 'center';
      row.style.gap = '10px';
      const icon = document.createElement('img');
      icon.src = iconSrc;
      icon.alt = `${label} icon`;
      icon.style.width = '24px';
      icon.style.height = '24px';
      icon.style.objectFit = 'contain';
      const text = document.createElement('span');
      text.textContent = `${label}: ${value}`;
      row.appendChild(icon);
      row.appendChild(text);
      vpList.appendChild(row);
    });
    vpVisualSection.appendChild(vpList);
    body.appendChild(vpVisualSection);

    const footer = document.createElement('div');
    footer.style.padding = '12px 20px 16px 20px';
    footer.style.display = 'flex';
    footer.style.justifyContent = 'flex-end';
    footer.style.borderTop = '1px solid rgba(148, 163, 184, 0.3)';

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.textContent = 'Back to Game';
    closeBtn.style.padding = '8px 16px';
    closeBtn.style.fontSize = '14px';
    closeBtn.style.fontWeight = '600';
    closeBtn.style.color = '#ffffff';
    closeBtn.style.background = 'rgba(51, 65, 85, 0.95)';
    closeBtn.style.border = '1px solid rgba(255, 255, 255, 0.35)';
    closeBtn.style.borderRadius = '8px';
    closeBtn.style.cursor = 'pointer';
    closeBtn.addEventListener('click', () => this.closeGameRulesPanel());

    footer.appendChild(closeBtn);
    panel.appendChild(title);
    panel.appendChild(body);
    panel.appendChild(footer);
    backdrop.appendChild(panel);
    backdrop.addEventListener('click', () => this.closeGameRulesPanel());

    document.body.appendChild(backdrop);
    this.gameRulesBackdrop = backdrop;
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
    this.activeResourceFxTimers.forEach((timerId) => clearTimeout(timerId));
    this.activeResourceFxTimers = [];
    this.pendingResourceBarPops = [];
    this.clearTradeNoticeTimers();
    this.clearIncomingTradeCountdownTimer();
    this.unbindPlayerTradeSocketEvents();
    this.clearBuildRejectToastTimers();
    this.clearYourTurnToastTimers();
    if (this.tutorialPromptCleanupTimer !== null) {
      clearTimeout(this.tutorialPromptCleanupTimer);
      this.tutorialPromptCleanupTimer = null;
    }
    if (this.buildRejectToastEl) {
      this.buildRejectToastEl.remove();
      this.buildRejectToastEl = null;
    }
    this.buildRejectToastTextEl = null;
    if (this.yourTurnToastEl) {
      this.yourTurnToastEl.remove();
      this.yourTurnToastEl = null;
    }
    this.yourTurnToastTextEl = null;
    this.lastYourTurnToastKey = null;
    if (this.tutorialOverlayEl) {
      this.tutorialOverlayEl.remove();
      this.tutorialOverlayEl = null;
    }
    this.tutorialPromptEl = null;
    this.tutorialPromptArrowEl = null;
    this.tutorialPromptBubbleEl = null;
    this.tutorialPromptBubbleTextEl = null;
    this.shownTutorialPromptKey = null;
    this.shownTutorialPromptTarget = null;
    this.dismissedTutorialPromptKey = null;
    this.lastRejectedBuildToastKey = null;
    this.awaitingBuildAck = false;
    this.lastBuildAttemptedAtMs = 0;
    if (this.resourceFxLayer) {
      this.resourceFxLayer.remove();
      this.resourceFxLayer = null;
    }
    this.dismissBuildRecipePopover();
    this.closeGameSettingsPanel();
    this.closeGameRulesPanel();
    this.closeWinnerOverlay();
    if (this.gameSettingsBackdrop) {
      this.gameSettingsBackdrop.remove();
      this.gameSettingsBackdrop = null;
    }
    if (this.gameRulesBackdrop) {
      this.gameRulesBackdrop.remove();
      this.gameRulesBackdrop = null;
    }
    this.gameSettingsBoardMusicRange = null;
    this.gameSettingsBoardMusicValueEl = null;
    this.gameSettingsGameSfxRange = null;
    this.gameSettingsGameSfxValueEl = null;
    window.removeEventListener(SETTINGS_CHANGED_EVENT, this.onSettingsChanged);
    window.removeEventListener('resize', this.onWindowResize);
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
    this.tutorialToggleButton = null;
    if (this.musicToggleButton) {
      this.musicToggleButton.remove();
      this.musicToggleButton = null;
    }
    if (this.playerPanel) {
      this.playerPanel.remove();
      this.playerPanel = null;
    }
    if (this.incomingTradeCard) {
      this.incomingTradeCard.remove();
      this.incomingTradeCard = null;
    }
    this.incomingTradeSenderTextEl = null;
    this.incomingTradeOfferTextEl = null;
    this.incomingTradeRequestTextEl = null;
    this.incomingTradeProgressFillEl = null;
    this.incomingTradeAcceptButton = null;
    this.incomingTradeDenyButton = null;
    this.incomingTradeRequest = null;
    this.isRespondingToTradeRequest = false;
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
    this.tradeTabsBankButton = null;
    this.tradeTabsPlayerButton = null;
    this.tradeBankContent = null;
    this.tradePlayerContent = null;
    this.tradePlayerBody = null;
    this.tradeNoticeEl = null;
    this.tradePanelTab = 'BANK';
    this.buildButtons = {};
    this.bankGiveButtons = {};
    this.bankReceiveButtons = {};
    this.bankGiveSelection = 'EMBER';
    this.bankReceiveSelection = 'STONE';
    this.playerTradeTargetPlayerId = null;
    this.playerTradeOfferSelection = emptyResourceBundle();
    this.playerTradeRequestSelection = emptyResourceBundle();
    this.pendingOutgoingTradeIds.clear();
    this.isSendingPlayerTradeRequest = false;
    this.buttonContainer = null;
    if (this.chatPanel) {
      this.chatPanel.remove();
      this.chatPanel = null;
    }
    this.chatMessagesContainer = null;
    this.chatInput = null;
    this.statusChatLog = [];
    this.lastStatusLogKey = null;
    this.lastAnnouncedWinnerPlayerId = null;
    this.isGameOver = false;
    this.navigateToScreen = null;
    this.mapScreen?.destroy();
    this.mapScreen = null;
    this.liveGameState = null;
    this.livePlayerId = null;
    this.lastRenderedResourceCounts = null;
    this.pendingBuild = null;
    this.resourceSelection = emptyResourceBundle();
  }
}
