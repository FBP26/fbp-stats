import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// The picks form keeps name, week name, picks, Best Bet and tiebreaker on the device until submission.
const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const start = html.indexOf('function websitePicksDraftKey() { return "fbpPicksDraft"; }');
const end = html.indexOf('document.getElementById("website-picks-form").addEventListener("input", websiteSavePicksDraft);');
assert.ok(start > 0 && end > start, 'Picks draft code is present');
assert.equal(html.split('websiteClearPicksDraft(); form.reset();').length - 1, 2, 'Both successful submit paths clear the draft');
assert.match(html, /refreshBestBetTeams\(\);\n    websiteRestorePicksDraft\(\);/, 'Every games render restores the draft');
assert.match(html, /resetWebsiteBestBet\(\);\n    websiteRestorePicksDraft\(\);/, 'Startup Best Bet reset keeps the draft');

const store = new Map();
const makePage = () => {
  const fields = Object.fromEntries(['website-picks-name', 'website-week-name', 'website-tiebreaker'].map(id => [id, { value: '', dispatchEvent() {} }]));
  const bestBet = { value: '', options: [{ value: '' }] };
  let radios = [];
  const setGames = games => { radios = games.flatMap((teams, index) => teams.map(value => ({ name: `game-${index + 1}`, value, checked: false, disabled: false }))); };
  const form = {
    querySelectorAll: () => radios,
    querySelector: selector => { const name = selector.match(/name="([^"]+)"/)[1]; return radios.find(input => input.name === name && input.checked) || null; }
  };
  const host = { querySelectorAll: () => radios, bestBetPickHandler() { bestBet.options = [{ value: '' }, ...radios.filter(input => input.checked).map(input => ({ value: input.value }))]; } };
  return { fields, bestBet, form, host, setGames, radios: () => radios };
};
const run = (page, selection) => {
  const context = vm.createContext({
    console, Date, JSON, Set, Event: class {},
    localStorage: { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, value), removeItem: key => store.delete(key) },
    websitePickSelection: () => selection, updateWebsiteBestBetPicker() {},
    document: { getElementById: id => id === 'website-picks-form' ? page.form : id === 'website-game-picks' ? page.host : id === 'website-best-bet' ? page.bestBet : page.fields[id] }
  });
  vm.runInContext(html.slice(start, end) + '\nthis.api = { save: websiteSavePicksDraft, restore: websiteRestorePicksDraft, clear: websiteClearPicksDraft };', context);
  return context.api;
};
const week12 = { testMode: false, phase: 'REGULAR_SEASON', season: 2026, week: 12 };
const games = [['KC', 'DEN'], ['BUF', 'MIA'], ['PHI', 'DAL']];

// Fill in part of the form, then leave.
let page = makePage(); page.setGames(games);
let api = run(page, week12);
page.fields['website-picks-name'].value = 'Jim';
page.fields['website-week-name'].value = 'Turkey Week';
page.fields['website-tiebreaker'].value = '455.5';
page.radios().find(input => input.value === 'DEN').checked = true;
page.radios().find(input => input.value === 'BUF').checked = true;
page.host.bestBetPickHandler(); page.bestBet.value = 'BUF';
api.save();

// A save while the games are reloading (no pick buttons) must not erase the saved picks.
const reloading = makePage(); reloading.fields['website-picks-name'].value = 'Jim';
run(reloading, week12).save();
assert.deepEqual(JSON.parse(store.get('fbpPicksDraft')).picks, ['DEN', 'BUF']);

// Come back later on a freshly loaded page: everything returns.
page = makePage(); page.setGames(games); api = run(page, week12); api.restore();
assert.equal(page.fields['website-picks-name'].value, 'Jim');
assert.equal(page.fields['website-week-name'].value, '');
assert.equal(page.fields['website-tiebreaker'].value, '');
assert.deepEqual(page.radios().filter(input => input.checked).map(input => input.value), ['DEN', 'BUF']);
assert.equal(page.bestBet.value, 'BUF');

// Full draft restores every field; typed values are never overwritten.
store.clear(); page = makePage(); page.setGames(games); api = run(page, week12);
Object.assign(page.fields['website-picks-name'], { value: 'Jim' }); Object.assign(page.fields['website-week-name'], { value: 'Turkey Week' }); Object.assign(page.fields['website-tiebreaker'], { value: '455.5' });
page.radios().find(input => input.value === 'DEN').checked = true; api.save();
page = makePage(); page.setGames(games); page.fields['website-week-name'].value = 'Typed Since'; page.radios().find(input => input.value === 'KC').checked = true;
run(page, week12).restore();
assert.equal(page.fields['website-week-name'].value, 'Typed Since');
assert.equal(page.fields['website-tiebreaker'].value, '455.5');
assert.deepEqual(page.radios().filter(input => input.checked).map(input => input.value), ['KC']);

// A draft from one week never fills in another week, and submitting clears it.
page = makePage(); page.setGames(games); run(page, { ...week12, week: 13 }).restore();
assert.equal(page.fields['website-picks-name'].value, '');
run(makePage(), week12).clear();
assert.equal(store.has('fbpPicksDraft'), false);
console.log('Picks draft survives leaving the page and clears on submit.');
