/**
 * @fileoverview Tests for withUpstreamDeadline — the shared ladder budget and the
 * single normalizing catch that decides what an exhausted upstream, a non-transient
 * upstream result, and a caller cancel each look like to the client.
 * @module tests/services/upstream-deadline.test
 */

import { JsonRpcErrorCode, McpError, notFound, timeout } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { gutenbergSearchBooks } from '@/mcp-server/tools/definitions/gutenberg-search-books.tool.js';
import { withUpstreamDeadline } from '@/services/upstream-deadline.js';

const BUDGET_MS = 15_000;

const OPTIONS = {
  budgetMs: BUDGET_MS,
  message: 'The Project Gutenberg catalog did not respond.',
  reason: 'catalog_unavailable',
};

/**
 * Stands in for an upstream that accepts the request and never answers, rejecting
 * with the abort reason the runtime delivers — the same shape `fetch` produces.
 */
function stall(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('withUpstreamDeadline — success', () => {
  it('returns the value and leaves no timer armed', async () => {
    vi.useFakeTimers();
    const ctx = createMockContext({ errors: gutenbergSearchBooks.errors });

    await expect(withUpstreamDeadline(ctx, OPTIONS, async () => 'page')).resolves.toBe('page');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('hands the run a signal that is not yet aborted', async () => {
    const ctx = createMockContext({ errors: gutenbergSearchBooks.errors });
    let seen: AbortSignal | undefined;

    await withUpstreamDeadline(ctx, OPTIONS, async (signal) => {
      seen = signal;
      return 'page';
    });

    expect(seen?.aborted).toBe(false);
  });
});

describe('withUpstreamDeadline — budget', () => {
  it('aborts the run at the budget and normalizes to a ServiceUnavailable with recovery', async () => {
    vi.useFakeTimers();
    const ctx = createMockContext({ errors: gutenbergSearchBooks.errors });
    const pending = withUpstreamDeadline(ctx, OPTIONS, stall).catch((e: unknown) => e);

    // One tick short of the budget the ladder is still running.
    await vi.advanceTimersByTimeAsync(BUDGET_MS - 1);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    const err = (await pending) as McpError;

    expect(err).toBeInstanceOf(McpError);
    expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(err.data).toMatchObject({
      reason: 'catalog_unavailable',
      recovery: { hint: expect.any(String) },
    });
  });

  it('marks a budget abort as an abort, not an exhausted ladder', async () => {
    vi.useFakeTimers();
    const ctx = createMockContext({ errors: gutenbergSearchBooks.errors });
    const pending = withUpstreamDeadline(ctx, OPTIONS, stall).catch((e: unknown) => e);

    await vi.advanceTimersByTimeAsync(BUDGET_MS);
    const err = (await pending) as McpError;

    // `enrichExhaustedError` never ran, so neither of its markers is present —
    // this failure is the budget firing, not the retry ladder giving up.
    expect(err.data).not.toHaveProperty('retryAttempts');
    expect(err.message).not.toContain('failed after');
  });

  it('clears the budget timer once the run settles', async () => {
    vi.useFakeTimers();
    const ctx = createMockContext({ errors: gutenbergSearchBooks.errors });

    await withUpstreamDeadline(ctx, OPTIONS, async () => 'page');
    await expect(
      withUpstreamDeadline(ctx, OPTIONS, () => Promise.reject(notFound('missing'))),
    ).rejects.toThrow();

    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('withUpstreamDeadline — classification', () => {
  it('normalizes an exhausted transient ladder, preserving the original as cause', async () => {
    const ctx = createMockContext({ errors: gutenbergSearchBooks.errors });
    const exhausted = timeout(
      'fetch GET https://gutendex.com/books/ timed out. (failed after 4 attempts)',
      {
        retryAttempts: 4,
      },
    );

    const err = (await withUpstreamDeadline(ctx, OPTIONS, () => Promise.reject(exhausted)).catch(
      (e: unknown) => e,
    )) as McpError;

    expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(err.data).toMatchObject({ reason: 'catalog_unavailable' });
    expect(err.message).toBe(OPTIONS.message);
    expect(err.cause).toBe(exhausted);
  });

  it('leaves a non-transient upstream result untouched', async () => {
    const ctx = createMockContext({ errors: gutenbergSearchBooks.errors });
    const outOfRange = notFound('The requested page is beyond the available result range.', {
      reason: 'page_out_of_range',
    });

    const err = await withUpstreamDeadline(ctx, OPTIONS, () => Promise.reject(outOfRange)).catch(
      (e: unknown) => e,
    );

    expect(err).toBe(outOfRange);
  });

  it('leaves a non-McpError throw untouched', async () => {
    const ctx = createMockContext({ errors: gutenbergSearchBooks.errors });
    const parseFailure = new SyntaxError('Unexpected token < in JSON at position 0');

    const err = await withUpstreamDeadline(ctx, OPTIONS, () => Promise.reject(parseFailure)).catch(
      (e: unknown) => e,
    );

    expect(err).toBe(parseFailure);
  });

  it('omits the recovery hint when the calling tool declares no matching reason', async () => {
    // A bare mock context has the always-`{}` resolver — the same thing a tool
    // that never declared the reason would give the service at runtime.
    const ctx = createMockContext();

    const err = (await withUpstreamDeadline(ctx, OPTIONS, () =>
      Promise.reject(timeout('upstream stalled')),
    ).catch((e: unknown) => e)) as McpError;

    expect(err.data).toMatchObject({ reason: 'catalog_unavailable' });
    expect(err.data).not.toHaveProperty('recovery');
  });
});

describe('withUpstreamDeadline — caller cancel', () => {
  it('rethrows a mid-run cancel unchanged rather than reporting an outage', async () => {
    const controller = new AbortController();
    const ctx = createMockContext({
      errors: gutenbergSearchBooks.errors,
      signal: controller.signal,
    });

    const pending = withUpstreamDeadline(ctx, OPTIONS, stall).catch((e: unknown) => e);
    controller.abort();
    const err = await pending;

    expect(err).not.toBeInstanceOf(McpError);
    expect(err).toBe(controller.signal.reason);
  });

  it('rethrows a cancel whose reason is a bare string, the shape notifications/cancelled produces', async () => {
    const controller = new AbortController();
    const ctx = createMockContext({
      errors: gutenbergSearchBooks.errors,
      signal: controller.signal,
    });

    const pending = withUpstreamDeadline(ctx, OPTIONS, stall).catch((e: unknown) => e);
    controller.abort('client gave up');
    const err = await pending;

    expect(err).toBe('client gave up');
  });

  it('rethrows a cancel unchanged even when the run raises a transient error', async () => {
    const controller = new AbortController();
    const ctx = createMockContext({
      errors: gutenbergSearchBooks.errors,
      signal: controller.signal,
    });
    const upstream = timeout('fetch timed out');

    const err = await withUpstreamDeadline(ctx, OPTIONS, async () => {
      controller.abort('client gave up');
      throw upstream;
    }).catch((e: unknown) => e);

    expect(err).toBe(upstream);
    expect((err as McpError).data).not.toMatchObject({ reason: 'catalog_unavailable' });
  });
});
