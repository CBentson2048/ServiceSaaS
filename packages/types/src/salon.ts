export interface SalonLocation {
  id: string;
  name: string;
  slug: string;
  addressLine1: string;
  addressLine2?: string;
  city: string;
  region?: string;
  postalCode: string;
  country: string;
  timezone: string;
  isActive: boolean;
}
