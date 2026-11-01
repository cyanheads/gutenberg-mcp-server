/**
 * @fileoverview Await cache writes without failing an otherwise successful read.
 * @module services/best-effort-cache
 */
import type { Context } from '@cyanheads/mcp-ts-core';

/** Failed writes preserve caller cancellation and disclose only the safe cache key. */
export async function bestEffortCache(
  ctx: Context,
  cacheKey: string,
  value: unknown,
  ttlSeconds: number,
): Promise<void> {
  try {
    await ctx.state.set(cacheKey, value, { ttl: ttlSeconds });
  } catch (error) {
    if (ctx.signal.aborted) throw error;
    ctx.log.warning('Cache write failed', { cacheKey });
  }
}
