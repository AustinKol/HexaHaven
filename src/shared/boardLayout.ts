import type {
  EdgeLocation,
  GameConfig,
  HexCoord,
  ResourceType,
  TileState,
  VertexLocation,
} from './types/domain';

const HEX_DIRECTIONS: [number, number][] = [[1, 0], [0, 1], [-1, 1], [-1, 0], [0, -1], [1, -1]];
const MAP_RADIUS: Record<GameConfig['mapSize'], number> = { small: 1, medium: 2, large: 3 };
const RESOURCE_TYPES: ResourceType[] = ['CRYSTAL', 'STONE', 'BLOOM', 'EMBER', 'GOLD'];
const TOKEN_POOL = [2, 3, 3, 4, 4, 5, 5, 6, 6, 8, 8, 9, 9, 10, 10, 11, 11, 12];

function hashSeed(input: number): number {
  return Math.trunc(input) >>> 0;
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

function shuffleInPlace<T>(values: T[], random: () => number): T[] {
  for (let i = values.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [values[i], values[j]] = [values[j], values[i]];
  }
  return values;
}

function uniqueCoords(coords: HexCoord[]): HexCoord[] {
  const seen = new Set<string>();
  return coords.filter((coord) => {
    const key = hexCoordKey(coord);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

export function hexCoordKey(coord: HexCoord): string {
  return `${coord.q},${coord.r}`;
}

export function sortHexCoords(coords: HexCoord[]): HexCoord[] {
  return [...coords].sort((left, right) => (left.q === right.q ? left.r - right.r : left.q - right.q));
}

export function tileIdFromCoord(coord: HexCoord): string {
  return `t:${hexCoordKey(coord)}`;
}

export function parseTileId(tileId: string): HexCoord | null {
  if (!tileId.startsWith('t:')) {
    return null;
  }

  const [qRaw, rRaw] = tileId.slice(2).split(',');
  const q = Number.parseInt(qRaw, 10);
  const r = Number.parseInt(rRaw, 10);
  if (!Number.isFinite(q) || !Number.isFinite(r)) {
    return null;
  }

  return { q, r };
}

export function vertexIdFromHexes(coords: HexCoord[]): string {
  const ordered = sortHexCoords(uniqueCoords(coords));
  return `v:${ordered.map((coord) => hexCoordKey(coord)).join('|')}`;
}

export function parseVertexId(vertexId: string): HexCoord[] {
  if (!vertexId.startsWith('v:')) {
    return [];
  }

  const raw = vertexId.slice(2).trim();
  if (!raw) {
    return [];
  }

  return raw
    .split('|')
    .map((part) => {
      const [qRaw, rRaw] = part.split(',');
      const q = Number.parseInt(qRaw, 10);
      const r = Number.parseInt(rRaw, 10);
      if (!Number.isFinite(q) || !Number.isFinite(r)) {
        return null;
      }
      return { q, r };
    })
    .filter((coord): coord is HexCoord => coord !== null);
}

export function edgeIdFromVertexIds(leftVertexId: string, rightVertexId: string): string {
  const [first, second] = [leftVertexId, rightVertexId].sort((left, right) => left.localeCompare(right));
  return `e:${first}~${second}`;
}

export function parseEdgeId(edgeId: string): [string, string] | null {
  if (!edgeId.startsWith('e:')) {
    return null;
  }

  const [left, right] = edgeId.slice(2).split('~');
  if (!left || !right) {
    return null;
  }

  return [left, right];
}

export function adjacentHexesForVertex(
  origin: HexCoord,
  corner: number,
  existingHexKeys: Set<string>,
): HexCoord[] {
  const neighborCorners = [corner, (corner + 5) % 6];
  const adjacentHexes: HexCoord[] = [{ q: origin.q, r: origin.r }];

  for (const directionIndex of neighborCorners) {
    const [dq, dr] = HEX_DIRECTIONS[directionIndex];
    const candidate = { q: origin.q + dq, r: origin.r + dr };
    if (existingHexKeys.has(hexCoordKey(candidate))) {
      adjacentHexes.push(candidate);
    }
  }

  return sortHexCoords(uniqueCoords(adjacentHexes));
}

export function canonicalEdgeIdForHex(
  origin: HexCoord,
  edge: number,
  existingHexKeys: Set<string>,
): string {
  const leftVertexId = vertexIdFromHexes(adjacentHexesForVertex(origin, edge, existingHexKeys));
  const rightVertexId = vertexIdFromHexes(adjacentHexesForVertex(origin, (edge + 1) % 6, existingHexKeys));
  return edgeIdFromVertexIds(leftVertexId, rightVertexId);
}

export function buildVertexLocationFromId(vertexId: string): VertexLocation {
  const adjacentHexes = parseVertexId(vertexId);
  return {
    id: vertexId,
    hex: adjacentHexes[0] ?? { q: 0, r: 0 },
    corner: 0,
    adjacentHexes,
  };
}

export function buildEdgeLocationFromId(edgeId: string): EdgeLocation {
  const parsed = parseEdgeId(edgeId);
  if (parsed === null) {
    return {
      id: edgeId,
      hex: { q: 0, r: 0 },
      dir: 0,
      adjacentHexes: [],
    };
  }

  const [leftVertexId, rightVertexId] = parsed;
  const leftHexes = parseVertexId(leftVertexId);
  const rightHexes = parseVertexId(rightVertexId);
  const rightKeys = new Set(rightHexes.map(hexCoordKey));
  const adjacentHexes = leftHexes.filter((coord) => rightKeys.has(hexCoordKey(coord)));

  return {
    id: edgeId,
    hex: adjacentHexes[0] ?? leftHexes[0] ?? { q: 0, r: 0 },
    dir: 0,
    adjacentHexes,
  };
}

export function generateBoardTiles(
  config: Pick<GameConfig, 'mapSeed' | 'mapSize'>,
  createdAtIso: string = new Date().toISOString(),
): TileState[] {
  const radius = MAP_RADIUS[config.mapSize];
  const coords: HexCoord[] = [];

  for (let q = -radius; q <= radius; q += 1) {
    for (let r = -radius; r <= radius; r += 1) {
      if (Math.abs(q + r) <= radius) {
        coords.push({ q, r });
      }
    }
  }

  const orderedCoords = sortHexCoords(coords);
  const existingHexKeys = new Set(orderedCoords.map(hexCoordKey));
  const random = mulberry32(hashSeed(config.mapSeed));

  const resourceAssignments = shuffleInPlace(
    orderedCoords.map((_, index) => RESOURCE_TYPES[index % RESOURCE_TYPES.length]),
    random,
  );
  const tokenAssignments = shuffleInPlace(
    orderedCoords.map((_, index) => TOKEN_POOL[index % TOKEN_POOL.length]),
    random,
  );

  return orderedCoords.map((coord, index) => {
    const adjacentTiles = HEX_DIRECTIONS
      .map(([dq, dr]) => ({ q: coord.q + dq, r: coord.r + dr }))
      .filter((candidate) => existingHexKeys.has(hexCoordKey(candidate)))
      .map(tileIdFromCoord);

    const vertices = Array.from({ length: 6 }, (_, corner) => (
      vertexIdFromHexes(adjacentHexesForVertex(coord, corner, existingHexKeys))
    ));

    const edges = Array.from({ length: 6 }, (_, edge) => canonicalEdgeIdForHex(coord, edge, existingHexKeys));

    return {
      tileId: tileIdFromCoord(coord),
      coord,
      resourceType: resourceAssignments[index],
      numberToken: tokenAssignments[index],
      adjacentTiles,
      vertices,
      edges,
      createdAt: createdAtIso,
    };
  });
}
