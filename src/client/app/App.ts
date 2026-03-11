import type { ScreenId } from '../../shared/constants/screenIds';
import { EntryScreen } from '../screens/EntryScreen';
import { MainMenuScreen } from '../screens/MainMenuScreen';
import { TestMapGenScreen } from '../screens/TestMapGenScreen';
import { getScreen, registerScreen } from './ScreenRegistry';

export class App {
  private currentScreen: any = null;

  constructor(private root: HTMLElement) {
    this.initializeScreens();
  }

  private initializeScreens(): void {
    registerScreen('entry', new EntryScreen());
    registerScreen('main-menu', new MainMenuScreen());
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
