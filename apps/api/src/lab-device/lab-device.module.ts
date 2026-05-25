import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { LabDeviceController } from './lab-device.controller';
import { LabDeviceService } from './lab-device.service';

@Module({
  imports: [AuthModule],
  controllers: [LabDeviceController],
  providers: [LabDeviceService],
  exports: [LabDeviceService],
})
export class LabDeviceModule {}
