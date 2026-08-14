'use strict';
// 通关率模拟：复用 index.html 内的纯逻辑（__hex2048Test），
// 复刻 滑动→级联聚变→热度→刷子 完整回合循环，扫描不同散热效率下的通关率。
// 通关 = 合成出 ★（999）。用法：node tools/heat_sim.js random|greedy
const fs = require('fs');
const html = fs.readFileSync('D:/code/hex2048/index.html', 'utf8');
const m = html.match(/<script>([\s\S]*?)<\/script>/);
if (!m) throw new Error('script block not found');

globalThis.document = { getElementById: () => null };
eval(m[1]);
const T = globalThis.__hex2048Test;
if (!T) throw new Error('__hex2048Test not exported');

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DIRS = T.DIRS;
const CELLS = T.CELLS;
const keyOf = T.keyOf;
const key = T.key;
const BOARD_KEYS = new Set(CELLS.map(keyOf));
const LANES = DIRS.map((d) => T.getLanes(d));

function slideOnly(grid, direction) {
  const moves = [];
  for (const lane of LANES[DIRS.indexOf(direction)]) {
    const segments = [];
    let seg = [];
    for (let i = 0; i < lane.length; i += 1) {
      if (seg.length === 0) { seg.push(lane[i]); continue; }
      const prev = seg[seg.length - 1];
      const cur = lane[i];
      if (cur.q - prev.q === -direction.q && cur.r - prev.r === -direction.r) seg.push(cur);
      else { segments.push(seg); seg = [cur]; }
    }
    if (seg.length) segments.push(seg);
    for (const laneSeg of segments) {
      const compact = [];
      for (const cell of laneSeg) {
        const tile = grid.get(keyOf(cell));
        if (tile) compact.push(tile);
      }
      for (let i = 0; i < compact.length; i += 1) {
        const target = laneSeg[i];
        const tile = compact[i];
        if (tile.q !== target.q || tile.r !== target.r) {
          moves.push({ tile, fromQ: tile.q, fromR: tile.r, toQ: target.q, toR: target.r });
        }
      }
    }
  }
  return moves.length ? moves : null;
}

function applyMoves(grid, moves) {
  for (const mv of moves) grid.delete(key(mv.fromQ, mv.fromR));
  for (const mv of moves) {
    grid.set(key(mv.toQ, mv.toR), mv.tile);
    mv.tile.q = mv.toQ; mv.tile.r = mv.toR;
  }
}

// 与游戏一致的 BFS 就近空位放置
function findNearestEmptySpot(grid, center, taken) {
  const queue = [{ q: center.q, r: center.r }];
  const visited = new Set();
  while (queue.length) {
    const cur = queue.shift();
    const k = key(cur.q, cur.r);
    if (!BOARD_KEYS.has(k) || visited.has(k)) continue;
    visited.add(k);
    if (!grid.has(k) && !taken.has(k)) return { q: cur.q, r: cur.r };
    for (const d of DIRS) queue.push({ q: cur.q + d.q, r: cur.r + d.r });
  }
  return null;
}

function applyFusionWave(grid, wave, state) {
  const consumed = new Set();
  for (const r of wave) for (const t of r.tiles) consumed.add(t.id);
  for (const tile of Array.from(grid.values())) {
    if (consumed.has(tile.id)) grid.delete(keyOf(tile));
  }
  const taken = new Set();
  for (const r of wave) for (const t of r.tiles) taken.add(keyOf(t));
  for (const r of wave) {
    const spots = r.tiles.slice().sort((a, b) => (a.q + a.r / 2) - (b.q + b.r / 2) || a.r - b.r);
    const atoms = [r.product, ...(r.byproducts || [])];
    for (let i = 0; i < atoms.length; i += 1) {
      const value = atoms[i];
      let spot = null;
      if (i < spots.length) spot = { q: spots[i].q, r: spots[i].r };
      else spot = findNearestEmptySpot(grid, r.center, taken);
      if (!spot) continue;
      taken.add(key(spot.q, spot.r));
      grid.set(key(spot.q, spot.r), { id: ++state.tileSeq, value, q: spot.q, r: spot.r });
    }
  }
}

function cloneGrid(grid) {
  const g = new Map();
  for (const [k, t] of grid) g.set(k, { id: t.id, value: t.value, q: t.q, r: t.r });
  return g;
}

function countFusionsForMove(grid, dir, state) {
  const g = cloneGrid(grid);
  const moves = slideOnly(g, dir);
  if (!moves) return 0;
  applyMoves(g, moves);
  let count = 0;
  for (;;) {
    const wave = T.computeFusionWave(g);
    if (!wave.length) break;
    applyFusionWave(g, wave, state);
    count += wave.length;
  }
  return count;
}

// 一局游戏：win=合成★；exploded=堆芯失控；maxTile=本局达到的最大值
function playGame(cool, maxTurns, rng, strategy) {
  const state = { tileSeq: 0 };
  const grid = new Map();
  const spawn = () => {
    const empty = CELLS.filter((c) => !grid.has(keyOf(c)));
    if (!empty.length) return;
    const cell = empty[Math.floor(rng() * empty.length)];
    const value = rng() < 0.9 ? 1 : 2;
    grid.set(keyOf(cell), { id: ++state.tileSeq, value, q: cell.q, r: cell.r });
  };
  spawn(); spawn();
  let heat = 0, turns = 0, unlocked = false, maxTile = 1;
  let invalidStreak = 0;
  const heatLimit = () => (unlocked ? 32 : 16);
  while (turns < maxTurns) {
    let dir;
    if (strategy === 'greedy') {
      let best = -1;
      const bestDirs = [];
      for (const d of DIRS) {
        const n = countFusionsForMove(grid, d, state);
        if (n > best) { best = n; bestDirs.length = 0; bestDirs.push(d); }
        else if (n === best) bestDirs.push(d);
      }
      if (best <= 0) {
        let fallback = null;
        for (const d of DIRS) if (slideOnly(grid, d)) { fallback = d; break; }
        if (!fallback) break; // 无有效移动，游戏结束
        dir = fallback;
      } else {
        dir = bestDirs[Math.floor(rng() * bestDirs.length)];
      }
    } else {
      if (invalidStreak >= 10) {
        let any = false;
        for (const d of DIRS) if (slideOnly(grid, d)) { any = true; break; }
        if (!any) break;
        invalidStreak = 0;
      }
      dir = DIRS[Math.floor(rng() * DIRS.length)];
    }
    const moves = slideOnly(grid, dir);
    if (!moves) { invalidStreak += 1; continue; }
    invalidStreak = 0;
    applyMoves(grid, moves);
    let exploded = false;
    for (;;) {
      const wave = T.computeFusionWave(grid);
      if (!wave.length) break;
      applyFusionWave(grid, wave, state);
      heat += wave.length;
      for (const t of grid.values()) if (t.value > maxTile) maxTile = t.value;
      if (!unlocked) {
        for (const t of grid.values()) if (t.value === 999) { unlocked = true; break; }
      }
      if (heat >= heatLimit()) { exploded = true; break; }
    }
    if (exploded) return { win: false, exploded: true, turns, maxTile };
    turns += 1;
    heat = Math.max(0, heat - cool);
    spawn();
    if (unlocked) return { win: true, exploded: false, turns, maxTile };
  }
  return { win: false, exploded: false, turns, maxTile };
}

function run(cool, strategy, games, maxTurns) {
  const rng = mulberry32(Math.floor(cool * 100) + (strategy === 'greedy' ? 777 : 1));
  let wins = 0, explodes = 0, ge56 = 0, ge197 = 0, ge238 = 0, totalTurns = 0;
  for (let g = 0; g < games; g += 1) {
    const r = playGame(cool, maxTurns, rng, strategy);
    if (r.win) wins += 1;
    if (r.exploded) explodes += 1;
    if (r.maxTile >= 56) ge56 += 1;
    if (r.maxTile >= 197) ge197 += 1;
    if (r.maxTile >= 238) ge238 += 1;
    totalTurns += r.turns;
  }
  return {
    winRate: (wins / games) * 100,
    explodeRate: (explodes / games) * 100,
    ge56: (ge56 / games) * 100,
    ge197: (ge197 / games) * 100,
    ge238: (ge238 / games) * 100,
    avgTurns: totalTurns / games
  };
}

const strategy = process.argv[2] || 'random';
const games = strategy === 'greedy' ? 120 : 200;
const maxTurns = strategy === 'greedy' ? 200 : 250;
const cools = [0.5, 1.0, 1.5, 2.0, 3.0, 5.0, 8.0, 12.0, 16.0, 20.0];

console.log('=== strategy: ' + strategy + '（通关=合成★；上限 16→32；' + games + ' 局，最多 ' + maxTurns + ' 回合）===');
console.log('散热/回合\t通关率%\t失控率%\t达到Fe(56)%\t达到Au(197)%\t达到U(238)%\t平均回合');
for (const cool of cools) {
  const t0 = Date.now();
  const r = run(cool, strategy, games, maxTurns);
  console.log(
    cool.toFixed(1) + '\t' +
    r.winRate.toFixed(2) + '\t' +
    r.explodeRate.toFixed(1) + '\t' +
    r.ge56.toFixed(1) + '\t' +
    r.ge197.toFixed(1) + '\t' +
    r.ge238.toFixed(1) + '\t' +
    r.avgTurns.toFixed(0) + '\t(' + (Date.now() - t0) + 'ms)'
  );
}
