import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { getPlatformProxy } from 'wrangler';
import { reconcileExistingCompletedOperationalSlate } from './operational-source-import.mjs';

async function main() {
  const args = process.argv.slice(2);
  const csvPath = args.find(argument => argument.startsWith('--csv='))?.slice(6);
  const apply = args.includes('--apply');
  if (!args.includes('--remote') || !csvPath || args.some(argument => argument !== '--remote' && argument !== '--apply' && !argument.startsWith('--csv='))) {
    throw new Error('Use --remote --csv=CANONICAL_COMPLETED_CSV [--apply]. Default mode is read-only.');
  }
  const proxy = await getPlatformProxy({ configPath: fileURLToPath(new URL('../wrangler.admin.toml', import.meta.url)), persist: false, remoteBindings: true });
  try {
    const result = await reconcileExistingCompletedOperationalSlate(proxy.env.DB, await readFile(csvPath, 'utf8'), { apply });
    console.log(JSON.stringify({ ...result, apply, csvPath }));
  } finally {
    await proxy.dispose();
  }
}

if (process.argv[1] && new URL(import.meta.url).pathname === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).pathname) main().catch(error => { console.error(error.message); process.exitCode = 1; });