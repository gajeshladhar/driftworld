// ── Driftworld · configuration ───────────────────────────────────────────────
// Real-Earth speedboat game. Land cover from ESRI/Impact Observatory Sentinel-2
// 10m LULC; elevation from Mapzen/AWS Terrarium 30m DEM tiles.

export const LULC_SERVICE =
  'https://ic.imagery1.arcgis.com/arcgis/rest/services/Sentinel2_10m_LandCover/ImageServer/exportImage';

export const DEM_URL = (z, x, y) =>
  `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;

// Zoom 13 ≈ 9 m/px at 60°N — closely matched to the LULC's native 10 m grid.
export const ZOOM       = 13;
export const TILE_PX    = 256;   // texture resolution per tile
export const MESH_SEG   = 48;    // terrain vertices per tile edge (chunky on purpose)
export const LOAD_RADIUS   = 3;  // tiles kept loaded around the player (7×7)
export const UNLOAD_RADIUS = 5;  // tiles disposed beyond this
export const MAX_INFLIGHT  = 6;  // concurrent tile fetches

export const VERTICAL_EXAGGERATION = 1.8; // 30 m DEM reads flat at game scale
export const PIXEL_SCALE = 1;             // 1 = native resolution (no downsampling)

// ── Impact Observatory / ESRI palette ────────────────────────────────────────
// Exact RGB as served by the ImageServer with nearest-neighbour interpolation.
// Verified against a live tile: 6 unique colours, zero interpolation.
export const CLASSES = {
  WATER:     { rgb: [0x1A, 0x5B, 0xAB], name: 'Water',        art: [0x14, 0x5A, 0x80] },
  TREES:     { rgb: [0x35, 0x82, 0x21], name: 'Trees',        art: [0x2B, 0x5F, 0x3F] },
  FLOODED:   { rgb: [0x87, 0xD1, 0x9E], name: 'Flooded veg.', art: [0x4E, 0x91, 0x73] },
  CROPS:     { rgb: [0xFF, 0xDB, 0x5C], name: 'Crops',        art: [0xC9, 0xA2, 0x4D] },
  BUILT:     { rgb: [0xED, 0x02, 0x2A], name: 'Built area',   art: [0x8F, 0x55, 0x63] },
  BARE:      { rgb: [0xED, 0xE9, 0xE4], name: 'Bare ground',  art: [0xB8, 0xA8, 0x94] },
  SNOW:      { rgb: [0xF2, 0xFA, 0xFF], name: 'Snow / ice',   art: [0xE8, 0xF2, 0xF7] },
  CLOUDS:    { rgb: [0xC8, 0xC8, 0xC8], name: 'Clouds',       art: [0xB9, 0xC3, 0xC9] },
  RANGELAND: { rgb: [0xEF, 0xCF, 0xA8], name: 'Rangeland',    art: [0xB3, 0x9A, 0x6F] },
};

export const WATER_RGB = CLASSES.WATER.rgb;

// ── Playable locations (all have substantial water at zoom 13) ───────────────
export const LOCATIONS = [
  { name: 'Geirangerfjord, Norway',  lat:  62.1005, lon:   7.2050 },
  { name: 'Ha Long Bay, Vietnam',    lat:  20.9101, lon: 107.1839 },
  { name: 'Kerala Backwaters, India',lat:   9.5000, lon:  76.4000 },
  { name: 'Milford Sound, NZ',       lat: -44.6414, lon: 167.8974 },
  { name: 'Lake Como, Italy',        lat:  45.9800, lon:   9.2600 },
  { name: 'Lofoten, Norway',         lat:  68.1500, lon:  13.6000 },
];

export const BOAT = {
  accel:      95,    // m/s^2 forward thrust
  brakeAccel: 150,   // S is a real brake before it becomes reverse
  reverseMax: 26,
  coastDrag:  0.30,  // per second, gentle: it glides, but never self-propels
  maxSpeed:   138,
  boostMax:   242,
  boostAccel: 168,
  // Steering is speed-gated like a car: no rotation at a standstill.
  turnRate:      2.05,  // rad/s at full authority
  turnFullAt:    30,    // m/s at which steering reaches full authority
  steerLerp:     7.0,   // how fast steering input ramps in/out
  turnFalloff:   0.55,  // high speed widens the turning circle
  hullLift:      1.6,
};

export const FLY = {
  accel: 240, drag: 0.32, maxSpeed: 700,
  turnRate: 1.3, turnFullAt: 55, steerLerp: 5.0, turnFalloff: 0.3,
  climbRate: 300,     // m/s held climb — no ceiling
  boostClimb: 2.6,    // Shift multiplies it
};

// ── Navigation ───────────────────────────────────────────────────────────────
export const NAV = {
  buoyCount:    6,      // active waypoints at once
  minRange:     600,    // metres from the player when placed
  maxRange:     3400,
  reachRadius:  85,
  beaconHeight: 60,
};

export const MINIMAP = { size: 190, spanMetres: 5200, thumbPx: 64 };

export const CLASS_ORDER = ['WATER','TREES','FLOODED','CROPS','BUILT','BARE','SNOW','CLOUDS','RANGELAND'];

// ── Atmosphere: golden hour. Warm haze on distant land, cool water. ─────────
export const SKY = {
  top:     0x1D4A7D,
  mid:     0x7FA9C4,
  horizon: 0xDCB894,
  sun:     [0.55, 0.30, 0.42],   // low elevation for long, warm light
};

// ── Ship ─────────────────────────────────────────────────────────────────────
// Rendered at full resolution in a second pass, so it stays crisp against the
// deliberately pixelated world.
export const SHIP = {
  accent:   0x38E8FF,   // forward running lights / canopy rim
  thrust:   0xFF5BC8,   // engines — magenta reads as unmistakably "rear"
  hull:     0x2A3550,
  hullTrim: 0x8FA7C4,
};

// -- Scenery density. Stride is in LULC pixels (10 m each). -----------------
export const PROPS = {
  treeStride:  7,  treeChance:  0.60,
  buildStride: 8,  buildChance: 0.72,
  shrubStride: 12, shrubChance: 0.32,
  rockStride:  13, rockChance:  0.28,
};


// ── Atmosphere presets. Uniform swaps only — no per-frame cost. ─────────────
export const ATMOSPHERES = [
  { name: 'Golden Hour', sun: [ 0.55, 0.30,  0.42], top: 0x1D4A7D, mid: 0x7FA9C4,
    horizon: 0xDCB894, light: 0xFFE6C4, amb: 0x4A5A78 },
  { name: 'Clear Noon',  sun: [ 0.25, 0.94,  0.20], top: 0x1B62B4, mid: 0x86BEE4,
    horizon: 0xCFE4F2, light: 0xFFF6E4, amb: 0x5A6E88 },
  { name: 'Cold Dawn',   sun: [-0.62, 0.22,  0.35], top: 0x27406E, mid: 0x7C93BC,
    horizon: 0xE3C7C0, light: 0xFFD9D2, amb: 0x46546E },
  { name: 'Deep Dusk',   sun: [-0.48, 0.13, -0.55], top: 0x14203F, mid: 0x4A4A82,
    horizon: 0xC97E6E, light: 0xFFB48C, amb: 0x33395C },
];

// ── Survey run: the game loop ──────────────────────────────────────────────
export const RUN = {
  lives:        9,
  crashInvuln:  2.2,     // seconds of grace after a hit, so one ridge is one life
  crashBounce:  260,     // how far the craft is lifted clear after a hit

  // Obstacle height above bare terrain, by land-cover class. The scenery is
  // instanced and far too numerous to collide against individually, so the
  // classification stands in for it: a tower block is 90 units of "ground".
  clearance:    26,      // baseline hull clearance over open ground
  obstacle: { BUILT: 96, TREES: 34, FLOODED: 20, SNOW: 10, WATER: 0 },

  ranks: [
    [0,     'DRIFTER'],
    [25,    'SCOUT'],
    [75,    'RANGER'],
    [180,   'PATHFINDER'],
    [400,   'ASCENDANT'],
  ],
};

// ── Place labels ───────────────────────────────────────────────────────────
export const PLACES = {
  bboxDeg:       0.18,   // half-size of the Overpass query box, degrees lat
  maxFetch:      70,
  maxVisible:    12,     // labels on screen at once; more is clutter
  maxDistance:   14000,  // world metres
  fadeStart:     7000,
  rankBias:      900,    // metres of "credit" per rank step, so a city beats a hamlet
  geocodeEvery:  2500,   // metres travelled before re-checking the locality
  queryEvery:    5000,   // metres travelled before re-querying Overpass
  minQueryGapMs: 20000,  // hard floor between Overpass calls; it is a shared service
};

// ── Showreel: enclosed water with dramatic relief, northern hemisphere so the
// fixed sun lights the terrain rather than back-lighting it. ────────────────
export const REEL = [
  { name: 'REINE',            sub: 'LOFOTEN, NORWAY',      lat: 67.9310, lon: 13.0890 },
  { name: 'GEIRANGERFJORD',   sub: 'MORE OG ROMSDAL, NORWAY', lat: 62.1005, lon:  7.2050 },
  { name: 'LYSEFJORD',        sub: 'ROGALAND, NORWAY',     lat: 59.0400, lon:  6.4600 },
  { name: 'LAGO DI COMO',     sub: 'LOMBARDIA, ITALY',     lat: 46.1400, lon:  9.3000 },
];

// ── Live weather ────────────────────────────────────────────────────────────
export const WEATHER = {
  refreshKm: 25,      // refetch once you have travelled this far
  windDrift: 0.12,    // hull drift per m/s of wind; enough to feel, not to strand
};

// ── Cloud deck ──────────────────────────────────────────────────────────────
// Heights are world units, i.e. metres x VERTICAL_EXAGGERATION. base 2600 is
// roughly a 1450 m cloud base, which sits above most fjord walls but well
// inside the craft's climb range.
export const CLOUDS = {
  layers:     3,
  base:       2600,
  spacing:    420,
  span:       46000,
  scale:      0.00055,
  fade:       520,      // camera distance over which a layer dissolves
  driftScale: 0.6,
};

// ── Life cells: scattered pickups that restore a life ───────────────────────
export const CELLS = {
  active:      5,        // how many exist ahead of you at once
  minRange:    900,      // metres from the craft when placed
  maxRange:    5200,
  reachRadius: 130,
  aboveGround: 320,      // floats this far over the terrain beneath it
  beaconHeight: 90,
};

// ── Combat ──────────────────────────────────────────────────────────────────
// Missiles are faster than the craft can ever fly, so outrunning one is not an
// option; they turn worse than you do, which makes a hard break the answer.
export const ENEMY = {
  maxActive:   2,
  firstWave:   16,      // seconds of quiet before the first contact
  spawnEvery:  13,
  spawnRange:  3400,
  spawnSpread: 0.85,    // radians either side of dead ahead
  speed:       340,
  turnRate:    0.9,
  standoff:    900,
  fireEvery:   4.6,
  fireRange:   2100,
  health:      2,
  despawn:     7500,
  scale:       2.4,     // the craft is ~50 units; a jet must read at 2 km
};

// Slower than the craft at full boost, so running is a real option, and with a
// turn radius (speed/turnRate) wider than yours, so breaking works too.
export const MISSILE = {
  speed:      470,
  turnRate:   0.55,     // radius ~855 m against the craft's ~700
  life:       8.5,
  hitRadius:  46,
  armAfter:   0.4,
  scale:      2.2,
};

export const GUN = {
  speed:      1500,
  life:       1.5,
  cooldown:   0.14,
  hitRadius:  70,
};
