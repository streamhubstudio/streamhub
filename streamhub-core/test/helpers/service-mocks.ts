/**
 * Contract-level service mocks (harness).
 *
 * Jest-fn fakes of the cross-module SERVICE CONTRACTS (src/shared/contracts).
 * Use these to instantiate a service under test WITHOUT its real collaborators —
 * so nothing dials LiveKit / Redis / S3 / other modules. Every method is a
 * `jest.fn()` with a benign default; override per test with `.mockResolvedValue`
 * etc. Pass `overrides` to seed specific return values at construction.
 *
 * These are the values you bind to the DI tokens (LIVEKIT_SERVICE, S3_SERVICE,
 * LOGS_SERVICE, ...) when building a Nest TestingModule, or pass positionally to
 * `newService()` in service-factory.ts.
 */
import type {
  AppsServiceContract,
  CallbacksServiceContract,
  LiveKitServiceContract,
  LogsServiceContract,
  RecordingServiceContract,
  S3ServiceContract,
  SamplesServiceContract,
  StreamsServiceContract,
} from '../../src/shared/contracts/services';

type Mocked<T> = { [K in keyof T]: T[K] extends (...a: infer A) => infer R
  ? jest.Mock<R, A extends unknown[] ? A : never>
  : T[K] };

function apply<T extends object>(base: T, overrides?: Partial<T>): T {
  return overrides ? Object.assign(base, overrides) : base;
}

export function mockLiveKitService(
  overrides?: Partial<LiveKitServiceContract>,
): Mocked<LiveKitServiceContract> {
  const base: LiveKitServiceContract = {
    createRoom: jest.fn(async (name: string) => ({
      name,
      sid: `RM_${name}`,
      numParticipants: 0,
      creationTime: Date.now(),
    })),
    deleteRoom: jest.fn(async () => undefined),
    listRooms: jest.fn(async () => []),
    mintToken: jest.fn(async () => 'test.jwt.token'),
    createIngress: jest.fn(async (input) => ({
      ingressId: 'IN_test',
      url: 'rtmp://localhost/live',
      streamKey: 'sk_test',
      roomName: input.roomName,
    })),
    deleteIngress: jest.fn(async () => undefined),
    startEgress: jest.fn(async () => ({ egressId: 'EG_test', status: 'EGRESS_STARTING' })),
    startStreamEgress: jest.fn(async (input) => ({
      egressId: 'EG_stream',
      status: 'EGRESS_STARTING',
      roomName: input.roomName,
      urls: [input.rtmpUrl],
    })),
    listStreamEgress: jest.fn(async () => []),
    startHlsEgress: jest.fn(async (input) => ({
      egressId: 'EG_hls',
      status: 'EGRESS_STARTING',
      roomName: input.roomName,
    })),
    listHlsEgress: jest.fn(async () => []),
    stopEgress: jest.fn(async () => ({ egressId: 'EG_test', status: 'EGRESS_ENDING' })),
    receiveWebhook: jest.fn(async () => ({})),
    isReachable: jest.fn(async () => true),
  };
  return apply(base, overrides) as Mocked<LiveKitServiceContract>;
}

export function mockS3Service(
  overrides?: Partial<S3ServiceContract>,
): Mocked<S3ServiceContract> {
  const base: S3ServiceContract = {
    upload: jest.fn(async (_c, _p, key) => ({
      key,
      bucket: 'test-bucket',
      url: `https://s3.test/test-bucket/${key}`,
      sizeBytes: 0,
      etag: 'etag',
    })),
    presignGet: jest.fn(async (_c, key) => `https://s3.test/${key}?sig=test`),
    delete: jest.fn(async () => undefined),
    exists: jest.fn(async () => true),
  };
  return apply(base, overrides) as Mocked<S3ServiceContract>;
}

export function mockLogsService(
  overrides?: Partial<LogsServiceContract>,
): Mocked<LogsServiceContract> {
  const base: LogsServiceContract = {
    write: jest.fn(() => undefined),
    query: jest.fn(async () => []),
  };
  return apply(base, overrides) as Mocked<LogsServiceContract>;
}

export function mockCallbacksService(
  overrides?: Partial<CallbacksServiceContract>,
): Mocked<CallbacksServiceContract> {
  const base: CallbacksServiceContract = {
    dispatch: jest.fn(async () => undefined),
  };
  return apply(base, overrides) as Mocked<CallbacksServiceContract>;
}

export function mockAppsService(
  overrides?: Partial<AppsServiceContract>,
): Mocked<AppsServiceContract> {
  const base: AppsServiceContract = {
    list: jest.fn(async () => []),
    get: jest.fn(async () => null),
    create: jest.fn(async () => {
      throw new Error('mockAppsService.create not configured');
    }),
    delete: jest.fn(async () => undefined),
    getConfig: jest.fn(async () => {
      throw new Error('mockAppsService.getConfig not configured');
    }),
    updateConfig: jest.fn(async () => {
      throw new Error('mockAppsService.updateConfig not configured');
    }),
    appDir: jest.fn((name: string) => `/tmp/streamhub-apps/${name}`),
  };
  return apply(base, overrides) as Mocked<AppsServiceContract>;
}

export function mockStreamsService(
  overrides?: Partial<StreamsServiceContract>,
): Mocked<StreamsServiceContract> {
  const base: StreamsServiceContract = {
    list: jest.fn(async () => []),
    get: jest.fn(async () => null),
    stop: jest.fn(async () => undefined),
    upsert: jest.fn(async () => {
      throw new Error('mockStreamsService.upsert not configured');
    }),
    end: jest.fn(async () => undefined),
    snapshot: jest.fn(async () => ({ key: 'snap.jpg', url: 'https://s3.test/snap.jpg' })),
  };
  return apply(base, overrides) as Mocked<StreamsServiceContract>;
}

export function mockSamplesService(
  overrides?: Partial<SamplesServiceContract>,
): Mocked<SamplesServiceContract> {
  const base: SamplesServiceContract = {
    generate: jest.fn(async () => []),
    list: jest.fn(async () => []),
    read: jest.fn(async () => ''),
    write: jest.fn(async () => undefined),
  };
  return apply(base, overrides) as Mocked<SamplesServiceContract>;
}

export function mockRecordingService(
  overrides?: Partial<RecordingServiceContract>,
): Mocked<RecordingServiceContract> {
  const base: RecordingServiceContract = {
    start: jest.fn(async () => ({
      vodId: 1,
      egressId: 'EG_test',
      status: 'recording' as const,
    })),
    stop: jest.fn(async () => ({
      vodId: 1,
      egressId: 'EG_test',
      status: 'ready' as const,
    })),
    onEgressEvent: jest.fn(async () => undefined),
  };
  return apply(base, overrides) as Mocked<RecordingServiceContract>;
}
