import Phaser, { Scene } from 'phaser';
import { createNoise2D } from 'simplex-noise';
import { ScreenId } from '../../shared/constants/screenIds';
import { clearLobbySession } from '../state/lobbyState';

// --- Types ---
type BiomeType = 'STONE' | 'BLOOM' | 'EMBER' | 'CRYSTAL' | 'GOLD';
type BiomeScores = Record<BiomeType, number>;
type MapSize = 'small' | 'medium' | 'large';

interface MapGenSceneOptions {
    mapSeed?: string | number;
    allowPointerRegenerate?: boolean;
}

// Rich color palettes per biome (sampled by noise for variation)
const BIOME_PALETTE: Record<BiomeType, number[]> = {
    STONE:   [0x5a5a5a, 0x656565, 0x707070, 0x7a7a7a, 0x858585, 0x4f4f4f],
    BLOOM:   [0x5d9a46, 0x6fb253, 0x80c261, 0x93cc74, 0xa4d78a, 0x74b95e],
    EMBER:   [0x171717, 0x222222, 0x2a2a2a, 0x341010, 0x461313, 0x5a1818],
    CRYSTAL: [0xa8c7d8, 0xb7d2e0, 0xc6dcea, 0xd3e5ef, 0xe0edf4, 0x95b8cc],
    GOLD:    [0x9c7b1f, 0xb18b22, 0xc49a24, 0xd9ad2a, 0xe8bf3c, 0x8b6d1a],
};

const MAP_RADIUS: Record<MapSize, number> = { small: 1, medium: 2, large: 3 };
const RESOURCE_BIOMES: BiomeType[] = ['STONE', 'BLOOM', 'EMBER', 'CRYSTAL', 'GOLD'];
const TOKEN_POOL = [2, 3, 3, 4, 4, 5, 5, 6, 6, 8, 8, 9, 9, 10, 10, 11, 11, 12];
const HEX_DIRS: [number, number][] = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
const TEST_MAP_BUTTON_FONT_FAMILY = '04b_30';
const TEST_MAP_BUTTON_FONT_URL = '/fonts/04b_30.ttf';

// ─── Color utilities ───
function hexToRGB(c: number): [number, number, number] {
    return [(c >> 16) & 0xff, (c >> 8) & 0xff, c & 0xff];
}
function lerpRGB(a: [number, number, number], b: [number, number, number], t: number): [number, number, number] {
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}
function samplePalette(biome: BiomeType, t: number): [number, number, number] {
    const pal = BIOME_PALETTE[biome];
    const idx = Math.min(Math.floor(t * pal.length), pal.length - 1);
    return hexToRGB(pal[idx]);
}
function clamp01(value: number): number {
    return Math.max(0, Math.min(1, value));
}
function ridge(value: number): number {
    return 1 - Math.abs(value * 2 - 1);
}
function createBiomeCountRecord(initialValue = 0): Record<BiomeType, number> {
    return {
        STONE: initialValue,
        BLOOM: initialValue,
        EMBER: initialValue,
        CRYSTAL: initialValue,
        GOLD: initialValue,
    };
}

function seededRandom(q: number, r: number, i: number): number {
    let seed = (q * 73856093) ^ (r * 19349663) ^ (i * 83492791);
    seed = ((seed >> 16) ^ seed) * 0x45d9f3b;
    seed = ((seed >> 16) ^ seed) * 0x45d9f3b;
    seed = (seed >> 16) ^ seed;
    return (seed & 0x7fffffff) / 0x7fffffff;
}

function hashStringToSeed(input: string): number {
    let hash = 2166136261;
    for (let i = 0; i < input.length; i += 1) {
        hash ^= input.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}

function normalizeSeed(seed: string | number | undefined): number | null {
    if (seed == null) {
        return null;
    }
    if (typeof seed === 'number' && Number.isFinite(seed)) {
        return Math.trunc(seed) >>> 0;
    }
    if (typeof seed === 'string' && seed.trim().length > 0) {
        return hashStringToSeed(seed.trim());
    }
    return null;
}

function mulberry32(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6D2B79F5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// ─── Hex helpers ───
function hexToPixel(q: number, r: number, size: number): { x: number; y: number } {
    return { x: size * (1.5 * q), y: size * (Math.sqrt(3) / 2 * q + Math.sqrt(3) * r) };
}
function pixelToFracHex(px: number, py: number, size: number): { q: number; r: number } {
    return { q: (2 / 3 * px) / size, r: (-1 / 3 * px + Math.sqrt(3) / 3 * py) / size };
}
function hexRound(qf: number, rf: number): { q: number; r: number } {
    const sf = -qf - rf;
    let rq = Math.round(qf), rr = Math.round(rf);
    const rs = Math.round(sf);
    const dq = Math.abs(rq - qf), dr = Math.abs(rr - rf), ds = Math.abs(rs - sf);
    if (dq > dr && dq > ds) rq = -rr - rs;
    else if (dr > ds) rr = -rq - rs;
    return { q: rq, r: rr };
}
function hexKey(q: number, r: number): string { return `${q},${r}`; }

// Normalized distance from hex center to edge (0=center, 1=on edge)
function normalizedHexDist(dx: number, dy: number, size: number): number {
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < 0.001) return 0;
    const angle = Math.atan2(dy, dx);
    const sector = ((angle % (Math.PI / 3)) + Math.PI / 3) % (Math.PI / 3) - Math.PI / 6;
    const edgeDist = (size * Math.cos(Math.PI / 6)) / Math.cos(sector);
    return Math.min(1, dist / edgeDist);
}

function isInsideHex(px: number, py: number, size: number): boolean {
    const s3 = Math.sqrt(3);
    return Math.abs(px) <= size && Math.abs(py) <= s3 / 2 * size && s3 * Math.abs(px) + Math.abs(py) <= s3 * size;
}

// ─── Classes ───
class Hex {
    q: number; r: number; s: number;
    biome: BiomeType = 'STONE';
    biomeScores: BiomeScores = { STONE: 0, BLOOM: 0, EMBER: 0, CRYSTAL: 0, GOLD: 0 };
    numberToken: number | null = null;
    elevation = 0; moisture = 0;
    constructor(q: number, r: number) { this.q = q; this.r = r; this.s = -q - r; }
}

class TerrainGenerator {
    private eNoise: ReturnType<typeof createNoise2D>;
    private mNoise: ReturnType<typeof createNoise2D>;
    readonly dNoise: ReturnType<typeof createNoise2D>;
    readonly dNoise2: ReturnType<typeof createNoise2D>;

    constructor(random: () => number) {
        this.eNoise = createNoise2D(random);
        this.mNoise = createNoise2D(random);
        this.dNoise = createNoise2D(random);
        this.dNoise2 = createNoise2D(random);
    }
    getElevation(x: number, y: number): number {
        let v = 0, a = 1, f = 1, m = 0;
        for (let i = 0; i < 4; i++) { v += a * (this.eNoise(x * f * 0.1, y * f * 0.1) + 1) / 2; m += a; a *= 0.5; f *= 2; }
        return Math.min(1, v / m);
    }
    getMoisture(x: number, y: number): number {
        let v = 0, a = 1, f = 1, m = 0;
        for (let i = 0; i < 3; i++) { v += a * (this.mNoise(x * f * 0.1 + 1000, y * f * 0.1 + 1000) + 1) / 2; m += a; a *= 0.5; f *= 2; }
        return Math.min(1, v / m);
    }
    getDetail(x: number, y: number): number { return (this.dNoise(x * 0.4, y * 0.4) + 1) / 2; }
    getDetail2(x: number, y: number): number { return (this.dNoise2(x * 0.8, y * 0.8) + 1) / 2; }
}

function computeBiomeScores(e: number, m: number, d1: number, d2: number): BiomeScores {
    const midElevation = 1 - Math.abs(e - 0.55) * 2;
    const dryness = 1 - m;
    const contrast = Math.abs(d1 - d2);

    return {
        STONE: clamp01(0.55 * e + 0.25 * dryness + 0.20 * ridge(d1)),
        BLOOM: clamp01(0.58 * m + 0.22 * clamp01(midElevation) + 0.20 * d2),
        EMBER: clamp01(0.52 * dryness + 0.30 * (1 - e) + 0.18 * d1),
        CRYSTAL: clamp01(0.42 * e + 0.28 * m + 0.15 * contrast + 0.15 * ridge(d2)),
        GOLD: clamp01(0.35 * ridge(d1) + 0.35 * ridge(d2) + 0.30 * contrast),
    };
}
function pickTopBiome(scores: BiomeScores): BiomeType {
    let best = RESOURCE_BIOMES[0];
    let bestScore = scores[best];
    for (let i = 1; i < RESOURCE_BIOMES.length; i++) {
        const biome = RESOURCE_BIOMES[i];
        if (scores[biome] > bestScore) {
            best = biome;
            bestScore = scores[biome];
        }
    }
    return best;
}

// Detail overlay drawing functions
function drawOceanDetails(g: Phaser.GameObjects.Graphics, cx: number, cy: number, sz: number, q: number, r: number) {
    for (let w = 0; w < 5; w++) {
        const wy = cy - sz * 0.4 + w * sz * 0.2;
        const alpha = 0.15 + w * 0.06;
        g.lineStyle(1.2, w % 2 === 0 ? 0x3498db : 0x2471a3, alpha);
        g.beginPath();
        let started = false;
        for (let t = -sz * 0.7; t <= sz * 0.7; t += 1.5) {
            const wx = cx + t;
            const wpy = wy + Math.sin(t * 0.25 + w * 1.8) * (2.5 + w * 0.5);
            if (!isInsideHex(wx - cx, wpy - cy, sz * 0.88)) { started = false; continue; }
            if (!started) { g.moveTo(wx, wpy); started = true; } else g.lineTo(wx, wpy);
        }
        g.strokePath();
    }
    for (let i = 0; i < 10; i++) {
        const dx = (seededRandom(q, r, i * 3) - 0.5) * sz * 1.4;
        const dy = (seededRandom(q, r, i * 3 + 1) - 0.5) * sz * 1.2;
        if (!isInsideHex(dx, dy, sz * 0.8)) continue;
        g.fillStyle(0xffffff, 0.08 + seededRandom(q, r, i + 90) * 0.12);
        g.fillCircle(cx + dx, cy + dy, 0.8 + seededRandom(q, r, i + 80) * 1.2);
    }
}

function drawBeachDetails(g: Phaser.GameObjects.Graphics, cx: number, cy: number, sz: number, q: number, r: number) {
    for (let i = 0; i < 25; i++) {
        const dx = (seededRandom(q, r, i * 2) - 0.5) * sz * 1.4;
        const dy = (seededRandom(q, r, i * 2 + 1) - 0.5) * sz * 1.2;
        if (!isInsideHex(dx, dy, sz * 0.8)) continue;
        const shade = seededRandom(q, r, i + 50) > 0.5 ? 0xc4a96a : 0xf5e6c8;
        g.fillStyle(shade, 0.35 + seededRandom(q, r, i + 60) * 0.3);
        g.fillCircle(cx + dx, cy + dy, 0.5 + seededRandom(q, r, i + 30) * 1.2);
    }
    for (let i = 0; i < 3; i++) {
        const dx = (seededRandom(q, r, i + 100) - 0.5) * sz * 0.9;
        const dy = (seededRandom(q, r, i + 101) - 0.5) * sz * 0.7;
        if (!isInsideHex(dx, dy, sz * 0.7)) continue;
        g.fillStyle(0xb89a6a, 0.6);
        g.fillEllipse(cx + dx, cy + dy, 3.5, 2.5);
        g.lineStyle(0.5, 0x8a6a3a, 0.4);
        g.strokeEllipse(cx + dx, cy + dy, 3.5, 2.5);
    }
}

function drawDesertDetails(g: Phaser.GameObjects.Graphics, cx: number, cy: number, sz: number, _q: number, _r: number) {
    for (let d = 0; d < 3; d++) {
        const baseY = cy + (d - 1) * sz * 0.28;
        g.lineStyle(1.2 + d * 0.3, d === 1 ? 0xb8a060 : 0xccb478, 0.3 + d * 0.05);
        g.beginPath();
        let started = false;
        for (let t = -sz * 0.6; t <= sz * 0.6; t += 1.5) {
            const dx = cx + t;
            const dy = baseY + Math.sin(t * 0.12 + d * 2.5) * (3 + d * 1.5);
            if (!isInsideHex(dx - cx, dy - cy, sz * 0.85)) { started = false; continue; }
            if (!started) { g.moveTo(dx, dy); started = true; } else g.lineTo(dx, dy);
        }
        g.strokePath();
    }
}

function drawSavannahDetails(g: Phaser.GameObjects.Graphics, cx: number, cy: number, sz: number, q: number, r: number) {
    for (let i = 0; i < 14; i++) {
        const dx = (seededRandom(q, r, i * 2) - 0.5) * sz * 1.3;
        const dy = (seededRandom(q, r, i * 2 + 1) - 0.5) * sz * 1.1;
        if (!isInsideHex(dx, dy, sz * 0.78)) continue;
        const px = cx + dx, py = cy + dy;
        const h = 3 + seededRandom(q, r, i + 40) * 4;
        const shade = seededRandom(q, r, i + 50) > 0.4 ? 0x8a7a20 : 0xb4a850;
        g.lineStyle(0.8, shade, 0.55);
        for (let b = -1; b <= 1; b++) {
            g.beginPath();
            g.moveTo(px + b, py);
            g.lineTo(px + b * 2.5, py - h);
            g.strokePath();
        }
    }
}

function drawForestDetails(g: Phaser.GameObjects.Graphics, cx: number, cy: number, sz: number, q: number, r: number) {
    for (let i = 0; i < 10; i++) {
        const dx = (seededRandom(q, r, i + 450) - 0.5) * sz * 1.3;
        const dy = (seededRandom(q, r, i + 460) - 0.5) * sz * 1.1;
        if (!isInsideHex(dx, dy, sz * 0.78)) continue;
        g.fillStyle(0x2a5a10, 0.25 + seededRandom(q, r, i + 470) * 0.2);
        g.fillCircle(cx + dx, cy + dy, 1.5 + seededRandom(q, r, i + 480) * 2);
    }
    const count = 5 + Math.floor(seededRandom(q, r, 400) * 4);
    for (let i = 0; i < count; i++) {
        const dx = (seededRandom(q, r, i * 2 + 410) - 0.5) * sz * 1.2;
        const dy = (seededRandom(q, r, i * 2 + 411) - 0.5) * sz * 1.0;
        if (!isInsideHex(dx, dy, sz * 0.72)) continue;
        const px = cx + dx, py = cy + dy;
        const h = 6 + seededRandom(q, r, i + 420) * 5;
        const isConifer = seededRandom(q, r, i + 425) > 0.4;
        g.fillStyle(0x5a3e1e, 0.75);
        g.fillRect(px - 1, py, 2, 4);
        if (isConifer) {
            const c1 = seededRandom(q, r, i + 430) > 0.5 ? 0x2a5a14 : 0x1a3a0a;
            g.fillStyle(c1, 0.85);
            g.fillTriangle(px, py - h, px - 4.5, py, px + 4.5, py);
            g.fillStyle(0x3a6a20, 0.7);
            g.fillTriangle(px, py - h - 2, px - 3, py - h * 0.4, px + 3, py - h * 0.4);
        } else {
            const c1 = seededRandom(q, r, i + 432) > 0.5 ? 0x4a7a20 : 0x3a6820;
            g.fillStyle(c1, 0.8);
            g.fillCircle(px, py - h * 0.6, 4 + seededRandom(q, r, i + 435) * 2);
        }
    }
}

function drawJungleDetails(g: Phaser.GameObjects.Graphics, cx: number, cy: number, sz: number, q: number, r: number) {
    for (let i = 0; i < 15; i++) {
        const dx = (seededRandom(q, r, i + 570) - 0.5) * sz * 1.3;
        const dy = (seededRandom(q, r, i + 580) - 0.5) * sz * 1.1;
        if (!isInsideHex(dx, dy, sz * 0.78)) continue;
        const shade = [0x0a2a14, 0x103820, 0x1a4d2e][Math.floor(seededRandom(q, r, i + 590) * 3)];
        g.fillStyle(shade, 0.3 + seededRandom(q, r, i + 595) * 0.25);
        g.fillCircle(cx + dx, cy + dy, 2 + seededRandom(q, r, i + 598) * 3);
    }
    const count = 8 + Math.floor(seededRandom(q, r, 500) * 4);
    for (let i = 0; i < count; i++) {
        const dx = (seededRandom(q, r, i * 2 + 510) - 0.5) * sz * 1.3;
        const dy = (seededRandom(q, r, i * 2 + 511) - 0.5) * sz * 1.1;
        if (!isInsideHex(dx, dy, sz * 0.75)) continue;
        const px = cx + dx, py = cy + dy;
        const rad = 3.5 + seededRandom(q, r, i + 520) * 4.5;
        const shade = seededRandom(q, r, i + 530);
        const color = shade < 0.3 ? 0x0d3018 : shade < 0.6 ? 0x1a4d2e : 0x2a6a3e;
        g.fillStyle(color, 0.55 + seededRandom(q, r, i + 535) * 0.25);
        g.fillCircle(px, py, rad);
    }
}

function drawMountainDetails(g: Phaser.GameObjects.Graphics, cx: number, cy: number, sz: number, q: number, r: number) {
    for (let i = 0; i < 12; i++) {
        const dx = (seededRandom(q, r, i + 650) - 0.5) * sz * 1.2;
        const dy = (seededRandom(q, r, i + 660) - 0.5) * sz;
        if (!isInsideHex(dx, dy, sz * 0.78)) continue;
        g.fillStyle(seededRandom(q, r, i + 670) > 0.5 ? 0x555550 : 0x707060, 0.35);
        g.fillEllipse(cx + dx, cy + dy, 1.5 + seededRandom(q, r, i + 675) * 2, 1 + seededRandom(q, r, i + 678));
    }
    const peakCount = 2 + Math.floor(seededRandom(q, r, 600) * 2);
    for (let i = 0; i < peakCount; i++) {
        const dx = (seededRandom(q, r, i + 610) - 0.5) * sz * 0.65;
        const dy = (seededRandom(q, r, i + 611) - 0.5) * sz * 0.25 + sz * 0.08;
        const pw = 7 + seededRandom(q, r, i + 620) * 7;
        const ph = 10 + seededRandom(q, r, i + 630) * 7;
        const px = cx + dx, py = cy + dy;
        g.fillStyle(0x505040, 0.6);
        g.fillTriangle(px, py - ph, px - pw, py, px, py);
        g.fillStyle(0x8a8a7a, 0.75);
        g.fillTriangle(px, py - ph, px, py, px + pw, py);
        g.fillStyle(0xf4f4f4, 0.9);
        const capH = ph * 0.3, capW = pw * 0.3;
        g.fillTriangle(px, py - ph, px - capW, py - ph + capH, px + capW, py - ph + capH);
    }
}

function drawArcticDetails(g: Phaser.GameObjects.Graphics, cx: number, cy: number, sz: number, q: number, r: number) {
    for (let i = 0; i < 6; i++) {
        const dx = (seededRandom(q, r, i + 700) - 0.5) * sz * 1.1;
        const dy = (seededRandom(q, r, i + 710) - 0.5) * sz * 0.9;
        if (!isInsideHex(dx, dy, sz * 0.72)) continue;
        g.fillStyle(0xffffff, 0.25 + seededRandom(q, r, i + 720) * 0.3);
        g.fillEllipse(cx + dx, cy + dy, 5 + seededRandom(q, r, i + 730) * 8, 2.5 + seededRandom(q, r, i + 740) * 4);
    }
    for (let c = 0; c < 3; c++) {
        g.lineStyle(0.6, 0x8ab8d0, 0.3);
        const sx = cx + (seededRandom(q, r, c + 750) - 0.5) * sz * 0.7;
        const sy = cy + (seededRandom(q, r, c + 755) - 0.5) * sz * 0.5;
        const ex = sx + (seededRandom(q, r, c + 760) - 0.5) * 12;
        const ey = sy + (seededRandom(q, r, c + 765) - 0.5) * 8;
        g.beginPath(); g.moveTo(sx, sy); g.lineTo(ex, ey); g.strokePath();
    }
    for (let i = 0; i < 8; i++) {
        const dx = (seededRandom(q, r, i + 780) - 0.5) * sz * 1.1;
        const dy = (seededRandom(q, r, i + 790) - 0.5) * sz * 0.9;
        if (!isInsideHex(dx, dy, sz * 0.72)) continue;
        const s = 1 + seededRandom(q, r, i + 800) * 1.5;
        g.fillStyle(0xffffff, 0.6);
        g.fillRect(cx + dx - s, cy + dy - 0.3, s * 2, 0.6);
    }
}

function drawStoneDetails(g: Phaser.GameObjects.Graphics, cx: number, cy: number, sz: number, q: number, r: number) {
    const pieceCount = 20 + Math.floor(seededRandom(q, r, 1200) * 10);
    for (let i = 0; i < pieceCount; i++) {
        const dx = (seededRandom(q, r, 1201 + i * 2) - 0.5) * sz * 1.35;
        const dy = (seededRandom(q, r, 1202 + i * 2) - 0.5) * sz * 1.15;
        if (!isInsideHex(dx, dy, sz * 0.78)) continue;
        const px = cx + dx;
        const py = cy + dy;
        const w = 5.1 + seededRandom(q, r, 1230 + i) * 9.9;
        const h = 4.2 + seededRandom(q, r, 1260 + i) * 8.0;
        const stoneShade = [0x5d5d5d, 0x676767, 0x717171][Math.floor(seededRandom(q, r, 1290 + i) * 3)];
        g.fillStyle(stoneShade, 0.76 + seededRandom(q, r, 1320 + i) * 0.14);
        g.fillEllipse(px, py, w, h);
        g.lineStyle(0.55, 0x4a4a4a, 0.5);
        g.strokeEllipse(px, py, w, h);

        const chipX = px - w * 0.22 + (seededRandom(q, r, 1330 + i) - 0.5) * 0.9;
        const chipY = py - h * 0.2 + (seededRandom(q, r, 1340 + i) - 0.5) * 0.8;
        g.fillStyle(0x8b8b8b, 0.16 + seededRandom(q, r, 1350 + i) * 0.12);
        g.fillEllipse(chipX, chipY, Math.max(2.1, w * 0.24), Math.max(1.7, h * 0.22));
    }
}

function drawBloomDetails(g: Phaser.GameObjects.Graphics, cx: number, cy: number, sz: number, q: number, r: number) {
    const stemCount = 14 + Math.floor(seededRandom(q, r, 1400) * 8);
    for (let i = 0; i < stemCount; i++) {
        const dx = (seededRandom(q, r, 1401 + i * 3) - 0.5) * sz * 1.2;
        const dy = (seededRandom(q, r, 1402 + i * 3) - 0.5) * sz * 1.0;
        if (!isInsideHex(dx, dy, sz * 0.75)) continue;
        const px = cx + dx;
        const py = cy + dy;
        const isHeroFlower = seededRandom(q, r, 1410 + i) > 0.62;
        const stemH = (isHeroFlower ? 6 : 4) + seededRandom(q, r, 1430 + i) * (isHeroFlower ? 7 : 5);
        g.lineStyle(isHeroFlower ? 1.2 : 0.9, 0x2f7f2f, isHeroFlower ? 0.62 : 0.5);
        g.beginPath();
        g.moveTo(px, py);
        g.lineTo(px, py - stemH);
        g.strokePath();

        const topX = px;
        const topY = py - stemH;
        const petalColor = [0xff8fd1, 0xffd95a, 0xffffff, 0xff9aa2, 0xdcb8ff][Math.floor(seededRandom(q, r, 1460 + i) * 5)];
        const petalR = (isHeroFlower ? 2.4 : 1.6) + seededRandom(q, r, 1490 + i) * (isHeroFlower ? 2.8 : 2.2);
        const petalSize = (isHeroFlower ? 2.0 : 1.3) + seededRandom(q, r, 1560 + i) * (isHeroFlower ? 1.5 : 1.2);
        const petalCount = isHeroFlower ? 6 : 5;
        for (let p = 0; p < petalCount; p++) {
            const ang = (Math.PI * 2 * p) / petalCount + seededRandom(q, r, 1520 + i) * 0.25;
            g.fillStyle(petalColor, isHeroFlower ? 0.82 : 0.66);
            g.fillCircle(topX + Math.cos(ang) * petalR, topY + Math.sin(ang) * petalR, petalSize);
        }
        g.fillStyle(0xf7e37c, isHeroFlower ? 0.95 : 0.82);
        g.fillCircle(topX, topY, isHeroFlower ? 1.8 : 1.25);
        if (isHeroFlower) {
            g.fillStyle(0xffffff, 0.45);
            g.fillCircle(topX - 0.6, topY - 0.6, 0.8);
        }
    }

    // Bright pollen-like sparkle dots to make bloom read clearly at distance.
    const sparkleCount = 10 + Math.floor(seededRandom(q, r, 1580) * 8);
    for (let i = 0; i < sparkleCount; i++) {
        const dx = (seededRandom(q, r, 1581 + i * 2) - 0.5) * sz * 1.25;
        const dy = (seededRandom(q, r, 1582 + i * 2) - 0.5) * sz * 1.05;
        if (!isInsideHex(dx, dy, sz * 0.78)) continue;
        const c = seededRandom(q, r, 1590 + i) > 0.5 ? 0xfff3a6 : 0xffe0ff;
        g.fillStyle(c, 0.3 + seededRandom(q, r, 1595 + i) * 0.35);
        g.fillCircle(cx + dx, cy + dy, 0.7 + seededRandom(q, r, 1598 + i) * 1.1);
    }
}

function drawEmberDetails(g: Phaser.GameObjects.Graphics, cx: number, cy: number, sz: number, q: number, r: number) {
    // Dark coal bed
    const coalCount = 14 + Math.floor(seededRandom(q, r, 1600) * 8);
    for (let i = 0; i < coalCount; i++) {
        const dx = (seededRandom(q, r, 1601 + i * 2) - 0.5) * sz * 1.25;
        const dy = (seededRandom(q, r, 1602 + i * 2) - 0.5) * sz * 1.05;
        if (!isInsideHex(dx, dy, sz * 0.78)) continue;
        const px = cx + dx;
        const py = cy + dy;
        const w = 1.5 + seededRandom(q, r, 1630 + i) * 3.6;
        const h = 1.0 + seededRandom(q, r, 1660 + i) * 2.6;
        g.fillStyle(0x161616, 0.7);
        g.fillEllipse(px, py, w, h);
    }

    // Charred wood pieces on top
    const woodCount = 3;
    for (let i = 0; i < woodCount; i++) {
        const dx = (seededRandom(q, r, 1701 + i * 2) - 0.5) * sz * 0.95;
        const dy = (seededRandom(q, r, 1702 + i * 2) - 0.5) * sz * 0.75;
        if (!isInsideHex(dx, dy, sz * 0.72)) continue;
        const px = cx + dx;
        const py = cy + dy;
        const angle = seededRandom(q, r, 1730 + i) * Math.PI * 2;
        const len = 15 + seededRandom(q, r, 1735 + i) * 12;
        const half = len / 2;
        const ux = Math.cos(angle);
        const uy = Math.sin(angle);
        const vx = -uy;
        const vy = ux;
        const thickness = 3.0 + seededRandom(q, r, 1740 + i) * 2.8;
        const hx = vx * thickness;
        const hy = vy * thickness;
        const ax = px - ux * half;
        const ay = py - uy * half;
        const bx = px + ux * half;
        const by = py + uy * half;

        g.fillStyle(0x7a5437, 0.94);
        g.fillTriangle(ax + hx, ay + hy, ax - hx, ay - hy, bx + hx, by + hy);
        g.fillTriangle(bx - hx, by - hy, ax - hx, ay - hy, bx + hx, by + hy);
        g.lineStyle(1.0, 0x2a1d14, 0.78);
        g.beginPath();
        g.moveTo(ax, ay);
        g.lineTo(bx, by);
        g.strokePath();

        // Center char line to help logs read at distance.
        g.lineStyle(0.8, 0x3a281d, 0.52);
        g.beginPath();
        g.moveTo(ax + ux * 1.5, ay + uy * 1.5);
        g.lineTo(bx - ux * 1.5, by - uy * 1.5);
        g.strokePath();

        // subtle hot tips
        g.fillStyle(0xff6a2a, 0.38 + seededRandom(q, r, 1750 + i) * 0.36);
        g.fillCircle(ax + ux * 1.8, ay + uy * 1.8, 1.9);
        g.fillCircle(bx - ux * 1.8, by - uy * 1.8, 1.9);
    }

    // More red/orange fire-ash dots
    const sparkCount = 26 + Math.floor(seededRandom(q, r, 1800) * 16);
    for (let i = 0; i < sparkCount; i++) {
        const dx = (seededRandom(q, r, 1801 + i * 2) - 0.5) * sz * 1.2;
        const dy = (seededRandom(q, r, 1802 + i * 2) - 0.5) * sz * 1.0;
        if (!isInsideHex(dx, dy, sz * 0.78)) continue;
        const glow = seededRandom(q, r, 1830 + i);
        const color = glow > 0.75 ? 0xffb347 : glow > 0.4 ? 0xff4a1f : 0xcf1717;
        g.fillStyle(color, 0.4 + glow * 0.34);
        g.fillCircle(cx + dx, cy + dy, 0.45 + glow * 0.8);
    }

    // Fine ember ash flecks
    const ashDotCount = 20 + Math.floor(seededRandom(q, r, 1900) * 14);
    for (let i = 0; i < ashDotCount; i++) {
        const dx = (seededRandom(q, r, 1901 + i * 2) - 0.5) * sz * 1.25;
        const dy = (seededRandom(q, r, 1902 + i * 2) - 0.5) * sz * 1.05;
        if (!isInsideHex(dx, dy, sz * 0.8)) continue;
        const heat = seededRandom(q, r, 1930 + i);
        const color = heat > 0.62 ? 0xff4a1f : 0xb31515;
        g.fillStyle(color, 0.14 + heat * 0.24);
        g.fillCircle(cx + dx, cy + dy, 0.2 + heat * 0.34);
    }
}

function drawCrystalDetails(g: Phaser.GameObjects.Graphics, cx: number, cy: number, sz: number, q: number, r: number) {
    // Crystal colonies: shared rocky matrix + parallel growth + radiating druzy needles.
    const colonyCount = 2;
    for (let c = 0; c < colonyCount; c++) {
        const baseDx = (seededRandom(q, r, 1901 + c * 2) - 0.5) * sz * 0.45;
        const baseDy = (seededRandom(q, r, 1902 + c * 2) - 0.5) * sz * 0.35;
        if (!isInsideHex(baseDx, baseDy, sz * 0.58)) continue;
        const bx = cx + baseDx;
        const by = cy + baseDy;

        // Shared matrix rock at the base
        const matrixW = 14 + seededRandom(q, r, 1930 + c) * 11.5;
        const matrixH = 7 + seededRandom(q, r, 1940 + c) * 5.8;
        g.fillStyle(0x788a9c, 0.5);
        g.fillEllipse(bx, by + 1.5, matrixW, matrixH);
        g.fillStyle(0x5a6879, 0.4);
        g.fillEllipse(bx - 1.2, by + 2.2, matrixW * 0.7, matrixH * 0.62);

        // Parallel-growth crystal prisms from matrix
        const parallelCount = 4 + Math.floor(seededRandom(q, r, 1950 + c) * 2);
        for (let i = 0; i < parallelCount; i++) {
            const slot = parallelCount <= 1 ? 0 : i / (parallelCount - 1) - 0.5;
            const px = bx + slot * matrixW * 0.74 + (seededRandom(q, r, 1960 + c * 10 + i) - 0.5) * 1.4;
            const py = by + (seededRandom(q, r, 1970 + c * 10 + i) - 0.5) * 0.9;
            if (!isInsideHex(px - cx, py - cy, sz * 0.72)) continue;
            const h = 16 + seededRandom(q, r, 1980 + c * 10 + i) * 15.5;
            const w = 4.2 + seededRandom(q, r, 1990 + c * 10 + i) * 5.0;
            const tilt = (seededRandom(q, r, 2000 + c * 10 + i) - 0.5) * 1.4;
            const tipX = px + tilt;
            const tipY = py - h;

            g.fillStyle(0xdcf0fb, 0.9);
            g.fillTriangle(tipX, tipY, px - w, py, px, py);
            g.fillStyle(0xb9d9ed, 0.84);
            g.fillTriangle(tipX, tipY, px, py, px + w, py);
            g.fillStyle(0xffffff, 0.52);
            g.fillRect(px - 1.2, py - h * 0.76, 2.4, h * 0.64);
            g.lineStyle(1.0, 0x8db3ca, 0.56);
            g.strokeTriangle(tipX, tipY, px - w, py, px + w, py);
        }

        // Radiating druzy needles around colony shoulders
        const needleCount = 8 + Math.floor(seededRandom(q, r, 2010 + c) * 5);
        for (let i = 0; i < needleCount; i++) {
            const ang = seededRandom(q, r, 2020 + c * 20 + i) * Math.PI * 2;
            const ring = matrixW * (0.18 + seededRandom(q, r, 2030 + c * 20 + i) * 0.24);
            const sx = bx + Math.cos(ang) * ring;
            const sy = by + Math.sin(ang) * (matrixH * 0.28);
            if (!isInsideHex(sx - cx, sy - cy, sz * 0.78)) continue;
            const len = 5.6 + seededRandom(q, r, 2040 + c * 20 + i) * 9.4;
            const dir = ang + (seededRandom(q, r, 2050 + c * 20 + i) - 0.5) * 0.8;
            const ex = sx + Math.cos(dir) * len;
            const ey = sy - Math.abs(Math.sin(dir)) * len;
            if (!isInsideHex(ex - cx, ey - cy, sz * 0.8)) continue;

            g.lineStyle(1.2, 0xd9f0fc, 0.58);
            g.beginPath();
            g.moveTo(sx, sy);
            g.lineTo(ex, ey);
            g.strokePath();
            g.fillStyle(0xf8fdff, 0.68);
            g.fillCircle(ex, ey, 1.0);
        }
    }

    // Geode-like inner lining of tiny crystals near tile interior.
    const liningCount = 10 + Math.floor(seededRandom(q, r, 2100) * 6);
    for (let i = 0; i < liningCount; i++) {
        const ang = seededRandom(q, r, 2101 + i) * Math.PI * 2;
        const radial = sz * (0.12 + seededRandom(q, r, 2110 + i) * 0.28);
        const px = cx + Math.cos(ang) * radial;
        const py = cy + Math.sin(ang) * radial * 0.76;
        if (!isInsideHex(px - cx, py - cy, sz * 0.62)) continue;
        const h = 5 + seededRandom(q, r, 2120 + i) * 7.8;
        const w = 1.8 + seededRandom(q, r, 2130 + i) * 2.8;
        const tipX = px + Math.cos(ang) * w * 0.4;
        const tipY = py - h;
        g.fillStyle(0xe1f2fb, 0.82);
        g.fillTriangle(tipX, tipY, px - w, py, px + w, py);
        g.lineStyle(0.6, 0x9fc3d8, 0.46);
        g.strokeTriangle(tipX, tipY, px - w, py, px + w, py);
    }
}

const BIOME_DETAIL: Record<BiomeType, (g: Phaser.GameObjects.Graphics, cx: number, cy: number, sz: number, q: number, r: number) => void> = {
    STONE: (g, cx, cy, sz, q, r) => {
        drawStoneDetails(g, cx, cy, sz, q, r);
    },
    BLOOM: (g, cx, cy, sz, q, r) => {
        drawBloomDetails(g, cx, cy, sz, q, r);
    },
    EMBER: (g, cx, cy, sz, q, r) => {
        drawEmberDetails(g, cx, cy, sz, q, r);
    },
    CRYSTAL: (g, cx, cy, sz, q, r) => {
        drawCrystalDetails(g, cx, cy, sz, q, r);
    },
    GOLD: (g, cx, cy, sz, q, r) => {
        const drawBullion = (x: number, y: number, w: number, h: number, inset: number, seedIdx: number): void => {
            // Front trapezoid
            const blx = x - w / 2;
            const bly = y + h / 2;
            const brx = x + w / 2;
            const bry = y + h / 2;
            const trx = x + w / 2 - inset;
            const trY = y - h / 2;
            const tlx = x - w / 2 + inset;
            const tlY = y - h / 2;

            g.fillStyle(0xc9972d, 0.94);
            g.beginPath();
            g.moveTo(blx, bly);
            g.lineTo(brx, bry);
            g.lineTo(trx, trY);
            g.lineTo(tlx, tlY);
            g.closePath();
            g.fillPath();
            g.lineStyle(0.9, 0x805e16, 0.7);
            g.strokePath();

            // Flat top face
            const topLift = Math.max(1.1, h * 0.32);
            const tx1 = tlx;
            const ty1 = tlY;
            const tx2 = trx;
            const ty2 = trY;
            const tx3 = trx - inset * 0.45;
            const ty3 = trY - topLift;
            const tx4 = tlx + inset * 0.45;
            const ty4 = tlY - topLift;
            const topColor = [0xffe384, 0xf8d96a, 0xeec14d][Math.floor(seededRandom(q, r, seedIdx) * 3)];

            g.fillStyle(topColor, 0.9);
            g.beginPath();
            g.moveTo(tx1, ty1);
            g.lineTo(tx2, ty2);
            g.lineTo(tx3, ty3);
            g.lineTo(tx4, ty4);
            g.closePath();
            g.fillPath();
            g.lineStyle(0.75, 0xb88b2a, 0.62);
            g.strokePath();

            // Subtle shine dot
            g.fillStyle(0xfff3b5, 0.65);
            g.fillCircle((tx1 + tx2) * 0.5 - w * 0.12, (ty3 + ty1) * 0.5, 0.9 + seededRandom(q, r, seedIdx + 99) * 0.75);
        };

        // Stable pyramid stack: 4-3-2-1 bars, centered in tile.
        const layers = 4;
        const baseW = 15.8;
        const baseH = 6.0;
        let seedCounter = 1100;
        for (let layer = 0; layer < layers; layer++) {
            const barsInLayer = layers - layer;
            const y = cy + sz * 0.28 - layer * (baseH * 1.1);
            for (let b = 0; b < barsInLayer; b++) {
                const spread = barsInLayer <= 1 ? 0 : b / (barsInLayer - 1) - 0.5;
                const x = cx + spread * (baseW * 0.86 * barsInLayer) + (seededRandom(q, r, seedCounter) - 0.5) * 1.4;
                if (!isInsideHex(x - cx, y - cy, sz * 0.9)) {
                    seedCounter += 3;
                    continue;
                }
                const w = baseW + seededRandom(q, r, seedCounter + 1) * 3.0;
                const h = baseH + seededRandom(q, r, seedCounter + 2) * 1.5;
                const inset = Math.max(1.4, w * 0.17);
                drawBullion(x, y, w, h, inset, seedCounter + 3);
                seedCounter += 7;
            }
        }

        const sparkleCount = 14 + Math.floor(seededRandom(q, r, 1010) * 7);
        for (let i = 0; i < sparkleCount; i++) {
            const dx = (seededRandom(q, r, 1011 + i * 2) - 0.5) * sz * 1.05;
            const dy = (seededRandom(q, r, 1012 + i * 2) - 0.5) * sz * 0.9;
            if (!isInsideHex(dx, dy, sz * 0.76)) continue;
            g.fillStyle(0xffe58f, 0.32 + seededRandom(q, r, 1030 + i) * 0.4);
            g.fillCircle(cx + dx, cy + dy, 0.9 + seededRandom(q, r, 1040 + i) * 1.1);
        }
    },
};

export class MapGenTest extends Scene {
    private terrain!: TerrainGenerator;
    private hexes: Hex[] = [];
    private hexMap = new Map<string, Hex>();
    private mapRadius = 5;
    private hexSize = 48;
    private readonly mapZoom = 1.5;
    private canvasKey = 'terrainCanvas';
    private readonly sandBorderTextureKeys = ['beach-corner-1', 'beach-corner-2', 'beach-corner-3'] as const;
    private readonly mapSeed: number | null;
    private readonly allowPointerRegenerate: boolean;
    private rng: () => number = Math.random;

    constructor(options?: MapGenSceneOptions) {
        super('MapGenTest');
        this.mapSeed = normalizeSeed(options?.mapSeed);
        this.allowPointerRegenerate = options?.allowPointerRegenerate ?? true;
    }

    private resetRandomSource(): void {
        this.rng = this.mapSeed == null ? Math.random : mulberry32(this.mapSeed);
    }

    preload() {
        this.sandBorderTextureKeys.forEach((key, idx) => {
            if (!this.textures.exists(key)) {
                this.load.image(key, `/images/beach-corner-${idx + 1}.png`);
            }
        });
    }

    regenerateMap(): void {
        this.resetRandomSource();
        this.terrain = new TerrainGenerator(this.rng);
        this.generateMap('medium');
        this.renderMap();
    }

    create() {
        this.regenerateMap();

        this.cameras.main.centerOn(0, 0);
        this.cameras.main.zoom = this.mapZoom;
        this.cameras.main.setBackgroundColor('rgba(0,0,0,0)');

        if (this.allowPointerRegenerate) {
            this.input.on('pointerdown', () => this.regenerateMap());
        }
    }

    private generateMap(size: MapSize) {
        this.mapRadius = MAP_RADIUS[size];
        this.hexes = [];
        this.hexMap.clear();

        for (let q = -this.mapRadius; q <= this.mapRadius; q++) {
            for (let r = -this.mapRadius; r <= this.mapRadius; r++) {
                if (Math.abs(q + r) <= this.mapRadius) {
                    const hex = new Hex(q, r);
                    const p = hexToPixel(q, r, this.hexSize);
                    hex.elevation = this.terrain.getElevation(p.x, p.y);
                    hex.moisture = this.terrain.getMoisture(p.x, p.y);
                    const d1 = this.terrain.getDetail(p.x, p.y);
                    const d2 = this.terrain.getDetail2(p.x, p.y);
                    hex.biomeScores = computeBiomeScores(hex.elevation, hex.moisture, d1, d2);
                    hex.biome = pickTopBiome(hex.biomeScores);
                    hex.numberToken = TOKEN_POOL[Math.floor(this.rng() * TOKEN_POOL.length)];
                    this.hexes.push(hex);
                    this.hexMap.set(hexKey(q, r), hex);
                }
            }
        }

        this.balanceBiomeDistribution();
    }

    private buildEqualTargets(totalTiles: number): Record<BiomeType, number> {
        const targets = createBiomeCountRecord(Math.floor(totalTiles / RESOURCE_BIOMES.length));
        const remainder = totalTiles % RESOURCE_BIOMES.length;
        const order = [...RESOURCE_BIOMES];
        for (let i = order.length - 1; i > 0; i--) {
            const j = Math.floor(this.rng() * (i + 1));
            const tmp = order[i];
            order[i] = order[j];
            order[j] = tmp;
        }
        for (let i = 0; i < remainder; i++) {
            targets[order[i]] += 1;
        }
        return targets;
    }

    private countBiomes(): Record<BiomeType, number> {
        const counts = createBiomeCountRecord(0);
        for (const hex of this.hexes) {
            counts[hex.biome] += 1;
        }
        return counts;
    }

    private reassignBestCandidate(targetBiome: BiomeType, counts: Record<BiomeType, number>, minDonorCount: number): boolean {
        let bestHex: Hex | null = null;
        let bestPenalty = Number.POSITIVE_INFINITY;
        let bestTie = Number.POSITIVE_INFINITY;

        for (const hex of this.hexes) {
            if (hex.biome === targetBiome) continue;
            const donorBiome = hex.biome;
            if (counts[donorBiome] <= minDonorCount) continue;

            const penalty = hex.biomeScores[donorBiome] - hex.biomeScores[targetBiome];
            const tieBreak = seededRandom(hex.q, hex.r, 2000 + targetBiome.length);
            if (
                penalty < bestPenalty - 1e-9 ||
                (Math.abs(penalty - bestPenalty) <= 1e-9 && tieBreak < bestTie)
            ) {
                bestHex = hex;
                bestPenalty = penalty;
                bestTie = tieBreak;
            }
        }

        if (!bestHex) return false;
        counts[bestHex.biome] -= 1;
        bestHex.biome = targetBiome;
        counts[targetBiome] += 1;
        return true;
    }

    private balanceBiomeDistribution(): void {
        if (this.hexes.length < RESOURCE_BIOMES.length) return;

        const targets = this.buildEqualTargets(this.hexes.length);
        const counts = this.countBiomes();

        for (const biome of RESOURCE_BIOMES) {
            while (counts[biome] === 0) {
                const changed = this.reassignBestCandidate(biome, counts, 1);
                if (!changed) break;
            }
        }

        let moved = true;
        let safety = 0;
        const maxMoves = this.hexes.length * RESOURCE_BIOMES.length * 2;
        while (moved && safety < maxMoves) {
            moved = false;
            safety += 1;
            for (const biome of RESOURCE_BIOMES) {
                if (counts[biome] >= targets[biome]) continue;
                const changed = this.reassignBestCandidate(biome, counts, targets[biome]);
                if (changed) moved = true;
            }
        }
    }

    private renderMap() {
        // Destroy from a snapshot so we do not skip nodes while mutating children.
        this.children.list.slice().forEach((child: Phaser.GameObjects.GameObject) => {
            if (child.type === 'Graphics' || child.type === 'Image' || child.type === 'Text') {
                child.destroy();
            }
        });

        if (this.textures.exists(this.canvasKey)) {
            this.textures.remove(this.canvasKey);
        }

        const sz = this.hexSize;
        const pad = sz * 2;
        const verticalPad = sz * 0.8;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const hex of this.hexes) {
            const p = hexToPixel(hex.q, hex.r, sz);
            minX = Math.min(minX, p.x - sz); maxX = Math.max(maxX, p.x + sz);
            minY = Math.min(minY, p.y - sz); maxY = Math.max(maxY, p.y + sz);
        }
        minX -= pad; minY -= (pad + verticalPad); maxX += pad; maxY += (pad + verticalPad);
        const w = Math.ceil(maxX - minX);
        const h = Math.ceil(maxY - minY);

        const canvasTex = this.textures.createCanvas(this.canvasKey, w, h)!;
        const ctx = canvasTex.getContext();
        const imageData = ctx.getImageData(0, 0, w, h);
        const data = imageData.data;

        const BLEND_START = 0.80;
        const BLEND_END = 0.98;

        for (let py = 0; py < h; py++) {
            for (let px = 0; px < w; px++) {
                const worldX = px + minX;
                const worldY = py + minY;

                const frac = pixelToFracHex(worldX, worldY, sz);
                const rounded = hexRound(frac.q, frac.r);
                const hex = this.hexMap.get(hexKey(rounded.q, rounded.r));
                if (!hex) continue;

                const hCenter = hexToPixel(hex.q, hex.r, sz);
                const dx = worldX - hCenter.x;
                const dy = worldY - hCenter.y;

                if (!isInsideHex(dx, dy, sz * 1.02)) continue;

                const nd = normalizedHexDist(dx, dy, sz);
                const d1 = this.terrain.getDetail(worldX, worldY);
                const d2 = this.terrain.getDetail2(worldX, worldY);
                const noiseIdx = (d1 * 0.7 + d2 * 0.3);

                let baseColor = samplePalette(hex.biome, noiseIdx);
                const bright = 0.92 + d2 * 0.16;
                baseColor = [baseColor[0] * bright, baseColor[1] * bright, baseColor[2] * bright];

                if (nd > BLEND_START) {
                    const blendT = Math.min(1, (nd - BLEND_START) / (BLEND_END - BLEND_START));
                    const smooth = blendT * blendT * (3 - 2 * blendT);

                    const angle = Math.atan2(dy, dx);
                    const dirIdx = ((Math.round(angle / (Math.PI / 3)) % 6) + 6) % 6;
                    const dir = HEX_DIRS[dirIdx];
                    const neighborHex = this.hexMap.get(hexKey(hex.q + dir[0], hex.r + dir[1]));

                    if (neighborHex && neighborHex.biome !== hex.biome) {
                        const neighborColor = samplePalette(neighborHex.biome, noiseIdx);
                        const nb: [number, number, number] = [neighborColor[0] * bright, neighborColor[1] * bright, neighborColor[2] * bright];
                        baseColor = lerpRGB(baseColor as [number, number, number], nb, smooth * 0.25);
                    }
                }

                const idx = (py * w + px) * 4;
                data[idx] = Math.min(255, Math.max(0, baseColor[0]));
                data[idx + 1] = Math.min(255, Math.max(0, baseColor[1]));
                data[idx + 2] = Math.min(255, Math.max(0, baseColor[2]));
                data[idx + 3] = 255;
            }
        }

        ctx.putImageData(imageData, 0, 0);
        canvasTex.refresh();

        this.add.image(minX + w / 2, minY + h / 2, this.canvasKey).setDepth(0);

        const graphics = this.add.graphics().setDepth(1);
        for (const hex of this.hexes) {
            const p = hexToPixel(hex.q, hex.r, sz);
            BIOME_DETAIL[hex.biome](graphics, p.x, p.y, sz, hex.q, hex.r);
        }

        this.drawNoisyTileOutlines(sz);

        this.drawSandBorder(sz);

        const tokenG = this.add.graphics().setDepth(3);
        for (const hex of this.hexes) {
            if (hex.numberToken == null) continue;
            const p = hexToPixel(hex.q, hex.r, sz);
            tokenG.fillStyle(0xffffff, 0.88);
            tokenG.fillCircle(p.x, p.y, 8);
            tokenG.lineStyle(1, 0x333333, 0.5);
            tokenG.strokeCircle(p.x, p.y, 8);
            const color = (hex.numberToken === 6 || hex.numberToken === 8) ? '#cc0000' : '#222222';
            this.add.text(p.x, p.y, hex.numberToken.toString(), {
                fontSize: '11px',
                fontStyle: 'bold',
                color,
                align: 'center',
                resolution: 10
            }).setOrigin(0.5).setDepth(4);
        }
    }

    private drawSandBorder(sz: number): void {
        const borderDepth = -0.1;
        const halfSide = sz * 0.5;

        for (const hex of this.hexes) {
            const c = hexToPixel(hex.q, hex.r, sz);
            for (let dirIdx = 0; dirIdx < HEX_DIRS.length; dirIdx++) {
                const [dq, dr] = HEX_DIRS[dirIdx];
                const nq = hex.q + dq;
                const nr = hex.r + dr;
                if (this.hexMap.has(hexKey(nq, nr))) continue;

                const n = hexToPixel(nq, nr, sz);
                const vx = n.x - c.x;
                const vy = n.y - c.y;
                const len = Math.hypot(vx, vy);
                if (len < 0.001) continue;

                const ux = vx / len;
                const uy = vy / len;
                const px = -uy;
                const py = ux;

                const mx = (c.x + n.x) * 0.5;
                const my = (c.y + n.y) * 0.5;
                const ax = mx + px * halfSide;
                const ay = my + py * halfSide;
                const bx = mx - px * halfSide;
                const by = my - py * halfSide;

                const sideLength = Math.hypot(bx - ax, by - ay);
                const imageLength = sideLength * 1.24;
                const imageWidth = sz * 0.42;
                const textureIdx = Math.floor(seededRandom(hex.q, hex.r, dirIdx * 17 + 900) * this.sandBorderTextureKeys.length);
                const textureKey = this.sandBorderTextureKeys[Math.min(this.sandBorderTextureKeys.length - 1, textureIdx)];
                const edgeAngle = Math.atan2(by - ay, bx - ax);
                const outwardOffset = sz * 0.16;

                this.add.image(mx + ux * outwardOffset, my + uy * outwardOffset, textureKey)
                    .setDepth(borderDepth)
                    .setDisplaySize(imageWidth, imageLength)
                    .setRotation(edgeAngle + Math.PI / 2)
                    .setAlpha(0.95);
            }
        }
    }

    private drawNoisyTileOutlines(sz: number): void {
        const outlineG = this.add.graphics().setDepth(2);
        const baseLineColor = 0xd1c295;
        const baseLineWidth = 5.4;
        const sandTones = [0xd1c295, 0xc4b27f, 0xe0d1a8, 0xbda66d] as const;
        const jitterScale = sz * 0.045;

        for (const hex of this.hexes) {
            const p = hexToPixel(hex.q, hex.r, sz);
            const vertices = Array.from({ length: 6 }, (_, i) => {
                const a = (Math.PI / 3) * i;
                return {
                    x: p.x + sz * Math.cos(a),
                    y: p.y + sz * Math.sin(a),
                };
            });

            for (let edgeIdx = 0; edgeIdx < 6; edgeIdx++) {
                const a = vertices[edgeIdx];
                const b = vertices[(edgeIdx + 1) % 6];
                const ex = b.x - a.x;
                const ey = b.y - a.y;
                const edgeLen = Math.hypot(ex, ey);
                if (edgeLen < 0.001) continue;
                const nx = -ey / edgeLen;
                const ny = ex / edgeLen;
                const tx = ex / edgeLen;
                const ty = ey / edgeLen;

                // Keep a thick base separator line under the sand dots.
                outlineG.lineStyle(baseLineWidth, baseLineColor, 1);
                outlineG.beginPath();
                outlineG.moveTo(a.x, a.y);
                outlineG.lineTo(b.x, b.y);
                outlineG.strokePath();

                // Dots-only separator: dense tiny grains distributed along each edge.
                const speckleCount = 28;
                for (let i = 0; i < speckleCount; i++) {
                    const t = seededRandom(hex.q, hex.r, 5600 + edgeIdx * 37 + i * 17);
                    const baseX = a.x + ex * t;
                    const baseY = a.y + ey * t;
                    const spread = jitterScale * 0.8;
                    const normalJitter = (seededRandom(hex.q, hex.r, 5700 + edgeIdx * 37 + i * 17) - 0.5) * 2 * spread;
                    const tangentJitter = (seededRandom(hex.q, hex.r, 5800 + edgeIdx * 37 + i * 17) - 0.5) * 2 * spread * 0.45;
                    const radius = 0.08 + seededRandom(hex.q, hex.r, 5900 + edgeIdx * 37 + i * 17) * 0.18;
                    const alpha = 0.78 + seededRandom(hex.q, hex.r, 6000 + edgeIdx * 37 + i * 17) * 0.22;
                    const sx = baseX + nx * normalJitter + tx * tangentJitter;
                    const sy = baseY + ny * normalJitter + ty * tangentJitter;
                    const speckleToneIdx = Math.floor(seededRandom(hex.q, hex.r, 6100 + edgeIdx * 37 + i * 17) * sandTones.length);
                    const speckleTone = sandTones[Math.min(sandTones.length - 1, speckleToneIdx)];
                    outlineG.fillStyle(speckleTone, alpha);
                    outlineG.fillCircle(sx, sy, radius);
                }

                const grainCount = 18;
                for (let i = 0; i < grainCount; i++) {
                    const t = seededRandom(hex.q, hex.r, 6200 + edgeIdx * 41 + i * 19);
                    const gx = a.x + ex * t + nx * ((seededRandom(hex.q, hex.r, 6300 + edgeIdx * 41 + i * 19) - 0.5) * jitterScale * 1.6);
                    const gy = a.y + ey * t + ny * ((seededRandom(hex.q, hex.r, 6400 + edgeIdx * 41 + i * 19) - 0.5) * jitterScale * 1.6);
                    const grainToneIdx = Math.floor(seededRandom(hex.q, hex.r, 6500 + edgeIdx * 41 + i * 19) * sandTones.length);
                    const grainTone = sandTones[Math.min(sandTones.length - 1, grainToneIdx)];
                    const grainRadius = 0.05 + seededRandom(hex.q, hex.r, 6600 + edgeIdx * 41 + i * 19) * 0.1;
                    const grainAlpha = 0.7 + seededRandom(hex.q, hex.r, 6700 + edgeIdx * 41 + i * 19) * 0.3;
                    outlineG.fillStyle(grainTone, grainAlpha);
                    outlineG.fillCircle(gx, gy, grainRadius);
                }
            }
        }
    }
}

// Screen wrapper for integration with app
export class TestMapGenScreen {
    readonly id = 'test-map-gen';
    private container: HTMLElement | null = null;
    private regenerateButton: HTMLButtonElement | null = null;
    private exitButton: HTMLButtonElement | null = null;
    private musicToggleButton: HTMLButtonElement | null = null;
    private game: Phaser.Game | null = null;
    private readonly showExitButton: boolean;
    private readonly enableBackgroundMusic: boolean;
    private readonly mapSeed?: string | number;
    private readonly showRegenerateButton: boolean;
    private readonly allowPointerRegenerate: boolean;
    private readonly backgroundMusic = new Audio('/audio/game-board-theme.mp3');
    private isMusicMuted = false;

    constructor(options?: {
        showExitButton?: boolean;
        enableBackgroundMusic?: boolean;
        mapSeed?: string | number;
        showRegenerateButton?: boolean;
        allowPointerRegenerate?: boolean;
    }) {
        this.showExitButton = options?.showExitButton ?? true;
        this.enableBackgroundMusic = options?.enableBackgroundMusic ?? true;
        this.mapSeed = options?.mapSeed;
        this.showRegenerateButton = options?.showRegenerateButton ?? true;
        this.allowPointerRegenerate = options?.allowPointerRegenerate ?? true;
        this.backgroundMusic.loop = true;
        this.backgroundMusic.volume = 0.35;
    }

    private ensureButtonFontRegistered(): void {
        const styleId = 'test-map-gen-button-font-face';
        if (document.getElementById(styleId)) return;
        const style = document.createElement('style');
        style.id = styleId;
        style.textContent = `
@font-face {
    font-family: '${TEST_MAP_BUTTON_FONT_FAMILY}';
    src: url('${TEST_MAP_BUTTON_FONT_URL}') format('truetype');
    font-display: swap;
}`;
        document.head.appendChild(style);
    }

    render(parentElement: HTMLElement, _onComplete?: () => void, navigate?: (screenId: string) => void): void {
        if (this.enableBackgroundMusic) {
            this.playBackgroundMusic();
        }
        // Clear existing content
        this.ensureButtonFontRegistered();
        parentElement.innerHTML = '';
        this.container = document.createElement('div');
        this.container.className = 'relative w-full h-full overflow-hidden';
        this.container.style.position = 'fixed';
        this.container.style.inset = '0';
        this.container.style.backgroundColor = '#9cced9';
        this.container.style.backgroundImage = "url('/images/test-map-grass.png')";
        this.container.style.backgroundSize = 'cover';
        this.container.style.backgroundPosition = 'center';
        this.container.style.backgroundRepeat = 'no-repeat';
        parentElement.appendChild(this.container);

        // Create Phaser mount over background
        const phaserMount = document.createElement('div');
        phaserMount.id = 'phaser-container';
        phaserMount.style.position = 'absolute';
        phaserMount.style.inset = '0';
        phaserMount.style.zIndex = '1';
        this.container.appendChild(phaserMount);

        if (this.showRegenerateButton) {
            this.regenerateButton = document.createElement('button');
            this.regenerateButton.textContent = 'Generate New Map';
            this.regenerateButton.style.position = 'absolute';
            this.regenerateButton.style.top = '16px';
            this.regenerateButton.style.left = '16px';
            this.regenerateButton.style.zIndex = '3';
            this.regenerateButton.style.padding = '8px 10px';
            this.regenerateButton.style.fontSize = '17px';
            this.regenerateButton.style.fontWeight = '600';
            this.regenerateButton.style.fontFamily = `'${TEST_MAP_BUTTON_FONT_FAMILY}', monospace`;
            this.regenerateButton.style.color = '#ffffff';
            this.regenerateButton.style.background = 'rgba(0, 0, 0, 0.7)';
            this.regenerateButton.style.border = '1px solid rgba(255, 255, 255, 0.35)';
            this.regenerateButton.style.borderRadius = '8px';
            this.regenerateButton.style.cursor = 'pointer';
            this.regenerateButton.onclick = () => {
                const scene = this.game?.scene.getScene('MapGenTest') as MapGenTest | undefined;
                scene?.regenerateMap();
            };
            this.container.appendChild(this.regenerateButton);
        } else {
            this.regenerateButton = null;
        }

        if (this.enableBackgroundMusic) {
            this.musicToggleButton = document.createElement('button');
            this.musicToggleButton.style.position = 'absolute';
            this.musicToggleButton.style.top = '62px';
            this.musicToggleButton.style.left = '16px';
            this.musicToggleButton.style.zIndex = '3';
            this.musicToggleButton.style.padding = '8px 10px';
            this.musicToggleButton.style.fontSize = '14px';
            this.musicToggleButton.style.fontWeight = '600';
            this.musicToggleButton.style.fontFamily = `'${TEST_MAP_BUTTON_FONT_FAMILY}', monospace`;
            this.musicToggleButton.style.color = '#ffffff';
            this.musicToggleButton.style.background = 'rgba(15, 23, 42, 0.85)';
            this.musicToggleButton.style.border = '1px solid rgba(255, 255, 255, 0.35)';
            this.musicToggleButton.style.borderRadius = '8px';
            this.musicToggleButton.style.cursor = 'pointer';
            this.musicToggleButton.onclick = () => this.toggleMusic();
            this.updateMusicButtonText();
            this.container.appendChild(this.musicToggleButton);
        }

        if (this.showExitButton) {
            this.exitButton = document.createElement('button');
            this.exitButton.textContent = 'Exit to Menu';
            this.exitButton.style.position = 'absolute';
            this.exitButton.style.top = '16px';
            this.exitButton.style.right = '16px';
            this.exitButton.style.zIndex = '3';
            this.exitButton.style.padding = '8px 10px';
            this.exitButton.style.fontSize = '14px';
            this.exitButton.style.fontWeight = '600';
            this.exitButton.style.fontFamily = `'${TEST_MAP_BUTTON_FONT_FAMILY}', monospace`;
            this.exitButton.style.color = '#ffffff';
            this.exitButton.style.background = 'rgba(15, 23, 42, 0.85)';
            this.exitButton.style.border = '1px solid rgba(255, 255, 255, 0.35)';
            this.exitButton.style.borderRadius = '8px';
            this.exitButton.style.cursor = 'pointer';
            this.exitButton.onclick = () => {
                clearLobbySession();
                navigate?.(ScreenId.MainMenu);
            };
            this.container.appendChild(this.exitButton);
        }

        // Initialize Phaser game
        const config: Phaser.Types.Core.GameConfig = {
            type: Phaser.AUTO,
            parent: 'phaser-container',
            width: window.innerWidth,
            height: window.innerHeight,
            transparent: true,
            scene: [new MapGenTest({
                mapSeed: this.mapSeed,
                allowPointerRegenerate: this.allowPointerRegenerate,
            })],
            scale: {
                mode: Phaser.Scale.FIT,
                autoCenter: Phaser.Scale.CENTER_BOTH,
            },
        };

        this.game = new Phaser.Game(config);
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
        if (this.game) {
            this.game.destroy(true);
            this.game = null;
        }
        if (this.container) {
            this.container.remove();
            this.container = null;
        }
        if (this.regenerateButton) {
            this.regenerateButton.remove();
            this.regenerateButton = null;
        }
        if (this.exitButton) {
            this.exitButton.remove();
            this.exitButton = null;
        }
        if (this.musicToggleButton) {
            this.musicToggleButton.remove();
            this.musicToggleButton = null;
        }
    }
}
