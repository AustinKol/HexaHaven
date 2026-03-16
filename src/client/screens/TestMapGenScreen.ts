import Phaser, { Scene } from 'phaser';
import { createNoise2D } from 'simplex-noise';
import { ScreenId } from '../../shared/constants/screenIds';
import { clearLobbySession } from '../state/lobbyState';

// --- Types ---
type BiomeType = 'OCEAN' | 'BEACH' | 'DESERT' | 'SAVANNAH' | 'FOREST' | 'JUNGLE' | 'MOUNTAIN' | 'ARCTIC';
type MapSize = 'small' | 'medium' | 'large';

interface MapGenSceneOptions {
    mapSeed?: string | number;
    allowPointerRegenerate?: boolean;
}

// Rich color palettes per biome (sampled by noise for variation)
const BIOME_PALETTE: Record<BiomeType, number[]> = {
    OCEAN:    [0x0e3d5e, 0x154f72, 0x1a5276, 0x1f6896, 0x2980b9, 0x1b6ca0],
    BEACH:    [0xd4bc82, 0xe0c892, 0xe8d4a2, 0xf0e0b8, 0xc8b070, 0xdcc898],
    DESERT:   [0xc0a060, 0xccb478, 0xd4c090, 0xe0d0a0, 0xb89850, 0xd8c488],
    SAVANNAH: [0x9a8a30, 0xaca040, 0xc4b86b, 0xd0c870, 0x8a7a20, 0xb4a850],
    FOREST:   [0x1a3a0a, 0x224810, 0x2d5016, 0x3a6420, 0x4a7a20, 0x1e4010],
    JUNGLE:   [0x0a2a14, 0x103820, 0x1a4d2e, 0x206038, 0x2a6a3e, 0x144428],
    MOUNTAIN: [0x606050, 0x707060, 0x8b8b7a, 0x989888, 0xa0a090, 0x787868],
    ARCTIC:   [0xc8d8e8, 0xd4e4f0, 0xdce8f0, 0xe8f0f8, 0xf0f4f8, 0xd0e0f0],
};

const MAP_RADIUS: Record<MapSize, number> = { small: 1, medium: 2, large: 3 };
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
    biome: BiomeType = 'OCEAN';
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

function determineBiome(e: number, m: number): BiomeType {
    if (e < 0.35) return 'OCEAN';
    if (e < 0.40) return 'BEACH';
    if (e > 0.80) return 'ARCTIC';
    if (e > 0.70) return 'MOUNTAIN';
    if (e < 0.50) { if (m > 0.75) return 'JUNGLE'; if (m > 0.55) return 'FOREST'; }
    if (e < 0.65) { if (m > 0.60) return 'FOREST'; if (m > 0.35) return 'SAVANNAH'; return 'DESERT'; }
    return 'SAVANNAH';
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

const BIOME_DETAIL: Record<BiomeType, (g: Phaser.GameObjects.Graphics, cx: number, cy: number, sz: number, q: number, r: number) => void> = {
    OCEAN: drawOceanDetails, BEACH: drawBeachDetails, DESERT: drawDesertDetails,
    SAVANNAH: drawSavannahDetails, FOREST: drawForestDetails, JUNGLE: drawJungleDetails,
    MOUNTAIN: drawMountainDetails, ARCTIC: drawArcticDetails,
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
                    hex.biome = determineBiome(hex.elevation, hex.moisture);
                    hex.numberToken = TOKEN_POOL[Math.floor(this.rng() * TOKEN_POOL.length)];
                    this.hexes.push(hex);
                    this.hexMap.set(hexKey(q, r), hex);
                }
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
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const hex of this.hexes) {
            const p = hexToPixel(hex.q, hex.r, sz);
            minX = Math.min(minX, p.x - sz); maxX = Math.max(maxX, p.x + sz);
            minY = Math.min(minY, p.y - sz); maxY = Math.max(maxY, p.y + sz);
        }
        minX -= pad; minY -= pad; maxX += pad; maxY += pad;
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

        const outlineG = this.add.graphics().setDepth(2);
        outlineG.lineStyle(0.8, 0x000000, 0.15);
        for (const hex of this.hexes) {
            const p = hexToPixel(hex.q, hex.r, sz);
            outlineG.beginPath();
            for (let i = 0; i < 6; i++) {
                const a = (Math.PI / 3) * i;
                const vx = p.x + sz * Math.cos(a);
                const vy = p.y + sz * Math.sin(a);
                if (i === 0) outlineG.moveTo(vx, vy); else outlineG.lineTo(vx, vy);
            }
            outlineG.closePath();
            outlineG.strokePath();
        }

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
                const outwardOffset = -sz * 0.04;

                this.add.image(mx + ux * outwardOffset, my + uy * outwardOffset, textureKey)
                    .setDepth(borderDepth)
                    .setDisplaySize(imageWidth, imageLength)
                    .setRotation(edgeAngle - Math.PI / 2)
                    .setAlpha(0.95);
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
