/**
 * Status enums for mappings and keys.
 *
 * Kept in one place so the UI legend, the classifier and the router cannot
 * drift apart. Plain strings in core; emoji and Vietnamese live in the UI.
 */

export const STATUS = {
  HEALTHY: 'HEALTHY',
  UNTESTED: 'UNTESTED',
  RATE_LIMITED: 'RATE_LIMITED',
  QUOTA_EXHAUSTED: 'QUOTA_EXHAUSTED',
  AUTH_INVALID: 'AUTH_INVALID',
  EXPIRED: 'EXPIRED',
  MODEL_DENIED: 'MODEL_DENIED',
  MODEL_UNAVAILABLE: 'MODEL_UNAVAILABLE',
  PROVIDER_DOWN: 'PROVIDER_DOWN',
  TEMP_ERROR: 'TEMP_ERROR',
  REQUEST_ERROR: 'REQUEST_ERROR',
  UNKNOWN_ERROR: 'UNKNOWN_ERROR',
  DISABLED: 'DISABLED',
};

export const STATUS_META = {
  HEALTHY: { emoji: '🟢', label: 'Khỏe' },
  // Every colour is unique on purpose. Two statuses sharing one made "chưa thử"
  // and "lỗi mạng" - and "model bị chặn" and "model không tồn tại" - look
  // identical in the health list, which is the list people read to decide
  // what to fix.
  UNTESTED: { emoji: '⚪', label: 'Chưa thử' },
  RATE_LIMITED: { emoji: '🟠', label: 'Chờ' },
  QUOTA_EXHAUSTED: { emoji: '🟣', label: 'Hết quota' },
  AUTH_INVALID: { emoji: '🔴', label: 'Key sai' },
  EXPIRED: { emoji: '⬛', label: 'Hết hạn' },
  MODEL_DENIED: { emoji: '🟡', label: 'Model chặn' },
  MODEL_UNAVAILABLE: { emoji: '🟦', label: 'Model không có' },
  PROVIDER_DOWN: { emoji: '🚫', label: 'Server lỗi' },
  TEMP_ERROR: { emoji: '🟤', label: 'Lỗi tạm' },
  REQUEST_ERROR: { emoji: '⚫', label: 'Lỗi yêu cầu' },
  UNKNOWN_ERROR: { emoji: '🟧', label: 'Lỗi khác' },
  DISABLED: { emoji: '⏸️', label: 'Đã tắt' },
};

/** Self-healing: may become usable again on its own. */
export const TRANSIENT_STATUS = new Set([
  STATUS.RATE_LIMITED,
  STATUS.TEMP_ERROR,
  STATUS.PROVIDER_DOWN,
]);

/** Terminal: only an explicit user action retries these. */
export const TERMINAL_STATUS = new Set([
  STATUS.AUTH_INVALID,
  STATUS.EXPIRED,
  STATUS.QUOTA_EXHAUSTED,
]);

/**
 * Statuses that take a whole key out of rotation.
 *
 * MODEL_DENIED is deliberately absent: it disables one model x key pair and
 * never the key itself. A key that cannot run one model can still run others.
 */
export const KEY_BLOCKING_STATUS = new Set([
  STATUS.AUTH_INVALID,
  STATUS.EXPIRED,
  STATUS.QUOTA_EXHAUSTED,
  STATUS.DISABLED,
]);

export function statusMeta(status) {
  return STATUS_META[status] ?? { emoji: '⚪', label: String(status ?? '—') };
}
