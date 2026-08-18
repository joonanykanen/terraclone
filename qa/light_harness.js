"use strict";
/* Deterministic harness: extracts the REAL lighting code (addLight/updateLight +
   supporting consts) from index.html and runs it on a synthetic world, so we can
   prove the "top of screen stays lit when digging" bug and verify the fix.
   Usage: node qa/light_harness.js [path/to/index.html] */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const FILE = path.resolve(process.argv[2] || path.join(__dirname, '..', 'index.html'));
const html = fs.readFileSync(FILE, 'utf8');

// ---- extract lighting section: from "const LW=" to the line before the rendering banner
const start = html.indexOf('const LW=');
const end = html.indexOf('/* ============================ rendering');
if (start < 0 || end < 0) throw new Error('could not locate lighting section');
const code = html.slice(start, end);

// ---- synthetic world
const TILE = 16, W = 400, H = 200, CW = 1280, CH = 720;
const SURF = 60;                      // surface row: rows < SURF are sky/air
const world = new Uint8Array(W * H);
const T = { AIR: 0, DIRT: 1, STONE: 2, GRASS: 3, SAND: 4, WOOD: 5, LEAVES: 6,
            IRON: 7, GOLD: 8, DIA: 9, SNOW: 10, TORCH: 11, PLANK: 12, WORKBENCH: 13, BEDROCK: 14 };
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  world[y * W + x] = y === SURF ? T.GRASS : y > SURF ? T.STONE : T.AIR;
}
const setT = (x, y, t) => { if (x >= 0 && x < W && y >= 0 && y < H) world[y * W + x] = t; };
const surf = new Int16Array(W).fill(SURF); // original surface (game never mutates surf after gen)

// scenario features:
setT(200, SURF, T.AIR); for (let y = SURF + 1; y <= SURF + 30; y++) setT(200, y, T.AIR); // 31-tile dug shaft @ x=200
setT(100, 56, T.LEAVES); setT(100, 57, T.LEAVES); setT(100, 58, T.LEAVES); setT(100, 59, T.LEAVES); // tree column @ x=100
for (let y = SURF + 1; y <= SURF + 10; y++) setT(300, y, T.AIR); // 10-tile hole in stone @ x=300

// day: full ambient (amb = 0.28 + 0.72*1 = 1.0)
const dayF = 1;
const player = { x: 200 * 16 + 4, y: (SURF + 28) * 16 };

function runLight2(camX, camY) {
  const sandbox = {
    W, H, CW, CH, T, world, surf, camX, camY, dayF, player,
    TILES: { 0:{solid:false},1:{solid:true},2:{solid:true},3:{solid:true},4:{solid:true},5:{solid:true},6:{solid:true},
             7:{solid:true},8:{solid:true},9:{solid:true},10:{solid:true},11:{solid:false},12:{solid:true},13:{solid:true},14:{solid:true} },
    mkCanvas: () => ({ getContext: () => ({ createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }), putImageData: () => {} }) }),
    __out: {},
  };
  vm.createContext(sandbox);
  vm.runInContext(code + `
    updateLight();
    __out.lightArr = lightArr; __out.openArr = openArr; __out.LW = LW; __out.LH = LH;
    __out.x0 = Math.floor(camX/16)-1; __out.y0 = Math.floor(camY/16)-1;
  `, sandbox, { filename: 'lighting-extracted.js' });
  return sandbox.__out;
}

// camera: camY such that view top row = y0. camX so column 200 is mid-screen.
function test(label, y0top, x0top, checks) {
  const camX = (x0top + 1) * 16;          // x0 = x0top
  const camY = (y0top + 1) * 16;          // y0 = y0top (view top row = y0top)
  const out = runLight2(camX, camY);
  const x0 = out.x0, y0 = out.y0;
  console.log(`\n=== ${label} (view top row y0=${y0}) ===`);
  for (const [tx, ty, desc] of checks) {
    const sx = tx - x0, sy = ty - y0;
    const l = out.lightArr[sy * out.LW + sx];
    const o = out.openArr[sy * out.LW + sx];
    console.log(`  (${tx},${ty}) ${desc.padEnd(46)} light=${l.toFixed(3)} open=${o}`);
  }
  return out;
}

// A: view entirely underground, top row = solid stone 20 rows below surface
test('A: underground view, top of screen is solid stone (20 below surface)', SURF + 19, 140, [
  [150, SURF + 20, 'stone at TOP of screen (20 below surf)'],
  [150, SURF + 25, 'stone 25 below surface'],
  [200, SURF + 20, 'shaft air at top of screen (20 below surf)'],
  [200, SURF + 28, 'shaft air near player (28 below surf)'],
]);

// B: view straddles the surface (like the user's screenshot)
test('B: surface visible at top of screen, shaft below', SURF - 15, 140, [
  [150, SURF - 5, 'sky air'],
  [150, SURF, 'surface grass'],
  [150, SURF + 3, 'stone 3 below surface'],
  [200, SURF, 'shaft top air (at surface)'],
  [200, SURF + 5, 'shaft air 5 below surface'],
  [200, SURF + 13, 'shaft air 13 below surface'],
  [200, SURF + 25, 'shaft air 25 below surface'],
]);

// C: regression checks — tree canopy + open hole in stone
test('C1: tree column', SURF - 15, 90, [
  [100, 55, 'air above canopy'],
  [100, 56, 'top leaf'],
  [100, 59, 'bottom leaf'],
  [100, SURF, 'ground under canopy (4 leaf rows above)'],
  [100, SURF + 2, 'stone under canopy, 2 deep'],
]);

test('C2: 10-tile hole in stone', SURF - 5, 290, [
  [300, SURF, 'surface above hole'],
  [300, SURF + 1, 'hole air 1 below surface'],
  [300, SURF + 6, 'hole air 6 below surface'],
  [300, SURF + 10, 'hole air 10 below surface (bottom of hole)'],
  [300, SURF + 11, 'stone 1 below hole bottom'],
]);
