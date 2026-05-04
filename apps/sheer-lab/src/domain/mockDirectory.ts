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
  {
    salonId: 'salon-soho',
    stylistId: 'sty-aria',
    stylistName: 'Aria Stone',
    pinHash: 'lab_pin_scaffold_b68a7768',
    role: 'stylist',
  },
  {
    salonId: 'salon-soho',
    stylistId: 'sty-maya',
    stylistName: 'Maya Reed',
    pinHash: 'lab_pin_scaffold_3476503c',
    role: 'manager',
  },
  {
    salonId: 'salon-shoreditch',
    stylistId: 'sty-noor',
    stylistName: 'Noor Patel',
    pinHash: 'lab_pin_scaffold_8997838e',
    role: 'stylist',
  },
  {
    salonId: 'salon-shoreditch',
    stylistId: 'sty-jules',
    stylistName: 'Jules Hart',
    pinHash: 'lab_pin_scaffold_7b658f8a',
    role: 'manager',
  },
];

export function verifySalonScopedPin(salonId: string, pin: string): StylistSession | null {
  const pinHash = hashPinForScaffold(pin, salonId);
  const stylist = STYLIST_PINS.find(
    (record) => record.salonId === salonId && record.pinHash === pinHash,
  );

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

function hashPinForScaffold(pin: string, salonId: string): string {
  // TODO: move to the API and replace with Argon2/bcrypt plus server-side salt/pepper handling.
  let hash = 2166136261;

  for (const char of `${salonId}:${pin}`) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }

  return `lab_pin_scaffold_${(hash >>> 0).toString(16)}`;
}
