/**
 * Unit spec — SetAccountSmtpDto validation (owner item 29, the 400 surface of
 * `PUT /account/smtp`).
 */
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { SetAccountSmtpDto } from './account.dto';

async function errorsOf(body: Record<string, unknown>) {
  return validate(plainToInstance(SetAccountSmtpDto, body));
}

describe('SetAccountSmtpDto', () => {
  it('accepts a full valid body', async () => {
    expect(
      await errorsOf({
        enabled: true,
        host: 'smtp.example.com',
        port: 587,
        user: 'me@example.com',
        pass: 's3cret',
        from: 'Me <me@example.com>',
      }),
    ).toHaveLength(0);
  });

  it('accepts an empty body (every field optional)', async () => {
    expect(await errorsOf({})).toHaveLength(0);
  });

  it('rejects an out-of-range port', async () => {
    expect((await errorsOf({ port: 0 })).length).toBeGreaterThan(0);
    expect((await errorsOf({ port: 70000 })).length).toBeGreaterThan(0);
  });

  it('rejects an over-long host/pass/from', async () => {
    expect((await errorsOf({ host: 'a'.repeat(256) })).length).toBeGreaterThan(0);
    expect((await errorsOf({ pass: 'a'.repeat(513) })).length).toBeGreaterThan(0);
    expect((await errorsOf({ from: 'a'.repeat(256) })).length).toBeGreaterThan(0);
  });
});
