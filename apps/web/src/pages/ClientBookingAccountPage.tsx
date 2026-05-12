import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { AppButton, AppCard } from '../design';
import { ClientBookingShell } from './ClientBookingShell';
import { readClientBookingSelection, updateClientBookingSelection } from './clientBookingFlow';

type CommunicationPreference = 'whatsapp' | 'sms' | 'email';

export function ClientBookingAccountPage() {
  const navigate = useNavigate();
  const selection = readClientBookingSelection();
  const [preference, setPreference] = useState<CommunicationPreference>(
    selection?.communicationPreference ?? 'email',
  );

  if (!selection?.selectedSlot) return <Navigate to="/book/date-time" replace />;
  if (!selection.account || !selection.client) return <Navigate to="/login?booking=1" replace />;
  if (selection.communicationPreference) return <Navigate to="/book/review" replace />;

  function continueNext() {
    updateClientBookingSelection({ communicationPreference: preference });
    navigate('/book/review');
  }

  return (
    <ClientBookingShell
      title="Communication preference"
      step="Step 4 of 5"
      footer={
        <AppButton
          size="lg"
          fullWidth
          onClick={continueNext}
          className="min-h-12 bg-[#1C1628] text-white hover:bg-[#2A2139]"
        >
          Continue to review
        </AppButton>
      }
    >
      <h1 className="text-[18px] font-semibold leading-6">How should we contact you?</h1>
      <p className="mt-1 text-[12px] text-text-secondary">
        Choose a communication preference before reviewing your booking.
      </p>

      <div className="mt-6">
        <div className="text-[13px] font-semibold">Communication preference</div>
        <div className="mt-2 grid gap-2 md:grid-cols-3">
          {(['whatsapp', 'sms', 'email'] as CommunicationPreference[]).map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setPreference(option)}
              className="block w-full text-left"
            >
              <AppCard
                elevation="none"
                className={preference === option ? 'border-[1.5px] border-primary bg-primary/5' : 'border-border'}
              >
                <div className="text-[14px] font-semibold">{formatPreference(option)}</div>
              </AppCard>
            </button>
          ))}
        </div>
      </div>

    </ClientBookingShell>
  );
}

function formatPreference(value: CommunicationPreference): string {
  if (value === 'whatsapp') return 'WhatsApp';
  if (value === 'sms') return 'SMS';
  return 'Email';
}
