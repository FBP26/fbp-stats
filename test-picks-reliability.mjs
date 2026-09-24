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