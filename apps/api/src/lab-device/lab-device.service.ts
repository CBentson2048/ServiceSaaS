import { Injectable } from '@nestjs/common';
import type { SharedDevice } from '@sheer/domain';
import type { PairScaleDto, RegisterLabDeviceDto } from './dto';

@Injectable()
export class LabDeviceService {
  register(dto: RegisterLabDeviceDto): SharedDevice {
    // TODO: persist shared device registration and enforce one active Lab device per location.
    return {
      id: 'device_scaffold',
      businessId: dto.businessId,
      locationId: dto.locationId,
      deviceName: dto.deviceName,
      deviceType: 'ipad',
      stationLabel: dto.stationLabel,
      appMode: 'sheer_lab',
      status: 'registered',
      registeredAt: new Date().toISOString(),
    };
  }

  getStatus(): SharedDevice {
    // TODO: resolve device from trusted device token/header instead of request placeholder.
    return {
      id: 'device_scaffold',
      businessId: 'business_scaffold',
      locationId: 'location_scaffold',
      deviceName: 'Sheer Lab iPad',
      deviceType: 'ipad',
      stationLabel: 'Basin',
      appMode: 'sheer_lab',
      status: 'active',
      registeredAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
    };
  }

  pairScale(dto: PairScaleDto) {
    // TODO: store lab.device_pairings row and mark prior pairing revoked/disconnected transactionally.
    return {
      pairingStatus: 'paired',
      bleDeviceIdentifier: dto.bleDeviceIdentifier,
      bleDeviceName: dto.bleDeviceName,
      deviceModel: dto.deviceModel,
    };
  }

  unpairScale() {
    // TODO: mark active pairing as revoked and audit manager/device action.
    return { pairingStatus: 'unpaired' };
  }
}
