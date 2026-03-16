import type { ScreenId } from '../../shared/constants/screenIds';
import { EntryScreen } from '../screens/EntryScreen';
import { GameBoardScreen } from '../screens/GameBoardScreen';
import { HostGameScreen } from '../screens/HostGameScreen';
import { JoinGameScreen } from '../screens/JoinGameScreen';
import { MainMenuScreen } from '../screens/MainMenuScreen';
import { SettingsScreen } from '../screens/SettingsScreen';
import { TestMapGenScreen } from '../screens/TestMapGenScreen';
import { WaitingRoomScreen } from '../screens/WaitingRoomScreen';
import { WatchGameScreen } from '../screens/WatchGameScreen';
import { getScreen, registerScreen } from './ScreenRegistry';

export class App {
  private currentScreen: any = null;

  constructor(private root: HTMLElement) {
    this.initializeScreens();
  }

  private initializeScreens(): void {
    registerScreen('entry', new EntryScreen());
    registerScreen('main-menu', new MainMenuScreen());
    registerScreen('host-game', new HostGameScreen());
    registerScreen('join-game', new JoinGameScreen());
    registerScreen('watch-game', new WatchGameScreen());
    registerScreen('waiting-room', new WaitingRoomScreen());
    registerScreen('game-board', new GameBoardScreen());
    registerScreen('settings', new SettingsScreen());
    registerScreen('test-map-gen', new TestMapGenScreen());
  }

  start(): void {
    this.root.dataset.ready = 'true';
    // Start with entry screen, transition to main menu after loading
    this.showScreen('entry', () => this.showScreen('main-menu'));
  }

  showScreen(screenId: ScreenId, onComplete?: () => void): void {
    // Cleanup previous screen
    if (this.currentScreen?.destroy) {
      this.currentScreen.destroy();
    }

    // Get and render new screen
    const screen = getScreen(screenId);
    if (screen) {
      this.currentScreen = screen;
      const navigate = (nextScreenId: ScreenId) => this.showScreen(nextScreenId);
      if (typeof screen.render === 'function') {
        screen.render(this.root, onComplete, navigate);
      }
    }
  }
}
