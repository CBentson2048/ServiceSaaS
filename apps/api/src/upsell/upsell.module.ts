import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { UpsellRulesController, UpsellSuggestionsController } from './upsell.controller';
import { UpsellRulesService } from './upsell-rules.service';
import { UpsellSuggestionService } from './upsell-suggestion.service';

/**
 * Rule-based upsell suggestions (V1.1, Wrike 4507283916).
 *
 * DELIBERATELY A LEAF. This module imports Auth and Audit and nothing else, and
 * — just as deliberately — NO other module imports it. Booking (StaffBooking,
 * PublicBooking) and checkout (LabAppointments, Bills) have no dependency on
 * this one, so an upsell failure cannot reach a Tier 1 path: appointments are
 * still created and bills are still settled if every line of this module
 * throws. The UI fetches suggestions separately and simply renders nothing when
 * that call fails.
 *
 * `UpsellSuggestionService` is exported anyway, so a later surface (the mobile
 * app, a ZAC tool) consumes the SAME engine rather than re-deriving one — but
 * only as an additional reader, never from inside a booking or till transaction.
 */
@Module({
  imports: [AuthModule, AuditModule],
  controllers: [UpsellSuggestionsController, UpsellRulesController],
  providers: [UpsellSuggestionService, UpsellRulesService],
  exports: [UpsellSuggestionService],
})
export class UpsellModule {}
