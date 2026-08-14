'use strict';
// 热度模拟：复用 index.html 内的纯逻辑（__hex2048Test），
// 复刻 滑动→级联聚变→热度→刷子 的完整回合循环，扫描不同前期冷却值。
const fs = require('fs');
const html = fs.readFileSync('D:/code/hex2048/index.html', 'utf8');
const m = html.match(/<script>([\s\S]*?)<\/script>/);
if (!m) throw new Error('script block not found');

globalThis.document = { getElementById: () => null };
eval(m[1]);
const T = globalThis.__hex2048Test;
if (!T) throw new Error('__hex2048Test not exported');

// ---- 可复现 RNG ----
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
// 预计算 6 个方向的巷道，避免每次滑动都重建排序
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
      else {
        for (const d of DIRS) {
          const c = { q: r.center.q + d.q, r: r.center.r + d.r };
          const k = key(c.q, c.r);
          if (CELLS.some(cc => cc.q === c.q && cc.r === c.r) && !grid.has(k) && !taken.has(k)) { spot = c; break; }
        }
      }
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

// 某方向走一步并打完所有级联后的聚变总数（不改变原棋盘）
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

// 一局游戏。strategy: 'random' | 'greedy'
function playGame(cool, HEAT_LIMIT, maxTurns, rng, strategy) {
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
  let heat = 0;
  let turns = 0;
  let fusions = 0;
  let madeStar = false;
  const heatTrace = [];
  let invalidStreak = 0;
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
        // 没有可产生聚变的移动：退化为普通随机滑动（真人玩家不会因此停手）
        let fallback = null;
        for (const d of DIRS) if (slideOnly(grid, d)) { fallback = d; break; }
        if (!fallback) break; // 真·无有效移动，游戏结束
        dir = fallback;
      } else {
        dir = bestDirs[Math.floor(rng() * bestDirs.length)];
      }
    } else {
      // 连续多次随机都无效时再做完整合法性检查（避免每回合 6 次扫描拖慢）
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
    let fusedCount = 0;
    let exploded = false;
    for (;;) {
      const wave = T.computeFusionWave(grid);
      if (!wave.length) break;
      applyFusionWave(grid, wave, state);
      fusedCount += wave.length;
      heat += wave.length;
      if (heat >= HEAT_LIMIT) { exploded = true; break; }
    }
    if (exploded) return { exploded: true, turns, fusions, heatTrace, madeStar };
    for (const t of grid.values()) if (t.value === 999) { madeStar = true; break; }
    turns += 1;
    fusions += fusedCount;
    heatTrace.push(heat);
    heat = Math.max(0, heat - cool);
    spawn();
    if (madeStar) break; // 前期结束（合成 ★）
  }
  return { exploded: false, turns, fusions, heatTrace, madeStar };
}

const HEAT_LIMIT = 15; // 前期上限
// 命令行：node _heat_sim.js random|greedy
const strategy = process.argv[2] || 'random';
const MAX_TURNS = strategy === 'greedy' ? 60 : 100;
const GAMES = strategy === 'greedy' ? 300 : 800;
const cools = strategy === 'greedy'
  ? [1.2, 1.3, 1.4, 1.5, 1.6]
  : [0, 0.5, 1.0, 1.2, 1.4, 1.5, 1.6, 1.8, 2.0, 2.5, 3.0, 4.0];

function pct(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function run(cool, strategy) {
  const rng = mulberry32(Math.floor(cool * 1000) + (strategy === 'greedy' ? 777 : 1));
  let exploded = 0, madeStar = 0, totalTurns = 0, totalFusions = 0;
  const heatVals = [];
  for (let g = 0; g < GAMES; g += 1) {
    const r = playGame(cool, HEAT_LIMIT, MAX_TURNS, rng, strategy);
    if (r.exploded) exploded += 1;
    if (r.madeStar) madeStar += 1;
    totalTurns += r.turns;
    totalFusions += r.fusions;
    for (const h of r.heatTrace) heatVals.push(h);
  }
  heatVals.sort((a, b) => a - b);
  const totalHeat = heatVals.reduce((s, h) => s + h, 0);
  let turnsInBand = 0;
  for (const h of heatVals) if (h >= 5 && h <= 10) turnsInBand += 1;
  return {
    explodeRate: (exploded / GAMES) * 100,
    starRate: (madeStar / GAMES) * 100,
    avgFusionsPerTurn: totalFusions / Math.max(1, totalTurns),
    meanHeat: totalHeat / Math.max(1, heatVals.length),
    p25: pct(heatVals, 25),
    p50: pct(heatVals, 50),
    p75: pct(heatVals, 75),
    p95: pct(heatVals, 95),
    bandPct: (turnsInBand / Math.max(1, heatVals.length)) * 100
  };
}

console.log('=== strategy: ' + strategy + ' (前期上限 15，最多 ' + MAX_TURNS + ' 回合，' + GAMES + ' 局) ===');
console.log('cool\t爆炸率%\t聚变/回合\t平均热度\tP25\tP50\tP75\tP95\t热度5~10占比%');
for (const cool of cools) {
  const t0 = Date.now();
  const r = run(cool, strategy);
  console.log(
    cool.toFixed(1) + '\t' +
    r.explodeRate.toFixed(1) + '\t' +
    r.avgFusionsPerTurn.toFixed(2) + '\t' +
    r.meanHeat.toFixed(2) + '\t' +
    r.p25.toFixed(1) + '\t' +
    r.p50.toFixed(1) + '\t' +
    r.p75.toFixed(1) + '\t' +
    r.p95.toFixed(1) + '\t' +
    r.bandPct.toFixed(1) + '\t(' + (Date.now() - t0) + 'ms)'
  );
}
