export interface AdminMutation {
  operationId: string;
  kind: 'submission' | 'payout' | 'week' | 'source-ledger';
  recordId: string;
  expectedVersion: number;
  expectedEpoch: number;
  reason: string;
  body: Record<string, unknown>;
}

export class AdminConflict extends Error {}

export async function adminDigest(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export function canonicalAdminJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalAdminJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalAdminJson(item)}`).join(',')}}`;
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('Unsupported administrative value.');
  return encoded;
}

export async function saveAdminRecord(db: D1Database, command: AdminMutation, actor: string, now = new Date().toISOString()): Promise<{ version: number; replayed: boolean }> {
  if (!command || !['submission', 'payout', 'week', 'source-ledger'].includes(command.kind)
    || !/^[a-zA-Z0-9:_-]{1,160}$/.test(command.recordId)
    || !/^[a-zA-Z0-9:_-]{16,160}$/.test(command.operationId)
    || !Number.isSafeInteger(command.expectedVersion) || command.expectedVersion < 0
    || !Number.isSafeInteger(command.expectedEpoch) || command.expectedEpoch < 1
    || typeof command.reason !== 'string' || !command.reason.trim() || command.reason.length > 500
    || !actor || actor.length > 100 || !command.body || Array.isArray(command.body) || typeof command.body !== 'object') {
    throw new Error('Invalid administrative mutation.');
  }
  const body = canonicalAdminJson(command.body);
  if (new TextEncoder().encode(body).length > 524288) throw new Error('Administrative record exceeds the size limit.');
  const requestHash = await adminDigest(canonicalAdminJson({ ...command, actor }));
  const existing = await db.prepare('SELECT request_hash, version FROM admin_events WHERE operation_id = ?')
    .bind(command.operationId).first<{ request_hash: string; version: number }>();
  if (existing) {
    if (existing.request_hash !== requestHash) throw new AdminConflict('Operation ID was already used for different content.');
    return { version: existing.version, replayed: true };
  }
  const version = command.expectedVersion + 1;
  await db.batch([
    db.prepare(`INSERT INTO admin_events
      (operation_id, request_hash, kind, record_id, version, epoch, actor, reason, recorded_at, body)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM admin_control WHERE id = 1 AND epoch = ?)
        AND COALESCE((SELECT version FROM admin_records WHERE kind = ? AND record_id = ?), 0) = ?
        AND NOT (? = 'source-ledger' AND ? > 0)
      ON CONFLICT DO NOTHING`)
      .bind(command.operationId, requestHash, command.kind, command.recordId, version, command.expectedEpoch,
        actor, command.reason.trim(), now, body, command.expectedEpoch, command.kind, command.recordId,
        command.expectedVersion, command.kind, command.expectedVersion),
    db.prepare(`INSERT INTO admin_records (kind, record_id, version, operation_id, body)
      SELECT kind, record_id, version, operation_id, body FROM admin_events
      WHERE operation_id = ? AND request_hash = ?
      ON CONFLICT (kind, record_id) DO UPDATE SET version = excluded.version,
        operation_id = excluded.operation_id, body = excluded.body
      WHERE admin_records.version = ?`)
      .bind(command.operationId, requestHash, command.expectedVersion),
  ]);
  const receipt = await db.prepare('SELECT request_hash, version FROM admin_events WHERE operation_id = ?')
    .bind(command.operationId).first<{ request_hash: string; version: number }>();
  if (!receipt || receipt.request_hash !== requestHash) throw new AdminConflict('Record or ownership epoch changed; reload before editing.');
  return { version: receipt.version, replayed: false };
}