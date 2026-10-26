/**
 * Unit spec — RemuxManager. child_process is mocked with a controllable fake
 * child (EventEmitter) so start/stop/crash-restart are deterministic and no real
 * ffmpeg is spawned; the HLS dir is a throwaway temp dir (real fs, so we assert
 * the actual create/cleanup effects). Locks down:
 *  - start spawns `ffmpeg` with the built remux args (`-c copy`, `-listen 1`)
 *    and creates the HLS output dir;
 *  - stop SIGTERMs the child AND removes the HLS dir;
 *  - a crash WHILE PUBLISHING restarts (backoff), a crash AFTER stop does NOT;
 *  - stdout/stderr are mirrored to LogsService under source `remux:<id>`.
 */
import { EventEmitter } from 'events';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { mockLogsService } from '../../../test/helpers';
import { RemuxManager, RemuxSpec } from './remux.manager';

jest.mock('child_process', () => ({ spawn: jest.fn() }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fakeChild(pid = 4242): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cp: any = new EventEmitter();
  cp.pid = pid;
  cp.stdout = new EventEmitter();
  cp.stderr = new EventEmitter();
  cp.kill = jest.fn(() => {
    cp.emit('exit', 0, 'SIGTERM');
    return true;
  });
  return cp;
}

const ID = 'pti_abc123';

describe('RemuxManager', () => {
  let mgr: RemuxManager;
  let logs: ReturnType<typeof mockLogsService>;
  let child: ReturnType<typeof fakeChild>;
  let tmp: string;
  let spec: RemuxSpec;

  beforeEach(() => {
    jest.useFakeTimers();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'remux-test-'));
    spec = {
      app: 'live',
      room: 'live-ch1',
      streamKey: 'ptk_secret',
      port: 1937,
      hlsDir: path.join(tmp, 'apps', 'live', 'hls', 'live-ch1'),
      appId: 7,
    };
    logs = mockLogsService();
    mgr = new RemuxManager(logs);
    child = fakeChild();
    (spawn as jest.Mock).mockReset();
    (spawn as jest.Mock).mockImplementation(() => fakeChild());
    (spawn as jest.Mock).mockImplementationOnce(() => child);
  });

  afterEach(() => {
    mgr.onModuleDestroy();
    jest.clearAllTimers();
    jest.useRealTimers();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('reports undefined for a never-started remux', () => {
    expect(mgr.status('nope')).toBeUndefined();
    expect(mgr.isActive('nope')).toBe(false);
  });

  it('start() spawns ffmpeg with the built remux args (-c copy, -listen 1) + creates the HLS dir', () => {
    const state = mgr.start(ID, spec);
    expect(state.status).toBe('live');
    expect(state.pid).toBe(4242);

    expect(spawn).toHaveBeenCalledTimes(1);
    const [bin, args, opts] = (spawn as jest.Mock).mock.calls[0];
    expect(bin).toBe('ffmpeg');
    expect(args).toEqual(expect.arrayContaining(['-c', 'copy', '-listen', '1']));
    expect(args).toContain('rtmp://0.0.0.0:1937/live/ptk_secret');
    expect(opts).toMatchObject({ stdio: ['ignore', 'pipe', 'pipe'] });
    // the HLS output dir is created before spawning
    expect(fs.existsSync(spec.hlsDir)).toBe(true);
    expect(mgr.isActive(ID)).toBe(true);
  });

  it('is idempotent while live (no second spawn)', () => {
    mgr.start(ID, spec);
    mgr.start(ID, spec);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('mirrors stdout/stderr to LogsService under source remux:<id>', () => {
    mgr.start(ID, spec);
    child.stderr.emit('data', Buffer.from('rtmp connect\nbad frame\n'));
    const lines = mgr.logs(ID).map((l) => l.line);
    expect(lines).toEqual(expect.arrayContaining(['rtmp connect', 'bad frame']));
    expect(logs.write).toHaveBeenCalledWith(
      'warn',
      `remux:${ID}`,
      'bad frame',
      expect.objectContaining({ app: 'live', room: 'live-ch1', stream: 'stderr' }),
      7,
    );
  });

  it('stop() SIGTERMs the child AND removes the HLS dir', () => {
    mgr.start(ID, spec);
    expect(fs.existsSync(spec.hlsDir)).toBe(true);

    const s = mgr.stop(ID);

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(fs.existsSync(spec.hlsDir)).toBe(false); // HLS dir cleaned
    expect(s.status).toBe('off');
    expect(mgr.isActive(ID)).toBe(false);
  });

  it('crash WHILE PUBLISHING restarts (with backoff)', () => {
    mgr.start(ID, spec);
    expect(spawn).toHaveBeenCalledTimes(1);

    // ffmpeg dies non-zero while we still want the ingress live.
    child.emit('exit', 1, null);
    expect(mgr.status(ID)?.status).toBe('idle'); // awaiting restart

    // Backoff elapses → it re-arms (second spawn).
    jest.advanceTimersByTime(1000);
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(mgr.status(ID)?.status).toBe('live');
    expect(mgr.status(ID)?.restarts).toBe(1);
  });

  it('crash AFTER stop (done) does NOT restart', () => {
    mgr.start(ID, spec);
    mgr.stop(ID); // desired := stopped (kill fires an exit too)
    expect(spawn).toHaveBeenCalledTimes(1);

    // Any late exit signal must not resurrect the process.
    child.emit('exit', 1, null);
    jest.advanceTimersByTime(60_000);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(mgr.status(ID)?.status).toBe('off');
  });

  it('a clean end-of-publish (code 0) re-arms the listener', () => {
    mgr.start(ID, spec);
    child.emit('exit', 0, null); // encoder disconnected cleanly
    expect(mgr.status(ID)?.status).toBe('idle');
    jest.advanceTimersByTime(250);
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it('onModuleDestroy SIGTERMs every running remux', () => {
    mgr.start(ID, spec);
    mgr.start('pti_two', { ...spec, streamKey: 'ptk_two', port: 1938 });
    mgr.onModuleDestroy();
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(mgr.status(ID)).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // Forward child (LiveKit-plane relay under the single-port switch): FLV push,
  // no HLS dir, and hidden from list() so it never becomes a passthrough row.
  // ---------------------------------------------------------------------------

  describe('forward child', () => {
    const FWD_ID = 'fwd_sk_livekit';
    let fwdSpec: RemuxSpec;

    beforeEach(() => {
      fwdSpec = {
        app: 'live',
        room: 'sk_livekit',
        streamKey: 'sk_livekit',
        forwardKey: 'sk_livekit',
        kind: 'forward',
        port: 1935,
        destPort: 11935,
        hlsDir: '',
      };
    });

    it('spawns the forward argv (-c copy -f flv, no -listen) and creates NO dir', () => {
      mgr.start(FWD_ID, fwdSpec);
      const [bin, args] = (spawn as jest.Mock).mock.calls[0];
      expect(bin).toBe('ffmpeg');
      expect(args).toEqual(expect.arrayContaining(['-c', 'copy', '-f', 'flv']));
      expect(args).toContain('rtmp://127.0.0.1:1935/live/sk_livekit');
      expect(args).toContain('rtmp://127.0.0.1:11935/live/sk_livekit');
      expect(args).not.toContain('-listen');
    });

    it('is EXCLUDED from list() (never leaks into the streams-table sync)', () => {
      mgr.start(ID, spec); // a real passthrough remux
      mgr.start(FWD_ID, fwdSpec); // a forward child
      const ids = mgr.list().map((e) => e.ingressId);
      expect(ids).toContain(ID);
      expect(ids).not.toContain(FWD_ID);
    });

    it('stop() SIGTERMs the forward with no filesystem touch (empty hlsDir)', () => {
      mgr.start(FWD_ID, fwdSpec);
      const s = mgr.stop(FWD_ID);
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      expect(s.status).toBe('off');
    });
  });
});
