/**
 * Camera barcode scanning decisions (§14/§32 of the redesign).
 *
 * The camera only ever produces a BARCODE STRING; it then joins the exact same
 * lookup/consumption path as the wedge scanner — there is no second inventory
 * implementation and no frame is uploaded anywhere.
 *
 * Detection uses the browser's built-in BarcodeDetector (Chrome/Edge/Android,
 * and Safari 17+ behind support checks). No barcode library is added: a decoder
 * bundle costs hundreds of KB for a capability the supported browsers already
 * expose, and every unsupported browser keeps the wedge/manual/search paths.
 *
 * DOM-free logic only — the component owns the <video> element and the stream.
 */

/** Formats worth trying: retail EANs/UPCs plus the CODE_128 most salons print. */
export const CAMERA_BARCODE_FORMATS = [
  'ean_13',
  'ean_8',
  'upc_a',
  'upc_e',
  'code_128',
  'code_39',
  'itf',
  'codabar',
] as const;

export type CameraSupport =
  | { supported: true }
  | { supported: false; reason: 'no_media_devices' | 'no_detector' | 'insecure_context' };

interface SupportProbe {
  hasMediaDevices: boolean;
  hasBarcodeDetector: boolean;
  isSecureContext: boolean;
}

/**
 * Camera capture needs getUserMedia AND a secure context (browsers refuse it on
 * plain http beyond localhost); decoding needs BarcodeDetector. Each failure is
 * reported distinctly so the UI can explain what to do instead of saying "not
 * supported".
 */
export function evaluateCameraSupport(probe: SupportProbe): CameraSupport {
  if (!probe.isSecureContext) return { supported: false, reason: 'insecure_context' };
  if (!probe.hasMediaDevices) return { supported: false, reason: 'no_media_devices' };
  if (!probe.hasBarcodeDetector) return { supported: false, reason: 'no_detector' };
  return { supported: true };
}

/** Probe the real browser globals. Safe to call during render (no side effects). */
export function probeCameraSupport(): CameraSupport {
  const nav = typeof navigator === 'undefined' ? undefined : navigator;
  return evaluateCameraSupport({
    hasMediaDevices: Boolean(nav?.mediaDevices?.getUserMedia),
    hasBarcodeDetector: typeof globalThis !== 'undefined' && 'BarcodeDetector' in globalThis,
    isSecureContext: typeof globalThis === 'undefined' ? false : globalThis.isSecureContext !== false,
  });
}

export const CAMERA_SUPPORT_MESSAGES: Record<Exclude<CameraSupport, { supported: true }>['reason'], string> = {
  insecure_context:
    'Camera scanning needs a secure (https) connection. Use the scanner field or search instead.',
  no_media_devices:
    'This device has no camera available to the browser. Use the scanner field or search instead.',
  no_detector:
    'This browser cannot decode barcodes from the camera. Chrome, Edge or Android Chrome can — meanwhile use the scanner field or search.',
};

export type CameraErrorKind = 'permission_denied' | 'no_camera' | 'in_use' | 'unknown';

export const CAMERA_ERROR_MESSAGES: Record<CameraErrorKind, string> = {
  permission_denied:
    'Camera access was blocked. Allow camera access in your browser settings, or use the scanner field or search.',
  no_camera: 'No camera was found on this device. Use the scanner field or search instead.',
  in_use: 'The camera is already in use by another app. Close it and try again.',
  unknown: 'The camera could not be started. Use the scanner field or search instead.',
};

/** Map a getUserMedia rejection to something a salon user can act on. */
export function classifyCameraError(error: unknown): CameraErrorKind {
  const name = typeof error === 'object' && error !== null && 'name' in error ? String((error as { name: unknown }).name) : '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'permission_denied';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'no_camera';
    case 'NotReadableError':
    case 'AbortError':
      return 'in_use';
    default:
      return 'unknown';
  }
}

/**
 * A camera sees the same barcode in dozens of consecutive frames. This gate
 * accepts the first sighting and then suppresses that code until either the
 * cooldown passes or a different code appears — so one physical scan is one
 * lookup, and holding a bottle in frame cannot spam the API.
 */
export class ScanDebouncer {
  private lastCode: string | null = null;
  private lastAt = 0;

  constructor(private readonly cooldownMs = 2500) {}

  /** True when this sighting should be treated as a NEW scan. */
  accept(code: string, now: number): boolean {
    const trimmed = code.trim();
    if (!trimmed) return false;
    if (trimmed === this.lastCode && now - this.lastAt < this.cooldownMs) return false;
    this.lastCode = trimmed;
    this.lastAt = now;
    return true;
  }

  reset(): void {
    this.lastCode = null;
    this.lastAt = 0;
  }
}

/**
 * Several barcodes can appear in one frame (a shelf of products). Picking the
 * largest detected area is the closest thing to "the one the user pointed at".
 */
export interface DetectedBarcode {
  rawValue: string;
  boundingBox?: { width: number; height: number };
}

export function chooseBarcode(detections: DetectedBarcode[]): string | null {
  const usable = detections.filter((detection) => detection.rawValue?.trim());
  if (usable.length === 0) return null;
  const best = usable.reduce((winner, candidate) => {
    const area = (candidate.boundingBox?.width ?? 0) * (candidate.boundingBox?.height ?? 0);
    const winnerArea = (winner.boundingBox?.width ?? 0) * (winner.boundingBox?.height ?? 0);
    return area > winnerArea ? candidate : winner;
  });
  return best.rawValue.trim();
}

/**
 * Stop every track on a stream. Called on success, on cancel and on unmount —
 * a camera light left on after a dialog closes is a privacy defect (§32).
 */
export function stopStream(stream: MediaStream | null | undefined): void {
  if (!stream) return;
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      // A track already ended by the browser throws; nothing left to release.
    }
  }
}

/** Rear camera on phones/tablets; the only camera on a desktop. */
export const CAMERA_CONSTRAINTS: MediaStreamConstraints = {
  video: { facingMode: { ideal: 'environment' } },
  audio: false,
};
