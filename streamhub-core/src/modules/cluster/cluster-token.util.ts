/**
 * STREAMHUB CLUSTER TOKEN — the constant-time `X-Cluster-Token` gate, factored
 * out so every node-facing endpoint checks the shared secret identically.
 *
 * Used by both the cluster registry (`ClusterController` — join/heartbeat) and
 * the GRID agent (`GridAgentController` — remote worker dispatch). Kept as pure
 * functions (no DI) so a controller only needs the resolved expected token and
 * the request.
 */
import {
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, timingSafeEqual } from 'crypto';
import type { Request } from 'express';

/**
 * Constant-time compare over SHA-256 digests (fixed length, no early-out). An
 * absent/empty `provided` never matches. The digests hide the token length and
 * keep the compare timing-independent of where the mismatch is.
 */
export function clusterTokenMatches(
  provided: string | undefined,
  expected: string,
): boolean {
  if (typeof provided !== 'string' || provided.length === 0) return false;
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * Enforce the `X-Cluster-Token` header against the configured cluster token.
 *   - `expected` unset      → 503 (the node-facing plane is disabled).
 *   - header wrong / absent → 401 (timing-safe compare).
 * The token itself is never logged. `disabledMessage` lets a caller phrase the
 * 503 for its own surface (join vs. grid agent).
 */
export function assertClusterToken(
  req: Request,
  expected: string,
  disabledMessage = 'cluster joining disabled (STREAMHUB_CLUSTER_TOKEN unset)',
  onInvalid?: () => void,
): void {
  if (!expected) {
    throw new ServiceUnavailableException({ error: disabledMessage });
  }
  const provided = req.header('x-cluster-token');
  if (!clusterTokenMatches(provided, expected)) {
    // Hook for the caller to feed the auto-ban (P1) before we reject — must
    // never throw. Runs only on a genuine mismatch, not on the 503 path.
    onInvalid?.();
    throw new UnauthorizedException({ error: 'invalid cluster token' });
  }
}
