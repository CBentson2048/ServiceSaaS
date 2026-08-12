/**
 * One-off backfill for migration 0085 (stored itemised bills).
 *
 * Every visit already paid before the bills tables existed gets its bill
 * frozen now, through exactly the same snapshot path checkout uses — so the
 * bill finder and money reporting see complete history, not just visits paid
 * after the migration. Idempotent: visits that already have a bill are
 * skipped, and a re-run only picks up whatever previously failed.
 *
 * (Without this script, bills still self-heal one at a time: viewing a paid
 * visit's bill freezes it lazily. The backfill just does them all at once.)
 *
 * Usage (from apps/api, with SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY set):
 *   pnpm backfill-bills
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { LabAppointmentsService } from '../src/lab-appointments/lab-appointments.service';

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  try {
    const service = app.get(LabAppointmentsService);
    const result = await service.backfillBills();
    console.log(
      `Backfill complete: ${result.scanned} paid visits scanned, ` +
        `${result.created} bills created, ${result.failed} failed.`,
    );
    if (result.failed > 0) process.exitCode = 1;
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
