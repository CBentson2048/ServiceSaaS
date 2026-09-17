/**
 * Every password field in the web app reveals through this component, either
 * directly (login, client create-account) or via TextField type="password"
 * (owner onboarding, invitation, reset, delete account).
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { TextField } from '../../components/onboarding/FormField';
import { PasswordInput } from './PasswordInput';

describe('PasswordInput', () => {
  it('starts hidden and toggles between hidden and shown', () => {
    render(<PasswordInput id="pw" aria-label="Password" defaultValue="hunter22" />);
    const input = screen.getByLabelText('Password');

    expect(input).toHaveProperty('type', 'password');

    fireEvent.click(screen.getByRole('button', { name: 'Show password' }));
    expect(input).toHaveProperty('type', 'text');
    expect(input).toHaveProperty('value', 'hunter22');

    fireEvent.click(screen.getByRole('button', { name: 'Hide password' }));
    expect(input).toHaveProperty('type', 'password');
  });

  it('does not submit the surrounding form when toggled', () => {
    const onSubmit = jest.fn((event: { preventDefault: () => void }) => event.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <PasswordInput aria-label="Password" />
      </form>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Show password' }));

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('keeps the mobile keyboard from capitalising a revealed password', () => {
    render(<PasswordInput aria-label="Password" />);
    const input = screen.getByLabelText('Password');

    expect(input.getAttribute('autocapitalize')).toBe('off');
    expect(input.getAttribute('autocorrect')).toBe('off');
    expect(input.getAttribute('spellcheck')).toBe('false');
  });

  it('disables the toggle with the input', () => {
    render(<PasswordInput aria-label="Password" disabled />);

    expect(screen.getByRole('button', { name: 'Show password' })).toHaveProperty('disabled', true);
  });
});

describe('TextField type="password"', () => {
  it('renders the reveal toggle outside the label', () => {
    render(<TextField label="Password" type="password" hint="At least 8 characters" />);
    const input = screen.getByLabelText('Password') as HTMLInputElement;
    const toggle = screen.getByRole('button', { name: 'Show password' });

    expect(input.labels).toHaveLength(1);
    expect(input.labels?.[0].textContent).toBe('Password');
    expect(input.labels?.[0].contains(toggle)).toBe(false);

    fireEvent.click(toggle);
    expect(input.type).toBe('text');
  });

  it('describes the control by its hint, then by its error', () => {
    const { rerender } = render(
      <TextField label="Password" type="password" hint="At least 8 characters" />,
    );
    const input = screen.getByLabelText('Password');
    const describedBy = () =>
      document.getElementById(input.getAttribute('aria-describedby') ?? '')?.textContent;

    expect(describedBy()).toBe('At least 8 characters');
    expect(input.getAttribute('aria-invalid')).toBeNull();

    rerender(
      <TextField
        label="Password"
        type="password"
        hint="At least 8 characters"
        error="Password must be at least 8 characters"
      />,
    );

    expect(describedBy()).toBe('Password must be at least 8 characters');
    expect(input.getAttribute('aria-invalid')).toBe('true');
  });

  it('leaves non-password fields as plain inputs without a toggle', () => {
    render(<TextField label="Email" type="email" />);

    expect(screen.getByLabelText('Email')).toHaveProperty('type', 'email');
    expect(screen.queryByRole('button')).toBeNull();
  });
});
