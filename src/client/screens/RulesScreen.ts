import { ScreenId } from '../../shared/constants/screenIds';
import { createMusicToggleButton } from '../ui/musicToggleButton';

type RulesBlock =
  | { kind: 'p'; text: string }
  | { kind: 'ul'; items: string[] }
  | { kind: 'ol'; items: string[] }
  | { kind: 'table'; rows: { item: string; cost: string }[] };

const RULES_SECTIONS: { heading: string; blocks: RulesBlock[] }[] = [
  {
    heading: 'Objective',
    blocks: [{ kind: 'p', text: 'First to 10 Victory Points (VP) wins.' }],
  },
  {
    heading: 'Setup',
    blocks: [
      {
        kind: 'ul',
        items: [
          'Each player places 1 settlement + 1 road, then repeats (same order).',
          'Settlements: at least 2 edges apart. Roads: must connect to your settlement.',
          'Gain 1 resource per hex next to your second settlement.',
        ],
      },
    ],
  },
  {
    heading: 'Turn',
    blocks: [
      {
        kind: 'ol',
        items: [
          'Roll: Roll 2 dice. Matching tiles produce resources (settlement = 1, city = 2). If no one has that number, nothing happens.',
          'Trade: Trade with players. Bank: 4 same → 1 of your choice.',
          'Build: Spend resources using the costs below.',
        ],
      },
      {
        kind: 'table',
        rows: [
          { item: 'Road', cost: 'ember + stone' },
          { item: 'Settlement', cost: 'ember + bloom + stone' },
          { item: 'City', cost: '3 stone + 2 bloom' },
          { item: 'Dev Card', cost: '2 crystal + 2 gold' },
        ],
      },
    ],
  },
  {
    heading: 'Building Rules',
    blocks: [
      {
        kind: 'ul',
        items: [
          'Roads: connect to your network; cannot pass through another player\'s settlement.',
          'Settlements: connect to your road; follow distance rule.',
          'Cities: replace a settlement; produce 2 resources.',
        ],
      },
    ],
  },
  {
    heading: 'Development Cards',
    blocks: [
      {
        kind: 'ul',
        items: [
          'Types: VP (+1), Road Building (2 roads), Year of Plenty (any 2), Monopoly (take all of one).',
          'Cannot use the turn you buy (except VP).',
        ],
      },
    ],
  },
  {
    heading: 'Victory Points',
    blocks: [
      {
        kind: 'p',
        text: 'Settlement = 1, City = 2, Longest Road = 2 (min 5), VP cards = 1 each.',
      },
    ],
  },
  {
    heading: 'End',
    blocks: [{ kind: 'p', text: 'Reach 10 VP on your turn to win.' }],
  },
];

export class RulesScreen {
  readonly id = ScreenId.Rules;
  private container: HTMLElement | null = null;
  private navigate: ((screenId: ScreenId) => void) | null = null;

  render(parentElement: HTMLElement, _onComplete?: () => void, navigate?: (screenId: ScreenId) => void): void {
    this.navigate = navigate ?? null;
    parentElement.innerHTML = '';

    this.container = document.createElement('div');
    this.container.className =
      'relative flex flex-col items-center justify-center w-full h-full overflow-hidden bg-gradient-to-b from-slate-900 to-slate-950';

    const backgroundVideo = document.createElement('video');
    backgroundVideo.className = 'absolute inset-0 w-full h-full object-cover';
    backgroundVideo.autoplay = true;
    backgroundVideo.loop = true;
    backgroundVideo.muted = true;
    backgroundVideo.playsInline = true;
    backgroundVideo.setAttribute('aria-hidden', 'true');

    const videoSource = document.createElement('source');
    videoSource.src = '/videos/welcome-bg.mp4';
    videoSource.type = 'video/mp4';
    backgroundVideo.appendChild(videoSource);

    const overlay = document.createElement('div');
    overlay.className = 'absolute inset-0 bg-slate-950/50';

    const content = document.createElement('div');
    content.className =
      'relative z-10 flex flex-col items-center justify-center w-full h-full px-4 py-8 min-h-0';

    const panel = document.createElement('div');
    panel.className =
      'flex flex-col w-full max-w-2xl max-h-[85vh] rounded-2xl border border-slate-600/40 bg-slate-900/75 backdrop-blur-md shadow-2xl';

    const header = document.createElement('div');
    header.className = 'flex-shrink-0 px-8 pt-8 pb-4 border-b border-slate-600/40';

    const title = document.createElement('h1');
    title.className =
      'font-hexahaven-title text-3xl sm:text-4xl font-bold text-white tracking-wide text-center drop-shadow-md';
    title.textContent = 'HexaHaven – Rules';
    header.appendChild(title);
    panel.appendChild(header);

    const scrollArea = document.createElement('div');
    scrollArea.className = 'flex-1 overflow-y-auto min-h-0 px-8 py-6 space-y-6';

    const appendBlock = (parent: HTMLElement, block: RulesBlock): void => {
      if (block.kind === 'p') {
        const p = document.createElement('p');
        p.className = 'font-hexahaven-rules-body text-lg text-slate-200/95 leading-relaxed';
        p.textContent = block.text;
        parent.appendChild(p);
        return;
      }
      if (block.kind === 'ul') {
        const ul = document.createElement('ul');
        ul.className = 'font-hexahaven-rules-body text-lg text-slate-200/95 list-disc pl-5 space-y-2';
        block.items.forEach((item) => {
          const li = document.createElement('li');
          li.className = 'leading-relaxed';
          li.textContent = item;
          ul.appendChild(li);
        });
        parent.appendChild(ul);
        return;
      }
      if (block.kind === 'ol') {
        const ol = document.createElement('ol');
        ol.className = 'font-hexahaven-rules-body text-lg text-slate-200/95 list-decimal pl-5 space-y-2';
        block.items.forEach((item) => {
          const li = document.createElement('li');
          li.className = 'leading-relaxed';
          li.textContent = item;
          ol.appendChild(li);
        });
        parent.appendChild(ol);
        return;
      }
      const table = document.createElement('table');
      table.className =
        'w-full text-left border-collapse font-hexahaven-rules-body text-base sm:text-lg text-slate-200/95 mt-2';
      const thead = document.createElement('thead');
      const hr = document.createElement('tr');
      hr.className = 'border-b border-slate-600/60';
      const thItem = document.createElement('th');
      thItem.className = 'py-2 pr-4 font-normal';
      thItem.textContent = 'Item';
      const thCost = document.createElement('th');
      thCost.className = 'py-2 font-normal';
      thCost.textContent = 'Cost';
      hr.appendChild(thItem);
      hr.appendChild(thCost);
      thead.appendChild(hr);
      table.appendChild(thead);
      const tbody = document.createElement('tbody');
      block.rows.forEach((row) => {
        const tr = document.createElement('tr');
        tr.className = 'border-b border-slate-700/50';
        const tdItem = document.createElement('td');
        tdItem.className = 'py-2 pr-4 align-top';
        tdItem.textContent = row.item;
        const tdCost = document.createElement('td');
        tdCost.className = 'py-2 align-top';
        tdCost.textContent = row.cost;
        tr.appendChild(tdItem);
        tr.appendChild(tdCost);
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      parent.appendChild(table);
    };

    RULES_SECTIONS.forEach(({ heading, blocks }) => {
      const section = document.createElement('div');
      const h = document.createElement('h2');
      h.className =
        'font-hexahaven-ui text-sm font-bold text-amber-100/95 mb-3 uppercase tracking-wide drop-shadow-sm';
      h.textContent = heading;
      section.appendChild(h);
      blocks.forEach((b) => appendBlock(section, b));
      scrollArea.appendChild(section);
    });

    panel.appendChild(scrollArea);

    const footer = document.createElement('div');
    footer.className = 'flex-shrink-0 flex justify-center px-8 py-5 border-t border-slate-600/40';

    const goBackBtn = document.createElement('button');
    goBackBtn.className =
      'font-hexahaven-ui px-8 py-3 font-semibold rounded-lg transition-all duration-200 cursor-pointer hover:shadow-lg bg-slate-700 text-white hover:bg-slate-600 active:bg-slate-800';
    goBackBtn.textContent = 'Go back';
    goBackBtn.addEventListener('click', () => {
      this.navigate?.(ScreenId.MainMenu);
    });

    footer.appendChild(goBackBtn);
    panel.appendChild(footer);

    content.appendChild(panel);

    this.container.appendChild(backgroundVideo);
    this.container.appendChild(overlay);
    this.container.appendChild(content);
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
