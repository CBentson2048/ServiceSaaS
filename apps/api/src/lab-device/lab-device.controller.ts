import { Body, Controller, Get, Post } from '@nestjs/common';
import { PairScaleDto, RegisterLabDeviceDto } from './dto';
import { LabDeviceService } from './lab-device.service';

@Controller('lab/device')
export class LabDeviceController {
  constructor(private readonly labDeviceService: LabDeviceService) {}

  @Post('register')
  register(@Body() dto: RegisterLabDeviceDto) {
    return this.labDeviceService.register(dto);
  }

  @Get('status')
  getStatus() {
    return this.labDeviceService.getStatus();
  }

  @Post('pair-scale')
  pairScale(@Body() dto: PairScaleDto) {
    return this.labDeviceService.pairScale(dto);
  }

  @Post('unpair-scale')
  unpairScale() {
    return this.labDeviceService.unpairScale();
  }
}
