// Client-side coverage for the inline page scripts, collected through Chromium's V8 coverage API.
// stampfill ships its front end as two inline module scripts (public page, admin page); c8 cannot see
// them because they live inside a string in stampfill.js. This measures how much of each script's
// non-whitespace bytes the browser tests executed and writes test-results/client-coverage.json.
//
// V8 forgets a document's counters when the page navigates away, so coverage is snapshotted before
// every goto()/reload() of a tracked page (and explicitly, via snapshot(), before in-page reloads).
// @ts-check
const fs = require('fs'), path = require('path');

/** @type {Map<string, Uint8Array>} source text -> executed bytes (union over all snapshots) */
const executed = new Map();
/** @type {Map<string, string>} source text -> script kind */
const kinds = new Map();
/** @type {Map<import('@playwright/test').Page, Promise<boolean>>} */
const live = new Map();

const begin = (page) => page.coverage.startJSCoverage({ resetOnNavigation: false }).then(() => true, () => false);

function merge(entries) {
  for (const e of entries) {
    if (!e.source || /\/vendor\//.test(e.url)) continue; // pdf.js is not ours
    const local = new Uint8Array(e.source.length);
    for (const fn of e.functions) for (const r of fn.ranges) local.fill(r.count > 0 ? 1 : 0, r.startOffset, r.endOffset);
    let acc = executed.get(e.source);
    if (!acc) { acc = new Uint8Array(e.source.length); executed.set(e.source, acc); kinds.set(e.source, /^\/admin/.test(new URL(e.url).pathname) ? 'admin page' : 'public page'); }
    for (let i = 0; i < acc.length; i++) acc[i] |= local[i];
  }
}

/** Starts collecting on a page and wraps goto()/reload() so nothing is lost on navigation. */
function start(page) {
  const ready = begin(page); live.set(page, ready);
  for (const name of ['goto', 'reload']) {
    const orig = page[name].bind(page);
    page[name] = async (...args) => { await snapshot(page); return orig(...args); };
  }
  return ready;
}

/** Folds what ran so far into the totals and keeps collecting. Call before an in-page reload. */
async function snapshot(page) {
  const ready = live.get(page); if (!ready || !(await ready)) return;
  try { merge(await page.coverage.stopJSCoverage()); } catch (e) { return; }
  live.set(page, begin(page));
}

/** Final collection for a page that is about to be closed. */
async function stop(page) {
  const ready = live.get(page); if (!ready) return; live.delete(page);
  if (!(await ready)) return;
  try { merge(await page.coverage.stopJSCoverage()); } catch (e) { /* page already gone */ }
}

async function finish() {
  for (const p of [...live.keys()]) await stop(p);
  const scripts = [...executed.entries()].map(([src, acc]) => {
    let hit = 0, total = 0;
    for (let i = 0; i < acc.length; i++) { if (/\S/.test(src[i])) { total++; if (acc[i]) hit++; } } // whitespace is not code
    const gaps = []; // largest unexecuted stretches, to see what the browser tests never reach
    for (let i = 0; i < acc.length;) {
      if (acc[i]) { i++; continue; }
      let j = i; while (j < acc.length && !acc[j]) j++;
      const text = src.slice(i, j); const size = text.replace(/\s/g, '').length;
      if (size > 40) gaps.push({ size, line: src.slice(0, i).split('\n').length, text: text.trim().replace(/\s+/g, ' ').slice(0, 110) });
      i = j;
    }
    gaps.sort((a, b) => b.size - a.size);
    return { kind: kinds.get(src), bytes: total, executed: hit, pct: Math.round((hit / total) * 1000) / 10, gaps: gaps.slice(0, 25) };
  });
  const bytes = scripts.reduce((n, s) => n + s.bytes, 0), hit = scripts.reduce((n, s) => n + s.executed, 0);
  const summary = { scripts, total: { bytes, executed: hit, pct: bytes ? Math.round((hit / bytes) * 1000) / 10 : 0 } };
  fs.mkdirSync('test-results', { recursive: true });
  fs.writeFileSync(path.join('test-results', 'client-coverage.json'), JSON.stringify(summary, null, 1));
  return summary;
}

module.exports = { start, snapshot, stop, finish };
