/**
 * StreamHub — DI injection tokens for the cross-module service contracts.
 *
 * TS interfaces don't exist at runtime, so DI is keyed by these symbols.
 * A module that implements a contract should bind it:
 *   providers: [{ provide: S3_SERVICE, useClass: S3Service }, S3Service]
 * and export S3_SERVICE. Consumers inject with @Inject(S3_SERVICE).
 */

export const S3_SERVICE = Symbol('S3_SERVICE');
export const LIVEKIT_SERVICE = Symbol('LIVEKIT_SERVICE');
export const RECORDING_SERVICE = Symbol('RECORDING_SERVICE');
export const APPS_SERVICE = Symbol('APPS_SERVICE');
export const LOGS_SERVICE = Symbol('LOGS_SERVICE');
export const STREAMS_SERVICE = Symbol('STREAMS_SERVICE');
export const CALLBACKS_SERVICE = Symbol('CALLBACKS_SERVICE');
export const SAMPLES_SERVICE = Symbol('SAMPLES_SERVICE');
export const RESTREAM_SERVICE = Symbol('RESTREAM_SERVICE');
