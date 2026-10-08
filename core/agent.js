/**
 * The chat session.
 *
 * One turn is: build the messages, hand them to the router, stream the answer
 * back. Nothing here knows about HTTP, providers or the DOM - the router owns
 * the fallback chain, and this owns the conversation and its budget.
 *
 * The budget is the reason this is a class and not a function. The app runs on
 * free quota, and the expensive failure is not one long answer - it is a long
 * conversation that nobody is counting. `spent` is summed from the usage the
 * provider itself reports and every turn is clamped to what is left, so the
 * session stops on its own instead of being stopped by a rejected request.
 *
 * Tools are not part of this file yet on purpose: the loop that feeds tool
 * results back needs the tool registry, and adding a half-loop now would be a
 * second place to change when it arrives.
 */

import { CONFIG } from './config.js';

/**
 * The standing instruction.
 *
 * Short, and it says the two things a model in this app must not do: invent
 * facts about a provider, and answer at length when a sentence will do.
 */
export const AGENT_SYSTEM = [
  'Bạn là trợ lý trong Free Model Hub — công cụ quản lý model AI miễn phí.',
  'Trả lời ngắn gọn, đúng trọng tâm, bằng tiếng Việt trừ khi người dùng dùng ngôn ngữ khác.',
  'Không bịa thông tin về model, URL hay API; nếu không chắc thì nói rõ là không chắc.',
].join(' ');

export class Agent {
  constructor(router, { maxTotalTokens = CONFIG.agent.maxTotalTokens, onEvent = null } = {}) {
    this.router = router;
    this.maxTotalTokens = maxTotalTokens;
    this.onEvent = onEvent;
    this.spent = 0;
  }

  /** Tokens left in this session, never negative. */
  get remaining() {
    return Math.max(0, this.maxTotalTokens - this.spent);
  }

  /**
   * The messages one call needs: the system line, the conversation so far, then
   * the new question. Plain {role, content} pairs, which is what every
   * OpenAI-compatible provider accepts.
   */
  static messagesFor(history, userText) {
    const messages = [{ role: 'system', content: AGENT_SYSTEM }];
    for (const m of history) {
      if (m?.role && typeof m.content === 'string') messages.push({ role: m.role, content: m.content });
    }
    messages.push({ role: 'user', content: userText });
    return messages;
  }

  /**
   * One streamed turn. Returns the router's result plus how much of the session
   * budget has been spent, so the UI can show it without reading a private.
   */
  async turn({
    history = [],
    userText,
    modelId = null,
    maxTokens = CONFIG.agent.maxTokensPerCall,
    onToken,
    // A caller that passes its own listener wins over the one given to the
    // constructor. Both exist because the constructor's listener outlives a
    // single turn and a caller's usually does not.
    onEvent = this.onEvent,
    run,
  } = {}) {
    if (this.remaining <= 0) {
      return { ok: false, reason: 'BUDGET_EXHAUSTED', spent: this.spent };
    }

    const messages = Agent.messagesFor(history, userText);
    const budgeted = Math.min(maxTokens, this.remaining);
    const result = await this.router.streamChat({
      messages,
      modelId,
      maxTokens: budgeted,
      onToken,
      onEvent,
      run,
    });

    // The provider's own count when it gives one, the clamp otherwise. Using the
    // clamp as a fallback keeps an under-reporting provider from making the
    // budget look untouched - the ceiling is what matters, not the number.
    const used = result?.usage?.total_tokens;
    this.spent += Number.isFinite(used) ? used : budgeted;

    return { ...result, spent: this.spent };
  }
}
