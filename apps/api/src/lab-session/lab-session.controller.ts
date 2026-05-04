import { Body, Controller, Get, Post } from '@nestjs/common';
import { LabSessionIdDto, UnlockLabSessionDto } from './dto';
import { LabSessionService } from './lab-session.service';

@Controller('lab/session')
export class LabSessionController {
  constructor(private readonly labSessionService: LabSessionService) {}

  @Post('unlock')
  unlock(@Body() dto: UnlockLabSessionDto) {
    return this.labSessionService.unlock(dto);
  }

  @Post('heartbeat')
  heartbeat(@Body() dto: LabSessionIdDto) {
    return this.labSessionService.heartbeat(dto);
  }

  @Post('logout')
  logout(@Body() dto: LabSessionIdDto) {
    return this.labSessionService.logout(dto);
  }

  @Get('me')
  me() {
    return this.labSessionService.me();
  }
}
