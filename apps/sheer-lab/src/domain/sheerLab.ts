export interface BoundSalon {
  id: string;
  name: string;
  locationName: string;
  deviceLabel: string;
  boundAtIso: string;
}

export interface StylistSession {
  salonId: string;
  stylistId: string;
  stylistName: string;
  role: 'stylist' | 'manager';
  startedAtIso: string;
}

export interface SalonOption {
  id: string;
  name: string;
  locationName: string;
  deviceLabel: string;
}

export interface StylistPinRecord {
  salonId: string;
  stylistId: string;
  stylistName: string;
  pinHash: string;
  role: 'stylist' | 'manager';
}
