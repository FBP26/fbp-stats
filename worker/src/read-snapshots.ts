import { synchronizeShadowCards } from './shadow-sync.ts';

type PublicPayload = Record<string, unknown>;
const snapshotNames = new Set(['active-week', 'current-week', 'current-week-race']);
export const snapshotMaxAgeMs = 90000;

const slateSignature = (games: PublicPayload[]): string => JSON.stringify(games.map(game => [
  String(game.gameId || ''), String(game.favorite || '').toUpperCase(),
  String(game.underdog || '').toUpperCase(), String(game.spread ?? ''),
]));

export function validatePublicReadPair(active: PublicPayload, current: PublicPayload): void {
  if (active.ok !== true || current.ok !== true || active.staged !== true
    || !Number.isInteger(active.season) || !Number.isInteger(active.week)
    || Number(active.week) < 1 || Number(active.week) > 18
    || active.season !== current.season || active.week !== current.week
    || !Array.isArray(active.games) || !active.games.length
    || !Array.isArray(current.games) || !Array.isArray(current.players)
    || slateSignature(active.games) !== slateSignature(current.games)) {
    throw new Error('Public read snapshots must describe one complete staged regular-season slate.');
  }
  const count = current.games.length;
  if (!['favorites', 'underdogs', 'spreads'].every(key => Array.isArray(current[key]) && current[key].length === count)
    || !current.players.every(player => player && typeof player.name === 'string'
      && Array.isArray(player.picks) && player.picks.length === count)) {
    throw new Error('Public current-week snapshot is incomplete.');
  }
}

async function compressPayload(payload: PublicPayload): Promise<ArrayBuffer> {
  const body = new Blob([JSON.stringify(payload)]).stream().pipeThrough(new CompressionStream('gzip'));
  const compressed = await new Response(body).arrayBuffer();
  if (compressed.byteLength > 1800000) throw new Error('Public snapshot exceeds the safe storage limit.');
  return compressed;
}

async function snapshotStatement(db: D1Database, name: string, season: number, week: number, startedAt: number, payload: PublicPayload): Promise<D1PreparedStatement> {
  return db.prepare(`INSERT INTO public_read_snapshots (name, season, week, read_started_at, payload)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET
    season = excluded.season, week = excluded.week, read_started_at = excluded.read_started_at,
    payload = excluded.payload WHERE excluded.read_started_at > public_read_snapshots.read_started_at`)
    .bind(name, season, week, startedAt, await compressPayload(payload));
}

async function sourceRead(source: string, parameters: Record<string, string>, fetcher: typeof fetch): Promise<PublicPayload> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const url = new URL(source);
    url.search = new URLSearchParams({ ...parameters, _: `${Date.now()}-${attempt}` }).toString();
    const response = await fetcher(url, { signal: AbortSignal.timeout(35000), cache: 'no-store' });
    if (attempt === 0 && [404, 408, 429, 500, 502, 503, 504].includes(response.status)) {
      await response.body?.cancel();
      continue;
    }
    if (!response.ok) throw new Error(`Public read source returned HTTP ${response.status}.`);
    const payload = await response.json() as PublicPayload;
    if (payload?.ok !== true) throw new Error('Public read source did not return a successful payload.');
    return payload;
  }
  throw new Error('Public read source retries exhausted.');
}

export async function refreshPublicReadSnapshots(db: D1Database, source: string | undefined, fetcher: typeof fetch = fetch): Promise<void> {
  if (!source) return;
  const startedAt = Date.now();
  const [active, current] = await Promise.all([
    sourceRead(source, { action: 'active-week', enrich: '0' }, fetcher),
    sourceRead(source, { action: 'current-week', fast: '1' }, fetcher),
  ]);
  validatePublicReadPair(active, current);
  const season = Number(current.season), week = Number(current.week);
  await db.batch(await Promise.all([
    snapshotStatement(db, 'active-week', season, week, startedAt, active),
    snapshotStatement(db, 'current-week', season, week, startedAt, current),
  ]));
  try {
    await synchronizeShadowCards(db, current, startedAt);
  } catch (error) {
    console.error('Shadow card synchronization failed:', error instanceof Error ? error.message : 'Unexpected error');
  }
  const raceStartedAt = Date.now();
  const race = await sourceRead(source, { action: 'current-week-race', season: String(season), week: String(week) }, fetcher);
  if (!Array.isArray(race.raceSnapshots)
    || (race.season != null && Number(race.season) !== season)
    || (race.week != null && Number(race.week) !== week)) {
    throw new Error('Public race snapshot does not match the requested week.');
  }
  await (await snapshotStatement(db, 'current-week-race', season, week, raceStartedAt, race)).run();
}

export async function publicReadSnapshot(request: Request, db: D1Database, origin: string, now = Date.now()): Promise<Response> {
  const url = new URL(request.url);
  const name = url.searchParams.get('kind') || '';
  const headers = {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Expose-Headers': 'X-FBP-Snapshot-At, X-FBP-Snapshot-Season, X-FBP-Snapshot-Week',
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json;charset=UTF-8',
  };
  if (!snapshotNames.has(name)) return Response.json({ ok: false, error: 'Unsupported public read.' }, { status: 400, headers });
  const row = await db.prepare('SELECT season, week, read_started_at, payload FROM public_read_snapshots WHERE name = ?')
    .bind(name).first<{ season: number; week: number; read_started_at: number; payload: number[] }>();
  const age = row ? now - row.read_started_at : Infinity;
  if (!row || age < 0 || age > snapshotMaxAgeMs
    || (url.searchParams.has('season') && Number(url.searchParams.get('season')) !== row.season)
    || (url.searchParams.has('week') && Number(url.searchParams.get('week')) !== row.week)
    || (name === 'current-week-race' && (!url.searchParams.has('season') || !url.searchParams.has('week')))) {
    return Response.json({ ok: false, error: 'No fresh matching snapshot. Use the authoritative source.' }, { status: 503, headers });
  }
  const stream = new Blob([new Uint8Array(row.payload)]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream, { headers: {
    ...headers,
    'X-FBP-Snapshot-At': String(row.read_started_at),
    'X-FBP-Snapshot-Season': String(row.season),
    'X-FBP-Snapshot-Week': String(row.week),
  } });
}