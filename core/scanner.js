/**
 * Model scanner (plan 8, 9).
 *
 * Discovery only. It never sends an inference request, so scanning a 460-model
 * provider costs no tokens - only the /models GET.
 *
 * Cache: a provider scanned recently is left alone unless forced, so opening
 * the UI does not re-fetch the world.
 */

import { CONFIG } from './config.js';
import { ProviderRegistry } from './provider-registry.js';
import { ModelRegistry } from './model-registry.js';
import { mapWithConcurrency, isoNow, makeId } from './util.js';
import { KEY_REQ, requirementFromDiscovery } from './key-requirement.js';

/**
 * The activity log.
 *
 * The `events` store has existed in the schema with nothing writing to it, which
 * is the worst state a store can be in: it looks like the feature is there and
 * it is not. So the store gets a writer, a reader and a retention policy here
 * rather than staying a declaration.
 *
 * Retention matters here more than the log itself. An event store with no
 * cap grows without bound on the user's own disk, in the one database the app
 * treats as its home, and the cost is invisible until the phone is full.
 */
/**
 * What an event row is for.
 *
 * Not free-form: the set is declared so a caller cannot invent a kind that no
 * reader knows how to render, and so `recent({ kind })` stays a real filter
 * rather than a string nobody filters by.
 */
export const EVENT_KIND = {
  SCAN: 'scan',
};

/**
 * A value that only ever goes up.
 *
 * Milliseconds since the epoch, with a per-session counter in the low digits so
 * two events written inside the same millisecond still order. The time prefix
 * keeps it increasing across restarts, which is what stops a new session from
 * writing events that sort before everything already in the log.
 */
let eventCounter = 0;
function nextSeq() {
  eventCounter = (eventCounter + 1) % 1000;
  return Date.now() * 1000 + eventCounter;
}

export class EventLog {
  constructor(storage, { limit = CONFIG.eventLogLimit } = {}) {
    this.storage = storage;
    this.limit = limit;
  }

  /**
   * Record one event.
   *
   * Never throws. A log that can fail the operation it is describing is a log
   * that loses exactly the entries worth having - the scan that went wrong.
   */
  async record({ kind, providerId = null, modelId = null, payload = null }) {
    if (!kind) return null;
    try {
      const row = {
        id: makeId('evt'),
        kind,
        ts: isoNow(),
        seq: nextSeq(),
        providerId,
        modelId,
        payload,
      };
      await this.storage.put('events', row);
      await this.trim();
      return row;
    } catch (error) {
      console.warn('Event log write failed (non-fatal):', error);
      return null;
    }
  }

  /** Newest first. */
  async recent({ limit = 50, kind = null, providerId = null } = {}) {
    const query = { where: {}, sort: { seq: 'DESC' }, limit };
    if (kind) query.where.kind = kind;
    if (providerId) query.where.providerId = providerId;
    if (!Object.keys(query.where).length) delete query.where;
    return this.storage.findMany('events', query);
  }

  /**
   * Drop the oldest rows past the cap.
   *
   * Read newest-first and delete the tail, so the rows that survive are the ones
   * somebody is still looking at. Ordered by `seq` rather than `ts`: twelve scans
   * written in one millisecond share a timestamp, and an arbitrary order here
   * would quietly delete the newest events and keep the oldest.
   */
  async trim() {
    const total = await this.storage.count('events');
    if (total <= this.limit) return 0;
    const rows = await this.storage.findMany('events', { sort: { seq: 'DESC' } });
    const doomed = rows.slice(this.limit).map((row) => row.id);
    if (doomed.length) await this.storage.removeMany('events', doomed);
    return doomed.length;
  }

  async clear() {
    await this.storage.clear('events');
  }
}

export class Scanner {
  constructor(storage, { providers, models, events } = {}) {
    this.storage = storage;
    this.providers = providers ?? new ProviderRegistry(storage);
    this.models = models ?? new ModelRegistry(storage);
    // Always present, so `scanProvider` never has to ask whether logging is
    // wired up. The optional call in there is belt and braces, not the design.
    this.events = events ?? new EventLog(storage);
  }

  /** True when a scan is worth doing (plan 9). */
  isStale(provider, ttlMs = CONFIG.cache.scanTtlMs) {
    const at = Date.parse(provider.lastScanAt ?? '');
    return !Number.isFinite(at) || Date.now() - at > ttlMs;
  }

  /**
   * Scan one provider.
   *
   * A provider with no /models endpoint is not an error the user must fix: it
   * is reported honestly and the provider stays, ready for manual models.
   */
  /**
     * Scan one provider.
     *
     * A scan that is given a key proves nothing about whether the URL needs
     * one: /models answers 200 either way. Recording that as "no key needed"
     * would move Groq into the wrong drawer the first time the user pasted a
     * key into it. So the verdict is only drawn from an anonymous scan, and a
     * keyed scan leaves the previous verdict untouched.
     */
  async scanProvider({ providerId, secret = null, force = false, onProgress } = {}) {
    const provider = await this.providers.get(providerId);
    if (!provider) return { providerId, ok: false, reason: 'NOT_FOUND' };

    if (provider.enabled === false) {
      return { providerId, ok: false, reason: 'DISABLED', models: 0 };
    }
    if (!force && !this.isStale(provider)) {
      return { providerId, ok: true, skipped: true, reason: 'FRESH', models: 0 };
    }

    const adapter = this.providers.adapterFor(provider);
    onProgress?.({ stage: 'discover', provider: provider.name });

    // A scan that was given a key proves nothing about whether the URL needs
    // one: /models answers 200 either way. Recording that as "no key needed"
    // would move Groq into the wrong drawer the first time the user pasted a
    // key into it. So the verdict is only drawn from an anonymous scan, and a
    // keyed scan leaves the previous verdict untouched.
    const anonymous = !secret;

    const result = await adapter.discoverModels({ secret });

    if (!result.ok) {
      // The scan is what proves whether this URL needs a key, so the verdict is
      // written here rather than inferred later from a stale `verified` field.
      // A 401/403 becomes REQUIRED; a 404, a timeout or a network failure stays
      // UNKNOWN, because "no key was sent" is not the same as "it wants a key".
      const keyRequirement = anonymous
        ? requirementFromDiscovery(result)
        : (provider.keyRequirement ?? KEY_REQ.UNKNOWN);
      await this.providers.update(providerId, {
        status: result.reason === 'TIMEOUT' ? 'TIMEOUT' : 'ERROR',
        lastError: result.error ?? null,
        ...(anonymous ? { keyRequirement, keyRequirementAt: isoNow() } : {}),
      });
      return {
        providerId,
        ok: false,
        reason: result.reason,
        keyRequirement,
        error: result.error,
        models: 0,
        latencyMs: result.latencyMs,
      };
    }

    // The whole catalog goes through one call, not one call per model.
    //
    // Every `put` on IndexedDB is its own transaction, so recording a large
    // catalog model by model opened a transaction per model - measured at ~200ms
    // of pure transaction overhead across a 12-URL registry, with the HTTP call
    // itself being the cheap part. `applyScan` reads the stored models once,
    // merges in memory and commits once.
    const discovered = result.models.map((model) => {
      const verdict = adapter.detectFree(model);
      return {
        providerId,
        modelId: model.modelId,
        displayName: model.displayName,
        pricing: model.pricing,
        pricingSource: model.pricingSource ?? null,
        evidence: verdict.evidence,
        metadata: model.metadata,
      };
    });

    const applied = await this.models.applyScan(providerId, discovered);

    // A 200 on /models is the proof that no key is needed to list this URL's
    // models, so it is recorded rather than left to be re-derived every render.
    await this.providers.update(providerId, {
      status: 'OK',
      lastScanAt: isoNow(),
      lastError: null,
      lastScanMs: result.latencyMs ?? null,
      ...(anonymous ? { keyRequirement: KEY_REQ.NONE, keyRequirementAt: isoNow() } : {}),
    });

    // One line per scan, for the activity log. A scan is the one routine action
    // whose outcome somebody later wants to explain ("why is this model NOT_SEEN
    // again"), so it is recorded; the per-model work above is not, or the log
    // would be unreadable.
    await this.events?.record({
      kind: 'scan',
      providerId,
      payload: {
        total: discovered.length,
        added: applied.added,
        merged: applied.merged,
        notSeen: applied.notSeen,
        latencyMs: result.latencyMs ?? null,
      },
    });

    return {
      providerId,
      ok: true,
      reason: 'OK',
      keyRequirement: anonymous ? KEY_REQ.NONE : (provider.keyRequirement ?? KEY_REQ.UNKNOWN),
      total: discovered.length,
      added: applied.added,
      merged: applied.merged,
      // Counted from what was actually stored, not from a second pass of the
      // detector over the raw catalog: the two could disagree, and the number
      // the user reads has to be the number of rows the drawer will show.
      free: (await this.models.list(providerId)).filter((m) => m.freeStatus !== 'PAID').length,
      notSeen: applied.notSeen,
      deactivated: applied.deactivated,
      latencyMs: result.latencyMs,
    };
  }

  /**
   * Scan every provider. Providers are independent hosts, so they run in
   * parallel under a concurrency cap rather than one after another.
   */
  async scanAll({ force = false, secretFor = () => null, onProgress, run } = {}) {
    const providers = (await this.providers.list()).filter((p) => p.enabled !== false);
    const summary = {
      providers: 0,
      skipped: 0,
      failed: 0,
      added: 0,
      merged: 0,
      notSeen: 0,
      results: [],
      cancelled: false,
    };

    await mapWithConcurrency(
      providers,
      CONFIG.scanConcurrency,
      async (provider, index) => {
        if (run?.cancelled()) {
          summary.cancelled = true;
          return;
        }
        onProgress?.({
          stage: 'scan',
          provider: provider.name,
          position: index + 1,
          total: providers.length,
        });

        const result = await this.scanProvider({
          providerId: provider.id,
          secret: secretFor(provider),
          force,
        });
        summary.results.push(result);

        if (result.skipped) summary.skipped += 1;
        else if (result.ok) {
          summary.providers += 1;
          summary.added += result.added;
          summary.merged += result.merged;
          summary.notSeen += result.notSeen ?? 0;
        } else {
          summary.failed += 1;
        }
      }
    );

    return summary;
  }
}

export { isoNow };
