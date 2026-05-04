import { Injectable } from '@nestjs/common';
import type { AssignLabPinDto, PinStatusQueryDto, ResetLabPinDto } from './dto';

@Injectable()
export class LabPinService {
  assign(dto: AssignLabPinDto) {
    // TODO: hash PIN server-side, enforce uniqueness per location, and never persist raw PIN.
    return {
      businessId: dto.businessId,
      locationId: dto.locationId,
      userProfileId: dto.userProfileId,
      status: 'active',
    };
  }

  reset(dto: ResetLabPinDto) {
    // TODO: deactivate existing credential and audit manager/owner reset action.
    return {
      businessId: dto.businessId,
      locationId: dto.locationId,
      userProfileId: dto.userProfileId,
      status: 'rotation_required',
    };
  }

  status(query: PinStatusQueryDto) {
    // TODO: aggregate active/locked PIN credentials by location for manager tools.
    return {
      locationId: query.locationId ?? 'location_scaffold',
      activeCredentialCount: 0,
      lockedCredentialCount: 0,
    };
  }
}
