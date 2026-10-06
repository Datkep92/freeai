/**
 * Thin re-export so a test can import the classifier without also reaching for
 * the status enum.
 */
export { classifyError as classifyErrorProbe } from '../core/error-classifier.js';
