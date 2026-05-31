import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import type { AuthUser } from '@sheer/domain';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequireRoles, RolesGuard } from '../auth/roles.guard';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { LabSessionService } from '../lab-session/lab-session.service';
import {
  AddFormulaItemDto,
  CaptureWeightDto,
  DuplicateFormulaDto,
  SaveFormulaDto,
  StartFormulaDto,
} from './dto';
import { LabFormulaService } from './lab-formula.service';

@Controller('lab/formulas')
@UseGuards(SupabaseAuthGuard, RolesGuard)
@RequireRoles('owner', 'manager', 'stylist')
export class LabFormulaController {
  constructor(private readonly labFormulaService: LabFormulaService) {}

  @Post('start')
  start(@CurrentUser() actor: AuthUser, @Body() dto: StartFormulaDto) {
    return this.labFormulaService.start(actor, dto);
  }

  @Get('client/:clientProfileId/latest')
  latestForClient(@CurrentUser() actor: AuthUser, @Param('clientProfileId') clientProfileId: string) {
    return this.labFormulaService.latestForClient(actor, clientProfileId);
  }

  @Get('client/:clientProfileId/history')
  historyForClient(@CurrentUser() actor: AuthUser, @Param('clientProfileId') clientProfileId: string) {
    return this.labFormulaService.historyForClient(actor, clientProfileId);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.labFormulaService.get(id);
  }

  @Post(':id/items')
  addItem(@Param('id') id: string, @Body() dto: AddFormulaItemDto) {
    return this.labFormulaService.addItem(id, dto);
  }

  @Post(':id/capture-weight')
  captureWeight(@Param('id') id: string, @Body() dto: CaptureWeightDto) {
    return this.labFormulaService.captureWeight(id, dto);
  }

  @Post(':id/finish-mixing')
  finishMixing(@Param('id') id: string) {
    return this.labFormulaService.finishMixing(id);
  }

  @Post(':id/save')
  save(@CurrentUser() actor: AuthUser, @Param('id') id: string, @Body() dto: SaveFormulaDto) {
    return this.labFormulaService.save(actor, id, dto);
  }

  @Post(':id/recalculate')
  recalculate(@Param('id') id: string) {
    return this.labFormulaService.recalculate(id);
  }

  @Post(':id/duplicate')
  duplicate(@CurrentUser() actor: AuthUser, @Param('id') id: string, @Body() dto: DuplicateFormulaDto) {
    return this.labFormulaService.duplicate(actor, id, dto);
  }
}

@Controller('lab/formulas/session')
export class LabSessionFormulaController {
  constructor(
    private readonly labFormulaService: LabFormulaService,
    private readonly labSessionService: LabSessionService,
  ) {}

  @Get(':sessionId/product-billing')
  async productBilling(@Param('sessionId') sessionId: string) {
    const session = await this.labSessionService.assertActiveSession(sessionId);
    return { settings: await this.labFormulaService.getProductBillingSettingsForLabSession(session) };
  }

  @Post(':sessionId/:id/finalize')
  async finalize(
    @Param('sessionId') sessionId: string,
    @Param('id') id: string,
    @Body() dto: SaveFormulaDto,
  ) {
    const session = await this.labSessionService.assertActiveSession(sessionId);
    return this.labFormulaService.finalizeForLabSession(session, id, dto);
  }
}
