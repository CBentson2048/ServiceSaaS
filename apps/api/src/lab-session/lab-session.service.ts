import { Injectable } from '@nestjs/common';
import type { PinUnlockResponse } from '@sheer/domain';
import { LAB_INACTIVITY_TIMEOUT_MS } from '@sheer/auth';
import type { LabSessionIdDto, UnlockLabSessionDto } from './dto';

@Injectable()
export class LabSessionService {
  unlock(dto: UnlockLabSessionDto): PinUnlockResponse {
    // TODO: verify PIN hash scoped by dto.locationId and active shared device before creating session.
    void dto;

    return {
      sessionId: 'lab_session_scaffold',
      status: 'active',
      userProfileId: 'user_profile_scaffold',
      displayName: 'Stylist Scaffold',
      role: 'stylist',
      expiresAt: new Date(Date.now() + LAB_INACTIVITY_TIMEOUT_MS).toISOString(),
    };
  }

  heartbeat(dto: LabSessionIdDto) {
    // TODO: update lab.formula_sessions.last_activity_at and extend expires_at if session is valid.
    return {
      sessionId: dto.sessionId,
      lastActivityAt: new Date().toISOString(),
    };
  }

  logout(dto: LabSessionIdDto) {
    // TODO: mark lab.formula_sessions ended with end_reason = manual_logout and write audit event.
    return {
      sessionId: dto.sessionId,
      status: 'logged_out',
    };
  }

  me() {
    // TODO: resolve from Lab session token/header instead of returning null scaffold.
    return null;
  }
}
