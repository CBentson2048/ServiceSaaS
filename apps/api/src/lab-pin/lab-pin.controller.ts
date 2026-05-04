import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { AssignLabPinDto, PinStatusQueryDto, ResetLabPinDto } from './dto';
import { LabPinService } from './lab-pin.service';

@Controller('lab/pins')
export class LabPinController {
  constructor(private readonly labPinService: LabPinService) {}

  @Post('assign')
  assign(@Body() dto: AssignLabPinDto) {
    return this.labPinService.assign(dto);
  }

  @Post('reset')
  reset(@Body() dto: ResetLabPinDto) {
    return this.labPinService.reset(dto);
  }

  @Get('status')
  status(@Query() query: PinStatusQueryDto) {
    return this.labPinService.status(query);
  }
}
