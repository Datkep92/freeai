/**
 * URL classification: does this URL need an API key?
 *
 * The drawer splits every URL by this, so a wrong verdict is not cosmetic: it
 * tells the user to go and get a key for a URL that works fine, or claims a URL
 * is ready when it will answer 401 the moment it is tapped. These cases pin the
 * verdict to the HTTP status that produced it, and cover the two mistakes that
 * actually happen - treating "not probed" as "needs a key", and letting a keyed
 * scan overwrite the answer.
 */
import { describe, it, assert, assertEqual } from './harness.js';
import { MemoryStorage } from '../core/storage.js';
import { ProviderRegistry } from '../core/provider-registry.js';
import { Scanner } from '../core/scanner.js';
import { createMockFetch } from './mock-fetch.js';
import { sanitizeError } from '../core/util.js';
import {
  KEY_REQ,
  requirementFromDiscovery,
  requirementOf,
  groupByRequirement,
} from '../core/key-requirement.js';

// Synthetic only. Never a valid credential.
const KEY_A = 'oc_sk_A1b2C3d4E5f6G7h8I9j0';

function useRoutes(routes) {
  const m = createMockFetch(routes);
  globalThis.fetch = m;
  return m;
}

/** A registry with no built-ins, so each case owns exactly the URLs it names. */
async function bare() {
  const storage = new MemoryStorage();
  const providers = new ProviderRegistry(storage);
  return { storage, providers, scanner: new Scanner(storage, { providers }) };
}

export function registerKeyReqCases() {
  describe('KR. A URL is classified by what a request actually returned', () => {
    it('KR1: a 200 on /models is the only proof that no key is needed', () => {
      assertEqual(requirementFromDiscovery({ ok: true, models: [] }), KEY_REQ.NONE);
    });

    it('KR2: 401 and 403 mean the URL is alive and waiting for a key', () => {
      assertEqual(requirementFromDiscovery({ ok: false, reason: 'HTTP_401' }), KEY_REQ.REQUIRED);
      assertEqual(requirementFromDiscovery({ ok: false, reason: 'HTTP_403' }), KEY_REQ.REQUIRED);
    });

    it('KR3: a 404 is not "needs a key" - nobody proved that', () => {
      // The old rule was `verified !== 'OPEN'`, which filed a 404 beside Groq.
      assertEqual(requirementFromDiscovery({ ok: false, reason: 'HTTP_404' }), KEY_REQ.UNKNOWN);
    });

    it('KR4: a timeout or a dead host is also unknown, not a key problem', () => {
      assertEqual(requirementFromDiscovery({ ok: false, reason: 'TIMEOUT' }), KEY_REQ.UNKNOWN);
      assertEqual(requirementFromDiscovery({ ok: false, reason: 'NETWORK' }), KEY_REQ.UNKNOWN);
      assertEqual(requirementFromDiscovery({ ok: false, reason: 'HTTP_500' }), KEY_REQ.UNKNOWN);
    });

    it('KR5: a missing result is unknown rather than an assumption', () => {
      assertEqual(requirementFromDiscovery(null), KEY_REQ.UNKNOWN);
    });

    it('KR6: a provider row stores and returns its own verdict', () => {
      assertEqual(requirementOf({ keyRequirement: KEY_REQ.NONE }), KEY_REQ.NONE);
      assertEqual(requirementOf({ keyRequirement: KEY_REQ.REQUIRED }), KEY_REQ.REQUIRED);
      assertEqual(requirementOf({ keyRequirement: KEY_REQ.UNKNOWN }), KEY_REQ.UNKNOWN);
    });

    it('KR7: a row written before the scanner existed falls back to its probe', () => {
      // Seeded built-ins still carry `verified` and no `keyRequirement`.
      assertEqual(requirementOf({ verified: 'OPEN' }), KEY_REQ.NONE);
      assertEqual(requirementOf({ verified: 'NEEDS_KEY' }), KEY_REQ.REQUIRED);
      assertEqual(requirementOf({ verified: 'BROKEN' }), KEY_REQ.UNKNOWN);
      assertEqual(requirementOf({}), KEY_REQ.UNKNOWN);
      assertEqual(requirementOf(null), KEY_REQ.UNKNOWN);
    });

    it('KR8: groups keep every URL, and never mix the two proven groups', () => {
      const groups = groupByRequirement([
        { id: 'a', keyRequirement: KEY_REQ.NONE },
        { id: 'b', keyRequirement: KEY_REQ.REQUIRED },
        { id: 'c', keyRequirement: KEY_REQ.UNKNOWN },
        { id: 'd', verified: 'NEEDS_KEY' },
        { id: 'e', keyRequirement: KEY_REQ.REQUIRED },
      ]);
      assertEqual(groups[KEY_REQ.NONE].map((p) => p.id).join(','), 'a');
      // Order within a group is the input order, so a URL keeps the position
      // the user dragged it to. `d` is a fallback-classified row and still
      // lands where it was in the list, not appended at the end.
      assertEqual(groups[KEY_REQ.REQUIRED].map((p) => p.id).join(','), 'b,d,e');
      assertEqual(groups[KEY_REQ.UNKNOWN].map((p) => p.id).join(','), 'c');
    });
  });

  describe('KR. The scan is what records the verdict', () => {
    it('KR9: an anonymous 401 files the URL as needing a key', async () => {
      const { providers, scanner } = await bare();
      const { provider } = await providers.upsert({ name: 'Locked', baseURL: 'https://locked.test/v1' });
      useRoutes({ '/models': { status: 401, body: { error: { message: 'No API key provided' } } } });

      const result = await scanner.scanProvider({ providerId: provider.id, force: true });
      assertEqual(result.ok, false);
      assertEqual(result.keyRequirement, KEY_REQ.REQUIRED);
      assertEqual((await providers.get(provider.id)).keyRequirement, KEY_REQ.REQUIRED);
    });

    it('KR10: an anonymous 200 files the URL as not needing a key', async () => {
      const { providers, scanner } = await bare();
      const { provider } = await providers.upsert({ name: 'Public', baseURL: 'https://public.test/v1' });
      useRoutes({
        '/models': { body: { data: [{ id: 'free-one', name: 'free-one' }] } },
      });

      const result = await scanner.scanProvider({ providerId: provider.id, force: true });
      assertEqual(result.ok, true);
      assertEqual(result.keyRequirement, KEY_REQ.NONE);
      assertEqual((await providers.get(provider.id)).keyRequirement, KEY_REQ.NONE);
    });

    it('KR11: a 404 stays unknown and keeps the URL addressable', async () => {
      const { providers, scanner } = await bare();
      const { provider } = await providers.upsert({ name: 'Gone', baseURL: 'https://gone.test/v1' });
      useRoutes({ '/models': { status: 404, body: { error: { message: 'not found' } } } });

      await scanner.scanProvider({ providerId: provider.id, force: true });
      // The provider row survives a failed discovery: the user may know a model
      // the endpoint does not list, so the URL stays and manual models still work.
      const row = await providers.get(provider.id);
      assert(row, 'the URL is still stored');
      assertEqual(row.keyRequirement, KEY_REQ.UNKNOWN);
    });

    it('KR12: a scan WITH a key does not claim the URL needs no key', async () => {
      // The bug this prevents: /models answers 200 when a key is sent, so a
      // keyed scan of Groq would move it into "không cần key" the first time
      // the user pasted a key into it - and it would be wrong forever after.
      const { providers, scanner } = await bare();
      const { provider } = await providers.upsert({ name: 'NeedsKey', baseURL: 'https://needs.test/v1' });

      // First, an anonymous scan proves it needs a key.
      useRoutes({ '/models': { status: 401, body: { error: { message: 'Missing API key' } } } });
      await scanner.scanProvider({ providerId: provider.id, force: true });
      assertEqual((await providers.get(provider.id)).keyRequirement, KEY_REQ.REQUIRED);

      // Then the same URL is scanned with a key, and it answers 200.
      useRoutes({ '/models': { body: { data: [{ id: 'm1', name: 'm1' }] } } });
      const withKey = await scanner.scanProvider({ providerId: provider.id, force: true, secret: KEY_A });
      assertEqual(withKey.ok, true, 'the keyed scan itself succeeded');
      assertEqual(
        (await providers.get(provider.id)).keyRequirement,
        KEY_REQ.REQUIRED,
        'but the verdict survives, because a keyed 200 is not proof either way'
      );
      assertEqual(withKey.keyRequirement, KEY_REQ.REQUIRED);
    });

    it('KR13: a keyed scan on a URL never classified leaves it unknown', async () => {
      const { providers, scanner } = await bare();
      const { provider } = await providers.upsert({ name: 'Fresh', baseURL: 'https://fresh.test/v1' });
      useRoutes({ '/models': { body: { data: [{ id: 'm1', name: 'm1' }] } } });

      const result = await scanner.scanProvider({ providerId: provider.id, force: true, secret: KEY_A });
      assertEqual(result.ok, true);
      assertEqual(
        (await providers.get(provider.id)).keyRequirement ?? KEY_REQ.UNKNOWN,
        KEY_REQ.UNKNOWN,
        'nothing was proven, so nothing is claimed'
      );
    });

    it('KR14: a fresh provider that serves free models stays addressable', async () => {
      const { providers, scanner } = await bare();
      const { provider } = await providers.upsert({ name: 'Gw', baseURL: 'https://gw.test/v1' });
      useRoutes({
        '/models': {
          body: { data: [{ id: 'x:free', name: 'x:free' }, { id: 'paid', name: 'paid', pricing: { prompt: '1', completion: '1' } }] },
        },
      });
      const result = await scanner.scanProvider({ providerId: provider.id, force: true });
      assertEqual(result.keyRequirement, KEY_REQ.NONE);
      assertEqual((await providers.get(provider.id)).status, 'OK');
    });
  });
  describe('KS. An error message must never carry a key', () => {
    // Providers echo back whatever they were sent, including the Authorization
    // header, and these messages are written to the log and shown in the health
    // list. A key that reaches either place is stored on disk and displayed, so
    // every echo shape a provider actually produces is checked here.
    const SECRET = 'oc_sk_A1b2C3d4E5f6G7h8I9j0';

    const leaks = (out) =>
      out.includes(SECRET) || out.includes(SECRET.slice(0, 8)) || out.includes(SECRET.slice(-8));

    it('KS1: the exact key echoed back is removed', () => {
      const out = sanitizeError(`Invalid key: ${SECRET} provided`, [SECRET]);
      assertEqual(leaks(out), false, 'got: ' + out);
      assert(out.includes('[secret]'), 'and it says something was redacted');
    });

    it('KS2: a bearer header is removed', () => {
      // This is the shape most providers actually send back.
      const out = sanitizeError(`Authorization: Bearer ${SECRET}`, [SECRET]);
      assertEqual(leaks(out), false, 'got: ' + out);
    });

    it('KS3: a JSON body quoting the key is removed', () => {
      const body = JSON.stringify({ error: { message: SECRET } });
      assertEqual(leaks(sanitizeError(body, [SECRET])), false);
    });

    it('KS4: a key pasted with surrounding whitespace is still removed', () => {
      // A pasted key routinely carries a trailing newline. Matching only the
      // stored value missed it, and the full key was written to the log - this
      // is the case that made the leak worth closing.
      const stored = ` ${SECRET}\n`;
      const out = sanitizeError(`bad key ${SECRET}\nhere`, [stored]);
      assertEqual(leaks(out), false, 'got: ' + JSON.stringify(out));
    });

    it('KS5: only the head or the tail is removed too', () => {
      assertEqual(leaks(sanitizeError(`bad ${SECRET.slice(0, 8)} here`, [SECRET])), false);
      assertEqual(leaks(sanitizeError(`bad ...${SECRET.slice(-8)} here`, [SECRET])), false);
    });

    it('KS6: an unrelated word is left alone', () => {
      // Blanketing short strings would make every message unreadable, and it
      // would hide that redaction is selective rather than a blanket wipe.
      const out = sanitizeError('the model is not allowed', [SECRET]);
      assert(out.includes('not allowed'), 'ordinary text survives: ' + out);
    });

    it('KS7: a very short secret is not treated as one', () => {
      const out = sanitizeError('key abc rejected', ['abc']);
      assertEqual(leaks(out), false);
      assert(out.includes('abc'), 'a 3-character value is ordinary text, not a key');
    });
  });

}
