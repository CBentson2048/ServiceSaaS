import { Controller, Get } from '@nestjs/common';
import type { ApiHealthResponse, ApiReadinessResponse } from '@sheer/types';
import { HealthService } from './health.service';

@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get()
  getHealth(): ApiHealthResponse {
    return this.healthService.getHealth();
  }

  @Get('ready')
  getReadiness(): ApiReadinessResponse {
    return this.healthService.getReadiness();
  }
}
