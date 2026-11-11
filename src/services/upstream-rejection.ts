/**
 * @fileoverview The one rule for which upstream statuses are permanent refusals,
 * shared by the catalog and text services so both classify a refusal the same way.
 * @module services/upstream-rejection
 */

/**
 * A status the upstream answers the same way however often it is asked: any 4xx but a
 * timeout or a rate limit, and 501, which would otherwise read as a retryable outage.
 */
export function isRejection(status: number): boolean {
  return (status >= 400 && status < 500 && status !== 408 && status !== 429) || status === 501;
}
