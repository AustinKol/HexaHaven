import { ScreenId } from '../../shared/constants/screenIds';
import { createMusicToggleButton } from '../ui/musicToggleButton';

const RULES_SECTIONS = [
  {
    heading: 'Objective',
    body: 'Be the first player to collect 10 Victory Points (VP). Earn VP by building settlements (1 VP), upgrading them to cities (2 VP), and through special achievements and Development Cards.',
  },
  {
    heading: 'Setup',
    body: 'The island of Hexahaven is made up of 19 hex tiles arranged randomly, each producing a different resource. Each hex (except the desert) is assigned a number token. Players start with 2 settlements and 2 roads placed on the board.',
  },
  {
    heading: 'Turn Structure',
    body: 'Each turn has three phases: (1) Roll both dice — all players collect resources for settlements and cities adjacent to hexes matching the roll. (2) Trade — swap resources with other players or the bank. (3) Build — spend resources to build roads, settlements, cities, or buy Development Cards.',
  },
  {
    heading: 'Resources',
    body: 'There are 5 resources: Lumber (forest), Brick (hills), Wool (pasture), Grain (fields), and Ore (mountains). The desert produces no resources and is where the Robber starts.',
  },
  {
    heading: 'Building Costs',
    body: 'Road: 1 Lumber + 1 Brick. Settlement: 1 Lumber + 1 Brick + 1 Wool + 1 Grain (must connect to your existing road and not be adjacent to another settlement). City: 2 Grain + 3 Ore (replaces a settlement, produces double resources). Development Card: 1 Ore + 1 Wool + 1 Grain.',
  },
  {
    heading: 'Development Cards',
    body: 'Knight: Move the Robber and steal a card (does not trigger the 7-card discard rule). Victory Point: worth 1 VP — keep it secret until you win. Road Building: place 2 free roads. Year of Plenty: take any 2 resources from the bank. Monopoly: name a resource and take all of that resource from every other player.',
  },
  {
    heading: 'Largest Army',
    body: 'The first player to play 3 Knight cards claims the Largest Army card, worth 2 VP. Any other player who plays more Knights than the current holder takes the card (and its VP).',
  },
  {
    heading: 'Longest Road',
    body: 'The first player to build a continuous road of at least 5 segments claims the Longest Road card, worth 2 VP. Another player who builds a longer continuous road takes it.',
  },
  {
    heading: 'Winning',
    body: 'The game ends immediately when any player reaches 10 VP on their own turn, including VP from Development Cards revealed at that moment. That player wins!',
  },
];

export class RulesScreen {
  readonly id = ScreenId.Rules;
  private container: HTMLElement | null = null;
  private navigate: ((screenId: ScreenId) => void) | null = null;

  render(parentElement: HTMLElement, _onComplete?: () => void, navigate?: (screenId: ScreenId) => void): void {
    this.navigate = navigate ?? null;
    parentElement.innerHTML = '';

    // ── Root ───────────────────────────────────────────────────────────
    this.container = document.createElement('div');
    this.container.className =
      'relative flex items-center justify-center w-full h-full bg-gradient-to-b from-slate-900 to-slate-950';

    // ── Panel ──────────────────────────────────────────────────────────
    const panel = document.createElement('div');
    panel.className =
      'relative flex flex-col bg-white rounded-2xl shadow-2xl w-[620px] max-h-[80vh]';

    // Header (fixed inside panel)
    const header = document.createElement('div');
    header.className = 'flex-shrink-0 px-12 pt-10 pb-4 border-b border-slate-200';

    const title = document.createElement('h1');
    title.className = 'font-hexahaven-ui text-3xl font-bold text-slate-900 tracking-wide uppercase text-center';
    title.textContent = 'How to Play';
    header.appendChild(title);
    panel.appendChild(header);

    // Scrollable content
    const scrollArea = document.createElement('div');
    scrollArea.className = 'flex-1 overflow-y-auto px-12 py-6 space-y-6';

    RULES_SECTIONS.forEach(({ heading, body }) => {
      const section = document.createElement('div');

      const h = document.createElement('h2');
      h.className = 'font-hexahaven-ui text-base font-bold text-slate-800 mb-1 uppercase tracking-wide';
      h.textContent = heading;

      const p = document.createElement('p');
      p.className = 'font-hexahaven-ui text-sm text-slate-600 leading-relaxed';
      p.textContent = body;

      section.appendChild(h);
      section.appendChild(p);
      scrollArea.appendChild(section);
    });

    panel.appendChild(scrollArea);

    // Footer (fixed inside panel)
    const footer = document.createElement('div');
    footer.className = 'flex-shrink-0 flex justify-end px-12 py-5 border-t border-slate-200';

    const goBackBtn = document.createElement('button');
    goBackBtn.className =
      'font-hexahaven-ui px-6 py-2 text-sm font-semibold rounded-lg bg-slate-200 text-slate-700 hover:bg-slate-300 active:bg-slate-400 transition-all duration-150 cursor-pointer';
    goBackBtn.textContent = 'Go back';
    goBackBtn.addEventListener('click', () => {
      this.navigate?.(ScreenId.MainMenu);
    });

    footer.appendChild(goBackBtn);
    panel.appendChild(footer);

    this.container.appendChild(panel);
    this.container.appendChild(createMusicToggleButton());
    parentElement.appendChild(this.container);
  }

  destroy(): void {
    if (this.container) {
      this.container.remove();
      this.container = null;
    }
  }
}
