import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { parseAlertFeed } from '../src/alert-details.ts';

const sortedCards = cards => cards.map(card => ({ ...card, name: card.name.trim().toLowerCase() })).sort((left, right) => left.name.localeCompare(right.name));
const fixedGames = games => games.map(({ clock, period, ...game }) => game);

export function compareCandidateArchive(stored, canonical) {
  assert.ok(stored, 'D1 has not finalized this week.');
  assert.equal(createHash('sha256').update(stored.payload_json).digest('hex'), stored.checksum, 'Candidate archive checksum mismatch.');
  const candidate = JSON.parse(stored.payload_json);
  assert.equal(candidate.phase, 'REGULAR_SEASON');
  assert.equal(canonical.season, candidate.season, 'Different seasons.');
  assert.equal(canonical.week, candidate.week, 'Different weeks.');
  assert.equal(canonical.tiebreakStatus, 'final', 'Canonical tiebreaker is not final.');
  assert.ok(canonical.actualTiebreaker !== '' && canonical.actualTiebreaker != null, 'Missing final tiebreaker.');
  assert.ok(Number.isFinite(Number(canonical.actualTiebreaker)), 'Invalid final tiebreaker.');
  assert.equal(candidate.actualTiebreaker, Number(canonical.actualTiebreaker), 'Final tiebreakers differ.');
  const feed = parseAlertFeed(canonical, candidate.season, candidate.week);
  assert.ok(feed.cards.length > 0 && feed.games.every(game => game.status === 'FINAL'), 'Canonical week is incomplete.');
  assert.deepEqual(fixedGames(candidate.games), fixedGames(feed.games), 'Ordered games, lines, kickoff times or final scores differ.');
  assert.deepEqual(sortedCards(candidate.cards), sortedCards(feed.cards), 'Player cards differ.');
  const records = rows => rows.map(row => {
    assert.ok(Number.isInteger(row.wins) && Number.isInteger(row.losses), 'Missing or invalid final record.');
    return { name: row.name.trim().toLowerCase(), wins: row.wins, losses: row.losses };
  }).sort((left, right) => left.name.localeCompare(right.name));
  assert.deepEqual(records(candidate.results), records(canonical.players), 'Final records differ.');
  return { season: candidate.season, week: candidate.week, games: feed.games.length, players: feed.cards.length, actualTiebreaker: candidate.actualTiebreaker, finalResultParity: true, fullReplacementReady: false, productionWrites: 0 };
}