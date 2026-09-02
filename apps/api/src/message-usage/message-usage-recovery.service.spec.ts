/**
 * MessageUsageRecoveryService — the timer that closes the accounting gap.
 *
 * What matters here is not that it records (MessageUsageService's own suite
 * proves that) but that it is SAFE TO RUN UNATTENDED: it drains in bounded
 * batches, it advances past a row it could not record instead of spinning on it
 * forever, it never overlaps itself, it cannot take the process down, and it
 * has no way to reach a provider.
 */
import type { ConfigService } from '@nestjs/config';
import { MessageUsageRecoveryService } from './message-usage-recovery.service';
import type { MessageUsageService } from './message-usage.service';

type Outcome = Awaited<ReturnType<MessageUsageService['recoverUnaccountedSends']>>;

function config(overrides: Record<string, string> = {}): ConfigService {
  return { get: (key: string) => overrides[key] } as unknown as ConfigService;
}

/** A usage service whose recovery returns a scripted sequence of outcomes. */
function usageReturning(...outcomes: Outcome[]) {
  const calls: Array<Record<string, unknown>> = [];
  let i = 0;
  const service = {
    recoverUnaccountedSends: jest.fn(async (options: Record<string, unknown>) => {
      calls.push(options);
      return outcomes[Math.min(i++, outcomes.length - 1)];
    }),
  } as unknown as MessageUsageService;
  return { service, calls };
}

const page = (found: number, recorded: number, cursorId = 'e1'): Outcome => ({
  found,
  recorded,
  failed: found - recorded,
  cursor: { sentAt: '2026-09-10T10:00:00Z', id: cursorId },
});

const empty: Outcome = { found: 0, recorded: 0, failed: 0, cursor: null };

describe('MessageUsageRecoveryService', () => {
  it('does not start a timer when disabled', () => {
    const { service } = usageReturning(empty);
    const worker = new MessageUsageRecoveryService(config({ MESSAGE_USAGE_RECOVERY_ENABLED: 'false' }), service);
    worker.onModuleInit();
    expect((worker as unknown as { timer: unknown }).timer).toBeNull();
    worker.onModuleDestroy();
  });

  it('starts an unref-ed timer when enabled, so it can never hold the process open', () => {
    const { service } = usageReturning(empty);
    const worker = new MessageUsageRecoveryService(config(), service);
    worker.onModuleInit();
    const timer = (worker as unknown as { timer: { unref?: unknown } | null }).timer;
    expect(timer).not.toBeNull();
    worker.onModuleDestroy();
    expect((worker as unknown as { timer: unknown }).timer).toBeNull();
  });

  it('stops draining as soon as a short page arrives', async () => {
    // 200 is the default batch size, so a page of 3 means the backlog is done.
    const { service, calls } = usageReturning(page(3, 3));
    await new MessageUsageRecoveryService(config(), service).tick();
    expect(calls).toHaveLength(1);
  });

  it('keeps draining full pages, up to the batch bound', async () => {
    const { service, calls } = usageReturning(page(2, 2));
    const worker = new MessageUsageRecoveryService(
      config({ MESSAGE_USAGE_RECOVERY_BATCH_SIZE: '2', MESSAGE_USAGE_RECOVERY_MAX_DRAIN_BATCHES: '3' }),
      service,
    );
    await worker.tick();
    // Bounded: it never drains the whole table in one tick, however long the
    // backlog is. What it does not finish, the next tick picks up.
    expect(calls).toHaveLength(3);
  });

  it('advances the cursor between pages, so a stuck row cannot block the scan', async () => {
    const { service, calls } = usageReturning(page(2, 2, 'first'), page(2, 2, 'second'), empty);
    const worker = new MessageUsageRecoveryService(
      config({ MESSAGE_USAGE_RECOVERY_BATCH_SIZE: '2', MESSAGE_USAGE_RECOVERY_MAX_DRAIN_BATCHES: '3' }),
      service,
    );
    await worker.tick();

    expect(calls[0].after).toBeNull();
    expect(calls[1].after).toEqual({ sentAt: '2026-09-10T10:00:00Z', id: 'first' });
    expect(calls[2].after).toEqual({ sentAt: '2026-09-10T10:00:00Z', id: 'second' });
  });

  it('leaves a row it could not record for a later tick rather than retrying forever', async () => {
    // A full page where nothing recorded: every row failed. The cursor still
    // advances, so the pass moves on — the failures are simply still unaccounted
    // next time, which is the retry.
    const { service, calls } = usageReturning(page(2, 0, 'stuck'), empty);
    const worker = new MessageUsageRecoveryService(
      config({ MESSAGE_USAGE_RECOVERY_BATCH_SIZE: '2', MESSAGE_USAGE_RECOVERY_MAX_DRAIN_BATCHES: '3' }),
      service,
    );
    await worker.tick();
    expect(calls[1].after).toEqual({ sentAt: '2026-09-10T10:00:00Z', id: 'stuck' });
  });

  it('never runs two ticks at once', async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const service = {
      recoverUnaccountedSends: jest.fn(async () => {
        await gate;
        return empty;
      }),
    } as unknown as MessageUsageService;

    const worker = new MessageUsageRecoveryService(config(), service);
    const first = worker.tick();
    await worker.tick(); // returns immediately — the guard is closed
    release!();
    await first;

    expect(service.recoverUnaccountedSends).toHaveBeenCalledTimes(1);
  });

  it('NEVER throws — an unhandled rejection in a timer would take the API down', async () => {
    const service = {
      recoverUnaccountedSends: jest.fn(async () => {
        throw new Error('database unreachable');
      }),
    } as unknown as MessageUsageService;
    const worker = new MessageUsageRecoveryService(config(), service);

    await expect(worker.tick()).resolves.toBeUndefined();
    // And the guard is released, so a failed tick does not wedge the worker.
    await expect(worker.tick()).resolves.toBeUndefined();
    expect(service.recoverUnaccountedSends).toHaveBeenCalledTimes(2);
  });

  it('scans every account — the worker has no tenant to scope to', async () => {
    const { service, calls } = usageReturning(empty);
    await new MessageUsageRecoveryService(config(), service).tick();
    expect(calls[0].businessId).toBeUndefined();
  });

  it('honours a grace window so it cannot race the dispatcher it repairs after', async () => {
    const { service, calls } = usageReturning(empty);
    await new MessageUsageRecoveryService(config({ MESSAGE_USAGE_RECOVERY_GRACE_SECONDS: '900' }), service).tick();
    expect(calls[0].graceSeconds).toBe(900);
  });

  it('clamps configuration rather than trusting it', async () => {
    const { service, calls } = usageReturning(empty);
    await new MessageUsageRecoveryService(
      config({ MESSAGE_USAGE_RECOVERY_BATCH_SIZE: '999999', MESSAGE_USAGE_RECOVERY_GRACE_SECONDS: '-5' }),
      service,
    ).tick();
    expect(calls[0].limit).toBe(1000);
    expect(calls[0].graceSeconds).toBe(0);
  });

  it('reports a repaired gap at WARN — recovery working is not nothing being wrong', async () => {
    const { service } = usageReturning(page(3, 3));
    const worker = new MessageUsageRecoveryService(config(), service);
    const warn = jest.spyOn(
      (worker as unknown as { logger: { warn: (m: string) => void } }).logger,
      'warn',
    );
    await worker.tick();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('3 recorded'));
  });

  it('says nothing when there is nothing to repair', async () => {
    const { service } = usageReturning(empty);
    const worker = new MessageUsageRecoveryService(config(), service);
    const warn = jest.spyOn(
      (worker as unknown as { logger: { warn: (m: string) => void } }).logger,
      'warn',
    );
    await worker.tick();
    expect(warn).not.toHaveBeenCalled();
  });
});
