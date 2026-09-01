import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import type {
  AuthUser,
  ListUpsellRulesResponse,
  UpsellRuleResponse,
  UpsellSuggestionsResponse,
} from '@sheer/domain';
import { CurrentUser } from '../auth/current-user.decorator';
import { PermissionsGuard, RequirePermissions } from '../auth/permissions.guard';
import { RequireRoles, RolesGuard } from '../auth/roles.guard';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import {
  CreateUpsellRuleDto,
  DraftUpsellContextDto,
  ListUpsellRulesQueryDto,
  UpdateUpsellRuleDto,
} from './dto';
import { UpsellRulesService } from './upsell-rules.service';
import { UpsellSuggestionService } from './upsell-suggestion.service';

/**
 * Suggestion reads for staff at booking and checkout.
 *
 * Gated on `bookings.manage` — the permission that already means "this person
 * creates and manages appointments". Whoever may add a service to a booking may
 * be shown which one to offer; nobody else. Reading suggestions grants no
 * ability to change them.
 *
 * Every endpoint here is READ-ONLY. Adding an add-on goes through the existing
 * booking/checkout flow after a member of staff chooses it.
 */
@Controller('upsell/suggestions')
@UseGuards(SupabaseAuthGuard, RolesGuard, PermissionsGuard)
@RequireRoles('owner', 'manager', 'stylist')
@RequirePermissions('bookings.manage')
export class UpsellSuggestionsController {
  constructor(private readonly suggestions: UpsellSuggestionService) {}

  /** Suggestions for a saved appointment, in the booking screen. */
  @Get('appointment/:appointmentId')
  forBooking(
    @CurrentUser() actor: AuthUser,
    @Param('appointmentId', new ParseUUIDPipe()) appointmentId: string,
  ): Promise<UpsellSuggestionsResponse> {
    return this.suggestions.forAppointment(actor, appointmentId, 'booking');
  }

  /**
   * The same appointment context at checkout. The candidate set is identical —
   * only the staff-facing wording differs — because the services on the bill
   * ARE the appointment's service lines.
   */
  @Get('checkout/:appointmentId')
  forCheckout(
    @CurrentUser() actor: AuthUser,
    @Param('appointmentId', new ParseUUIDPipe()) appointmentId: string,
  ): Promise<UpsellSuggestionsResponse> {
    return this.suggestions.forAppointment(actor, appointmentId, 'checkout');
  }

  /**
   * Suggestions while a booking is still being built and has no id yet. POST
   * because the context is a body, not because anything is written — this
   * endpoint performs no mutation of any kind.
   */
  @Post('draft')
  @HttpCode(HttpStatus.OK)
  forDraft(
    @CurrentUser() actor: AuthUser,
    @Body() body: DraftUpsellContextDto,
  ): Promise<UpsellSuggestionsResponse> {
    return this.suggestions.forDraft(actor, body);
  }
}

/**
 * Owner configuration of the rules themselves.
 *
 * Separate controller because it is a different audience and a different gate:
 * `settings.booking.manage` plus the owner role (the service re-checks the role
 * independently). A stylist holding `bookings.manage` reaches the suggestions
 * controller above and gets nowhere near this one.
 */
@Controller('upsell/rules')
@UseGuards(SupabaseAuthGuard, RolesGuard, PermissionsGuard)
@RequireRoles('owner')
@RequirePermissions('settings.booking.manage')
export class UpsellRulesController {
  constructor(private readonly rules: UpsellRulesService) {}

  @Get()
  list(
    @CurrentUser() actor: AuthUser,
    @Query() query: ListUpsellRulesQueryDto,
  ): Promise<ListUpsellRulesResponse> {
    return this.rules.list(actor, query);
  }

  @Post()
  create(@CurrentUser() actor: AuthUser, @Body() body: CreateUpsellRuleDto): Promise<UpsellRuleResponse> {
    return this.rules.create(actor, body);
  }

  /** Also the enable/disable toggle: `{ "enabled": false }`. */
  @Patch(':ruleId')
  update(
    @CurrentUser() actor: AuthUser,
    @Param('ruleId', new ParseUUIDPipe()) ruleId: string,
    @Body() body: UpdateUpsellRuleDto,
  ): Promise<UpsellRuleResponse> {
    return this.rules.update(actor, ruleId, body);
  }

  @Delete(':ruleId')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @CurrentUser() actor: AuthUser,
    @Param('ruleId', new ParseUUIDPipe()) ruleId: string,
  ): Promise<void> {
    return this.rules.remove(actor, ruleId);
  }
}
