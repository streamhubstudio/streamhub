/**
 * MEDIAMTX INTERNAL HOOK SINK — the core side of the single-port :1935 RTMP
 * switch (features/rtmp-single-port.md). A front MediaMTX owns the public :1935
 * and calls these three loopback-only routes:
 *
 *  - POST internal/mediamtx/auth      → `authHTTPAddress`: allow/deny a publish.
 *  - POST internal/mediamtx/ready     → `runOnReady`: a publish became ready →
 *                                       arm the passthrough remux (PULL mode).
 *  - POST internal/mediamtx/notready  → `runOnNotReady`: publish ended → stop it.
 *
 * GUARD (defence in depth): every route requires BOTH (a) an internal peer —
 * loopback OR RFC1918/link-local, since under compose the mediamtx container
 * reaches core over the bridge network (source IP 172.x) — AND (b) the shared
 * `STREAMHUB_MEDIAMTX_HOOK_SECRET`, presented as the `X-MediaMTX-Secret` header
 * OR a `?secret=` query param (MediaMTX's `authHTTPAddress` cannot send custom
 * headers), constant-time compared. An unset secret DISABLES the routes (403) —
 * they must never run unguarded.
 *
 * `@Public()` bypasses the Bearer guard (like the LiveKit webhook sink); the
 * internal+secret guard replaces token auth here. Path routing (LiveKit forward
 * vs passthrough) is the pure {@link classifyMediamtxPath} — the core owns ALL
 * routing (MediaMTX has no path regexes), so `live/<key>` publishes are relayed
 * to the moved LiveKit ingress by an armed forward child.
 */
import {
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Request } from 'express';
import { timingSafeEqual } from 'node:crypto';

import { Public } from '../../shared/auth';
import { ConfigService } from '../../shared/config/config.service';
import { clientIpOf, isPrivateOrLoopbackIp } from '../security/ip-cidr.util';
import { classifyMediamtxPath } from './mediamtx-path.util';
import { PassthroughService } from './passthrough.service';

/** MediaMTX `authHTTPAddress` POST body (v1 shape — we only read action+path). */
interface MediamtxAuthBody {
  action?: string;
  path?: string;
}

/** MediaMTX `runOnReady`/`runOnNotReady` hook body (path is enough). */
interface MediamtxPathBody {
  path?: string;
}

/** Header carrying the shared hook secret. */
const HOOK_SECRET_HEADER = 'x-mediamtx-secret';

@ApiExcludeController()
@Public()
@Controller('internal/mediamtx')
export class MediamtxHookController {
  constructor(
    private readonly config: ConfigService,
    private readonly passthrough: PassthroughService,
  ) {}

  /**
   * `authHTTPAddress` — allow (200) or deny (401) a publish. Reads/HLS
   * (action != publish) and the LiveKit plane pass; a passthrough push is
   * validated against the minted key.
   */
  @Post('auth')
  @HttpCode(200)
  auth(@Req() req: Request, @Body() body: MediamtxAuthBody): { ok: true } {
    this.assertInternal(req);
    // Only 'publish' is gated here; reads (playback/HLS) are always allowed.
    if (body?.action && body.action !== 'publish') return { ok: true };
    const cls = classifyMediamtxPath(body?.path ?? '');
    if (cls.kind === 'livekit') return { ok: true }; // LiveKit does its own auth
    if (cls.kind === 'passthrough' && this.passthrough.authorizeKey(cls.app, cls.key)) {
      return { ok: true };
    }
    throw new UnauthorizedException('mediamtx publish denied');
  }

  /**
   * `runOnReady` — a publish is live. Passthrough path → arm the remux (pull
   * mode); LiveKit path → arm the FORWARD to the moved LiveKit ingress (the core
   * owns routing). Invalid → no-op.
   */
  @Post('ready')
  @HttpCode(200)
  ready(@Req() req: Request, @Body() body: MediamtxPathBody): { ok: true } {
    this.assertInternal(req);
    const cls = classifyMediamtxPath(body?.path ?? '');
    if (cls.kind === 'passthrough') {
      // Pull mode is selected inside handlePublish (config.mediamtxEnable + rtmp).
      this.passthrough.handlePublish(cls.app, cls.key);
    } else if (cls.kind === 'livekit') {
      this.passthrough.handleForwardPublish(cls.key);
    }
    return { ok: true };
  }

  /**
   * `runOnNotReady` — a publish ended. Passthrough → stop the remux (keep the
   * key); LiveKit → stop the forward child. Invalid → no-op.
   */
  @Post('notready')
  @HttpCode(200)
  notready(@Req() req: Request, @Body() body: MediamtxPathBody): { ok: true } {
    this.assertInternal(req);
    const cls = classifyMediamtxPath(body?.path ?? '');
    if (cls.kind === 'passthrough') {
      this.passthrough.handleDone(cls.app, cls.key);
    } else if (cls.kind === 'livekit') {
      this.passthrough.handleForwardDone(cls.key);
    }
    return { ok: true };
  }

  // ---------------------------------------------------------------------------

  /**
   * Internal peer (loopback OR RFC1918/link-local — compose bridge) + matching
   * shared secret (header or `?secret=`), else 403. Unset secret ⇒ disabled.
   */
  private assertInternal(req: Request): void {
    const secret = this.config.mediamtxHookSecret;
    if (!secret) {
      throw new ForbiddenException('mediamtx hooks disabled (no secret configured)');
    }
    const ip = clientIpOf(req);
    if (!ip || !isPrivateOrLoopbackIp(ip)) {
      throw new ForbiddenException('mediamtx hooks are internal-only');
    }
    const presented = this.presentedSecret(req);
    if (!presented || !constantTimeEqual(presented, secret)) {
      throw new ForbiddenException('mediamtx hook secret mismatch');
    }
  }

  /** The secret from the `X-MediaMTX-Secret` header, falling back to `?secret=`. */
  private presentedSecret(req: Request): string | undefined {
    const header = req.headers[HOOK_SECRET_HEADER];
    const fromHeader = Array.isArray(header) ? header[0] : header;
    if (fromHeader) return fromHeader;
    const query = (req.query as Record<string, unknown> | undefined)?.secret;
    const fromQuery = Array.isArray(query) ? query[0] : query;
    return typeof fromQuery === 'string' ? fromQuery : undefined;
  }
}

/** Length-safe constant-time string compare (no early-exit timing leak). */
function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
