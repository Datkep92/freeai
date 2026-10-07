import { describe, it, assert, assertEqual } from './harness.js';
import { MemoryStorage } from '../core/storage.js';
import { ProviderRegistry } from '../core/provider-registry.js';
import { ModelRegistry } from '../core/model-registry.js';
import { KeyRegistry } from '../core/key-registry.js';
import { exportRegistry, importRegistry } from '../core/io.js';
import { secretFields } from '../core/db/schema.js';
import { createMockFetch } from './mock-fetch.js';

const KEY_A = 'oc_sk_A1b2C3d4E5f6G7h8I9j0';
const KEY_B = 'oc_sk_Z9y8X7w6V5u4T3s2R1q0';

export function registerIoCases() {
  describe('IO. Export and import', () => {
    it('IO1: export leaves secrets out by default', async () => {
      const s = new MemoryStorage();
      const providers = new ProviderRegistry(s);
      const keys = new KeyRegistry(s);
      const { provider } = await providers.upsert({ name: 'T', baseURL: 'https://t.test/v1' });
      await keys.add({ providerId: provider.id, secret: KEY_A });

      const dump = await exportRegistry(s);
      const text = JSON.stringify(dump);
      assertEqual(text.includes(KEY_A), false, 'no secret anywhere in the export');
      assertEqual(dump.includesSecrets, false);
      assert(dump.keys[0].fingerprint, 'the fingerprint is kept so the key is recognisable');
    });

    it('IO2: exporting secrets is possible but must be asked for', async () => {
      const s = new MemoryStorage();
      const providers = new ProviderRegistry(s);
      const keys = new KeyRegistry(s);
      const { provider } = await providers.upsert({ name: 'T', baseURL: 'https://t.test/v1' });
      await keys.add({ providerId: provider.id, secret: KEY_A });

      const dump = await exportRegistry(s, { includeSecrets: true });
      assertEqual(dump.includesSecrets, true);
      assertEqual(JSON.stringify(dump).includes(KEY_A), true);
    });

    it('IO3: import merges instead of overwriting', async () => {
      const source = new MemoryStorage();
      const sp = new ProviderRegistry(source);
      const sk = new KeyRegistry(source);
      const { provider } = await sp.upsert({ name: 'T', baseURL: 'https://t.test/v1' });
      await sk.add({ providerId: provider.id, secret: KEY_A });
      const payload = await exportRegistry(source);

      const target = new MemoryStorage();
      const tk = new KeyRegistry(target);
      const sameProvider = (await new ProviderRegistry(target).upsert({ name: 'T', baseURL: 'https://t.test/v1' })).provider;
      // The key now exists locally with a newer status; importing must not
      // roll that back.
      const existing = await tk.add({ providerId: sameProvider.id, secret: KEY_A });
      await tk.update(existing.key.id, { status: 'HEALTHY' });

      const result = await importRegistry(target, payload);
      assertEqual(result.ok, true);
      assertEqual(result.merged >= 1, true, 'the duplicate merged instead of being added again');
      assertEqual(
        (await new ProviderRegistry(target).list()).length,
        1,
        'the same URL must not appear twice after an import'
      );
      const keys = await tk.list();
      assertEqual(keys.length, 1);
      assertEqual(keys[0].status, 'HEALTHY', 'the newer local status survived');
    });

    it('IO4: a round trip preserves providers and models', async () => {
      const s = new MemoryStorage();
      const providers = new ProviderRegistry(s);
      const models = new ModelRegistry(s);
      const { provider } = await providers.upsert({ name: 'T', baseURL: 'https://t.test/v1' });
      await models.upsertDiscovered({ providerId: provider.id, modelId: 'm1', pricing: { prompt: '0', completion: '0' } });

      const payload = await exportRegistry(s);
      const fresh = new MemoryStorage();
      await importRegistry(fresh, payload);

      assertEqual((await new ProviderRegistry(fresh).list()).length, 1);
      const restored = await new ModelRegistry(fresh).list();
      assertEqual(restored.length, 1);
      assertEqual(restored[0].modelId, 'm1');
      assertEqual(restored[0].freeStatus, 'FREE_VERIFIED', 'the verdict survives the trip');
    });

    it('IO5: a malformed file is rejected, not half-applied', async () => {
      const s = new MemoryStorage();
      assertEqual((await importRegistry(s, null)).ok, false);
      assertEqual((await importRegistry(s, 'nonsense')).ok, false);
      assertEqual((await importRegistry(s, { providers: 'not-an-array' })).ok, true);
      assertEqual((await s.list('providers')).length, 0);
    });
  });
}
