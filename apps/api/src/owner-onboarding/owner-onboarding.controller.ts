import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import type {
  BusinessSlugAvailabilityResponse,
  OwnerOnboardingBootstrap,
  OwnerOnboardingResponse,
} from '@sheer/domain';
import { CheckBusinessSlugDto, OwnerOnboardingRequestDto } from './dto';
import { OwnerOnboardingService } from './owner-onboarding.service';

@Controller('owner/onboarding')
export class OwnerOnboardingController {
  constructor(private readonly onboarding: OwnerOnboardingService) {}

  @Get('bootstrap')
  bootstrap(): OwnerOnboardingBootstrap {
    return this.onboarding.getBootstrap();
  }

  @Get('check-business-slug')
  async checkBusinessSlug(
    @Query() query: CheckBusinessSlugDto,
  ): Promise<BusinessSlugAvailabilityResponse> {
    return this.onboarding.checkBusinessSlug(query.slug);
  }

  @Post('register')
  async register(@Body() body: OwnerOnboardingRequestDto): Promise<OwnerOnboardingResponse> {
    return this.onboarding.register(body);
  }
}
