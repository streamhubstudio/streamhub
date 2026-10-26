/**
 * Unit spec — PassthroughRtmpServer boot re-arm under the MediaMTX single-port
 * switch (restart resilience). The pull remuxes + LiveKit forwards are core child
 * processes that die with the core; MediaMTX keeps the publishers and only fires
 * `runOnReady` on publish START, so on boot the server queries the MediaMTX API
 * (`/v3/paths/list`) and re-arms every already-`ready` path. `global.fetch` is
 * mocked — no network. Locks down:
 *  - a ready passthrough path re-arms a PULL remux (handlePublish);
 *  - a ready `live/` path re-arms a FORWARD (handleForwardPublish);
 *  - not-ready paths are skipped;
 *  - a down/erroring API warns and continues (never throws, never arms);
 *  - pagination (pageCount > 1) is walked;
 *  - with mediamtxEnable OFF the API is never probed.
 */
import type { ConfigService } from '../../shared/config/config.service';
import type { AppsServiceContract } from '../../shared/contracts';
import type { IngressAuthService } from '../livekit/ingress-auth.service';
import { PassthroughRtmpServer } from './passthrough.rtmp-server';
import type { PassthroughService } from './passthrough.service';
import type { RemuxManager } from './remux.manager';

type Server = PassthroughRtmpServer & {
  rearmFromMediamtx(): Promise<void>;
};

const okJson = (body: unknown) => ({
  ok: true,
  status: 200,
  json: async () => body,
});

function makeServer(configOverrides: Partial<ConfigService> = {}) {
  const config = {
    rtmpPassthroughEnable: true,
    mediamtxEnable: true,
    mediamtxApiUrl: 'http://127.0.0.1:9997',
    mediamtxRtmpPort: 1935,
    livekitIngressRtmpPort: 11935,
    rtmpPassthroughPort: 1937,
    ...configOverrides,
  } as ConfigService;
  const passthrough = {
    handlePublish: jest.fn(() => ({ accepted: true })),
    handleForwardPublish: jest.fn(),
    list: jest.fn(() => []),
  };
  const ingressAuth = { listPassthrough: jest.fn(() => []) };
  const remux = { stop: jest.fn() };
  const apps = { list: jest.fn(async () => []) };
  const server = new PassthroughRtmpServer(
    config,
    passthrough as unknown as PassthroughService,
    ingressAuth as unknown as IngressAuthService,
    remux as unknown as RemuxManager,
    apps as unknown as AppsServiceContract,
  ) as Server;
  return { server, passthrough, ingressAuth, remux, apps, config };
}

describe('PassthroughRtmpServer — MediaMTX boot re-arm', () => {
  let fetchMock: jest.Mock;
  const realFetch = global.fetch;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = realFetch;
  });

  it('re-arms a PULL remux for a ready passthrough path', async () => {
    fetchMock.mockResolvedValueOnce(
      okJson({ pageCount: 1, items: [{ name: 'shop/ptk_x', ready: true }] }),
    );
    const { server, passthrough } = makeServer();

    await server.rearmFromMediamtx();

    expect(passthrough.handlePublish).toHaveBeenCalledWith('shop', 'ptk_x');
    expect(passthrough.handleForwardPublish).not.toHaveBeenCalled();
  });

  it('re-arms a FORWARD for a ready live/ path', async () => {
    fetchMock.mockResolvedValueOnce(
      okJson({ pageCount: 1, items: [{ name: 'live/sk_x', ready: true }] }),
    );
    const { server, passthrough } = makeServer();

    await server.rearmFromMediamtx();

    expect(passthrough.handleForwardPublish).toHaveBeenCalledWith('sk_x');
    expect(passthrough.handlePublish).not.toHaveBeenCalled();
  });

  it('re-arms a passthrough push on the "live" app (live/ptk_…) as a PULL remux', async () => {
    fetchMock.mockResolvedValueOnce(
      okJson({ pageCount: 1, items: [{ name: 'live/ptk_radio', ready: true }] }),
    );
    const { server, passthrough } = makeServer();

    await server.rearmFromMediamtx();

    expect(passthrough.handlePublish).toHaveBeenCalledWith('live', 'ptk_radio');
    expect(passthrough.handleForwardPublish).not.toHaveBeenCalled();
  });

  it('skips not-ready paths (nothing armed)', async () => {
    fetchMock.mockResolvedValueOnce(
      okJson({
        pageCount: 1,
        items: [
          { name: 'shop/ptk_x', ready: false },
          { name: 'live/sk_y', ready: false },
        ],
      }),
    );
    const { server, passthrough } = makeServer();

    await server.rearmFromMediamtx();

    expect(passthrough.handlePublish).not.toHaveBeenCalled();
    expect(passthrough.handleForwardPublish).not.toHaveBeenCalled();
  });

  it('re-arms both planes from a mixed page (ready pull + ready forward, skips not-ready)', async () => {
    fetchMock.mockResolvedValueOnce(
      okJson({
        pageCount: 1,
        items: [
          { name: 'shop/ptk_a', ready: true },
          { name: 'live/sk_b', ready: true },
          { name: 'shop/ptk_c', ready: false },
        ],
      }),
    );
    const { server, passthrough } = makeServer();

    await server.rearmFromMediamtx();

    expect(passthrough.handlePublish).toHaveBeenCalledTimes(1);
    expect(passthrough.handlePublish).toHaveBeenCalledWith('shop', 'ptk_a');
    expect(passthrough.handleForwardPublish).toHaveBeenCalledTimes(1);
    expect(passthrough.handleForwardPublish).toHaveBeenCalledWith('sk_b');
  });

  it('walks pagination when pageCount > 1', async () => {
    fetchMock
      .mockResolvedValueOnce(
        okJson({ pageCount: 2, items: [{ name: 'a/ptk_1', ready: true }] }),
      )
      .mockResolvedValueOnce(
        okJson({ pageCount: 2, items: [{ name: 'live/sk_2', ready: true }] }),
      );
    const { server, passthrough } = makeServer();

    await server.rearmFromMediamtx();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((fetchMock.mock.calls[0][0] as string)).toContain('page=0');
    expect((fetchMock.mock.calls[1][0] as string)).toContain('page=1');
    expect(passthrough.handlePublish).toHaveBeenCalledWith('a', 'ptk_1');
    expect(passthrough.handleForwardPublish).toHaveBeenCalledWith('sk_2');
  });

  it('a down API warns and continues (never throws, nothing armed)', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const { server, passthrough } = makeServer();

    await expect(server.rearmFromMediamtx()).resolves.toBeUndefined();
    expect(passthrough.handlePublish).not.toHaveBeenCalled();
    expect(passthrough.handleForwardPublish).not.toHaveBeenCalled();
  });

  it('a non-2xx API response is treated as unreachable (warn + continue)', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) });
    const { server, passthrough } = makeServer();

    await expect(server.rearmFromMediamtx()).resolves.toBeUndefined();
    expect(passthrough.handlePublish).not.toHaveBeenCalled();
  });

  it('does NOT probe the MediaMTX API when the single-port switch is OFF', () => {
    const { server } = makeServer({ mediamtxEnable: false });
    server.onApplicationBootstrap();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
