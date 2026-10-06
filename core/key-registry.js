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
    const all = await this.storage.list('keys');
    return providerId ? all.filter((k) => k.providerId === providerId) : all;
  }

  async get(id) {
    return this.storage.get('keys', id);
  }

  async findByFingerprint(providerId, fingerprint) {
    const all = await this.list(providerId);
    return all.find((k) => k.fingerprint === fingerprint) ?? null;
  }

  /** Has the user deleted this key for this provider? */
  async isDeleted(providerId, fingerprint) {
    const store = await this.storage.list('deletedKeys');
    return store.some((d) => d.identity === `${providerId}::${fingerprint}`);
  }

  async listDeleted(providerId = null) {
    const all = await this.storage.list('deletedKeys');
    return providerId ? all.filter((d) => d.providerId === providerId) : all;
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

    const mappings = await this.storage.list('mappings');
    for (const mapping of mappings.filter((m) => m.keyId === id)) {
      await this.storage.remove('mappings', mapping.id);
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
    const store = await this.storage.list('deletedKeys');
    const record = store.find((d) => d.identity === `${providerId}::${fingerprint}`);
    if (!record) return { key: null, reason: 'NOT_DELETED' };

    for (const row of store.filter((d) => d.identity === record.identity)) {
      await this.storage.remove('deletedKeys', row.id);
    }
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
    const record = {
      id: makeId('unr'),
      kind: 'KEY',
      fingerprint,
      masked: maskSecret(trimmed),
      secret: trimmed,
      hint,
      raw: trimmed,
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
