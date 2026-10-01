const API = 'https://fbp-api.fbp-api-worker.workers.dev/';
const TOKEN_KEY = 'fbp-private-ledger-token';
let records = [], control, selected;
const element = id => document.getElementById(id);
const money = value => value === 'even' ? 'Even' : value.startsWith('+') ? `+$${value.slice(1)}` : `$${value}`;

async function api(action, options = {}, parameters = {}) {
  const token = sessionStorage.getItem(TOKEN_KEY);
  const url = new URL(API);
  url.searchParams.set('action', action);
  Object.entries(parameters).forEach(([key, value]) => url.searchParams.set(key, value));
  const response = await fetch(url, {
    ...options,
    headers: { Authorization: `Bearer ${token || ''}`, ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
  });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(result.error || 'Private admin request failed.');
  return result;
}
function setMessage(text, error = false) { element('status').textContent = text; element('status').className = `message${error ? ' error' : ''}`; }
function drawPlayers() {
  const season = element('season').value;
  const current = records.filter(record => record.body.season === season);
  element('players').innerHTML = current.map(record => `<button class="player${record.body.balance.startsWith('+') ? ' credit' : ''}" data-id="${record.record_id}" aria-current="${selected?.record_id === record.record_id}">${record.body.name}<small>${money(record.body.balance)}</small></button>`).join('');
  document.querySelectorAll('.player').forEach(button => button.addEventListener('click', () => { selected = records.find(record => record.record_id === button.dataset.id); drawPlayers(); drawDetail(); }));
}
async function drawDetail() {
  if (!selected) { element('detail').innerHTML = '<p>Select a player.</p>'; return; }
  const body = selected.body;
  const periods = body.periods.map((period, index) => `<span class="period">${period === 'Playoffs' ? 'PO' : `W${period}`}<b>${body.weeks[index] || '—'}</b></span>`).join('');
  element('detail').innerHTML = `<h2>${body.name}</h2><p class="balance">${money(body.balance)}</p><div class="periods">${periods}</div><form id="cash-form" class="transaction"><h2>Record cash movement</h2><label>Direction<select id="direction"><option value="CASH_PAID_OUT">Money paid to player</option><option value="PAYMENT_RECEIVED">Money received from player</option></select></label><label>Amount ($)<input id="amount" type="number" min="0.01" step="0.01" required></label><label>Reason<input id="reason" maxlength="500" placeholder="Gary surplus paid out" required></label><button type="submit">Record transaction</button></form><div id="history" class="history">Loading history...</div>`;
  element('cash-form').addEventListener('submit', postTransaction);
  try {
    const result = await api('private-ledger-history', {}, { id: selected.record_id });
    element('history').innerHTML = `<h2>History</h2><ul>${result.history.slice(0, 8).map(item => `<li>v${item.version}: ${item.reason}<br><small>${item.recorded_at}</small></li>`).join('')}</ul>`;
  } catch (error) { element('history').textContent = error.message; }
}
async function postTransaction(event) {
  event.preventDefault();
  const amount = element('amount').value, reason = element('reason').value.trim(), type = element('direction').value;
  const direction = type === 'CASH_PAID_OUT' ? 'paid to' : 'received from';
  if (!confirm(`Record $${amount} ${direction} ${selected.body.name}?\n\n${reason}`)) return;
  const button = event.currentTarget.querySelector('button'); button.disabled = true;
  try {
    const receipt = await api('private-ledger-transaction', { method: 'POST', body: JSON.stringify({ recordId: selected.record_id, expectedVersion: selected.version, expectedEpoch: control.epoch, operationId: crypto.randomUUID(), type, amount, reason }) });
    setMessage(`Transaction recorded at revision ${receipt.version}.`); await load();
  } catch (error) { setMessage(error.message, true); button.disabled = false; }
}
async function load() {
  const result = await api('private-ledger-records');
  records = result.records; control = result.control;
  const seasons = [...new Set(records.map(record => record.body.season))];
  const prior = element('season').value;
  element('season').innerHTML = seasons.map(season => `<option>${season}</option>`).join('');
  element('season').value = seasons.includes(prior) ? prior : seasons[0];
  selected = selected && records.find(record => record.record_id === selected.record_id);
  drawPlayers(); await drawDetail();
}
async function unlock() {
  try { await load(); element('unlock').hidden = true; element('ledger').hidden = false; element('sign-out').hidden = false; }
  catch (error) { element('unlock-message').textContent = error.message; element('unlock-message').className = 'message error'; sessionStorage.removeItem(TOKEN_KEY); }
}
element('unlock-form').addEventListener('submit', async event => { event.preventDefault(); sessionStorage.setItem(TOKEN_KEY, element('access-token').value); await unlock(); });
element('season').addEventListener('change', () => { selected = null; drawPlayers(); drawDetail(); });
element('refresh').addEventListener('click', () => load().catch(error => setMessage(error.message, true)));
element('sign-out').addEventListener('click', () => { sessionStorage.removeItem(TOKEN_KEY); location.reload(); });
if (sessionStorage.getItem(TOKEN_KEY)) unlock();