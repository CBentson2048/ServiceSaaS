import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  MethodNotAllowedException,
  Post,
  Query,
} from '@nestjs/common';
import type { AcceptStaffInvitationResponse, InvitationLookupResponse } from '@sheer/domain';
import { AcceptStaffInvitationDto, InspectInvitationQueryDto } from './dto';
import { StaffService } from './staff.service';

/**
 * Public endpoints used by the staff invitation acceptance flow.
 * No bearer token is required because the invitee does not yet have one.
 */
@Controller('staff/invitations')
export class StaffInvitationsController {
  constructor(private readonly staff: StaffService) {}

  @Get('inspect')
  inspect(@Query() query: InspectInvitationQueryDto): Promise<InvitationLookupResponse> {
    return this.staff.inspectInvitationByToken(query.token);
  }

  @Post('accept')
  accept(@Body() body: AcceptStaffInvitationDto): Promise<AcceptStaffInvitationResponse> {
    return this.staff.acceptInvitation(body);
  }

  /**
   * Friendly fallback so anyone who opens the accept URL directly in a
   * browser tab (e.g., copy/pasting the API path instead of the web invite
   * link) gets a clear 405 explaining where to go. The actual acceptance
   * is POST-only, by design — this route only exists to make debugging
   * the "Cannot GET ..." 404 obvious.
   */
  @Get('accept')
  @HttpCode(HttpStatus.METHOD_NOT_ALLOWED)
  acceptGetHint(): never {
    throw new MethodNotAllowedException(
      'POST /api/staff/invitations/accept is the only allowed method. ' +
        'Open your invitation by clicking the web URL provided by the business owner ' +
        '(e.g. http://localhost:5173/staff/accept-invite?token=...).',
    );
  }
}
