/**
 * Camera scanning decisions (§14/§32), tested without a camera — every branch
 * a CI machine can never exercise for real is a pure function here.
 */
import {
  CAMERA_ERROR_MESSAGES,
  CAMERA_SUPPORT_MESSAGES,
  ScanDebouncer,
  chooseBarcode,
  classifyCameraError,
  evaluateCameraSupport,
  stopStream,
} from './cameraScan';

describe('support detection', () => {
  const supported = { hasMediaDevices: true, hasBarcodeDetector: true, isSecureContext: true };

  it('is supported when the browser has camera access and a decoder', () => {
    expect(evaluateCameraSupport(supported)).toEqual({ supported: true });
  });

  it('reports each missing capability distinctly, with usable advice', () => {
    expect(evaluateCameraSupport({ ...supported, isSecureContext: false })).toEqual({
      supported: false,
      reason: 'insecure_context',
    });
    expect(evaluateCameraSupport({ ...supported, hasMediaDevices: false })).toEqual({
      supported: false,
      reason: 'no_media_devices',
    });
    expect(evaluateCameraSupport({ ...supported, hasBarcodeDetector: false })).toEqual({
      supported: false,
      reason: 'no_detector',
    });
  });

  it('always points an unsupported browser back to the scanner or search', () => {
    for (const message of Object.values(CAMERA_SUPPORT_MESSAGES)) {
      expect(message.toLowerCase()).toMatch(/scanner field|search/);
    }
  });
});

describe('camera error classification', () => {
  it('separates a denied permission from a missing camera and a busy one', () => {
    expect(classifyCameraError({ name: 'NotAllowedError' })).toBe('permission_denied');
    expect(classifyCameraError({ name: 'SecurityError' })).toBe('permission_denied');
    expect(classifyCameraError({ name: 'NotFoundError' })).toBe('no_camera');
    expect(classifyCameraError({ name: 'OverconstrainedError' })).toBe('no_camera');
    expect(classifyCameraError({ name: 'NotReadableError' })).toBe('in_use');
  });

  it('falls back to a usable unknown state', () => {
    expect(classifyCameraError(new Error('boom'))).toBe('unknown');
    expect(classifyCameraError(undefined)).toBe('unknown');
    expect(CAMERA_ERROR_MESSAGES.unknown.length).toBeGreaterThan(0);
  });

  it('tells a blocked user how to recover', () => {
    expect(CAMERA_ERROR_MESSAGES.permission_denied).toMatch(/browser settings/i);
  });
});

describe('repeat-frame suppression', () => {
  it('accepts the first sighting of a code', () => {
    const debouncer = new ScanDebouncer(2500);
    expect(debouncer.accept('5010000000001', 1000)).toBe(true);
  });

  it('ignores the same code held in front of the lens', () => {
    const debouncer = new ScanDebouncer(2500);
    debouncer.accept('5010000000001', 1000);
    expect(debouncer.accept('5010000000001', 1300)).toBe(false);
    expect(debouncer.accept('5010000000001', 2000)).toBe(false);
  });

  it('accepts the same code again after the cooldown — a deliberate second scan', () => {
    const debouncer = new ScanDebouncer(2500);
    debouncer.accept('5010000000001', 1000);
    expect(debouncer.accept('5010000000001', 4000)).toBe(true);
  });

  it('accepts a different code immediately', () => {
    const debouncer = new ScanDebouncer(2500);
    debouncer.accept('5010000000001', 1000);
    expect(debouncer.accept('5010000000002', 1100)).toBe(true);
  });

  it('ignores empty detections', () => {
    expect(new ScanDebouncer().accept('   ', 1000)).toBe(false);
  });

  it('forgets its history on reset', () => {
    const debouncer = new ScanDebouncer(2500);
    debouncer.accept('5010000000001', 1000);
    debouncer.reset();
    expect(debouncer.accept('5010000000001', 1100)).toBe(true);
  });
});

describe('choosing between multiple barcodes in frame', () => {
  it('picks the largest — the one the user pointed at', () => {
    expect(
      chooseBarcode([
        { rawValue: 'small', boundingBox: { width: 10, height: 10 } },
        { rawValue: 'large', boundingBox: { width: 80, height: 40 } },
      ]),
    ).toBe('large');
  });

  it('handles a detector that reports no bounding box', () => {
    expect(chooseBarcode([{ rawValue: 'only' }])).toBe('only');
  });

  it('returns null when nothing usable was decoded', () => {
    expect(chooseBarcode([])).toBeNull();
    expect(chooseBarcode([{ rawValue: '   ' }])).toBeNull();
  });

  it('trims the decoded value', () => {
    expect(chooseBarcode([{ rawValue: ' 5010000000001 ' }])).toBe('5010000000001');
  });
});

describe('stream cleanup', () => {
  it('stops every track so the camera light goes out', () => {
    const stop = jest.fn();
    const stream = { getTracks: () => [{ stop }, { stop }] } as unknown as MediaStream;
    stopStream(stream);
    expect(stop).toHaveBeenCalledTimes(2);
  });

  it('tolerates a null stream and a track that already ended', () => {
    expect(() => stopStream(null)).not.toThrow();
    const throwing = {
      getTracks: () => [
        {
          stop() {
            throw new Error('already stopped');
          },
        },
      ],
    } as unknown as MediaStream;
    expect(() => stopStream(throwing)).not.toThrow();
  });
});
