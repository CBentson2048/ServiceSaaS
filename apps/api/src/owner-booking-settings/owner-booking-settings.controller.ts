import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import type {
  AuthUser,
  LocationCommunicationSettingsResponse,
  OwnerBookingSettingsResponse,
  ServiceRequirementRuleResponse,
  ServiceUpgradeSuggestionResponse,
} from '@sheer/domain';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequireRoles, RolesGuard } from '../auth/roles.guard';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import {
  UpdateLocationCommunicationSettingsDto,
  UpsertServiceRequirementRuleDto,
  UpsertServiceUpgradeSuggestionDto,
} from './dto';
import { OwnerBookingSettingsService } from './owner-booking-settings.service';

@Controller('owner/booking-settings')
@UseGuards(SupabaseAuthGuard, RolesGuard)
@RequireRoles('owner')
export class OwnerBookingSettingsController {
  constructor(private readonly settings: OwnerBookingSettingsService) {}

  @Get()
  list(
    @CurrentUser() actor: AuthUser,
    @Query('locationId') locationId?: string,
  ): Promise<OwnerBookingSettingsResponse> {
    return this.settings.getSettings(actor, locationId);
  }

  @Put('communication')
  async updateCommunicationSettings(
    @CurrentUser() actor: AuthUser,
    @Body() body: UpdateLocationCommunicationSettingsDto,
  ): Promise<LocationCommunicationSettingsResponse> {
    return { settings: await this.settings.updateCommunicationSettings(actor, body) };
  }

  @Post('requirement-rules')
  async createRequirementRule(
    @CurrentUser() actor: AuthUser,
    @Body() body: UpsertServiceRequirementRuleDto,
  ): Promise<ServiceRequirementRuleResponse> {
    return { rule: await this.settings.createRequirementRule(actor, body) };
  }

  @Patch('requirement-rules/:id')
  async updateRequirementRule(
    @CurrentUser() actor: AuthUser,
    @Param('id') id: string,
    @Body() body: UpsertServiceRequirementRuleDto,
  ): Promise<ServiceRequirementRuleResponse> {
    return { rule: await this.settings.updateRequirementRule(actor, id, body) };
  }

  @Delete('requirement-rules/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteRequirementRule(
    @CurrentUser() actor: AuthUser,
    @Param('id') id: string,
  ): Promise<void> {
    return this.settings.deleteRequirementRule(actor, id);
  }

  @Post('upgrade-suggestions')
  async createUpgradeSuggestion(
    @CurrentUser() actor: AuthUser,
    @Body() body: UpsertServiceUpgradeSuggestionDto,
  ): Promise<ServiceUpgradeSuggestionResponse> {
    return { suggestion: await this.settings.createUpgradeSuggestion(actor, body) };
  }

  @Patch('upgrade-suggestions/:id')
  async updateUpgradeSuggestion(
    @CurrentUser() actor: AuthUser,
    @Param('id') id: string,
    @Body() body: UpsertServiceUpgradeSuggestionDto,
  ): Promise<ServiceUpgradeSuggestionResponse> {
    return { suggestion: await this.settings.updateUpgradeSuggestion(actor, id, body) };
  }

  @Delete('upgrade-suggestions/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteUpgradeSuggestion(
    @CurrentUser() actor: AuthUser,
    @Param('id') id: string,
  ): Promise<void> {
    return this.settings.deleteUpgradeSuggestion(actor, id);
  }
}
