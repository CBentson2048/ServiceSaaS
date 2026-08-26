/**
 * Camera capture with the camera mocked (§14/§32/§33) — CI never needs a real
 * device. What matters: it starts only on demand, hands back a barcode string,
 * explains every failure, and always releases the stream.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CameraScannerView } from './CameraScannerView';

type Detect = jest.Mock<Promise<{ rawValue: string }[]>, [unknown]>;

function installCamera(options: {
  detect?: Detect;
  getUserMedia?: jest.Mock;
  withDetector?: boolean;
  secure?: boolean;
} = {}) {
  const stop = jest.fn();
  const stream = { getTracks: () => [{ stop }] };
  const getUserMedia = options.getUserMedia ?? jest.fn().mockResolvedValue(stream);
  Object.defineProperty(globalThis, 'isSecureContext', {
    configurable: true,
    value: options.secure ?? true,
  });
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia },
  });
  const detect: Detect = options.detect ?? (jest.fn().mockResolvedValue([]) as Detect);
  if (options.withDetector ?? true) {
    (globalThis as unknown as { BarcodeDetector: unknown }).BarcodeDetector = class {
      detect = detect;
    };
  } else {
    delete (globalThis as unknown as { BarcodeDetector?: unknown }).BarcodeDetector;
  }
  // jsdom has no media pipeline: pretend the preview has frames to decode.
  Object.defineProperty(HTMLMediaElement.prototype, 'readyState', { configurable: true, value: 4 });
  HTMLMediaElement.prototype.play = jest.fn().mockResolvedValue(undefined);
  return { getUserMedia, detect, stop };
}

afterEach(() => {
  jest.useRealTimers();
  delete (globalThis as unknown as { BarcodeDetector?: unknown }).BarcodeDetector;
});

describe('when the browser supports scanning', () => {
  it('requests the camera only once mounted — never on page load', async () => {
    const { getUserMedia } = installCamera();
    expect(getUserMedia).not.toHaveBeenCalled();
    render(<CameraScannerView onDetected={jest.fn()} onCancel={jest.fn()} />);
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(1));
    // Rear camera, no microphone.
    expect(getUserMedia).toHaveBeenCalledWith(expect.objectContaining({ audio: false }));
  });

  it('shows a labelled preview while scanning', async () => {
    installCamera();
    render(<CameraScannerView onDetected={jest.fn()} onCancel={jest.fn()} />);
    expect(await screen.findByLabelText('Camera preview for barcode scanning')).toBeTruthy();
  });

  it('hands a detected barcode back and stops the stream', async () => {
    jest.useFakeTimers();
    const detect = jest.fn().mockResolvedValue([{ rawValue: '5010000000001' }]) as Detect;
    const { stop } = installCamera({ detect });
    const onDetected = jest.fn();
    render(<CameraScannerView onDetected={onDetected} onCancel={jest.fn()} />);

    await Promise.resolve();
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(400);

    expect(onDetected).toHaveBeenCalledWith('5010000000001');
    // The camera must not keep running after a successful scan.
    expect(stop).toHaveBeenCalled();
  });

  it('reports one scan per code even though frames repeat', async () => {
    jest.useFakeTimers();
    const detect = jest.fn().mockResolvedValue([{ rawValue: '5010000000001' }]) as Detect;
    installCamera({ detect });
    const onDetected = jest.fn();
    render(<CameraScannerView onDetected={onDetected} onCancel={jest.fn()} />);

    await Promise.resolve();
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(1200);

    expect(onDetected).toHaveBeenCalledTimes(1);
  });

  it('releases the camera when the view unmounts', async () => {
    const { stop, getUserMedia } = installCamera();
    const { unmount } = render(<CameraScannerView onDetected={jest.fn()} onCancel={jest.fn()} />);
    await waitFor(() => expect(getUserMedia).toHaveBeenCalled());
    unmount();
    await waitFor(() => expect(stop).toHaveBeenCalled());
  });
});

describe('when scanning is not possible', () => {
  it('explains a browser without a barcode decoder and offers the scanner field', async () => {
    installCamera({ withDetector: false });
    render(<CameraScannerView onDetected={jest.fn()} onCancel={jest.fn()} />);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/cannot decode barcodes/i);
    expect(screen.getByRole('button', { name: /scanner field/i })).toBeTruthy();
  });

  it('explains an insecure page', async () => {
    installCamera({ secure: false });
    render(<CameraScannerView onDetected={jest.fn()} onCancel={jest.fn()} />);
    expect((await screen.findByRole('alert')).textContent).toMatch(/secure \(https\) connection/i);
  });

  it('explains a denied permission without pretending scanning failed', async () => {
    const denied = Object.assign(new Error('denied'), { name: 'NotAllowedError' });
    installCamera({ getUserMedia: jest.fn().mockRejectedValue(denied) });
    render(<CameraScannerView onDetected={jest.fn()} onCancel={jest.fn()} />);
    expect((await screen.findByRole('alert')).textContent).toMatch(/camera access was blocked/i);
  });

  it('explains a missing camera', async () => {
    const missing = Object.assign(new Error('none'), { name: 'NotFoundError' });
    installCamera({ getUserMedia: jest.fn().mockRejectedValue(missing) });
    render(<CameraScannerView onDetected={jest.fn()} onCancel={jest.fn()} />);
    expect((await screen.findByRole('alert')).textContent).toMatch(/no camera was found/i);
  });

  it('lets the user fall back to the scanner field', async () => {
    installCamera({ withDetector: false });
    const onCancel = jest.fn();
    render(<CameraScannerView onDetected={jest.fn()} onCancel={onCancel} />);
    fireEvent.click(await screen.findByRole('button', { name: /scanner field/i }));
    expect(onCancel).toHaveBeenCalled();
  });
});
