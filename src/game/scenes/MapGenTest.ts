import { Scene } from 'phaser';
import { createNoise2D } from 'simplex-noise';

interface HexState {
    cellSize: number;
    hexSize: number;
    hexWidth: number;
    hexHeight: number;
    cols: number;
    rows: number;
    hexPoints: number[];
    frequency: number;
    hexGrid: Map<string, Hex>;
}

export class MapGenTest extends Scene
{
    camera: Phaser.Cameras.Scene2D.Camera;
    background: Phaser.GameObjects.Image;
    msg_text : Phaser.GameObjects.Text;
    hex: HexState;
    hexGrid: Map<string, Hex>;

    constructor ()
    {
        super('MapGenTest');
        this.hex = {
            cellSize: 16,
            hexSize: 0,
            hexWidth: 0,
            hexHeight: 0,
            cols: 0,
            rows: 0,
            hexPoints: [],
            frequency: 0.08,
            hexGrid: new Map<string, Hex>()
        };
        this.hexGrid = this.hex.hexGrid;
    }

    create ()
    {
        this.camera = this.cameras.main;
        this.camera.setBackgroundColor(0x000000);

        const width = this.scale.width;
        const height = this.scale.height;

        // Initialize hex object
        this.hex.hexSize = this.hex.cellSize; // radius
        this.hex.hexWidth = Math.sqrt(3) * this.hex.hexSize;
        this.hex.hexHeight = 2 * this.hex.hexSize;
        this.hex.cols = Math.ceil(width / this.hex.hexWidth) + 2;
        this.hex.rows = Math.ceil(height / (this.hex.hexSize * 1.5)) + 2;

        // Precompute hexagon points (relative to center) for pointy-top hex
        this.hex.hexPoints = (() => {
            const pts: number[] = [];
            for (let i = 0; i < 6; i++) {
                const angle = Phaser.Math.DegToRad(60 * i + 30);
                pts.push(this.hex.hexSize * Math.cos(angle), this.hex.hexSize * Math.sin(angle));
            }
            return pts;
        })();

        // Create simplex noise generator
        // 1. SETUP NOISE LAYERS
        // We use a large offset for moisture so it doesn't look identical to elevation
        const elevNoise = createNoise2D(); 
        const moistNoise = createNoise2D(); 

        const gridData: Hex[] = [];

        // 2. GENERATE RAW DATA
        for (let r = 0; r < this.hex.rows; r++) {
            for (let c = 0; c < this.hex.cols; c++) {
                // Convert Offset (Row/Col) to Axial (Q/R)
                // Odd-r offset to axial conversion
                const q = c - (r - (r & 1)) / 2;
                const r_axial = r;
                
                const h = new Hex(q, r_axial);
                
                // Store screen position for rendering later
                // (You might want to add x/y properties to your Hex class)
                (h as any).screenX = c * this.hex.hexWidth + (r % 2) * (this.hex.hexWidth / 2);
                (h as any).screenY = r * (this.hex.hexSize * 1.5);

                const nx = c * this.hex.frequency;
                const ny = r * this.hex.frequency;

                // Raw Noise (-1 to 1)
                h.elevation = elevNoise(nx, ny);
                h.moisture = moistNoise(nx + 1000, ny + 1000); // Offset for variety

                gridData.push(h);
                this.hexGrid.set(`${h.q},${h.r}`, h);
            }
        }

        // 3. BALANCE THE BIOMES (Histogram Equalization)
        // This forces your map to use the full range of values (0.0 to 1.0) evenly.
        this.normalizeValues(gridData, 'elevation');
        this.normalizeValues(gridData, 'moisture');

        // 4. RENDER
        gridData.forEach(h => {
            const color = this.getBiomeColor(h.elevation, h.moisture);
            this.add.polygon((h as any).screenX, (h as any).screenY, this.hex.hexPoints, color, 1);
        });

        // Add a back button
        const backButton = this.add.text(this.scale.width - 20, 20, 'Back to Menu', {
            fontFamily: 'Arial', fontSize: 20, color: '#ffffff',
            backgroundColor: '#000000'
        }).setOrigin(1, 0).setPadding(10).setInteractive({ useHandCursor: true });

        backButton.on('pointerdown', () => {
            this.scene.start('MainMenu');
        });
    }

    // This ensures specific percentages of the map are Water/Land/Mountain
    // regardless of the random seed.
    normalizeValues(list: Hex[], property: 'elevation' | 'moisture') {
        // Sort by the raw noise value
        list.sort((a, b) => a[property] - b[property]);

        // Re-assign values based on rank (0.0 to 1.0)
        const total = list.length;
        list.forEach((hex, index) => {
            hex[property] = index / total;
        });
    }

    getBiomeColor(e: number, m: number): number {
        // WHITTAKER-STYLE BIOME TABLE
        
        // Water Level (Bottom 30% of elevation)
        if (e < 0.3) return 0x08224b; // Deep Ocean
        if (e < 0.35) return 0x3fa9f5; // Shallow Water

        // Land - Logic splits by Moisture (m)
        
        // High Elevation (Mountain/Snow)
        if (e > 0.85) {
            if (m < 0.3) return 0x555555; // Scorched Peak
            if (m < 0.7) return 0x888888; // Bare Mountain
            return 0xffffff;              // Snow
        }

        // Mid Elevation (Hills/Forests)
        if (e > 0.6) {
            if (m < 0.33) return 0xd2c38e; // Desert Dunes
            if (m < 0.66) return 0x556B2F; // Shrubland
            return 0x228B22;              // Forest
        }

        // Low Elevation (Plains/Beach)
        if (m < 0.2) return 0xe0d2a4; // Sand/Beach
        if (m < 0.5) return 0x90EE90; // Grassland
        if (m < 0.8) return 0x228B22; // Forest
        return 0x006400;              // Jungle/Swamp
    }
}

class Hex {
    q: number;
    r: number;
    s: number;
    elevation: number;
    moisture: number;

    constructor(q: number, r: number) {
        this.q = q;
        this.r = r;
        this.s = -q - r;
    }
}