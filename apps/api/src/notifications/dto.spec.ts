/**
 * Request DTOs, exercised through the REAL ValidationPipe with the EXACT options
 * main.ts uses — `whitelist`, `transform` AND `forbidNonWhitelisted`. The last one
 * matters: with it, an unknown property is REJECTED rather than silently stripped,
 * so a spec that omits it documents an outcome the deployed API never produces.
 *
 * WHY THROUGH THE PIPE. Query strings arrive as text, and the interesting bugs live
 * in the transform layer, not the service: `?unreadOnly=false` must mean false, and
 * — the one that would be invisible from a service-level spec — an ABSENT
 * `unreadOnly` must stay undefined rather than collapsing to `true` and silently
 * making the default feed unread-only. Calling the service with a hand-built object
 * cannot prove any of that.
 */

import { ValidationPipe, type ArgumentMetadata, BadRequestException } from '@nestjs/common';
import { ListNotificationsQueryDto, RegisterDeviceDto } from './dto';

const pipe = new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true });

function queryMeta(): ArgumentMetadata {
  return { type: 'query', metatype: ListNotificationsQueryDto, data: '' };
}
function bodyMeta(): ArgumentMetadata {
  return { type: 'body', metatype: RegisterDeviceDto, data: '' };
}

async function parseQuery(raw: Record<string, unknown>): Promise<ListNotificationsQueryDto> {
  return (await pipe.transform(raw, queryMeta())) as ListNotificationsQueryDto;
}

describe('ListNotificationsQueryDto', () => {
  it('leaves unreadOnly undefined when the parameter is absent', async () => {
    // The whole feed is the default. If this ever becomes `true`, the bell stops
    // showing read history.
    expect((await parseQuery({})).unreadOnly).toBeUndefined();
  });

  it('treats ?unreadOnly=true as true', async () => {
    expect((await parseQuery({ unreadOnly: 'true' })).unreadOnly).toBe(true);
    expect((await parseQuery({ unreadOnly: '1' })).unreadOnly).toBe(true);
  });

  it('treats ?unreadOnly=false as FALSE, not as "present therefore true"', async () => {
    expect((await parseQuery({ unreadOnly: 'false' })).unreadOnly).toBe(false);
    expect((await parseQuery({ unreadOnly: '0' })).unreadOnly).toBe(false);
  });

  it('treats a bare ?unreadOnly as true', async () => {
    expect((await parseQuery({ unreadOnly: '' })).unreadOnly).toBe(true);
  });

  it('coerces page and pageSize to numbers', async () => {
    const parsed = await parseQuery({ page: '3', pageSize: '10' });
    expect(parsed.page).toBe(3);
    expect(parsed.pageSize).toBe(10);
  });

  it('rejects a pageSize above the cap rather than silently clamping at the edge', async () => {
    await expect(parseQuery({ pageSize: '5000' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a zero or negative page', async () => {
    await expect(parseQuery({ page: '0' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('REJECTS an attempt to pass a userId rather than quietly ignoring it', async () => {
    // forbidNonWhitelisted turns "?userId=someone-else" into a 400 before the
    // handler runs, so impersonation is not merely unhandled — it is unspeakable.
    await expect(parseQuery({ userId: 'someone-else', page: '1' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});

describe('RegisterDeviceDto', () => {
  it('accepts a well-formed registration', async () => {
    const parsed = (await pipe.transform(
      { deviceIdentifier: 'installation-aaaa', platform: 'ios', pushToken: 'ExponentPushToken[X1234567]' },
      bodyMeta(),
    )) as RegisterDeviceDto;
    expect(parsed.platform).toBe('ios');
  });

  it('accepts a registration with no push token yet', async () => {
    const parsed = (await pipe.transform(
      { deviceIdentifier: 'installation-aaaa', platform: 'android' },
      bodyMeta(),
    )) as RegisterDeviceDto;
    expect(parsed.pushToken).toBeUndefined();
  });

  it('rejects an unknown platform', async () => {
    await expect(
      pipe.transform({ deviceIdentifier: 'installation-aaaa', platform: 'blackberry' }, bodyMeta()),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('requires a device identifier', async () => {
    await expect(pipe.transform({ platform: 'ios' }, bodyMeta())).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('REJECTS an attempt to register a device for another user or business', async () => {
    await expect(
      pipe.transform(
        {
          deviceIdentifier: 'installation-aaaa',
          platform: 'ios',
          userProfileId: 'someone-else',
          businessId: 'another-business',
        },
        bodyMeta(),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
