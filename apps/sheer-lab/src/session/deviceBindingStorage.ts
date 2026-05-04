import type { BoundSalon } from '../domain/sheerLab';

const BOUND_SALON_KEY = '@sheer-lab/bound-salon';
let memoryBoundSalon: string | null = null;

export async function readBoundSalon(): Promise<BoundSalon | null> {
  const rawValue = getStorageValue();

  if (!rawValue) {
    return null;
  }

  return JSON.parse(rawValue) as BoundSalon;
}

export async function writeBoundSalon(salon: BoundSalon): Promise<void> {
  setStorageValue(JSON.stringify(salon));
}

export async function clearBoundSalon(): Promise<void> {
  removeStorageValue();
}

function getStorageValue(): string | null {
  if (typeof localStorage !== 'undefined') {
    return localStorage.getItem(BOUND_SALON_KEY);
  }

  return memoryBoundSalon;
}

function setStorageValue(value: string): void {
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(BOUND_SALON_KEY, value);
    return;
  }

  memoryBoundSalon = value;
}

function removeStorageValue(): void {
  if (typeof localStorage !== 'undefined') {
    localStorage.removeItem(BOUND_SALON_KEY);
    return;
  }

  memoryBoundSalon = null;
}
