import { Buffer } from 'buffer';
import type { Device } from 'react-native-ble-plx';

import { logger } from '../../lib/logging/logger';
import type { AcaiaCharacteristicBinding, BleWeightReading } from './types';

const ACAIA_OLD_WEIGHT_CHARACTERISTIC = '00002a80-0000-1000-8000-00805f9b34fb';
const ACAIA_OLD_WEIGHT_CHARACTERISTIC_SHORT = '2a80';
const ACAIA_NEW_WRITE_CHARACTERISTIC = '49535343-8841-43f4-a8d4-ecbe34729bb3';
const ACAIA_NEW_READ_CHARACTERISTIC = '49535343-1e4d-4bd9-ba61-23c647249616';

const IDENTIFY = [
  0xef, 0xdd, 0x0b, 0x30, 0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x30, 0x31,
  0x32, 0x33, 0x34, 0x9a, 0x6d,
];
const HEARTBEAT = [0xef, 0xdd, 0x00, 0x02, 0x00, 0x02, 0x00];
const NOTIFICATION_REQUEST = [
  0xef, 0xdd, 0x0c, 0x09, 0x00, 0x01, 0x01, 0x02, 0x02, 0x05, 0x03, 0x04, 0x15, 0x06,
];

export const ACAIA_HEARTBEAT_INTERVAL_MS = 2750;

function normalizeUuid(uuid: string): string {
  return uuid.toLowerCase();
}

function matchesUuid(candidate: string, expected: string): boolean {
  const normalized = normalizeUuid(candidate);
  return normalized === expected || normalized === ACAIA_OLD_WEIGHT_CHARACTERISTIC_SHORT;
}

export async function discoverAcaiaCharacteristics(
  device: Device,
): Promise<AcaiaCharacteristicBinding> {
  const services = await device.services();

  for (const service of services) {
    const characteristics = await service.characteristics();
    const newRead = characteristics.find(
      (characteristic) => normalizeUuid(characteristic.uuid) === ACAIA_NEW_READ_CHARACTERISTIC,
    );
    const newWrite = characteristics.find(
      (characteristic) => normalizeUuid(characteristic.uuid) === ACAIA_NEW_WRITE_CHARACTERISTIC,
    );

    if (newRead && newWrite) {
      return {
        protocol: 'acaia-new',
        serviceUUID: service.uuid,
        readCharacteristicUUID: newRead.uuid,
        writeCharacteristicUUID: newWrite.uuid,
      };
    }

    const oldWeight = characteristics.find((characteristic) =>
      matchesUuid(characteristic.uuid, ACAIA_OLD_WEIGHT_CHARACTERISTIC),
    );

    if (oldWeight) {
      return {
        protocol: 'acaia-old',
        serviceUUID: service.uuid,
        readCharacteristicUUID: oldWeight.uuid,
        writeCharacteristicUUID: oldWeight.uuid,
      };
    }
  }

  throw new Error('No supported Acaia weight characteristics found');
}

export async function startAcaiaSession(
  device: Device,
  binding: AcaiaCharacteristicBinding,
): Promise<void> {
  await writeAcaiaCommand(device, binding, IDENTIFY, 'identify');
  await writeAcaiaCommand(device, binding, NOTIFICATION_REQUEST, 'notification-request');
}

export async function sendAcaiaHeartbeat(
  device: Device,
  binding: AcaiaCharacteristicBinding,
): Promise<void> {
  await writeAcaiaCommand(device, binding, HEARTBEAT, 'heartbeat');
}

export function decodeAcaiaWeightPacket(base64Payload: string): BleWeightReading | null {
  const bytes = [...Buffer.from(base64Payload, 'base64')];

  try {
    const newPacket = decodeNewAcaiaWeight(bytes);
    if (newPacket) return newPacket;

    const oldPacket = decodeOldAcaiaWeight(bytes);
    if (oldPacket) return oldPacket;
  } catch (error) {
    logger.warn('Acaia weight packet parse failed', {
      error: error instanceof Error ? error.message : String(error),
      bytes,
    });
  }

  return null;
}

async function writeAcaiaCommand(
  device: Device,
  binding: AcaiaCharacteristicBinding,
  command: number[],
  label: string,
): Promise<void> {
  const payload = Buffer.from(command).toString('base64');
  await device.writeCharacteristicWithResponseForService(
    binding.serviceUUID,
    binding.writeCharacteristicUUID,
    payload,
  );
  logger.info('Acaia command written', { label, protocol: binding.protocol });
}

function decodeNewAcaiaWeight(bytes: number[]): BleWeightReading | null {
  if ((bytes.length !== 13 && bytes.length !== 17) || bytes[4] !== 0x05) return null;

  const raw = ((bytes[6] ?? 0) << 8) + (bytes[5] ?? 0);
  const scale = 10 ** (bytes[9] ?? 0);
  const sign = (bytes[10] ?? 0) & 0x02 ? -1 : 1;

  return createBleReading((raw / scale) * sign, inferStability(bytes));
}

function decodeOldAcaiaWeight(bytes: number[]): BleWeightReading | null {
  if (bytes.length !== 10 && bytes.length !== 14) return null;

  const raw = ((bytes[3] ?? 0) << 8) + (bytes[2] ?? 0);
  const scale = 10 ** (bytes[6] ?? 0);
  const sign = (bytes[7] ?? 0) & 0x02 ? -1 : 1;

  return createBleReading((raw / scale) * sign, inferStability(bytes));
}

function createBleReading(grams: number, stable?: boolean): BleWeightReading {
  return {
    grams,
    unit: 'g',
    stable,
    source: 'ble',
    capturedAt: new Date().toISOString(),
  };
}

function inferStability(bytes: number[]): boolean | undefined {
  const candidate = bytes[11] ?? bytes[8];
  if (candidate === undefined) return undefined;

  return (candidate & 0x01) === 0x01;
}
