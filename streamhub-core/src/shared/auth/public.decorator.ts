import { SetMetadata } from '@nestjs/common';

/** Metadata key marking a route as not requiring a Bearer token. */
export const IS_PUBLIC_KEY = 'streamhub:isPublic';

/**
 * Mark a controller or handler as public (no auth). Used by StreamHubAuthGuard to
 * skip token checks (e.g. /health, player assets, webhooks with own signature).
 */
export const Public = (): MethodDecorator & ClassDecorator =>
  SetMetadata(IS_PUBLIC_KEY, true);
