import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryDatabase } from './helpers/d1.mjs';
import { existingOperationalCard, submitOperationalCard } from '../src/operational-submissions.ts';
import worker, { dispatchSubmissionConfirmationOutbox } from '../src/index.ts';
import { saveAdminRecord } from '../src/admin-store.ts';
import { createOperationalCheckpoint, rehearseOperationalCheckpoint } from '../scripts/operational-checkpoint.mjs';

const command = { operationId: 'submission-fixture-0001', name: 'Example', weekName: 'None', season: 2026, week: 3, picks: ['mia'], bestBet: 'MIA', tiebreaker: 0 };
function fixture() {
  const memory = memoryDatabase(['0001_initial.sql', '0009_admin_record_history.sql', '0011_payout_journal.sql', '0012_submission_admin_projection.sql', '0013_operational_receipts.sql', '0016_independent_best_bet.sql']);
  memory.sqlite.exec(`INSERT INTO weeks(id,season,week,phase,status) VALUES(1,2026,3,'REGULAR_SEASON','open');
    INSERT INTO games(id,week_id,game_index,external_id,kickoff_at,favorite,underdog,spread,home_team,away_team) VALUES(1,1,0,'game1','2026-09-27T17:00:00Z','BUF','mia',3,'BUF','MIA');`);
  return memory;
}

test('current-card lookup supplies replacement identity without exposing picks and fails closed outside D1 ownership', async () => {
  const { sqlite, adapter } = fixture();
  try {
    await assert.rejects(existingOperationalCard(adapter, command), /Sheets currently owns/);
    sqlite.exec("UPDATE admin_control SET owner='D1',epoch=2");
    const before = Date.parse('2026-09-24T20:00:00Z');
    const empty = await existingOperationalCard(adapter, command, before);
    assert.equal(empty.submissionId, null);
    assert.equal(empty.canSubmit, true);
    await submitOperationalCard(adapter, command, '2026-09-24T19:00:00Z');
    const card = await existingOperationalCard(adapter, { ...command, name: ' example ' }, before);
    assert.equal(card.submissionId, 1);
    assert.equal(card.name, 'Example');
    assert.equal(card.replacementLocked, false);
    assert.equal('picks' in card, false);
    const locked = await existingOperationalCard(adapter, command, Date.parse('2026-09-27T17:00:00Z'));
    assert.equal(locked.replacementLocked, true);
    assert.equal(locked.canSubmit, false);
    sqlite.exec("UPDATE weeks SET status='finalized'");
    assert.equal((await existingOperationalCard(adapter, { ...command, name: 'New player' }, before)).canSubmit, false);
  } finally { sqlite.close(); }
});

test('submissions fail closed under Sheets ownership; D1 writes and retries preserve one original card', async () => {
  const { sqlite, adapter } = fixture();
  try {
    await assert.rejects(submitOperationalCard(adapter, command), /Sheets currently owns/);
    assert.equal(sqlite.prepare('SELECT count(*) AS total FROM players').get().total, 0);
    sqlite.exec("UPDATE admin_control SET owner='D1',epoch=2");
    const result = await submitOperationalCard(adapter, command, '2026-09-24T19:00:00.123Z');
    await assert.rejects(submitOperationalCard(adapter, { ...command, expectedEpoch: 1 }), /ownership changed/);
    assert.equal(result.submittedAt, '2026-09-24T19:00:00.123Z');
    assert.equal(result.submissionId, 1);
    assert.equal((await submitOperationalCard(adapter, command)).replayed, true);
    assert.equal(sqlite.prepare('SELECT count(*) AS total FROM submissions').get().total, 1);
    assert.equal(sqlite.prepare('SELECT picked_team FROM submission_picks').get().picked_team, 'mia');
    assert.equal(sqlite.prepare('SELECT count(*) AS total FROM admin_submission_links').get().total, 1);
    const body = JSON.parse(sqlite.prepare("SELECT body FROM admin_records WHERE kind='submission'").get().body);
    await saveAdminRecord(adapter, { kind: 'submission', recordId: 'operational:submission-fixture-0001', expectedVersion: 1, expectedEpoch: 2,
      operationId: 'owner-correction-0001', reason: 'Correct entered week name', body: { ...body, weekName: 'Corrected' } }, 'owner');
    assert.equal(sqlite.prepare('SELECT week_name FROM submissions').get().week_name, 'Corrected');
    await assert.rejects(submitOperationalCard(adapter, { ...command, tiebreaker: 1 }), /reused/);
    await assert.rejects(submitOperationalCard(adapter, { ...command, operationId: 'submission-fixture-0002', tiebreaker: '' }), /numeric tiebreaker/);
  } finally { sqlite.close(); }
});

test('confirmation email is queued only for explicit consent and never duplicates a replayed card', async () => {
  const { sqlite, adapter } = fixture();
  try {
    sqlite.exec('CREATE TABLE submission_confirmation_outbox (id INTEGER PRIMARY KEY, submission_id INTEGER NOT NULL, operation_id TEXT NOT NULL UNIQUE, destination TEXT NOT NULL, payload_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT \'queued\', attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, sent_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)');
    sqlite.exec("UPDATE admin_control SET owner='D1',epoch=2");
    await assert.rejects(submitOperationalCard(adapter, { ...command, confirmationEmail: 'player@example.com' }), /explicit consent/);
    await assert.rejects(submitOperationalCard(adapter, { ...command, confirmationEmailConsent: true, confirmationEmail: 'not-an-email' }), /valid confirmation email/);
    const payload = { ...command, confirmationEmailConsent: true, confirmationEmail: ' Player@Example.COM ' };
    await submitOperationalCard(adapter, payload, '2026-09-24T19:00:00Z');
    await submitOperationalCard(adapter, payload);
    const outbox = sqlite.prepare('SELECT operation_id,destination,status,payload_json FROM submission_confirmation_outbox').get();
    assert.deepEqual({ operationId: outbox.operation_id, destination: outbox.destination, status: outbox.status }, { operationId: command.operationId, destination: 'player@example.com', status: 'queued' });
    assert.equal(JSON.parse(outbox.payload_json).name, 'Example');
    assert.equal(sqlite.prepare('SELECT count(*) AS total FROM submission_confirmation_outbox').get().total, 1);
  } finally { sqlite.close(); }
});

test('confirmation outbox sends only committed consented rows and retries relay failures', async () => {
  const { sqlite, adapter } = fixture();
  try {
    sqlite.exec('CREATE TABLE submission_confirmation_outbox (id INTEGER PRIMARY KEY, submission_id INTEGER NOT NULL, operation_id TEXT NOT NULL UNIQUE, destination TEXT NOT NULL, payload_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT \'queued\', attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, sent_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)');
    sqlite.exec("UPDATE admin_control SET owner='D1',epoch=2");
    await submitOperationalCard(adapter, { ...command, confirmationEmailConsent: true, confirmationEmail: 'player@example.com' }, '2026-09-24T19:00:00Z');
    assert.deepEqual(await dispatchSubmissionConfirmationOutbox(adapter, async () => false), { sent: 0, failed: 1 });
    assert.equal(sqlite.prepare('SELECT status FROM submission_confirmation_outbox').get().status, 'failed');
    let delivered = null;
    assert.deepEqual(await dispatchSubmissionConfirmationOutbox(adapter, async (to, subject, body) => { delivered = { to, subject, body }; return true; }), { sent: 1, failed: 0 });
    assert.equal(sqlite.prepare('SELECT status FROM submission_confirmation_outbox').get().status, 'sent');
    assert.equal(delivered.to, 'player@example.com');
  } finally { sqlite.close(); }
});

test('a thrown confirmation relay error leaves the accepted card committed and retryable', async () => {
  const { sqlite, adapter } = fixture();
  try {
    sqlite.exec('CREATE TABLE submission_confirmation_outbox (id INTEGER PRIMARY KEY, submission_id INTEGER NOT NULL, operation_id TEXT NOT NULL UNIQUE, destination TEXT NOT NULL, payload_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT \'queued\', attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, sent_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)');
    sqlite.exec("UPDATE admin_control SET owner='D1',epoch=2");
    await submitOperationalCard(adapter, { ...command, confirmationEmailConsent: true, confirmationEmail: 'player@example.com' }, '2026-09-24T19:00:00Z');
    assert.deepEqual(await dispatchSubmissionConfirmationOutbox(adapter, async () => { throw new Error('relay unavailable'); }), { sent: 0, failed: 1 });
    const outbox = sqlite.prepare('SELECT status,attempts FROM submission_confirmation_outbox').get();
    assert.equal(outbox.status, 'failed');
    assert.equal(outbox.attempts, 1);
    assert.equal(sqlite.prepare('SELECT count(*) AS total FROM submissions').get().total, 1);
    assert.equal(sqlite.prepare('SELECT count(*) AS total FROM payout_journal').get().total, 1);
  } finally { sqlite.close(); }
});

test('new late entrants are accepted, replacements lock at kickoff, stale and failed writes preserve prior cards', async () => {
  const { sqlite, adapter } = fixture();
  try {
    sqlite.exec("UPDATE admin_control SET owner='D1',epoch=2");
    await submitOperationalCard(adapter, command, '2026-09-24T19:00:00Z');
    const next = { ...command, operationId: 'submission-fixture-0002', expectedSubmissionId: 1, tiebreaker: 400 };
    await assert.rejects(submitOperationalCard(adapter, next, '2026-09-27T17:00:00Z'), /first kickoff/);
    await submitOperationalCard(adapter, { ...command, name: 'Late New', operationId: 'submission-fixture-0003' }, '2026-09-27T18:00:00Z');
    await assert.rejects(submitOperationalCard(adapter, { ...next, expectedSubmissionId: null }, '2026-09-24T20:00:00Z'), /current card changed/);
    sqlite.exec("CREATE TRIGGER reject_fixture BEFORE INSERT ON submission_picks WHEN NEW.submission_id > 2 BEGIN SELECT RAISE(ABORT,'forced pick failure'); END;");
    await assert.rejects(submitOperationalCard(adapter, next, '2026-09-24T20:00:00Z'), /forced pick failure/);
    assert.equal(sqlite.prepare('SELECT superseded_at FROM submissions WHERE id=1').get().superseded_at, null);
    assert.equal(sqlite.prepare('SELECT count(*) AS total FROM operational_receipts').get().total, 2);
    assert.deepEqual(sqlite.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { sqlite.close(); }
});

test('replacement validation matches live limits and timestamp collisions preserve the original for retry', async () => {
  const { sqlite, adapter } = fixture();
  try {
    sqlite.exec("UPDATE admin_control SET owner='D1',epoch=2");
    await assert.rejects(submitOperationalCard(adapter, { ...command, name: 'A'.repeat(14) }), /Invalid name/);
    await assert.rejects(submitOperationalCard(adapter, { ...command, weekName: 'A'.repeat(256) }), /Invalid name/);
    for (const tiebreaker of ['400.1234', '4e2', true, '']) {
      await assert.rejects(submitOperationalCard(adapter, { ...command, tiebreaker }), /numeric tiebreaker/);
    }
    const original = { ...command, name: 'A'.repeat(13), weekName: 'A'.repeat(255), tiebreaker: '400.123' };
    await submitOperationalCard(adapter, original, '2026-09-24T19:00:00.123Z');
    const replacement = { ...original, operationId: 'submission-fixture-0002', expectedSubmissionId: 1, picks: ['BUF'], bestBet: 'BUF' };
    await assert.rejects(submitOperationalCard(adapter, replacement, '2026-09-24T19:00:00.123Z'), /UNIQUE constraint/);
    assert.equal(sqlite.prepare('SELECT superseded_at FROM submissions WHERE id=1').get().superseded_at, null);
    assert.equal(sqlite.prepare('SELECT count(*) AS total FROM operational_receipts').get().total, 1);
    await submitOperationalCard(adapter, replacement, '2026-09-24T19:00:00.124Z');
    assert.equal((await submitOperationalCard(adapter, original)).submissionId, 1);
    assert.equal((await submitOperationalCard(adapter, replacement)).submissionId, 2);
    assert.deepEqual(sqlite.prepare('SELECT picked_team FROM submission_picks ORDER BY submission_id').all().map(row => row.picked_team), ['mia', 'BUF']);
    assert.equal(sqlite.prepare('SELECT count(*) AS total FROM submissions WHERE superseded_at IS NULL').get().total, 1);
    assert.equal(sqlite.prepare('SELECT count(*) AS total FROM admin_submission_links').get().total, 2);
  } finally { sqlite.close(); }
});

test('the public Worker route rejects writes while Sheets owns the pool', async () => {
  const { sqlite, adapter } = fixture();
  try {
    const status = await worker.fetch(new Request('https://example.test/?action=backend-status'), { DB: adapter, CORS_ORIGIN: '*' });
    assert.deepEqual(await status.json(), { ok: true, owner: 'SHEETS', epoch: 1, writesEnabled: false });
    const response = await worker.fetch(new Request('https://example.test/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(command) }), { DB: adapter, CORS_ORIGIN: '*' });
    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /Sheets currently owns/);
    sqlite.exec("UPDATE admin_control SET owner='D1',epoch=2");
    const disabled = await worker.fetch(new Request('https://example.test/', { method: 'POST', body: JSON.stringify(command) }), { DB: adapter, CORS_ORIGIN: '*' });
    assert.equal(disabled.status, 409);
    assert.equal(sqlite.prepare('SELECT count(*) AS total FROM submissions').get().total, 0);
  } finally { sqlite.close(); }
});

test('public corrections cannot bypass the private editor under either owner', async () => {
  const { sqlite, adapter } = fixture();
  try {
    sqlite.exec("UPDATE admin_control SET owner='D1',epoch=2");
    const receipt = await submitOperationalCard(adapter, command, '2026-09-24T19:00:00Z');
    for (const owner of ['D1', 'SHEETS']) {
      sqlite.prepare('UPDATE admin_control SET owner=?').run(owner);
      const response = await worker.fetch(new Request('https://example.test/', { method: 'POST', body: JSON.stringify({
        action: 'correct-submission-name', originalName: command.name, correctedName: 'Changed', correctedWeekName: 'Changed',
        submittedAt: receipt.submittedAt, season: command.season, week: command.week,
      }) }), { DB: adapter, CORS_ORIGIN: '*', OPERATIONAL_WRITES_ENABLED: 'true' });
      assert.equal(response.status, 403);
      assert.match((await response.json()).error, /private owner editor/);
    }
    assert.equal(sqlite.prepare('SELECT week_name FROM submissions').get().week_name, command.weekName);
    assert.equal(sqlite.prepare('SELECT canonical_name FROM players').get().canonical_name, command.name);
    assert.equal(sqlite.prepare('SELECT count(*) AS total FROM submission_corrections').get().total, 0);
  } finally { sqlite.close(); }
});

test('an ownership transition between validation and commit fences the entire transaction', async () => {
  const { sqlite, adapter } = fixture();
  try {
    sqlite.exec("UPDATE admin_control SET owner='D1',epoch=2");
    const changing = { ...adapter, batch: async statements => {
      sqlite.exec("UPDATE admin_control SET owner='SHEETS',epoch=3");
      return adapter.batch(statements);
    } };
    await assert.rejects(submitOperationalCard(changing, command, '2026-09-24T19:00:00Z'), /ownership changed/);
    assert.equal(sqlite.prepare('SELECT count(*) AS total FROM submissions').get().total, 0);
    assert.equal(sqlite.prepare('SELECT count(*) AS total FROM players').get().total, 0);
    assert.equal(sqlite.prepare('SELECT count(*) AS total FROM operational_receipts').get().total, 0);
  } finally { sqlite.close(); }
});

test('operational recovery retains originals, replacements, corrections and immutable receipts without production writes', async () => {
  const { sqlite, adapter } = memoryDatabase(['0001_initial.sql', '0009_admin_record_history.sql', '0010_candidate_lifecycle.sql', '0011_payout_journal.sql', '0012_submission_admin_projection.sql', '0013_operational_receipts.sql', '0014_playoff_eligibility.sql', '0016_independent_best_bet.sql', '0017_submission_confirmation_outbox.sql']);
  try {
    sqlite.exec(`UPDATE admin_control SET owner='D1',epoch=2;
      INSERT INTO weeks(id,season,week,phase,status) VALUES(1,2026,3,'REGULAR_SEASON','open');
      INSERT INTO games(id,week_id,game_index,external_id,kickoff_at,favorite,underdog,spread,home_team,away_team) VALUES(1,1,0,'game1','2026-09-27T17:00:00Z','BUF','mia',3,'BUF','MIA');`);
    await submitOperationalCard(adapter, command, '2026-09-24T19:00:00Z');
    await submitOperationalCard(adapter, { ...command, operationId: 'replacement-checkpoint-001', expectedSubmissionId: 1 }, '2026-09-24T20:00:00Z');
    const record = sqlite.prepare("SELECT * FROM admin_records WHERE record_id='operational:replacement-checkpoint-001'").get();
    await saveAdminRecord(adapter, { kind: 'submission', recordId: record.record_id, expectedVersion: 1, expectedEpoch: 2,
      operationId: 'checkpoint-correction-001', reason: 'Correct name', body: { ...JSON.parse(record.body), weekName: 'Corrected' } }, 'owner');
    const checkpoint = await createOperationalCheckpoint(adapter);
    const result = await rehearseOperationalCheckpoint(checkpoint);
    assert.equal(result.exactStateRestored, true);
    assert.equal(result.counts.submissions, 2);
    assert.equal(result.counts.submission_corrections, 1);
    assert.equal(result.counts.operational_receipts, 2);
    assert.equal(result.epoch, 3);
    assert.equal(result.productionWrites, 0);
    assert.equal(sqlite.prepare('SELECT owner FROM admin_control').get().owner, 'D1');
    checkpoint.payload.tables.submissions[0].week_name = 'Corrupted';
    await assert.rejects(rehearseOperationalCheckpoint(checkpoint), /checksum/);
  } finally { sqlite.close(); }
});

test('new opposing Best Bets are rejected while legacy opposing cards remain readable and correctable', async () => {
  const { sqlite, adapter } = fixture();
  try {
    sqlite.exec("UPDATE admin_control SET owner='D1',epoch=2");
    await assert.rejects(submitOperationalCard(adapter, { ...command, bestBet: 'BUF' }, '2026-09-24T19:00:00Z'), /one of the selected picks/);
    assert.equal(sqlite.prepare('SELECT count(*) AS total FROM submissions').get().total, 0);
    await submitOperationalCard(adapter, command, '2026-09-24T19:00:00Z');
    sqlite.exec("UPDATE submissions SET best_bet_team='BUF'");
    assert.equal(sqlite.prepare('SELECT best_bet_team FROM submissions').get().best_bet_team, 'BUF');
    const response = await worker.fetch(new Request('https://example.test/?action=current-week'), { DB: adapter, CORS_ORIGIN: '*' });
    assert.equal(response.status, 200);
    const player = (await response.json()).players[0];
    assert.equal(player.bestBet, 'BUF');
    assert.deepEqual(player.picks, ['mia']);
    const body = JSON.parse(sqlite.prepare("SELECT body FROM admin_records WHERE kind='submission'").get().body);
    await saveAdminRecord(adapter, { kind: 'submission', recordId: 'operational:submission-fixture-0001', expectedVersion: 1, expectedEpoch: 2,
      operationId: 'opposing-correction-001', reason: 'Change ordinary pick', body: { ...body, picks: ['BUF'], bestBet: 'mia' } }, 'owner');
    assert.equal(sqlite.prepare('SELECT best_bet_team FROM submissions').get().best_bet_team, 'mia');
    assert.equal(sqlite.prepare('SELECT picked_team FROM submission_picks').get().picked_team, 'BUF');
  } finally { sqlite.close(); }
});

test('a slate change during validation cannot accept picks against the wrong games', async () => {
  const { sqlite, adapter } = fixture();
  try {
    sqlite.exec("UPDATE admin_control SET owner='D1',epoch=2");
    const changing = { ...adapter, batch: async statements => {
      sqlite.exec("UPDATE games SET underdog='pit'");
      return adapter.batch(statements);
    } };
    await assert.rejects(submitOperationalCard(changing, command, '2026-09-24T19:00:00Z'), /changed during submission/);
    assert.equal(sqlite.prepare('SELECT count(*) AS total FROM admin_records').get().total, 0);
    assert.equal(sqlite.prepare('SELECT count(*) AS total FROM submissions').get().total, 0);
  } finally { sqlite.close(); }
});

test('entry fees commit with cards, allow credit and never repeat for retries or replacements', async () => {
  const { sqlite, adapter } = fixture();
  try {
    sqlite.exec("UPDATE admin_control SET owner='D1',epoch=2");
    sqlite.exec("CREATE TRIGGER fail_fee BEFORE INSERT ON payout_journal BEGIN SELECT RAISE(ABORT,'forced fee failure'); END");
    await assert.rejects(submitOperationalCard(adapter, command, '2026-09-24T19:00:00Z'), /forced fee/);
    assert.equal(sqlite.prepare('SELECT count(*) AS total FROM submissions').get().total, 0);
    assert.equal(sqlite.prepare('SELECT count(*) AS total FROM operational_receipts').get().total, 0);
    sqlite.exec('DROP TRIGGER fail_fee');
    await submitOperationalCard(adapter, command, '2026-09-24T19:00:00Z');
    await submitOperationalCard(adapter, command);
    await submitOperationalCard(adapter, { ...command, operationId: 'replacement-no-fee-001', expectedSubmissionId: 1 }, '2026-09-24T20:00:00Z');
    const payout = JSON.parse(sqlite.prepare("SELECT body FROM admin_records WHERE kind='payout'").get().body);
    assert.equal(payout.balanceCents, 1000);
    assert.equal(payout.weeks[2], '10');
    assert.equal(sqlite.prepare('SELECT count(*) AS total FROM payout_journal').get().total, 1);
    const journal = sqlite.prepare('SELECT * FROM payout_journal').get();
    assert.equal(journal.money_in_cents + journal.money_out_cents, 0);
    assert.equal(journal.amount_cents, 1000);
  } finally { sqlite.close(); }
});

test('entry fees preserve prepaid periods, consume partial surplus and fence concurrent account edits', async () => {
  for (const period of ['paid', 'win', 'tie', '']) {
    const { sqlite, adapter } = fixture();
    try {
      sqlite.exec("UPDATE admin_control SET owner='D1',epoch=2");
      const weeks = Array(19).fill('');
      weeks[2] = period;
      const body = { name: 'Example', season: '2026', periods: [...Array.from({ length: 18 }, (_, index) => String(index + 1)), 'Playoffs'], weeks,
        balance: '+5', balanceCents: -500, reconciliation: { status: 'accepted-payout-baseline' } };
      await saveAdminRecord(adapter, { kind: 'payout', recordId: 'payout:existing', expectedVersion: 0, expectedEpoch: 2,
        operationId: 'existing-prepaid-account', reason: 'Test baseline', body }, 'source');
      await submitOperationalCard(adapter, command, '2026-09-24T19:00:00Z');
      const saved = JSON.parse(sqlite.prepare("SELECT body FROM admin_records WHERE kind='payout'").get().body);
      assert.equal(saved.weeks[2], period || '5');
      assert.equal(saved.balanceCents, period ? -500 : 500);
      assert.equal(sqlite.prepare('SELECT count(*) AS total FROM payout_journal').get().total, period ? 0 : 1);
    } finally { sqlite.close(); }
  }
  const { sqlite, adapter } = fixture();
  try {
    sqlite.exec("UPDATE admin_control SET owner='D1',epoch=2");
    const changing = { ...adapter, batch: async statements => {
      await saveAdminRecord(adapter, { kind: 'payout', recordId: 'payout:concurrent', expectedVersion: 0, expectedEpoch: 2, operationId: 'concurrent-payout-account', reason: 'Concurrent owner account',
        body: { name: 'Example', season: '2026', balanceCents: 0 } }, 'owner');
      return adapter.batch(statements);
    } };
    await assert.rejects(submitOperationalCard(changing, command, '2026-09-24T19:00:00Z'), /changed during submission/);
    assert.equal(sqlite.prepare('SELECT count(*) AS total FROM submissions').get().total, 0);
    assert.equal(sqlite.prepare('SELECT count(*) AS total FROM payout_journal').get().total, 0);
    assert.equal(sqlite.prepare("SELECT count(*) AS total FROM admin_records WHERE kind='payout'").get().total, 1);
  } finally { sqlite.close(); }
});