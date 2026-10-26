/**
 * Unit spec — UpdateAppConfigDto `timezone` validation (owner item 11, the
 * 400 surface of `PATCH /apps/:name`). Pins: empty string (server default)
 * and any real IANA zone name validate; garbage does not; other fields on the
 * DTO stay valid/untouched (additive change).
 */
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { UpdateAppConfigDto } from './update-app-config.dto';

async function errorsOf(body: Record<string, unknown>) {
  return validate(plainToInstance(UpdateAppConfigDto, body));
}

function timezoneErrors(
  errors: Awaited<ReturnType<typeof errorsOf>>,
): typeof errors {
  return errors.filter((e) => e.property === 'timezone');
}

describe('UpdateAppConfigDto — timezone', () => {
  it('accepts an empty string (server/host local default)', async () => {
    expect(timezoneErrors(await errorsOf({ timezone: '' }))).toHaveLength(0);
  });

  it('accepts omitting the field entirely', async () => {
    expect(timezoneErrors(await errorsOf({ displayName: 'Live' }))).toHaveLength(0);
  });

  it.each([
    'UTC',
    'America/Argentina/Buenos_Aires',
    'Europe/Madrid',
    'Asia/Tokyo',
    'Australia/Sydney',
  ])('accepts the real IANA zone %s', async (tz) => {
    expect(timezoneErrors(await errorsOf({ timezone: tz }))).toHaveLength(0);
  });

  it.each(['Not/AZone', 'literally anything', 'GMT+25', 'Mars/Olympus_Mons'])(
    'rejects the garbage value %s (400)',
    async (tz) => {
      const errors = timezoneErrors(await errorsOf({ timezone: tz }));
      expect(errors.length).toBeGreaterThan(0);
      const messages = errors.flatMap((e) => Object.values(e.constraints ?? {}));
      expect(messages.join(' ')).toMatch(/iana/i);
    },
  );

  it('rejects a non-string value', async () => {
    const errors = timezoneErrors(await errorsOf({ timezone: 12345 }));
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects an over-long value (> 64 chars)', async () => {
    const errors = timezoneErrors(
      await errorsOf({ timezone: 'A'.repeat(65) }),
    );
    expect(errors.length).toBeGreaterThan(0);
  });

  it('leaves sibling fields valid (additive change)', async () => {
    expect(
      await errorsOf({
        displayName: 'Live',
        roomPrefix: 'live',
        timezone: 'America/Argentina/Buenos_Aires',
        recordingEnabled: true,
      }),
    ).toHaveLength(0);
  });
});
