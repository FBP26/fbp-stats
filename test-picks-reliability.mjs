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
console.log('Rapid touch selection, compatibility clicks, disabled teams, and mouse fallback passed.');
console.log('Inline syntax, Eastern-time retention, week isolation, pick shares, and removed chart checks passed.');