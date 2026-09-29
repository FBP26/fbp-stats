import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

export function memoryDatabase(migrations) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  for (const migration of migrations) sqlite.exec(readFileSync(new URL(`../../migrations/${migration}`, import.meta.url), 'utf8'));
  const adapter = {
    prepare(sql) {
      let values = [];
      return {
        bind(...parameters) { values = parameters.map(value => value instanceof ArrayBuffer ? new Uint8Array(value) : value); return this; },
        async first() { return sqlite.prepare(sql).get(...values) || null; },
        async all() { return { results: sqlite.prepare(sql).all(...values) }; },
        async run() {
          const statement = sqlite.prepare(sql);
          if (statement.columns().length) return { results: statement.all(...values), meta: { changes: 0 } };
          const result = statement.run(...values);
          return { ...result, meta: { changes: Number(result.changes) } };
        },
      };
    },
    async batch(statements) {
      sqlite.exec('BEGIN');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  };
  return { sqlite, adapter };
}