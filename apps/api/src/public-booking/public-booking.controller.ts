import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import type {
  CreatePublicBookingResponse,
  PublicBookingAttemptResponse,
  PublicBookingAvailabilityResponse,
  PublicBookingLocationsResponse,
  PublicBookingServiceSelectionResponse,
  PublicBookingStylistsResponse,
  StartPublicBookingCheckoutResponse,
} from '@sheer/domain';
import {
  CreatePublicBookingDto,
  PublicBookingAttemptParamDto,
  PublicBookingAvailabilityQueryDto,
  PublicBookingSelectionQueryDto,
  PublicBookingStylistsQueryDto,
  StartPublicBookingCheckoutDto,
} from './dto';
import { PublicBookingService } from './public-booking.service';

@Controller('public/booking')
export class PublicBookingController {
  constructor(private readonly booking: PublicBookingService) {}

  @Get('locations')
  listLocations(): Promise<PublicBookingLocationsResponse> {
    return this.booking.listLocations();
  }

  @Get('selection')
  getServiceSelection(
    @Query() query: PublicBookingSelectionQueryDto,
  ): Promise<PublicBookingServiceSelectionResponse> {
    return this.booking.getServiceSelection(query);
  }

  @Get('stylists')
  getStylists(
    @Query() query: PublicBookingStylistsQueryDto,
  ): Promise<PublicBookingStylistsResponse> {
    return this.booking.getStylists(query);
  }

  @Get('availability')
  getAvailability(
    @Query() query: PublicBookingAvailabilityQueryDto,
  ): Promise<PublicBookingAvailabilityResponse> {
    return this.booking.getAvailability(query);
  }

  @Post('appointments')
  createAppointment(
    @Body() body: CreatePublicBookingDto,
  ): Promise<CreatePublicBookingResponse> {
    return this.booking.createAppointment(body);
  }

  @Post('start-checkout')
  startCheckout(
    @Body() body: StartPublicBookingCheckoutDto,
  ): Promise<StartPublicBookingCheckoutResponse> {
    return this.booking.startCheckout(body);
  }

  @Get('attempts/:id')
  getBookingAttempt(
    @Param() params: PublicBookingAttemptParamDto,
  ): Promise<PublicBookingAttemptResponse> {
    return this.booking.getBookingAttempt(params.id);
  }
}
