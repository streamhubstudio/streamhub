/**
 * Unit spec — CreateIngressDto validation (the 400 surface of
 * `POST /apps/:app/ingress`). Pins the SRT rule: `inputType: 'srt'` is a valid
 * input type but REQUIRES `mode: 'passthrough'` (LiveKit's ingress API has no
 * SRT input type — rtmp|whip|url only — so the transcode path can never take an
 * SRT push; the remote-SRT-source alternative is `inputType:'url'` with an
 * srt:// url, which flows through the LiveKit URL-pull + SSRF guard). Also pins
 * that the pre-SRT shapes (rtmp/whip/url, with or without mode) stay valid, so
 * the enum addition is additive.
 */
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { CreateIngressDto } from './create-ingress.dto';

async function errorsOf(body: Record<string, unknown>) {
  return validate(plainToInstance(CreateIngressDto, body));
}

describe('CreateIngressDto — inputType srt requires mode passthrough', () => {
  it("accepts {inputType:'srt', mode:'passthrough'}", async () => {
    expect(
      await errorsOf({ inputType: 'srt', mode: 'passthrough', room: 'ch1' }),
    ).toHaveLength(0);
  });

  it("rejects {inputType:'srt'} without a mode (400)", async () => {
    const errors = await errorsOf({ inputType: 'srt', room: 'ch1' });
    expect(errors.length).toBeGreaterThan(0);
    const messages = errors.flatMap((e) => Object.values(e.constraints ?? {}));
    expect(messages.join(' ')).toMatch(/srt.+passthrough/i);
  });

  it("rejects {inputType:'srt', mode:'transcode'} (400)", async () => {
    const errors = await errorsOf({
      inputType: 'srt',
      mode: 'transcode',
      room: 'ch1',
    });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('still rejects an unknown inputType', async () => {
    const errors = await errorsOf({ inputType: 'udp', room: 'ch1' });
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe('CreateIngressDto — pre-SRT shapes stay valid (additive change)', () => {
  it.each([
    { inputType: 'rtmp', room: 'ch1' },
    { inputType: 'rtmp', room: 'ch1', mode: 'passthrough' },
    { inputType: 'rtmp', room: 'ch1', mode: 'transcode' },
    { inputType: 'whip', room: 'ch1' },
    { inputType: 'url', url: 'rtsp://cam.example.com/live' },
    { inputType: 'url', url: 'srt://relay.example.com:9000' },
  ])('accepts %o', async (body) => {
    expect(await errorsOf(body)).toHaveLength(0);
  });
});
