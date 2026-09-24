import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
for (const script of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
  if (script[1].trim()) new vm.Script(script[1]);
}
const context = vm.createContext({ Intl, Date, websiteGameStatus: game => game.status });
for (const name of ['websiteKeepCompletedWeek', 'websiteGamePickShare']) {
  const start = html.indexOf(`function ${name}(`);
  const rest = html.slice(start);
  const end = rest.slice(1).search(/\n(?:async )?function /) + 1;
  vm.runInContext(rest.slice(0, end), context);
}
const previous = { season: 2026, week: 2, completedGameDate: '2026-09-21', games: [{ status: 'FINAL' }] };
const current = { season: 2026, week: 3 };
assert.equal(context.websiteKeepCompletedWeek(previous, current, new Date('2026-09-24T03:59:59Z')), true);
assert.equal(context.websiteKeepCompletedWeek(previous, current, new Date('2026-09-24T04:00:00Z')), false);
assert.equal(context.websiteKeepCompletedWeek({ ...previous, completedGameDate: '2026-11-09' }, current, new Date('2026-11-12T04:59:59Z')), true);
assert.equal(context.websiteKeepCompletedWeek({ ...previous, completedGameDate: '2026-11-09' }, current, new Date('2026-11-12T05:00:00Z')), false);
assert.equal(context.websiteKeepCompletedWeek(previous, { ...current, week: 4 }, new Date('2026-09-23T12:00:00Z')), false);
const shares = context.websiteGamePickShare({ favorites: ['BUF'], underdogs: ['mia'], players: ['BUF', 'buf', 'mia', ''].map(pick => ({ picks: [pick] })) }, { favorite: 'BUF', underdog: 'mia' });
assert.equal(shares.total, 3);
assert.equal(shares.counts.BUF, 2);
assert.equal(shares.counts.MIA, 1);
assert.equal(html.includes('renderWebsiteCurrentProbability'), false);
const host = {};
let changes = 0;
const pickContext = vm.createContext({
  Event,
  document: { getElementById: () => ({ addEventListener() {} }) },
  websiteSavePickDraft() {},
});
const selectionStart = html.indexOf('function initializeWebsiteGamePickKeyboard(');
const selectionEnd = html.indexOf('\nfunction websiteIsNeutralSite', selectionStart);
vm.runInContext(html.slice(selectionStart, selectionEnd), pickContext);
pickContext.initializeWebsiteGamePickKeyboard(host);
const choices = Array.from({ length: 16 }, () => {
  const input = { checked: false, disabled: false, dispatchEvent: () => changes++ };
  const target = { closest: () => ({ querySelector: () => input }) };
  return { input, target };
});
for (const { input, target } of choices) {
  host.onpointerup({ target, pointerType: 'touch', isPrimary: true });
  assert.equal(input.checked, true, 'Touch must select before a click arrives');
  host.onclick({ target, preventDefault() {} });
}
assert.equal(changes, 16, 'Compatibility clicks must not repeat change events');
const disabled = choices[0];
disabled.input.checked = false;
disabled.input.disabled = true;
host.onpointerup({ target: disabled.target, pointerType: 'touch', isPrimary: true });
assert.equal(disabled.input.checked, false);
const mouse = choices[1];
mouse.input.checked = false;
host.onpointerup({ target: mouse.target, pointerType: 'mouse', isPrimary: true });
assert.equal(mouse.input.checked, false, 'Mouse selection retains native click timing');
host.onclick({ target: mouse.target, preventDefault() {} });
assert.equal(mouse.input.checked, true);
assert.match(html, /touch-action: manipulation; -webkit-tap-highlight-color: transparent/);
assert.match(html, /grid-column:1 \/ -1;font-size:10px/);
for (const cachedWeek of [3, 2, null]) {
  let finishCurrent;
  const currentRequest = new Promise(resolve => { finishCurrent = resolve; });
  const raceWeeks = [];
  const refreshContext = vm.createContext({
    console,
    clearTimeout() {},
    websiteLiveRefreshTimer: null,
    websiteLiveRefreshGeneration: 0,
    WEBSITE_SUBMISSIONS_ENDPOINT: 'https://example.test',
    websiteRefreshMessage() {},
    websitePickSelection: () => ({ season: 2026, week: 3, staged: true }),
    websiteActiveRegularWeekLoadedAt: 0,
    websiteReadCurrentWeekCache: () => cachedWeek ? { season: 2026, week: cachedWeek } : null,
    websiteRenderCachedLive() {},
    updateWebsiteWeekLabels() {},
    fetchWebsiteCurrentWeek: () => currentRequest,
    fetchWebsiteCurrentWeekRace: async (season, week) => { raceWeeks.push(week); return [{ season, week }]; },
    renderWebsiteWeekOne: async (data, race) => ({ data: await data, race: await race }),
    document: {
      getElementById: () => ({ classList: { contains: () => true } }),
      querySelector: () => ({}),
    },
  });
  const refreshStart = html.indexOf('async function renderSelectedWebsiteWeek(');
  const refreshEnd = html.indexOf('\nconst WEBSITE_PULL_REFRESH_THRESHOLD', refreshStart);
  vm.runInContext(html.slice(refreshStart, refreshEnd), refreshContext);
  const resultRequest = refreshContext.renderSelectedWebsiteWeek();
  assert.deepEqual(raceWeeks, cachedWeek ? [cachedWeek] : [], 'Known-week race starts before the standings response');
  finishCurrent({ ok: true, season: 2026, week: 3, games: [{}] });
  const result = await resultRequest;
  assert.equal(result.race[0].week, 3, 'Rollover must never attach last week race to this week');
  assert.equal(raceWeeks.length, cachedWeek === 2 ? 2 : 1, 'Matching prefetch is reused without duplicate reads');
}
console.log('Live parallel reads, race request reuse, cold start, and rollover isolation passed.');
const readStart = html.indexOf('const WEBSITE_READ_SNAPSHOT_ENDPOINT =');
const readEnd = html.indexOf('async function loadActiveRegularWeek(', readStart);
for (const scenario of ['fresh', 'stale', 'wrong-week', 'timeout', 'unavailable', 'submitted']) {
  const requests = [];
  const storage = new Map();
  const readContext = vm.createContext({
    Date, URL, URLSearchParams, AbortSignal, structuredClone,
    WEBSITE_SUBMISSIONS_ENDPOINT: 'https://source.test/exec',
    localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    fetch: async url => {
      requests.push(String(url));
      if (url.hostname === 'source.test') return Response.json({ ok: true, origin: 'source', players: [{ name: 'Jim' }] });
      if (scenario === 'timeout') throw new Error('timeout');
      return Response.json({ ok: true, origin: 'snapshot', players: [{ name: 'Jim' }] }, {
        status: scenario === 'unavailable' ? 503 : 200,
        headers: {
          'X-FBP-Snapshot-At': String(Date.now() - (scenario === 'stale' ? 91000 : 1000)),
          'X-FBP-Snapshot-Season': '2026',
          'X-FBP-Snapshot-Week': scenario === 'wrong-week' ? '2' : '3',
        },
      });
    },
  });
  vm.runInContext(html.slice(readStart, readEnd), readContext);
  if (scenario === 'submitted') readContext.websiteBypassReadSnapshots();
  const [first, second] = await Promise.all([
    readContext.websiteFetchPublicRead('current-week', { season: '2026', week: '3' }),
    readContext.websiteFetchPublicRead('current-week', { season: '2026', week: '3' }),
  ]);
  assert.equal(first.origin, scenario === 'fresh' ? 'snapshot' : 'source', scenario);
  assert.equal(requests.length, ['fresh', 'submitted'].includes(scenario) ? 1 : 2, 'Concurrent reads share requests');
  first.players[0].name = 'Changed locally';
  assert.equal(second.players[0].name, 'Jim', 'Probability calculations cannot mutate another consumer payload');
  await assert.rejects(readContext.websiteFetchPublicRead('notification-preferences'), /Unsupported public read/);
}
console.log('Fresh snapshot reads, bounded fallback, week isolation, submission bypass, and request deduplication passed.');
console.log('Rapid touch selection, compatibility clicks, disabled teams, and mouse fallback passed.');
console.log('Inline syntax, Eastern-time retention, week isolation, pick shares, and removed chart checks passed.');
const historyRequests = new Map();
const historyTables = {};
const historyContext = vm.createContext({
  DATA_DIR: 'data',
  manifest: [],
  tableData: historyTables,
  fetch: async url => {
    if (url === 'data/manifest.json') return { json: async () => ['overall', 'money_won', 'weekly_champs'].map(key => ({ key })) };
    return new Promise(resolve => historyRequests.set(url, data => resolve({ json: async () => data })));
  },
});
const initStart = html.indexOf('async function init() {');
const initTablesEnd = html.indexOf('  [websitePlayers,', initStart);
vm.runInContext(html.slice(initStart, initTablesEnd) + '\n}', historyContext);
const historyLoading = historyContext.init();
await new Promise(setImmediate);
assert.equal(historyRequests.size, 3, 'All independent summary downloads start without waiting for earlier files');
for (const [url, finish] of [...historyRequests].reverse()) finish([{ source: url }]);
await historyLoading;
assert.equal(historyTables.overall[0].source, 'data/overall.json');
assert.equal(historyTables.weekly_champs[0].source, 'data/weekly_champs.json');
console.log('Parallel historical summary loading preserves table identity across out-of-order responses.');
for (const route of ['enter-picks', 'live-analysis', 'faq', 'players', 'alltime']) {
  const rendered = [];
  const nodes = new Map();
  const loadingContext = vm.createContext({
    DATA_DIR: 'data', WEBSITE_WEEK_HISTORY_VERSION: 'test',
    manifest: [], tableData: {}, websitePicks: [], location: { hash: `#${route}` },
    fetch: async url => ({ json: async () => url.endsWith('payouts.json') ? { seasons: [] } : [] }),
    Option: class { constructor(label, value) { this.label = label; this.value = value; } },
    document: { getElementById: id => {
      if (!nodes.has(id)) nodes.set(id, { options: [], add() {}, append() {}, classList: { contains: () => id === `view-${route}` } });
      return nodes.get(id);
    } },
    renderNamesArchiveSummary() {}, initViews() {}, populateStreakCategories() {}, populateWeeklyRankPlayers() {},
    renderProfile: () => rendered.push('players'), renderAllTime: () => rendered.push('alltime'),
    loadDrilldown: async () => rendered.push('archive'),
  });
  vm.runInContext(html.slice(initStart, html.indexOf('\nfunction renderPicksGrid()', initStart)), loadingContext);
  await loadingContext.init();
  if (['enter-picks', 'live-analysis', 'faq'].includes(route)) assert.deepEqual(rendered, [], 'Lightweight pages must not render hidden history or fetch the full archive');
  else assert.ok(rendered.includes(route), 'Requested historical page still initializes');
}
console.log('Lightweight-page startup avoids hidden profile/All Time work and archive downloads.');
const { gzipSync } = await import('node:zlib');
const { webcrypto } = await import('node:crypto');
const historySource = new TextEncoder().encode('[{"name":"Mac","weekName":"None","wins":0,"note":null}]');
const historyHash = Buffer.from(await webcrypto.subtle.digest('SHA-256', historySource)).toString('hex');
const historyManifest = { version: 1, files: Object.fromEntries(['games.json', 'player_picks.json'].map(filename => [filename, {
  file: `${filename.replace('.json', '')}.${historyHash.slice(0, 16)}.json.gz`, sha256: historyHash, bytes: historySource.length,
}])) };
for (const failure of ['none', 'manifest', 'gzip', 'checksum', 'unsupported']) {
  const requests = [];
  const manifest = structuredClone(historyManifest);
  if (failure === 'checksum') manifest.files['games.json'].sha256 = '0'.repeat(64), manifest.files['games.json'].file = 'games.0000000000000000.json.gz';
  const historyContext = vm.createContext({
    DATA_DIR: 'data', DecompressionStream: failure === 'unsupported' ? undefined : DecompressionStream,
    crypto: webcrypto, Response, AbortSignal, TextDecoder, console: { warn() {} },
    fetch: async url => {
      requests.push(url);
      if (url.endsWith('history-bundles.json')) return failure === 'manifest' ? new Response('', { status: 404 }) : Response.json(manifest);
      if (url.endsWith('.gz')) return new Response(failure === 'gzip' ? new Uint8Array([1, 2, 3]) : gzipSync(historySource));
      return new Response(historySource);
    },
  });
  const loaderStart = html.indexOf('let websiteHistoryBundleManifest =');
  vm.runInContext(html.slice(loaderStart, html.indexOf('async function loadDrilldown()', loaderStart)), historyContext);
  const loaded = await Promise.all(['games.json', 'player_picks.json'].map(filename => historyContext.websiteFetchHistoryFile(filename)));
  assert.equal(JSON.stringify(loaded[0]), new TextDecoder().decode(historySource));
  assert.equal(JSON.stringify(loaded[1]), new TextDecoder().decode(historySource));
  assert.equal(requests.filter(url => url.endsWith('history-bundles.json')).length, failure === 'unsupported' ? 0 : 1);
  assert.equal(requests.includes('data/games.json'), failure !== 'none');
}
console.log('Compressed history integrity, shared manifest reads, original JSON fallback, and compatibility checks passed.');