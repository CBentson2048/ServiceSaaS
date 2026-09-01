import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import {
  ClientSignalsController,
  DiarySignalsController,
  OperationalSignalReportController,
  OperationalSignalSettingsController,
} from './operational-signals.controller';
import { OperationalSignalsService } from './operational-signals.service';

/**
 * Operational & client intelligence signals (V1.1, Wrike 4507283793).
 *
 * DELIBERATELY A LEAF, and this is the mechanism behind the ticket's failure-
 * isolation requirement rather than a comment about it. This module imports Auth
 * and Audit only. Booking, StaffBooking, LabAppointments, Bills, Eod, Crm and
 * the Lab have no dependency on it, so signal code cannot execute inside a
 * booking, a check-in, a checkout or a till transaction. If every line here
 * threw, appointments would still be created and bills would still be settled.
 *
 * It is exported so the CRM client profile and the diary can embed signals in
 * payloads they already build — a one-way dependency, always through a
 * best-effort call site that degrades to "no signal" rather than failing the page.
 */
@Module({
  imports: [AuthModule, AuditModule],
  controllers: [
    ClientSignalsController,
    DiarySignalsController,
    OperationalSignalReportController,
    OperationalSignalSettingsController,
  ],
  providers: [OperationalSignalsService],
  exports: [OperationalSignalsService],
})
export class OperationalSignalsModule {}
