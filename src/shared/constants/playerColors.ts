/** Distinct player colors (red, green, blue, yellow). Shuffled per room at creation. */
export const PLAYER_COLOR_PALETTE = ['#DC2626', '#16A34A', '#2563EB', '#EAB308'] as const;

export type PlayerColorHue = 'red' | 'green' | 'blue' | 'yellow';

const HEX_TO_HUE: Record<string, PlayerColorHue> = {
  dc2626: 'red',
  '16a34a': 'green',
  '2563eb': 'blue',
  eab308: 'yellow',
  /** Legacy orange slot → yellow assets */
  ea580c: 'yellow',
};

const PALETTE_HUE_RGB: Record<PlayerColorHue, readonly [number, number, number]> = {
  red: [220, 38, 38],
  green: [22, 163, 74],
  blue: [37, 99, 235],
  yellow: [234, 179, 8],
};

function parseHexRgb(hex: string): [number, number, number] | null {
  const h = hex.replace(/^#/, '').trim();
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  if (full.length !== 6) return null;
  const n = parseInt(full, 16);
  if (!Number.isFinite(n)) return null;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Maps a player/structure `#rrggbb` to a hue for settlement/city sprites (per-color PNG assets). */
export function ownerColorToPlayerHue(colorHex: string): PlayerColorHue {
  const n = colorHex.replace(/^#/, '').toLowerCase();
  const full = n.length === 3 ? n.split('').map((c) => c + c).join('') : n;
  if (full.length === 6 && HEX_TO_HUE[full]) {
    return HEX_TO_HUE[full];
  }
  const rgb = parseHexRgb(colorHex);
  if (!rgb) return 'red';
  let best: PlayerColorHue = 'red';
  let bestD = Infinity;
  (['red', 'green', 'blue', 'yellow'] as const).forEach((hue) => {
    const p = PALETTE_HUE_RGB[hue];
    const d = (rgb[0] - p[0]) ** 2 + (rgb[1] - p[1]) ** 2 + (rgb[2] - p[2]) ** 2;
    if (d < bestD) {
      bestD = d;
      best = hue;
    }
  });
  return best;
}

export function shufflePlayerColorOrder(): string[] {
  const arr = [...PLAYER_COLOR_PALETTE];
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = arr[i]!;
    arr[i] = arr[j]!;
    arr[j] = t;
  }
  return arr;
}

/** Keeps existing player colors when merging game state; assigns from room order for new players. */
export function resolvePlayerColor(
  room: { playerColorOrder: string[] },
  index: number,
  existing?: { color: string } | null,
): string {
  if (existing?.color) {
    return existing.color;
  }
  return room.playerColorOrder[index % room.playerColorOrder.length];
}
