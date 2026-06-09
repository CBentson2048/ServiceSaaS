import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import type { StaffBookingPaymentMode, StaffBookingSource } from '@sheer/domain';

const BOOKING_SOURCES: StaffBookingSource[] = ['walk_in', 'phone_booking', 'staff_booking'];
const PAYMENT_MODES: StaffBookingPaymentMode[] = [
  'pay_in_salon',
  'deposit_waived',
  'deposit_due',
  'paid_in_full',
  'no_deposit',
];

/**
 * Staff-side equivalents of the public booking query DTOs. Unlike the public
 * flow (which can resolve a location by business + location slug), the staff
 * flow always operates on a concrete `locationId` so the LocationScopeGuard can
 * enforce that it is inside the signed-in user's scope.
 */
export class StaffBookingSelectionQueryDto {
  @IsUUID()
  locationId!: string;
}

export class StaffBookingStylistsQueryDto extends StaffBookingSelectionQueryDto {
  @IsString()
  serviceIds!: string;
}

export class StaffBookingAvailabilityQueryDto extends StaffBookingStylistsQueryDto {
  @IsOptional()
  @IsUUID()
  stylistId?: string;

  @IsOptional()
  @IsIn(['true', 'false'])
  nextAvailable?: 'true' | 'false';

  @IsISO8601()
  dateFrom!: string;

  @IsISO8601()
  dateTo!: string;
}

export class CreateStaffBookingDto {
  @IsUUID()
  locationId!: string;

  @IsArray()
  @ArrayMinSize(1)
  @IsUUID(undefined, { each: true })
  serviceIds!: string[];

  @IsUUID()
  staffProfileId!: string;

  @IsISO8601()
  selectedStartAt!: string;

  @IsIn(['specific_staff', 'next_available'])
  staffRequestMode!: 'specific_staff' | 'next_available';

  @IsUUID()
  clientProfileId!: string;

  @IsIn(['whatsapp', 'sms', 'email'])
  communicationPreference!: 'whatsapp' | 'sms' | 'email';

  @IsIn(BOOKING_SOURCES)
  bookingSource!: StaffBookingSource;

  @IsIn(PAYMENT_MODES)
  paymentMode!: StaffBookingPaymentMode;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  clientNote?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  internalNote?: string;

  @IsOptional()
  @IsBoolean()
  sendConfirmation?: boolean;
}
