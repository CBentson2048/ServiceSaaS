import { Navigate } from 'react-router-dom';
import { readClientBookingSelection } from './clientBookingFlow';

export function ClientBookingPreferencePage() {
  const selection = readClientBookingSelection();
  return <Navigate to={selection?.selectedSlot ? '/book/account' : '/book/date-time'} replace />;
}
