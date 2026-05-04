import type { SalonOption, StylistPinRecord, StylistSession } from './sheerLab';

export const SALON_OPTIONS: SalonOption[] = [
  {
    id: 'salon-soho',
    name: 'Sheer Soho',
    locationName: 'Soho Lab Bench',
    deviceLabel: 'Basin Tablet 01',
  },
  {
    id: 'salon-shoreditch',
    name: 'Sheer Shoreditch',
    locationName: 'Colour Bar',
    deviceLabel: 'Basin Tablet 02',
  },
];

const STYLIST_PINS: StylistPinRecord[] = [
  { salonId: 'salon-soho', stylistId: 'sty-aria', stylistName: 'Aria Stone', pin: '1234', role: 'stylist' },
  { salonId: 'salon-soho', stylistId: 'sty-maya', stylistName: 'Maya Reed', pin: '2468', role: 'manager' },
  { salonId: 'salon-shoreditch', stylistId: 'sty-noor', stylistName: 'Noor Patel', pin: '1234', role: 'stylist' },
  {
    salonId: 'salon-shoreditch',
    stylistId: 'sty-jules',
    stylistName: 'Jules Hart',
    pin: '8642',
    role: 'manager',
  },
];

export function verifySalonScopedPin(salonId: string, pin: string): StylistSession | null {
  const stylist = STYLIST_PINS.find((record) => record.salonId === salonId && record.pin === pin);

  if (!stylist) {
    return null;
  }

  return {
    salonId: stylist.salonId,
    stylistId: stylist.stylistId,
    stylistName: stylist.stylistName,
    role: stylist.role,
    startedAtIso: new Date().toISOString(),
  };
}
