/**
 * The drawer is the surface every product edit happens on, so its dialog
 * behaviour is load-bearing for accessibility (§25): labelled, focus moved in
 * and returned, Tab trapped, Escape closes.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { Drawer } from './Drawer';

function renderDrawer(onClose = jest.fn()) {
  const utils = render(
    <>
      <button type="button">outside trigger</button>
      <Drawer open onClose={onClose} title="Edit product" description="Change the details">
        <button type="button">first</button>
        <input aria-label="middle" />
        <button type="button">last</button>
      </Drawer>
    </>,
  );
  return { ...utils, onClose };
}

describe('Drawer', () => {
  it('renders nothing when closed', () => {
    render(
      <Drawer open={false} onClose={jest.fn()} title="Hidden">
        <span>content</span>
      </Drawer>,
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('is an accessible dialog labelled by its title', () => {
    renderDrawer();
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-labelledby')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Edit product' })).toBeTruthy();
  });

  it('lands focus on the first CONTENT control, not the close button', () => {
    renderDrawer();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'first' }));
  });

  it('closes on Escape', () => {
    const { onClose } = renderDrawer();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('closes from the labelled close button and the overlay', () => {
    const onClose = jest.fn();
    renderDrawer(onClose);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId('drawer-overlay'));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('does not close when the panel itself is clicked', () => {
    const { onClose } = renderDrawer();
    fireEvent.click(screen.getByRole('dialog'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('traps Tab inside the panel', () => {
    renderDrawer();
    const last = screen.getByRole('button', { name: 'last' });
    // The close button is the first focusable in the panel, so the wrap
    // lands there — focus never escapes to the page behind.
    const close = screen.getByRole('button', { name: 'Close' });

    last.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(close);

    close.focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it('locks the page behind it and releases the lock on close', () => {
    const { unmount } = renderDrawer();
    expect(document.body.style.overflow).toBe('hidden');
    unmount();
    expect(document.body.style.overflow).not.toBe('hidden');
  });
});
