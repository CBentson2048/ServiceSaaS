import { Module } from '@nestjs/common';
import { LabPinController } from './lab-pin.controller';
import { LabPinService } from './lab-pin.service';

@Module({
  controllers: [LabPinController],
  providers: [LabPinService],
})
export class LabPinModule {}
