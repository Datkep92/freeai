/**
 * Rotation priority (plan 30, 31).
 *
 * Which free model answers the next request is decided here, and the user's
 * decisions are stored separately from any measurement so neither can silently
 * overwrite the other.
 *
 * Four separate ideas, kept apart on purpose:
 *
 *   skipped  - "leave this out of the rotation entirely". A lock is a skip, not
 *              a promotion: locking a slow model must not make it run first.
 *   order    - "try these in this sequence". Written by dragging. It overrides
 *              the automatic order for the ids the user actually moved, and
 *              leaves every other id to sort on its own merits.
 *   rotation - which rule fills the rest of the list: fastest first, the order
 *              the user set, or spread load round-robin.
 *   perUrl   - the same settings again, for one URL, which overrides the global
 *              ones for that URL only.
 *
 * The reason "lock = skip" matters: a lock that also promoted would make the
 * rotation start with exactly the models the user was trying to keep out of it.
 * And the reason order is a sparse list rather than a full sequence matters: if
 * every id were stored, a model discovered by the next scan would be frozen at
 * the end forever instead of sorting by its own speed.
 */

/** Scopes. A scope owns one ordering; ids never collide across scopes. */
export const SCOPE = {
  PROVIDER: 'provider',
  MODEL: 'model',
  KEY: 'key',
};

/**
 * How the rotation fills the list once the skipped ids and the dragged ids are
 * out of the way.
 *
 * SPEED is the default: the app's whole claim is "use free models", and among
 * free models the one that answers fastest is the one worth using.
 */
export const ROTATION = {
  SPEED: 'SPEED',
  // Only what the user dragged, in the order they dragged it.
  MANUAL: 'MANUAL',
  // Least recently used first, so load spreads instead of hammering one key.
  ROUND_ROBIN: 'ROUND_ROBIN',
};

/**
 * The hierarchy, lowest level first.
 *
 * Order matters twice: it is the order the UI opens in for a manual unlock, and
 * it is the order an inherited lock is reported in.
 */
export const LEVELS = ['key', 'model', 'provider'];

/** What sits under each level, used to cascade an explicit unlock. */
const LEVELS_BELOW = {
  key: [],
  model: ['key'],
  provider: ['model', 'key'],
};

function scopeForLevel(level) {
  if (level === 'provider') return SCOPE.PROVIDER;
  if (level === 'model') return SCOPE.MODEL;
  if (level === 'key') return SCOPE.KEY;
  return null;
}

export const SETTINGS_ID = 'priority';

/** Global settings. Per-URL settings live on the provider row. */
export function defaultPriority() {
  return {
    id: SETTINGS_ID,
    rotation: ROTATION.SPEED,
    skipped: { [SCOPE.PROVIDER]: [], [SCOPE.MODEL]: [], [SCOPE.KEY]: [] },
    order: { [SCOPE.PROVIDER]: [], [SCOPE.MODEL]: [], [SCOPE.KEY]: [] },
    updatedAt: null,
  };
}

/** Per-URL settings. Absent keys mean "fall back to the global setting". */
export function defaultUrlPriority() {
  return {
    rotation: null,
    skipped: null,
    order: null,
  };
}

export class Priority {
  constructor(storage) {
    this.storage = storage;
  }

  async load() {
    const stored = await this.storage.get('settings', SETTINGS_ID);
    if (!stored) return defaultPriority();

    // Merged per scope: a hand-edited or older row must not leave a scope
    // undefined and crash a sort.
    const base = defaultPriority();
    return {
      ...base,
      ...stored,
      skipped: { ...base.skipped, ...(stored.skipped ?? {}) },
      order: { ...base.order, ...(stored.order ?? {}) },
    };
  }

  async save(state) {
    const row = { ...state, updatedAt: new Date().toISOString() };
    await this.storage.put('settings', row);
    return row;
  }

  /**
   * Lock or unlock one id.
   *
   * Locking is a skip. Unlocking removes the id from the skip list only - it is
   * deliberately left in the manual order, because "stop skipping it" does not
   * mean "forget where I put it".
   */
  async setSkipped(scope, id, skipped = true) {
    const state = await this.load();
    const list = [...(state.skipped[scope] ?? [])];
    const next = skipped
      ? (list.includes(id) ? list : [...list, id])
      : list.filter((x) => x !== id);
    state.skipped[scope] = next;
    return this.save(state);
  }

  /**
   * Lock or unlock one row, cascading by level.
   *
   * The levels are key < model < URL. Locking a level means everything under it
   * stops being used, and the cheapest correct way to express that is to lock
   * the level itself rather than writing a lock onto every descendant: one row
   * stays true even after something new is added underneath it.
   *
   * So locking a URL covers every model and key on it without touching their
   * rows - the lock is inherited, not copied. That is what keeps "khoá URL" from
   * needing to be redone after the next scan discovers a new model.
   *
   * Unlocking does NOT cascade the same way. Unlocking a URL only clears the
   * URL, because a model the user locked deliberately should stay locked;
   * anything that was only locked because its parent was becomes usable again,
   * which is the point of computing inheritance rather than writing locks down.
   *
   * `exclusive` is what the UI calls for a manual unlock by level: clear this
   * level and reopen everything below it, lowest level first, so the user gets a
   * fully working subtree instead of one level reopened and the rest still
   * blocked by an inherited lock.
   *
   * A cascade is bounded by the subtree it belongs to, and `descendants` is
   * what supplies that bound. Blanking every lock below the level instead would
   * mean opening one URL in the drawer silently reopened a model the user had
   * locked on a completely different URL - the kind of change that is never
   * noticed until a request goes somewhere it should not have.
   *
   * When `descendants` is absent there is nothing provably inside this
   * subtree, so nothing below is touched. Unlocking then clears only the level
   * that was tapped, and inherited locks above still apply - which is honest
   * rather than silently doing too much.
   */
  async setLocked({ level, id, locked, exclusive = false, descendants = null }) {
    const state = await this.load();
    const scope = scopeForLevel(level);
    if (!scope) return state;

    const current = new Set(state.skipped[scope] ?? []);
    if (locked) current.add(id);
    else current.delete(id);
    state.skipped[scope] = [...current];

    if (!locked && exclusive && descendants) {
      const below = LEVELS_BELOW[level] ?? [];
      for (const child of below) {
        const childScope = scopeForLevel(child);
        if (!childScope) continue;
        const inside = descendants[child] ?? [];
        if (!inside.length) continue;
        const owned = new Set(inside);
        // Only ids that actually belong to this subtree are released. Anything
        // else in the same scope belongs to another URL and stays locked.
        state.skipped[childScope] = (state.skipped[childScope] ?? []).filter((x) => !owned.has(x));
      }
    }

    return this.save(state);
  }

  /** Is this row locked, counting a lock inherited from the level above? */
  async isLocked({ level, id, providerLocked = false }) {
    if (providerLocked) return true;
    const state = await this.load();
    const scope = scopeForLevel(level);
    if (!scope) return false;
    return (state.skipped[scope] ?? []).includes(id);
  }

  async isSkipped(scope, id) {
    const state = await this.load();
    return (state.skipped[scope] ?? []).includes(id);
  }

  async toggleSkipped(scope, id) {
    const nowSkipped = !(await this.isSkipped(scope, id));
    await this.setSkipped(scope, id, nowSkipped);
    return nowSkipped;
  }

  /** Store the order for a scope, as a list of ids the user arranged. */
  async setOrder(scope, ids) {
    const state = await this.load();
    state.order[scope] = [...ids];
    return this.save(state);
  }

  async orderFor(scope) {
    const state = await this.load();
    return state.order[scope] ?? [];
  }

  /**
   * Move one id to a new index.
   *
   * The id is appended when it is not in the list yet, so dragging something
   * that has never been ordered inserts it rather than doing nothing.
   */
  async move(scope, id, toIndex) {
    const state = await this.load();
    const list = [...(state.order[scope] ?? [])];
    const from = list.indexOf(id);
    if (from !== -1) list.splice(from, 1);
    list.splice(Math.max(0, Math.min(toIndex, list.length)), 0, id);
    state.order[scope] = list;
    return this.save(state);
  }

  async setRotation(rotation) {
    const state = await this.load();
    if (!Object.values(ROTATION).includes(rotation)) return state;
    state.rotation = rotation;
    return this.save(state);
  }

  // ------------------------------------------------------- per-URL settings

  /**
   * Settings for one URL, with the global values filled in behind it.
   *
   * Returning a merged view rather than the raw row means the router and the UI
   * can ask one question - "what applies here" - and never have to know whether
   * an override exists.
   */
  async forProvider(provider) {
    const global = await this.load();
    const local = provider?.priority ?? null;

    const pick = (field, scope) => {
      const globalValue = global[field]?.[scope] ?? [];
      if (!local) return globalValue;

      const localValue = local[field];
      // null means "no override here", which falls back to global.
      if (localValue === null || localValue === undefined) return globalValue;

      // Per-URL settings may hold either a plain array or an object keyed by
      // kind. Only the models key is read as a skip list here; anything else is
      // not an array and must not reach a Set constructor.
      if (Array.isArray(localValue)) return localValue;
      if (typeof localValue === 'object') {
        const keyed = scope === SCOPE.MODEL ? localValue.models : localValue.keys;
        return Array.isArray(keyed) ? keyed : [];
      }
      return globalValue;
    };

    const rotation = local?.rotation ?? global.rotation;
    // A model id can appear on several URLs, so the per-URL skip list is
    // stored as model ids rather than row ids to stay readable, and the caller
    // matches on either.
    const skipped = new Set([
      ...(global.skipped?.[SCOPE.MODEL] ?? []),
      ...pick('skipped', SCOPE.MODEL),
    ]);

    return {
      rotation,
      skippedModels: skipped,
      skippedKeys: new Set(pick('skipped', SCOPE.KEY)),
      orderModels: pick('order', SCOPE.MODEL),
      orderKeys: pick('order', SCOPE.KEY),
      isGlobal: !local,
    };
  }

  /**
   * Save one URL's overrides.
   *
   * Only the fields the user actually set are stored. Passing null clears the
   * override so the global value applies again, which is why a merge against
   * the existing row is needed rather than a replacement.
   */
  async setProviderPriority(providerId, patch) {
    const providers = await this.storage.list('providers');
    const provider = providers.find((p) => p.id === providerId);
    if (!provider) return null;

    const current = provider.priority ?? defaultUrlPriority();
    const next = {
      rotation: patch.rotation !== undefined ? patch.rotation : current.rotation ?? null,
      skipped: patch.skipped !== undefined ? patch.skipped : current.skipped ?? null,
      order: patch.order !== undefined ? patch.order : current.order ?? null,
    };

    const updated = { ...provider, priority: next, updatedAt: new Date().toISOString() };
    await this.storage.put('providers', updated);
    return updated;
  }
}

/**
 * Order rows for display or for rotation.
 *
 * Pure, so the UI and the router order a list identically without either of
 * them reading storage - reading a stored order is async and a comparator
 * cannot be.
 *
 * Precedence, highest first:
 *   1. locked ids are removed entirely (the caller keeps them visible)
 *   2. ids the user dragged, in the order they were dragged
 *   3. the rotation rule: fastest first, or as-is
 *   4. the caller's own comparator
 */
export function sortByPriority(
  rows,
  { skipped = new Set(), order = [], rotation = ROTATION.SPEED, metrics = new Map(), scope, fallback = null, idOf = null, metricKeyOf = null } = {}
) {
  const orderIndex = new Map(order.map((id, i) => [id, i]));

  // `idOf` lets a caller sort something that is not a stored row. The router
  // ranks { mapping, model, key } candidates, not model rows, so without this
  // it would look up an id that does not exist and every dragged position
  // would be ignored - the list would be ordered by hand and the router would
  // not be.
  const identify = idOf ?? ((row) => rowId(row, scope));
  const metricKey = metricKeyOf ?? ((row) => keyFor(row, scope));

  const decorated = rows.map((row, i) => ({ row, i }));
  decorated.sort((a, b) => {
    const idA = identify(a.row);
    const idB = identify(b.row);

    const ordA = orderIndex.get(idA);
    const ordB = orderIndex.get(idB);
    // A dragged id outranks an undragged one. This is the override: the user
    // decides, and speed only fills the gaps.
    if (ordA !== undefined || ordB !== undefined) {
      if (ordA === undefined) return 1;
      if (ordB === undefined) return -1;
      return ordA - ordB;
    }

    if (rotation === ROTATION.SPEED) {
      const speedA = speedOf(metrics.get(metricKey(a.row)));
      const speedB = speedOf(metrics.get(metricKey(b.row)));
      if (speedA !== speedB) return speedB - speedA;
    }

    if (fallback) {
      const verdict = fallback(a.row, b.row);
      if (verdict !== 0) return verdict;
    }
    return a.i - b.i; // stable
  });

  return decorated.map((d) => d.row);
}

/** Split a list into what rotation may use and what the user locked out. */
export function partitionByLock(rows, { skipped = new Set(), scope } = {}) {
  const free = [];
  const locked = [];
  for (const row of rows) {
    const id = rowId(row, scope);
    // A model is matched by either its row id or its model id, because a
    // per-URL skip list is written in model ids.
    const key = keyFor(row, scope);
    if (skipped.has(id) || skipped.has(key) || skipped.has(row.modelId)) locked.push(row);
    else free.push(row);
  }
  return { free, locked };
}

/**
 * Speed score used to rank models.
 *
 * Unmeasured models sort last rather than scoring zero: a model that has never
 * run is not slow, it is unknown, and ranking it as 0 tok/s would push every
 * genuinely fast model down behind it.
 */
export function speedOf(metrics) {
  if (!metrics || !metrics.samples) return -1;
  const speed = Number.isFinite(metrics.tokensPerSec) ? metrics.tokensPerSec / 10 : 0;
  // Time to first token matters on its own: a model that answers instantly at
  // 20 tok/s feels better than one that stalls for two seconds.
  const ttft = Number.isFinite(metrics.ttftMs) ? 1 / (1 + metrics.ttftMs / 1000) : 0;
  return Math.round((speed + ttft) * 100) / 100;
}

/**
 * Which id identifies a row in a scope.
 *
 * Models and keys are addressed by their own row id, but the same model id can
 * exist on two URLs. Callers that keep a per-URL list match on modelId as well,
 * which is why this returns the row id and `keyFor` returns the readable one.
 */
function rowId(row, scope) {
  if (scope === SCOPE.MODEL) return row.id ?? `${row.providerId}::${row.modelId}`;
  if (scope === SCOPE.KEY) return row.id ?? `${row.providerId}::${row.fingerprint}`;
  if (scope === SCOPE.PROVIDER) return row.id ?? row.builtinId ?? row.baseURL;
  return row.id ?? null;
}

/** The human-readable identity, used for per-URL lists written by hand. */
function keyFor(row, scope) {
  if (scope === SCOPE.MODEL) return row.modelId ?? row.id ?? null;
  if (scope === SCOPE.KEY) return row.fingerprint ?? row.id ?? null;
  if (scope === SCOPE.PROVIDER) return row.id ?? row.builtinId ?? null;
  return row.id ?? null;
}

export { keyFor as identityFor };
