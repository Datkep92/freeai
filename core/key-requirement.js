/**
 * Does this URL need an API key? (plan 1, 9)
 *
 * The drawer splits every URL into "không cần key" and "cần API key". That split
 * is the first question a new user has, so it must never be a guess. It is
 * derived from what a real request actually returned:
 *
 *   OPEN      - GET /models answered 200 with no key. The catalog is public,
 *               so a scan returns models right now.
 *   NEEDS_KEY - the endpoint is alive but answered 401/403. The URL works and
 *               is not broken; it is simply waiting for the user's key.
 *   UNKNOWN   - never probed, or the answer was 404/5xx/network. Neither
 *               verdict is proven, so it is filed separately instead of being
 *               counted as "needs a key".
 *   BROKEN    - probed and answered 404/5xx/network. These are the UNKNOWN set
 *               that has been actually probed, and are kept out of both proven
 *               lists so nobody taps a dead entry.
 *
 * Why UNKNOWN is not folded into NEEDS_KEY: a gateway added by hand that has
 * never been probed would land beside Groq and DeepSeek, and the drawer would
 * be claiming it needs a key when nobody has asked it yet. The distinction is
 * one HTTP status, and it is the difference between a fact and an assumption.
 *
 * The built-in `verified` field and `freeTier` are deliberately NOT consulted to
 * decide the group. `freeTier` answers "is this provider cheap", which is a
 * different question, and `verified` is a snapshot a live scan must be allowed
 * to correct. Both stay on the row for display; neither decides the group.
 */

/** The groups the drawer shows. */
export const KEY_REQ = {
  NONE: 'NONE',         // không cần key
  REQUIRED: 'REQUIRED', // cần API key
  UNKNOWN: 'UNKNOWN',   // chưa biết
};

export const KEY_REQ_META = {
  [KEY_REQ.NONE]: {
    title: 'không cần key',
    hint: 'GET /models trả 200 không cần key. Quét được ngay.',
    tag: 'quét ngay',
    tagClass: 'free',
  },
  [KEY_REQ.REQUIRED]: {
    title: 'cần API key',
    hint: 'URL còn sống nhưng chặn không có key. Dán key vào là dùng được.',
    tag: 'cần key',
    tagClass: 'needkey',
  },
  [KEY_REQ.UNKNOWN]: {
    title: 'chưa kiểm tra',
    hint: 'Chưa biết URL này cần key hay không. Bấm quét để xác định.',
    tag: 'chưa thử',
    tagClass: '',
  },
};

/** HTTP statuses that prove the endpoint exists but refuses an anonymous call. */
const REFUSAL_STATUS = new Set([401, 403]);

/**
 * Turn a discovery outcome into a requirement verdict.
 *
 * Takes the shape `discoverModels` already returns, so nothing new has to be
 * invented at the call site and the verdict cannot drift from the scan that
 * produced it.
 */
export function requirementFromDiscovery(result) {
  if (!result) return KEY_REQ.UNKNOWN;

  // A 200 is the only positive proof. Anything else is an absence of proof.
  if (result.ok) return KEY_REQ.NONE;

  // The reason carries the classified HTTP status, so 401 and 500 stay apart.
  const status = Number(String(result.reason ?? '').replace('HTTP_', ''));
  if (Number.isFinite(status) && REFUSAL_STATUS.has(status)) return KEY_REQ.REQUIRED;

  // 404, 5xx, TIMEOUT, NETWORK, BAD_SHAPE: alive or not, nobody proved it
  // wants a key. UNKNOWN says exactly that, so the URL stays out of both
  // proven lists instead of being mislabelled.
  return KEY_REQ.UNKNOWN;
}

/**
 * The verdict for a provider row.
 *
 * Reads the classification the last scan stored. `verified` is the older probe
 * snapshot, consulted only as a fallback for rows stored before the scanner
 * wrote a verdict of its own.
 */
export function requirementOf(provider) {
  if (!provider) return KEY_REQ.UNKNOWN;

  const stored = provider.keyRequirement;
  if (stored === KEY_REQ.NONE || stored === KEY_REQ.REQUIRED || stored === KEY_REQ.UNKNOWN) {
    return stored;
  }

  if (provider.verified === 'NEEDS_KEY') return KEY_REQ.REQUIRED;
  if (provider.verified === 'OPEN') return KEY_REQ.NONE;
  return KEY_REQ.UNKNOWN;
}

/** Split providers into the three drawer groups, order preserved. */
export function groupByRequirement(providers) {
  const groups = {
    [KEY_REQ.NONE]: [],
    [KEY_REQ.REQUIRED]: [],
    [KEY_REQ.UNKNOWN]: [],
  };
  for (const provider of providers) groups[requirementOf(provider)].push(provider);
  return groups;
}
