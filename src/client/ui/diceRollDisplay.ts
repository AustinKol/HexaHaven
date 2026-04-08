import type { DiceRoll } from '../../shared/types/domain';

/** Cell indices in a 3×3 grid (reading order). */
const PIP_CELLS: Record<number, number[]> = {
  1: [4],
  2: [0, 8],
  3: [0, 4, 8],
  4: [0, 2, 6, 8],
  5: [0, 2, 4, 6, 8],
  6: [0, 2, 3, 5, 6, 8],
};

function clampDie(n: number): number {
  if (!Number.isFinite(n)) return 1;
  return Math.min(6, Math.max(1, Math.floor(n)));
}

function buildDieFace(): { el: HTMLDivElement; setValue: (v: number) => void } {
  const el = document.createElement('div');
  el.className =
    'hexahaven-die-face grid grid-cols-3 grid-rows-3 gap-0.5 p-1.5 w-[44px] h-[44px] shrink-0 rounded-lg border-2 border-slate-500 bg-gradient-to-br from-slate-100 to-slate-200 shadow-inner';
  el.setAttribute('role', 'img');
  const pips: HTMLDivElement[] = [];
  for (let i = 0; i < 9; i++) {
    const pip = document.createElement('div');
    pip.className = 'm-auto rounded-full bg-slate-800';
    pip.style.width = '7px';
    pip.style.height = '7px';
    pip.style.opacity = '0';
    el.appendChild(pip);
    pips.push(pip);
  }
  const setValue = (v: number): void => {
    const face = clampDie(v);
    const on = new Set(PIP_CELLS[face] ?? PIP_CELLS[1]);
    pips.forEach((pip, i) => {
      pip.style.opacity = on.has(i) ? '1' : '0';
    });
    el.setAttribute('aria-label', `Die showing ${face}`);
  };
  setValue(1);
  return { el, setValue };
}

export interface DiceHud {
  root: HTMLDivElement;
  setRollingShake: (on: boolean) => void;
  setRandomRollingFrame: () => void;
  setFromRoll: (roll: DiceRoll) => void;
  setPlaceholder: (message: string) => void;
  setFromStringMessage: (message: string) => void;
  playSettle: () => void;
}

/**
 * Two pip dice + sum for the Turn HUD. Rolling state is driven by the screen (interval + server ack).
 */
export function createDiceHud(): DiceHud {
  const root = document.createElement('div');
  root.className = 'mb-3 hexahaven-dice-hud';

  const row = document.createElement('div');
  row.className = 'hexahaven-dice-row flex flex-wrap items-center justify-center gap-2';

  const rollingZone = document.createElement('div');
  rollingZone.className = 'hexahaven-dice-rolling-zone';
  const rollingRow = document.createElement('div');
  rollingRow.className = 'hexahaven-dice-rolling-row';

  const makeRollingDie = (): HTMLDivElement => {
    const frame = document.createElement('div');
    frame.className = 'hexahaven-dice-rolling-frame';
    const gif = document.createElement('img');
    gif.className = 'hexahaven-dice-rolling-gif';
    gif.src = '/images/dice-roll-animation.gif';
    gif.alt = 'Rolling die animation';
    gif.draggable = false;
    frame.appendChild(gif);
    return frame;
  };

  rollingRow.appendChild(makeRollingDie());
  rollingRow.appendChild(makeRollingDie());
  rollingZone.appendChild(rollingRow);

  const d1 = buildDieFace();
  const plus = document.createElement('span');
  plus.className = 'font-hexahaven-ui text-slate-400 text-sm select-none';
  plus.textContent = '+';
  const d2 = buildDieFace();
  const eq = document.createElement('span');
  eq.className = 'font-hexahaven-ui text-slate-400 text-sm select-none';
  eq.textContent = '=';
  const sumEl = document.createElement('span');
  sumEl.className = 'font-hexahaven-ui text-lg font-semibold text-white tabular-nums min-w-[1.5rem] text-center';

  const caption = document.createElement('div');
  caption.className = 'font-hexahaven-ui mt-1.5 text-center text-xs text-slate-400 min-h-[1rem]';

  row.appendChild(d1.el);
  row.appendChild(plus);
  row.appendChild(d2.el);
  row.appendChild(eq);
  row.appendChild(sumEl);

  root.appendChild(row);
  root.appendChild(rollingZone);
  root.appendChild(caption);

  let settleHandler: (() => void) | null = null;
  let rollFadeTimer: number | null = null;

  const setRollingShake = (on: boolean): void => {
    row.classList.toggle('hexahaven-dice-roll-shake', on);
    if (on) {
      if (rollFadeTimer !== null) {
        clearTimeout(rollFadeTimer);
        rollFadeTimer = null;
      }
      root.classList.remove('is-roll-fading');
      root.classList.add('is-rolling');
      void rollingZone.offsetWidth;
      caption.textContent = 'Rolling...';
      return;
    }
    if (!root.classList.contains('is-rolling')) {
      return;
    }
    root.classList.add('is-roll-fading');
    rollFadeTimer = window.setTimeout(() => {
      root.classList.remove('is-roll-fading');
      root.classList.remove('is-rolling');
      rollFadeTimer = null;
    }, 360);
  };

  const setRandomRollingFrame = (): void => {
    d1.setValue(1 + Math.floor(Math.random() * 6));
    d2.setValue(1 + Math.floor(Math.random() * 6));
    sumEl.textContent = '···';
    caption.textContent = '';
  };

  const setFromRoll = (roll: DiceRoll): void => {
    d1.el.style.opacity = '1';
    d2.el.style.opacity = '1';
    d1.setValue(roll.d1Val);
    d2.setValue(roll.d2Val);
    sumEl.textContent = String(roll.sum);
    caption.textContent = '';
  };

  const setPlaceholder = (message: string): void => {
    d1.setValue(1);
    d2.setValue(1);
    sumEl.textContent = '—';
    caption.textContent = message;
    d1.el.style.opacity = '0.45';
    d2.el.style.opacity = '0.45';
  };

  const setFromStringMessage = (message: string): void => {
    d1.setValue(1);
    d2.setValue(1);
    sumEl.textContent = '—';
    caption.textContent = message;
    d1.el.style.opacity = '0.55';
    d2.el.style.opacity = '0.55';
  };

  const playSettle = (): void => {
    row.classList.remove('hexahaven-dice-settle');
    void row.offsetWidth;
    row.classList.add('hexahaven-dice-settle');
    if (settleHandler) {
      row.removeEventListener('animationend', settleHandler);
    }
    settleHandler = (): void => {
      row.classList.remove('hexahaven-dice-settle');
      settleHandler = null;
    };
    row.addEventListener('animationend', settleHandler, { once: true });
  };

  return {
    root,
    setRollingShake,
    setRandomRollingFrame,
    setFromRoll,
    setPlaceholder,
    setFromStringMessage,
    playSettle,
  };
}
