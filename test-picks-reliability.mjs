import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const clientContext = vm.createContext({ URL, URLSearchParams, AbortSignal, Date });
vm.runInContext(readFileSync(new URL('./live-client.js', import.meta.url), 'utf8'), clientContext);
const pendingStorage = new Map();
let ownership = { ok: true, owner: 'D1', epoch: 2, writesEnabled: true }, loseResponse = true, operationIds = 0;
const submissionRequests = [];
const liveClient = new clientContext.FBPLiveClient({ workerUrl: 'https://worker.test/', sheetsUrl: 'https://sheets.test/',
  storage: { getItem: key => pendingStorage.get(key), setItem: (key, value) => pendingStorage.set(key, value), removeItem: key => pendingStorage.delete(key) },
  newId: () => `stable-operation-${++operationIds}`,
  fetcher: async (url, options) => {
    if (options?.method !== 'POST') return Response.json(ownership);
    submissionRequests.push({ url: String(url), body: JSON.parse(options.body) });
    if (loseResponse) throw new Error('Response lost after acceptance');
    return Response.json({ ok: true, replayed: true });
  },
});
const clientCard = { name: 'Example', season: 2026, week: 4, picks: ['BUF'], bestBet: 'BUF' };
const lookup = { owner: 'D1', epoch: 2, submissionId: null };
await assert.rejects(liveClient.submit(clientCard, lookup), /Response lost/);
loseResponse = false;
const reloadedClient = new clientContext.FBPLiveClient({ workerUrl: liveClient.workerUrl, sheetsUrl: liveClient.sheetsUrl, fetcher: liveClient.fetcher, storage: liveClient.storage, newId: liveClient.newId });
await reloadedClient.submit(clientCard, { ...lookup, submissionId: 12 });
assert.deepEqual(submissionRequests[0], submissionRequests[1], 'A lost response retries the original operation and expected card ID');
assert.equal(pendingStorage.size, 0);
ownership = { ...ownership, epoch: 3 };
await assert.rejects(liveClient.submit(clientCard, lookup), /ownership changed/);
assert.equal(submissionRequests.length, 2);
ownership = { ...ownership, writesEnabled: false };
await assert.rejects(liveClient.submit(clientCard, { ...lookup, epoch: 3 }), /temporarily paused/);
ownership = { ...ownership, owner: 'SHEETS' };
await assert.rejects(liveClient.submit(clientCard, lookup), /ownership changed/);
console.log('Owner-aware client preserves submission retries and refuses stale ownership or disabled writes.');
for (const startingOwner of ['SHEETS', 'D1']) {
  let readOwner = { ok: true, owner: startingOwner, epoch: 2 }, changeOwner = false;
  const readRequests = [];
  const reader = new clientContext.FBPLiveClient({ workerUrl: 'https://worker.test/', sheetsUrl: 'https://sheets.test/', storage: liveClient.storage,
    fetcher: async url => {
      if (url.searchParams.get('action') === 'backend-status') return Response.json(readOwner);
      readRequests.push(String(url));
      if (changeOwner) readOwner = { ...readOwner, epoch: 3 };
      return Response.json({ ok: true, games: [], raceSnapshots: [] });
    },
  });
  for (const action of ['week-config', 'preseason-test', 'current-week-race']) await reader.read(action, { season: 2027, week: 1 });
  assert.ok(readRequests.every(url => new URL(url).hostname === (startingOwner === 'D1' ? 'worker.test' : 'sheets.test')));
  assert.equal(new URL(readRequests[2]).searchParams.get('action'), startingOwner === 'D1' ? 'race-archive' : 'current-week-race');
  changeOwner = true;
  await assert.rejects(reader.read('week-config'), /ownership changed while loading/);
}
assert.match(html, /websiteLiveClient\.read\('week-config'/);
assert.match(html, /websiteLiveClient\.read\('preseason-test'/);
console.log('Slate, preseason and race reads follow ownership and discard responses across epoch changes.');
clientContext.fetch = function () {
  assert.equal(this.FBPLiveClient, clientContext.FBPLiveClient, 'Native fetch must be invoked on the browser global, not the client instance');
  return Promise.resolve(Response.json({ ok: true, owner: 'SHEETS', epoch: 1 }));
};
const nativeFetchClient = new clientContext.FBPLiveClient({ workerUrl: 'https://worker.test/', sheetsUrl: 'https://sheets.test/', storage: liveClient.storage });
assert.equal((await nativeFetchClient.owner()).owner, 'SHEETS');
for (const script of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
  if (script[1].trim()) new vm.Script(script[1]);
}
const confirmationSections = new Map([
  ['confirmation-lead', { textContent: 'Picks submitted for Alex.' }],
  ['confirmation-identity', {
    querySelector: () => ({ textContent: 'Your pool history' }),
    querySelectorAll: selector => selector === '.confirmation-metric-table tr'
      ? [{ querySelector: cell => ({ textContent: cell === 'th' ? 'Pool weeks' : '18' }) }]
      : [],
  }],
  ['confirmation-picks', {
    querySelector: () => ({ textContent: 'Live outlook' }),
    querySelectorAll: selector => selector === '.confirmation-metric-table tr'
      ? [{ querySelector: cell => ({ textContent: cell === 'th' ? 'Chance to win' : '12.5% Tied 3rd of 24' }) }]
      : [],
  }],
  ['confirmation-history', {
    querySelector: () => ({ textContent: 'Pick form' }),
    querySelectorAll: selector => selector === 'p, li'
      ? [{ textContent: 'This card repeats a familiar pick.' }]
      : [],
  }],
]);
const confirmationContext = vm.createContext({ document: { getElementById: id => confirmationSections.get(id) } });
const confirmationStart = html.indexOf('function websiteConfirmationEmailText(');
const confirmationEnd = html.indexOf('\nasync function sendWebsitePickConfirmationEmail', confirmationStart);
vm.runInContext(html.slice(confirmationStart, confirmationEnd), confirmationContext);
const confirmationEmail = confirmationContext.websiteConfirmationEmailText();
assert.match(confirmationEmail, /^Picks submitted for Alex\./);
assert.match(confirmationEmail, /Your pool history:\n- Pool weeks: 18/);
assert.match(confirmationEmail, /Live outlook:\n- Chance to win: 12\.5% Tied 3rd of 24/);
assert.match(confirmationEmail, /Pick form:\n- This card repeats a familiar pick\./);
console.log('Confirmation email receipts preserve section headings and one detail per bullet.');
const context = vm.createContext({ Intl, Date, websiteGameStatus: game => game.status });
const selectionFunctionStart = html.indexOf('function websiteCompetitiveSelection(');
const selectionFunctionEnd = html.indexOf('\nfunction updateWebsiteWeekLabels(', selectionFunctionStart);
vm.runInContext(html.slice(selectionFunctionStart, selectionFunctionEnd), context);
for (const phase of ['REGULAR_SEASON', 'PLAYOFFS']) {
  const selection = context.websiteCompetitiveSelection({ season: 2026, week: 3, phase, staged: true });
  assert.equal(selection.phase, phase);
  assert.equal(selection.staged, true);
  assert.equal(context.websiteCompetitiveSelection({ ...selection, staged: false, games: [{}] }).staged, false);
}
assert.equal(context.websiteCompetitiveSelection({ season: 2026, week: 3, games: [{}] }).phase, 'REGULAR_SEASON');
assert.throws(() => context.websiteCompetitiveSelection({ phase: 'UNKNOWN' }), /Invalid/);
const kickoffDisplayStart = html.indexOf('function websiteKickoffDisplay(');
const kickoffDisplayEnd = html.indexOf('\nfunction decorateWebsiteWeekOneHeaders(', kickoffDisplayStart);
vm.runInContext(html.slice(kickoffDisplayStart, kickoffDisplayEnd), context);
assert.match(context.websiteKickoffDisplay('2026-10-02T00:15:00.000Z'), /^Thu, Oct 1, 8:15 PM EDT$/);
assert.equal(context.websiteKickoffDisplay('Not started'), 'Not started');
context.websiteGameWinner = (data, index) => data.games[index].winner ?? null;
const probabilityPresentationStart = html.indexOf('function websiteProbabilityEvidence(');
const probabilityPresentationEnd = html.indexOf('\nfunction websiteConditionalProbabilities(', probabilityPresentationStart);
vm.runInContext(html.slice(probabilityPresentationStart, probabilityPresentationEnd), context);
const openingProbabilities = context.websitePresentationProbabilities({ games: [{}, {}] }, [75, 25]);
assert.equal(openingProbabilities.reduce((total, probability) => total + probability, 0), 100);
assert.ok(openingProbabilities[0] > openingProbabilities[1], 'Pregame display keeps the weighted model ordering');
assert.ok(openingProbabilities[0] - openingProbabilities[1] <= 4, 'Pregame display limits the probability spread');
const postgameProbabilities = context.websitePresentationProbabilities({ games: [{ winner: 'BUF' }, {}] }, [75, 25]);
assert.deepEqual(postgameProbabilities, [50 + 25 * Math.sqrt(.5), 50 - 25 * Math.sqrt(.5)], 'Completed games retain the existing evidence calibration');
console.log('Opening probabilities retain capped model-based differentiation before kickoff.');
for (const week of [1, 2, 3, 4]) {
  assert.equal(context.websiteRequiresTiebreak({ phase: 'PLAYOFFS', week }), week === 4);
  assert.equal(context.websiteRequiresTiebreak({ phase: 'REGULAR_SEASON', week }), true);
}
assert.equal(context.websiteRoundLabel({ phase: 'PLAYOFFS', week: 4 }), 'Super Bowl');
const bestBetOptions = ['BUF', 'mia', 'PIT', 'bal'].map(team => ({ dataset: { team }, setAttribute() {} }));
const bestBetSelect = { value: '', options: [], replaceChildren(...options) { this.options = options; this.value = ''; } };
const picksForm = { elements: { 'game-1': { value: '' }, 'game-2': { value: '' } } };
const bestBetSummary = { setAttribute() {} };
const bestBetContext = vm.createContext({
  Option: class { constructor(text, value) { this.text = text; this.value = value; } },
  websiteActiveGames: [{ favorite: 'BUF', underdog: 'mia' }, { favorite: 'PIT', underdog: 'bal' }],
  websiteBestBetTeam: team => ({ team, name: team, logo: '' }), websiteEscapeHtml: value => value,
  document: {
    getElementById: id => id === 'website-best-bet' ? bestBetSelect : picksForm,
    querySelector: () => ({ classList: { toggle() {} }, querySelector: () => bestBetSummary, querySelectorAll: () => bestBetOptions }),
  },
});
for (const name of ['updateWebsiteBestBetPicker', 'confirmWebsiteBestBetMismatch']) {
  const start = html.indexOf(`function ${name}(`);
  const end = html.indexOf('\nfunction ', start + 1);
  vm.runInContext(html.slice(start, end), bestBetContext);
}
bestBetContext.updateWebsiteBestBetPicker();
assert.deepEqual(bestBetSelect.options.map(option => option.value), ['']);
assert.ok(bestBetOptions.every(option => option.hidden && option.disabled));
picksForm.elements['game-1'].value = 'BUF';
picksForm.elements['game-2'].value = 'bal';
bestBetContext.updateWebsiteBestBetPicker();
assert.deepEqual(bestBetSelect.options.map(option => option.value), ['', 'BUF', 'bal']);
bestBetSelect.value = 'BUF';
bestBetContext.updateWebsiteBestBetPicker();
assert.equal(bestBetSelect.value, 'BUF');
picksForm.elements['game-1'].value = 'mia';
bestBetContext.updateWebsiteBestBetPicker();
assert.equal(bestBetSelect.value, '');
assert.deepEqual(bestBetSelect.options.map(option => option.value), ['', 'mia', 'bal']);
assert.deepEqual(bestBetOptions.filter(option => !option.hidden).map(option => option.dataset.team), ['mia', 'bal']);
bestBetContext.updateWebsiteBestBetPicker('MIA');
assert.equal(bestBetSelect.value, 'mia', 'A valid saved Best Bet is restored after choices are rebuilt');
bestBetContext.updateWebsiteBestBetPicker('BUF');
assert.equal(bestBetSelect.value, '', 'An opposing draft Best Bet cannot become an available choice');
const savedOpposingCard = { picks: ['BUF', 'bal'], bestBet: 'mia' };
const originalCard = JSON.stringify(savedOpposingCard);
for (let attempt = 0; attempt < 4; attempt += 1) assert.equal(bestBetContext.confirmWebsiteBestBetMismatch(savedOpposingCard, { focus() {} }), false);
assert.equal(JSON.stringify(savedOpposingCard), originalCard);
assert.equal(bestBetContext.confirmWebsiteBestBetMismatch({ picks: ['BUF', 'bal'], bestBet: 'BAL' }, {}), true);
console.log('Best Bet options follow selected teams, clear invalidated choices, reject repeated overrides, and do not mutate saved cards.');
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
    websiteCompetitiveSelection: context.websiteCompetitiveSelection,
    websiteRoundLabel: context.websiteRoundLabel,
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
    websiteLiveClient: { owner: async () => ({ owner: 'SHEETS', epoch: 1 }) },
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
for (const fails of [false, true]) {
  const requests = [];
  const readContext = vm.createContext({
    Date, structuredClone, localStorage: { getItem() {} },
    websiteLiveClient: { owner: async () => ({ owner: 'D1', epoch: 2 }), read: async action => {
      requests.push(action);
      if (fails) throw new Error('Operational read unavailable');
      return { ok: true, origin: 'D1' };
    } },
    fetch: () => { throw new Error('Must never use Sheets or its snapshot under D1 ownership'); },
  });
  vm.runInContext(html.slice(readStart, readEnd), readContext);
  const read = readContext.websiteFetchPublicRead('current-week-race', { season: '2026', week: '3' });
  if (fails) await assert.rejects(read, /Operational read unavailable/);
  else assert.equal((await read).origin, 'D1');
  assert.deepEqual(requests, ['current-week-race']);
}
console.log('D1 live reads never fall back to Sheets, including when the operational read fails.');
const payoutRequests = [];
const payoutContext = vm.createContext({
  Date,
  Papa: { parse: () => ({ errors: [], data: [['2026']] }) },
  parsePayoutSheetRows: rows => [{ year: Number(rows[0][0]) }],
  fetch: async url => {
    payoutRequests.push(String(url));
    return { ok: true, text: async () => '2026' };
  },
});
const payoutStart = html.indexOf('let payoutSheetLoadPromise =');
vm.runInContext(html.slice(payoutStart, html.indexOf('function payoutUnpaidTooltip(', payoutStart)), payoutContext);
assert.equal((await payoutContext.loadPayoutSheet())[0].year, 2026);
assert.match(payoutRequests[0], /docs\.google\.com\/spreadsheets\/d\/19LkATudJU7W7bsnBBNy7iCI68P3Nhbt10XIJ5Q7HRCA\/export\?format=csv&gid=2/);
console.log('Payouts refresh from the Sheets CSV regardless of separate pool ownership.');
for (const action of ['season-status', 'race-archive']) assert.ok(html.includes(`websiteLiveClient.read('${action}'`));
const archiveReads = [];
let archiveOwner = { owner:'SHEETS', epoch:1 };
const archiveContext = vm.createContext({
  weekLiveRaceArchiveCache:new Map(),
  websiteLiveClient:{ owner:async()=>archiveOwner, read:async(action, parameters)=>{
    archiveReads.push({ action, ...parameters, owner:archiveOwner.owner });
    return { ok:true, raceSnapshots:[{ owner:archiveOwner.owner }] };
  } },
});
const archiveStart = html.indexOf('async function loadWeekLiveRaceArchive(');
vm.runInContext(html.slice(archiveStart, html.indexOf('\nfunction showWeekLiveRaceFrame', archiveStart)), archiveContext);
assert.equal((await archiveContext.loadWeekLiveRaceArchive(2026,3))[0].owner, 'SHEETS');
await archiveContext.loadWeekLiveRaceArchive(2026,3);
assert.equal(archiveReads.length, 1);
archiveOwner = { owner:'D1', epoch:2 };
assert.equal((await archiveContext.loadWeekLiveRaceArchive(2026,3))[0].owner, 'D1');
assert.equal(archiveReads.length, 2);
console.log('Historical race caches are isolated by backend ownership and epoch.');
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