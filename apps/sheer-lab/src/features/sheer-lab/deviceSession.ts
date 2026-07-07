import type { LabDeviceRegistrationResponse, LabDeviceResolveResponse } from '@sheer/domain';

import { sheerApiClient } from '../../lib/api/client';
import {
  clearDeviceSession,
  loadDeviceSession,
  saveDeviceSession,
  SecureDeviceStorageUnavailableError,
} from '../../lib/storage/deviceSessionStorage';

export type DeviceResolutionState =
  | { status: 'resolving' }
  | { status: 'unregistered' }
  | { status: 'ready'; context: LabDeviceResolveResponse }
  | { status: 'disabled'; reason: string }
  | { status: 'registration_required'; reason: string };

interface RegisterDevicePayload {
  businessId: string;
  locationId: string;
  deviceName: string;
  stationLabel?: string;
}

export async function resolveStoredDeviceSession(): Promise<DeviceResolutionState> {
  logDeviceResolution('started');
  let stored;
  try {
    stored = await loadDeviceSession();
  } catch (err: unknown) {
    if (err instanceof SecureDeviceStorageUnavailableError) {
      logDeviceResolution('secure_storage_unavailable');
      return { status: 'registration_required', reason: err.message };
    }
    throw err;
  }
  if (!stored) {
    logDeviceResolution('token_not_found');
    return { status: 'unregistered' };
  }

  logDeviceResolution('token_found');
  try {
    const context = await sheerApiClient.labDevices.resolve(stored.deviceSessionToken);
    if (context.device.id !== stored.sharedDeviceId) {
      await clearDeviceSession();
      logDeviceResolution('token_cleared_mismatch');
      return { status: 'registration_required', reason: 'Device registration no longer matches this iPad.' };
    }
    if (context.device.status === 'inactive' || context.device.status === 'revoked') {
      logDeviceResolution('blocked_device');
      return { status: 'disabled', reason: `This Qlooqo Lab device is ${context.device.status}.` };
    }
    logDeviceResolution('resolved');
    return { status: 'ready', context };
  } catch (err: unknown) {
    await clearDeviceSessionSafely();
    logDeviceResolution('token_cleared_invalid');
    return {
      status: 'registration_required',
      reason: err instanceof Error ? err.message : 'Device registration could not be verified.',
    };
  }
}

export async function registerDeviceSession(payload: RegisterDevicePayload): Promise<LabDeviceResolveResponse> {
  return persistRegisteredDevice(await sheerApiClient.labDevices.register(payload));
}

export async function registerDeviceWithToken(deviceSessionToken: string): Promise<LabDeviceResolveResponse> {
  const context = await sheerApiClient.labDevices.resolve(deviceSessionToken.trim());
  await saveDeviceSession({
    sharedDeviceId: context.device.id,
    deviceSessionToken: deviceSessionToken.trim(),
  });
  return context;
}

export async function persistRegisteredDevice(response: LabDeviceRegistrationResponse): Promise<LabDeviceResolveResponse> {
  await saveDeviceSession({
    sharedDeviceId: response.device.id,
    deviceSessionToken: response.deviceSessionToken,
  });
  return {
    device: response.device,
    location: {
      id: response.device.locationId,
      name: 'Assigned location',
    },
  };
}

export async function resetStoredDeviceSession(): Promise<void> {
  await clearDeviceSessionSafely();
  logDeviceResolution('token_cleared_manual_reset');
}

async function clearDeviceSessionSafely(): Promise<void> {
  try {
    await clearDeviceSession();
  } catch (err: unknown) {
    if (!(err instanceof SecureDeviceStorageUnavailableError)) throw err;
  }
}

function logDeviceResolution(event: string): void {
  if (__DEV__) {
    // Do not include tokens or raw identifiers in startup diagnostics.
    console.info(`[sheer-lab-device] ${event}`);
  }
}
