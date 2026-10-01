import { getPlatformProxy } from 'wrangler';
import { fileURLToPath } from 'node:url';
import { refreshActiveGameStates } from '../src/index.ts';

const proxy = await getPlatformProxy({
  configPath: fileURLToPath(new URL('../wrangler.admin.toml', import.meta.url)),
  persist: false,
  remoteBindings: true,
});

try {
  const result = await refreshActiveGameStates(proxy.env.DB);
  console.log(JSON.stringify({ ok: true, checkedAt: new Date().toISOString(), ...result }));
} finally {
  await proxy.dispose();
}