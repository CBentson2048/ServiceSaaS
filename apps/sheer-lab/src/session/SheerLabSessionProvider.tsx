import { useRouter } from 'expo-router';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { clearBoundSalon, readBoundSalon, writeBoundSalon } from './deviceBindingStorage';
import { verifySalonScopedPin } from '../domain/mockDirectory';
import type { BoundSalon, SalonOption, StylistSession } from '../domain/sheerLab';

interface PinResult {
  ok: boolean;
  message?: string;
}

interface SheerLabSessionValue {
  isHydrating: boolean;
  boundSalon: BoundSalon | null;
  stylistSession: StylistSession | null;
  bindSalon: (salon: SalonOption) => Promise<void>;
  unbindSalon: () => Promise<void>;
  signInWithPin: (pin: string) => Promise<PinResult>;
  signOutStylist: () => void;
}

const SheerLabSessionContext = createContext<SheerLabSessionValue | null>(null);

export function SheerLabSessionProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [isHydrating, setIsHydrating] = useState(true);
  const [boundSalon, setBoundSalon] = useState<BoundSalon | null>(null);
  const [stylistSession, setStylistSession] = useState<StylistSession | null>(null);

  useEffect(() => {
    let isMounted = true;

    readBoundSalon()
      .then((storedSalon) => {
        if (isMounted) {
          setBoundSalon(storedSalon);
        }
      })
      .finally(() => {
        if (isMounted) {
          setIsHydrating(false);
        }
      });

    return () => {
      isMounted = false;
    };
  }, []);

  const value = useMemo<SheerLabSessionValue>(
    () => ({
      isHydrating,
      boundSalon,
      stylistSession,
      bindSalon: async (salon) => {
        const nextSalon: BoundSalon = {
          ...salon,
          boundAtIso: new Date().toISOString(),
        };

        await writeBoundSalon(nextSalon);
        setBoundSalon(nextSalon);
        setStylistSession(null);
      },
      unbindSalon: async () => {
        await clearBoundSalon();
        setBoundSalon(null);
        setStylistSession(null);
      },
      signInWithPin: async (pin) => {
        if (!boundSalon) {
          return { ok: false, message: 'Bind this tablet to a salon before PIN login.' };
        }

        const session = verifySalonScopedPin(boundSalon.id, pin);

        if (!session) {
          return { ok: false, message: 'PIN not recognised for this salon.' };
        }

        setStylistSession(session);
        return { ok: true };
      },
      signOutStylist: () => {
        setStylistSession(null);
        router.replace('/locked');
      },
    }),
    [boundSalon, isHydrating, router, stylistSession],
  );

  return (
    <SheerLabSessionContext.Provider value={value}>{children}</SheerLabSessionContext.Provider>
  );
}

export function useSheerLabSession() {
  const context = useContext(SheerLabSessionContext);

  if (!context) {
    throw new Error('useSheerLabSession must be used inside SheerLabSessionProvider');
  }

  return context;
}
