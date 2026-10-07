/**
 * Key registry (plan 10, 11).
 *
 * A key belongs to a URL, never to a model: one secret serves every model that
 * URL lists. Storage keeps it once, and the model x key status lives in the
 * separate mappings table.
 *
 * Two guarantees this file is responsible for:
 *   - no duplicates, enforced on a SHA-256 fingerprint rather than the string
 *   - a deleted key stays deleted, even if the user pastes it again, while an
 *     explicit restore brings it back
 */

import { STATUS } from './statuses.js';
import { fingerprintSecret, isoNow, makeId, maskSecret } from './util.js';

export class KeyRegistry {
  constructor(storage) {
    this.storage = storage;
  }

  async list(providerId = null) {
    return providerId ? this.storage.findMany('keys', { where: { providerId } }) : this.storage.list('keys');
  }

  async get(id) {
    return this.storage.get('keys', id);
  }

  /**
   * The same secret on the same URL is one key.
   *
   * Asked of the unique index `by_provider_fingerprint`, so it does not matter
   * how many keys the machine holds.
   */
  async findByFingerprint(providerId, fingerprint) {
    return this.storage.find('keys', { providerId, fingerprint });
  }

  /** Has the user deleted this key for this provider? */
  async isDeleted(providerId, fingerprint) {
    const row = await this.storage.find('deletedKeys', { identity: `${providerId}::${fingerprint}` });
    return row !== null;
  }

  async listDeleted(providerId = null) {
    return providerId
      ? this.storage.findMany('deletedKeys', { where: { providerId } })
      : this.storage.list('deletedKeys');
  }

  /**
   * Add a key to a URL.
   *
   * Returns a reason instead of throwing on every rejection, because each one
   * is a normal thing for the user to do and each needs its own message.
   */
  async add({ providerId, secret }) {
    const trimmed = String(secret ?? '').trim();
    if (!trimmed) return { key: null, created: false, reason: 'EMPTY' };

    const fingerprint = await fingerprintSecret(trimmed);

    // A key the user deleted must not come back just because it was pasted
    // again - otherwise the delete button looks broken.
    if (await this.isDeleted(providerId, fingerprint)) {
      return { key: null, created: false, reason: 'BLOCKED', fingerprint };
    }

    const existing = await this.findByFingerprint(providerId, fingerprint);
    if (existing) return { key: existing, created: false, reason: 'DUPLICATE' };

    const key = {
      id: makeId('key'),
      providerId,
      fingerprint,
      masked: maskSecret(trimmed),
      secret: trimmed,
      enabled: true,
      status: STATUS.UNTESTED,
      verifiedModelId: null,
      lastCheckedAt: null,
      lastSuccessAt: null,
      lastError: null,
      createdAt: isoNow(),
      updatedAt: isoNow(),
    };
    await this.storage.put('keys', key);
    return { key, created: true };
  }

  async update(id, patch) {
    const key = await this.get(id);
    if (!key) return null;
    const updated = { ...key, ...patch, updatedAt: isoNow() };
    await this.storage.put('keys', updated);
    return updated;
  }

  /** Remove a key and remember it, so re-pasting does not resurrect it. */
  async remove(id) {
    const key = await this.get(id);
    if (!key) return false;

    // The mappings are found through the index rather than by reading every
    // verdict on the machine, then dropped in one batch.
    const mappings = await this.storage.findMany('mappings', { where: { keyId: id } });
    if (mappings.length) {
      await this.storage.removeMany('mappings', mappings.map((m) => m.id));
    }
    await this.storage.remove('keys', id);

    // Only the non-reversible fingerprint is kept, never the secret.
    await this.storage.put('deletedKeys', {
      id: makeId('del'),
      identity: `${key.providerId}::${key.fingerprint}`,
      providerId: key.providerId,
      fingerprint: key.fingerprint,
      masked: key.masked,
      deletedAt: isoNow(),
    });
    return true;
  }

  /** Undo a delete. This is the only path that brings a key back. */
  async restore(providerId, secret) {
    const trimmed = String(secret ?? '').trim();
    const fingerprint = await fingerprintSecret(trimmed);
    const record = await this.storage.find('deletedKeys', { identity: `${providerId}::${fingerprint}` });
    if (!record) return { key: null, reason: 'NOT_DELETED' };

    // The identity is unique, so this is one row. Removing by identity rather
    // than by the remembered id means a tombstone written by an older version
    // - with a different id - is cleared too, and the key really comes back.
    await this.storage.removeMany(
      'deletedKeys',
      (await this.storage.findMany('deletedKeys', { where: { identity: record.identity } })).map((r) => r.id)
    );
    return this.add({ providerId, secret: trimmed });
  }

  /**
   * Keys that were pasted without a known provider (plan 11).
   *
   * A key prefix is a hint, never a conclusion, so this parks the secret
   * instead of guessing which URL it belongs to.
   */
  async park({ secret, hint = null }) {
    const trimmed = String(secret ?? '').trim();
    if (!trimmed) return null;
    const fingerprint = await fingerprintSecret(trimmed);
    // The secret is stored once. It used to be written a second time as `raw`,
    // which was the same string in the same row: two copies of a credential on
    // disk, one more place for a leak to come from, and nothing ever read it.
    const record = {
      id: makeId('unr'),
      kind: 'KEY',
      fingerprint,
      masked: maskSecret(trimmed),
      secret: trimmed,
      hint,
      createdAt: isoNow(),
    };
    await this.storage.put('unresolved', record);
    return record;
  }

  async listUnresolved() {
    return this.storage.list('unresolved');
  }

  async dropUnresolved(id) {
    await this.storage.remove('unresolved', id);
  }
}
