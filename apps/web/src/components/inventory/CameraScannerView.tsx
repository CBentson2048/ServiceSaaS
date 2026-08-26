import { useCallback, useEffect, useRef, useState } from 'react';
import { AppButton } from '../../design/components';
import {
  CAMERA_BARCODE_FORMATS,
  CAMERA_CONSTRAINTS,
  CAMERA_ERROR_MESSAGES,
  CAMERA_SUPPORT_MESSAGES,
  ScanDebouncer,
  chooseBarcode,
  classifyCameraError,
  probeCameraSupport,
  stopStream,
  type DetectedBarcode,
} from './cameraScan';

/** Minimal shape of the browser's BarcodeDetector (not in lib.dom yet). */
interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<DetectedBarcode[]>;
}
type BarcodeDetectorCtor = new (options?: { formats?: readonly string[] }) => BarcodeDetectorLike;

const DETECT_INTERVAL_MS = 300;

/**
 * Live camera barcode capture (§14). The camera is started only when this view
 * mounts — i.e. only after the user chooses "Scan with camera" — and every
 * track is stopped on unmount, on error and after a successful detection, so
 * no stream outlives the dialog (§32). Frames are decoded in the browser by
 * BarcodeDetector; nothing is recorded, stored or uploaded.
 *
 * The component's only output is a barcode STRING handed to `onDetected`,
 * which then follows the identical lookup path as the wedge scanner.
 */
export function CameraScannerView({
  onDetected,
  onCancel,
}: {
  onDetected: (barcode: string) => void;
  onCancel: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const debouncerRef = useRef(new ScanDebouncer());
  const liveRef = useRef(true);
  const [status, setStatus] = useState<'starting' | 'scanning' | 'error'>('starting');
  const [message, setMessage] = useState<string | null>(null);

  const support = probeCameraSupport();

  const teardown = useCallback(() => {
    liveRef.current = false;
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    stopStream(streamRef.current);
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  useEffect(() => {
    if (!support.supported) {
      setStatus('error');
      setMessage(CAMERA_SUPPORT_MESSAGES[support.reason]);
      return;
    }

    liveRef.current = true;
    let cancelled = false;

    async function start() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia(CAMERA_CONSTRAINTS);
        if (cancelled || !liveRef.current) {
          stopStream(stream);
          return;
        }
        streamRef.current = stream;
        const video = videoRef.current;
        if (video) {
          video.srcObject = stream;
          // iOS Safari needs both to play an inline preview without controls.
          video.setAttribute('playsinline', 'true');
          video.muted = true;
          await video.play().catch(() => undefined);
        }

        const Detector = (globalThis as unknown as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;
        if (!Detector) {
          if (!cancelled) {
            setStatus('error');
            setMessage(CAMERA_SUPPORT_MESSAGES.no_detector);
          }
          teardown();
          return;
        }
        const detector = new Detector({ formats: CAMERA_BARCODE_FORMATS });
        // The dialog can close while permission is being granted; never touch
        // state (or keep a timer) after that.
        if (cancelled || !liveRef.current) {
          teardown();
          return;
        }
        setStatus('scanning');

        timerRef.current = setInterval(async () => {
          const element = videoRef.current;
          if (!element || element.readyState < 2 || !liveRef.current) return;
          try {
            const detections = await detector.detect(element);
            const code = chooseBarcode(detections);
            // One physical scan must be one lookup: repeated frames of the
            // same code inside the cooldown are ignored.
            if (code && debouncerRef.current.accept(code, Date.now()) && liveRef.current) {
              teardown();
              onDetected(code);
            }
          } catch {
            // A single undecodable frame is normal — keep scanning.
          }
        }, DETECT_INTERVAL_MS);
      } catch (error: unknown) {
        if (cancelled) return;
        setStatus('error');
        setMessage(CAMERA_ERROR_MESSAGES[classifyCameraError(error)]);
        teardown();
      }
    }

    void start();
    return () => {
      cancelled = true;
      teardown();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (status === 'error') {
    return (
      <div className="rounded-input-lg border border-warning-border bg-warning-soft px-3 py-3" role="alert">
        <p className="text-[13px] text-warning">{message}</p>
        <AppButton size="sm" variant="secondary" className="mt-2" onClick={onCancel}>
          Use the scanner field instead
        </AppButton>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="relative overflow-hidden rounded-input-lg border border-border bg-surface-ink">
        <video
          ref={videoRef}
          className="aspect-video w-full object-cover"
          playsInline
          muted
          aria-label="Camera preview for barcode scanning"
        />
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="h-24 w-3/4 rounded-input-lg border-2 border-white/70 shadow-[0_0_0_9999px_rgba(0,0,0,0.25)]" />
        </div>
      </div>
      <p className="text-[12px] text-text-secondary" role="status">
        {status === 'starting' ? 'Starting camera…' : 'Point the camera at the barcode.'}
      </p>
      <AppButton size="sm" variant="ghost" onClick={onCancel}>
        Cancel camera
      </AppButton>
    </div>
  );
}
