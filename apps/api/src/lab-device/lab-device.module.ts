import { Module } from '@nestjs/common';
import { LabDeviceController } from './lab-device.controller';
import { LabDeviceService } from './lab-device.service';

@Module({
  controllers: [LabDeviceController],
  providers: [LabDeviceService],
  exports: [LabDeviceService],
})
export class LabDeviceModule {}
