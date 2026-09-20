/**
 * @fileoverview Bounds a `withRetry` ladder against a single wall-clock budget and
 * normalizes what an exhausted budget looks like to the caller. Shared by the
 * catalog and text services so the caller-cancel passthrough rule is written once.
 * @module services/upstream-deadline
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';

/**
 * Error codes `withRetry` treats as transient. An `McpError` carrying one of
 * these reached the catch because the ladder kept retrying and gave up (or
 * refused a `Retry-After` longer than its cap) — an upstream outage. Anything
 * else (a 404 translated to a domain reason, a parse failure) is a real result
 * the deadline has no business relabelling, so it is rethrown untouched.
 */
const TRANSIENT_CODES: ReadonlySet<number> = new Set([
  JsonRpcErrorCode.ServiceUnavailable,
  JsonRpcErrorCode.Timeout,
  JsonRpcErrorCode.RateLimited,
]);

/** How an exhausted ladder is reported to the client. */
export interface UpstreamDeadlineOptions {
  /** Wall-clock ceiling for the whole ladder, in milliseconds. */
  budgetMs: number;
  /**
   * Client-facing message. Must name the upstream or the record in domain terms —
   * never a resolved request URL or a configured base URL, both of which are
   * operator-owned and overridable to a self-hosted instance.
   */
  message: string;
  /** Contract reason the calling tools declare for this upstream's outage. */
  reason: string;
}

/**
 * Runs an upstream ladder under a shared deadline and normalizes its failure.
 *
 * `RetryOptions` has carried its own `deadlineMs` since framework 0.13.4, so the
 * budget alone is no longer what this helper is for: it also composes the budget
 * with `ctx.signal` into the one signal the ladder and the fetch share, and
 * normalizes an exhausted ladder onto the calling tool's declared contract
 * reason. The signal handed to `run` must be passed to **both**
 * `withRetry({ signal })` and `fetchWithTimeout(..., { signal })`, or the
 * deadline expires while the request it was meant to cancel keeps running.
 *
 * A caller cancel is rethrown unchanged: it is not an upstream outage, and
 * relabelling it would advertise a retry that cannot help.
 */
export async function withUpstreamDeadline<T>(
  ctx: Context,
  { budgetMs, message, reason }: UpstreamDeadlineOptions,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const deadline = new AbortController();
  /**
   * Abort with a held exception rather than a string: `fetch` and `withRetry`'s
   * `sleep` both reject with the reason *value*, and holding the instance lets a
   * caller identity-match this deadline's abort against any other reason the
   * runtime or the client might deliver.
   */
  const deadlineReason = new DOMException(
    `Upstream budget of ${budgetMs}ms elapsed.`,
    'TimeoutError',
  );
  const timer = setTimeout(() => deadline.abort(deadlineReason), budgetMs);

  try {
    return await run(AbortSignal.any([deadline.signal, ctx.signal]));
  } catch (err: unknown) {
    if (ctx.signal.aborted) throw err;
    const exhausted =
      deadline.signal.aborted || (err instanceof McpError && TRANSIENT_CODES.has(err.code));
    if (!exhausted) throw err;
    throw serviceUnavailable(message, { reason, ...ctx.recoveryFor(reason) }, { cause: err });
  } finally {
    clearTimeout(timer);
  }
}
