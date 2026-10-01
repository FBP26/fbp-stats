import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPlatformProxy } from 'wrangler';
import { createOperationalCheckpoint } from './operational-checkpoint.mjs';

async function main() {
  const args = process.argv.slice(2);
  const output = args.find(argument => argument.startsWith('--output='))?.slice(9);
  if (!args.includes('--remote') || !output || args.some(argument => argument !== '--remote' && !argument.startsWith('--output='))) {
    throw new Error('Use --remote --output=PRIVATE_CHECKPOINT.json. This command only reads D1.');
  }
  const target = resolve(output);
  const proxy = await getPlatformProxy({ configPath: fileURLToPath(new URL('../wrangler.admin.toml', import.meta.url)), persist: false, remoteBindings: true });
  try {
    const checkpoint = await createOperationalCheckpoint(proxy.env.DB);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, `${JSON.stringify(checkpoint)}\n`, { flag: 'wx' });
    console.log(JSON.stringify({ output: target, sha256: checkpoint.sha256, tables: Object.fromEntries(Object.entries(checkpoint.payload.tables).map(([table, rows]) => [table, rows.length])), absentTables: checkpoint.absentTables, productionWrites: 0 }));
  } finally {
    await proxy.dispose();
  }
}

if (process.argv[1] && new URL(import.meta.url).pathname === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).pathname) main().catch(error => { console.error(error.message); process.exitCode = 1; });