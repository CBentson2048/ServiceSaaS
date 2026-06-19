import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import type {
  ResetServiceBillingRulesResponse,
  ServiceBillingRulesResponse,
  UpdateServiceBillingRulesResponse,
} from '@sheer/domain';

import { LabSessionService } from '../lab-session/lab-session.service';
import { UpdateServiceBillingRulesDto } from './dto';
import { LabBillingRulesService } from './lab-billing-rules.service';

// Sheer Lab station "Billing & Revenue Rules". Authenticated by the PIN lab
// session (sessionId in the URL), not a JWT — mirroring the lab inventory and
// lab formula controllers. The owner/manager gate is enforced in the service.
@Controller('lab/billing-rules/session')
export class LabBillingRulesController {
  constructor(
    private readonly service: LabBillingRulesService,
    private readonly labSessionService: LabSessionService,
  ) {}

  @Get(':sessionId/rules')
  async getRules(@Param('sessionId') sessionId: string): Promise<ServiceBillingRulesResponse> {
    const session = await this.labSessionService.assertActiveSession(sessionId);
    return this.service.getRulesForLabSession(session);
  }

  @Patch(':sessionId/rules')
  async updateRules(
    @Param('sessionId') sessionId: string,
    @Body() dto: UpdateServiceBillingRulesDto,
  ): Promise<UpdateServiceBillingRulesResponse> {
    const session = await this.labSessionService.assertActiveSession(sessionId);
    return this.service.updateRulesForLabSession(session, dto);
  }

  @Post(':sessionId/rules/reset')
  async resetRules(
    @Param('sessionId') sessionId: string,
  ): Promise<ResetServiceBillingRulesResponse> {
    const session = await this.labSessionService.assertActiveSession(sessionId);
    return this.service.resetRulesForLabSession(session);
  }
}
