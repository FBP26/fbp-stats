let records = [];
let control;
const initialLocation = new URL(location.href);
let kind = initialLocation.searchParams.get('view') === 'payout' ? 'payout' : 'submission';
let selected;
let dirty = false;
let pending = null;
let pendingTransaction = null;
const byId = id => document.getElementById(id);
const needsReconciliation = body => ['mismatch', 'missing-ledger', 'invalid', 'unavailable'].includes(body.reconciliation?.status);
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));

function message(text, error = false) { byId('message').textContent = text; byId('message').className = error ? 'error' : ''; }
async function api(path, options) {
  const response = await fetch(path, options);
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `Request failed (${response.status})`);
  return result;
}
function allowDiscard() { return !dirty || confirm('Discard unsaved changes?'); }
function markDirty(formId) {
  dirty = true;
  if (formId === 'editor') pending = null;
  else pendingTransaction = null;
  const otherForm = formId === 'editor' ? 'transaction' : 'editor';
  document.querySelectorAll(`#${otherForm} input, #${otherForm} textarea, #${otherForm} select, #${otherForm} button[type="submit"]`).forEach(element => { element.disabled = true; });
}
function drawList() {
  const search = byId('search').value.trim().toLowerCase();
  const season = byId('season').value;
  byId('review-filter').hidden = kind !== 'payout';
  const viewLocation = new URL(location.href);
  viewLocation.searchParams.set('view', kind);
  if (kind === 'payout' && byId('needs-review').checked) viewLocation.searchParams.set('review', '1');
  else viewLocation.searchParams.delete('review');
  history.replaceState(null, '', viewLocation);
  document.querySelectorAll('[data-kind]').forEach(tab => tab.setAttribute('aria-pressed', String(tab.dataset.kind === kind)));
  const filtered = records.filter(record => record.kind === kind && (!season || record.body.season === season)
    && (kind !== 'payout' || !byId('needs-review').checked || needsReconciliation(record.body))
    && `${record.body.name} ${record.body.season} ${record.body.weekName || ''}`.toLowerCase().includes(search))
    .sort((left, right) => right.body.season.localeCompare(left.body.season) || (right.body.week || 0) - (left.body.week || 0) || left.body.name.localeCompare(right.body.name));
  byId('count').textContent = `${filtered.length} records`;
  byId('records').innerHTML = filtered.map(record => `<button type="button" data-record="${escapeHtml(record.record_id)}" aria-current="${selected?.record_id === record.record_id}">${escapeHtml(record.body.name)}<small>${escapeHtml(record.body.season)}${record.body.week ? ` / Week ${record.body.week}` : ''} / v${record.version}</small></button>`).join('');
  byId('records').querySelectorAll('button').forEach(button => button.addEventListener('click', () => {
    if (!allowDiscard()) return;
    selected = records.find(record => record.record_id === button.dataset.record && record.kind === kind);
    dirty = false; pending = null; pendingTransaction = null; drawList(); drawDetail();
  }));
}
const field = (id, label, value, type = 'text') => `<div><label for="${id}">${escapeHtml(label)}</label><input id="${id}" name="${id}" type="${type}" value="${escapeHtml(value)}"${type === 'number' ? ' step="0.001" min="-100" max="1200"' : ''}></div>`;
async function drawDetail() {
  if (!selected) { byId('detail').innerHTML = '<div class="empty">Select a record</div>'; return; }
  const record = selected;
  const body = record.body;
  const reconciliation = needsReconciliation(body)
    ? `<p class="reconciliation" role="status">Reconciliation: ${escapeHtml(body.reconciliation.status)} / Payout balance: ${escapeHtml(body.reconciliation.payoutBalance)} / Ledger balance: ${escapeHtml(body.reconciliation.ledgerBalance ?? 'Missing')}</p>` : '';
  const content = record.kind === 'submission'
    ? `<div class="fields">${field('name', 'Player', body.name)}${field('weekName', 'Week name', body.weekName)}${field('bestBet', 'Best Bet', body.bestBet)}${field('tiebreaker', 'Tiebreaker', body.tiebreaker, 'number')}</div><fieldset><legend>Picks</legend><div class="picks">${body.picks.map((pick, index) => field(`pick-${index}`, `Game ${index + 1}`, pick)).join('')}</div></fieldset>`
    : `<div class="fields">${field('balance', 'Balance', body.balance)}<div><label for="notes">Notes</label><textarea id="notes">${escapeHtml(body.notes)}</textarea></div></div><fieldset><legend>Periods</legend><div class="periods">${body.weeks.map((value, index) => field(`period-${index}`, body.periods[index] || `Period ${index + 1}`, value)).join('')}</div></fieldset>`;
  byId('detail').innerHTML = `<h2>${escapeHtml(body.name)}</h2><p class="meta">${escapeHtml(body.season)}${body.week ? ` / Week ${body.week}` : ''} / Revision ${record.version}${body.submittedAt ? ` / Submitted ${escapeHtml(body.submittedAt)}` : ''}</p>${reconciliation}<form id="editor">${content}<label for="reason">Change reason</label><input id="reason" required maxlength="500"><div class="save-row"><button type="button" id="cancel">Cancel</button><button class="primary" id="save" type="submit">Save rehearsal edit</button></div></form><section class="history"><h3>Revision History</h3><div id="history">Loading</div></section>`;
  byId('editor').addEventListener('input', () => markDirty('editor'));
  if (record.kind === 'payout') {
    byId('balance').readOnly = true;
    const opening = body.balanceCents === undefined;
    const currentSeason = Math.max(...records.filter(item => item.kind === 'payout').map(item => Number(item.body.season)));
    if (Number(body.season) === currentSeason) {
      const transactionTypes = opening ? [['ADOPT_PAYOUT_BASELINE', 'Imported Payout opening balance']] : [
        ['PAYMENT_RECEIVED', 'Payment received'], ['PRIZE_CREDIT', 'Prize credited'], ['CASH_PAID_OUT', 'Credit paid out'],
        ['PRIZE_PAID', 'Prize paid immediately'], ['PLAYER_DEBT_ADJUSTMENT', 'Increase amount owed'], ['PLAYER_CREDIT_ADJUSTMENT', 'Increase player credit'],
      ];
      byId('editor').insertAdjacentHTML('afterend', `<section class="history"><h3>Payout Transaction</h3><form id="transaction"><div class="fields"><div><label for="transactionType">Type</label><select id="transactionType">${transactionTypes.map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}</select></div>${opening ? `<div><label>Imported balance</label><output>${escapeHtml(body.balance)}</output></div>` : '<div><label for="transactionAmount">Amount ($)</label><input id="transactionAmount" type="number" min="0.01" step="0.01" required></div>'}</div><label for="transactionReason">Transaction reason</label><input id="transactionReason" required maxlength="500"><div class="save-row"><button type="submit" class="primary" id="postTransaction">${opening ? 'Use imported Payout balance' : 'Post rehearsal transaction'}</button></div></form></section>`);
      byId('transaction').addEventListener('input', () => markDirty('transaction'));
      byId('transaction').addEventListener('submit', postTransaction);
    }
  }
  byId('cancel').addEventListener('click', () => { if (allowDiscard()) { dirty = false; pending = null; pendingTransaction = null; drawDetail(); } });
  byId('editor').addEventListener('submit', save);
  try {
    const result = await api(`/api/history?kind=${encodeURIComponent(record.kind)}&id=${encodeURIComponent(record.record_id)}`);
    if (selected !== record) return;
    byId('history').innerHTML = result.history.map(revision => `<div class="revision">v${revision.version} / ${escapeHtml(revision.reason)}<small>${escapeHtml(revision.recorded_at)} / ${escapeHtml(revision.actor)}</small><details><summary>Recorded values</summary><pre>${escapeHtml(JSON.stringify(revision.body, null, 2))}</pre></details></div>`).join('');
  } catch (error) { if (selected === record) byId('history').textContent = error.message; }
}
async function postTransaction(event) {
  event.preventDefault();
  const record = selected;
  pendingTransaction ||= { recordId: record.record_id, expectedVersion: record.version, expectedEpoch: control.epoch,
    operationId: crypto.randomUUID(), type: byId('transactionType').value, amount: byId('transactionAmount')?.value || '', reason: byId('transactionReason').value };
  if (!confirm(`${byId('transactionType').selectedOptions[0].text}: ${record.body.name}\n${pendingTransaction.type === 'ADOPT_PAYOUT_BASELINE' ? `Imported balance: ${record.body.balance}` : `Amount: $${pendingTransaction.amount}`}\n\nConfirm this rehearsal transaction? Live Sheets remains unchanged.`)) return;
  byId('postTransaction').disabled = true;
  try {
    const receipt = await api('/api/payout-transactions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(pendingTransaction) });
    dirty = false; pendingTransaction = null; pending = null;
    await load(record.record_id);
    message(`Transaction recorded at revision ${receipt.version}. Live Sheets data unchanged.`);
  } catch (error) { message(error.message, true); }
  finally { if (byId('postTransaction')) byId('postTransaction').disabled = false; }
}
async function save(event) {
  event.preventDefault();
  const record = selected;
  const changes = record.kind === 'submission'
    ? { name: byId('name').value.trim(), weekName: byId('weekName').value, bestBet: byId('bestBet').value.trim(), tiebreaker: Number(byId('tiebreaker').value), picks: record.body.picks.map((_, index) => byId(`pick-${index}`).value.trim()) }
    : { balance: byId('balance').value.trim(), notes: byId('notes').value, weeks: record.body.weeks.map((_, index) => byId(`period-${index}`).value) };
  pending ||= { operationId: crypto.randomUUID(), kind: record.kind, recordId: record.record_id, expectedVersion: record.version, expectedEpoch: control.epoch, reason: byId('reason').value, changes };
  byId('save').disabled = true;
  try {
    const receipt = await api('/api/records', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(pending) });
    dirty = false; pending = null; pendingTransaction = null;
    await load(record.record_id);
    message(`Saved revision ${receipt.version}. Live Sheets data unchanged.`);
  } catch (error) { message(error.message, true); }
  finally { if (byId('save')) byId('save').disabled = false; }
}
async function load(recordId) {
  try {
    const result = await api('/api/records');
    records = result.records; control = result.control;
    document.title = result.demo ? 'FBP | Sample Admin (Not Live Data)' : 'FBP | Private Cloud Admin';
    byId('mode').textContent = result.demo ? 'Sample data / Disposable session' : `Rehearsal / ${control.owner} live / Epoch ${control.epoch}`;
    const season = byId('season').value;
    byId('season').innerHTML = '<option value="">All seasons</option>' + [...new Set(records.map(record => record.body.season))].sort().reverse().map(value => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join('');
    byId('season').value = season;
    selected = recordId ? records.find(record => record.record_id === recordId && record.kind === kind) : null;
    drawList(); await drawDetail();
  } catch (error) { message(error.message, true); }
}
document.querySelectorAll('[data-kind]').forEach(button => button.addEventListener('click', () => {
  if (!allowDiscard()) return;
  kind = button.dataset.kind; selected = null; dirty = false; pending = null; pendingTransaction = null;
  document.querySelectorAll('[data-kind]').forEach(tab => tab.setAttribute('aria-pressed', String(tab === button)));
  drawList(); drawDetail();
}));
byId('search').addEventListener('input', drawList);
byId('season').addEventListener('change', drawList);
byId('needs-review').addEventListener('change', drawList);
byId('refresh').addEventListener('click', () => { if (allowDiscard()) { dirty = false; pending = null; pendingTransaction = null; load(selected?.record_id); } });
addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
byId('needs-review').checked = initialLocation.searchParams.get('review') === '1';
load();