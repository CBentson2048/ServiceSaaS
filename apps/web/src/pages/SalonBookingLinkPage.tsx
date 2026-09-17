import { Navigate, useParams } from 'react-router-dom';
import { bookingServicePath } from './bookingLinks';

/**
 * `/s/:salonCode` — the short booking link owners share. It only forwards to the
 * salon's service page; that page resolves the code, and shows the salon's own
 * "not found" / "online booking unavailable" message when the code is stale.
 */
export function SalonBookingLinkPage() {
  const { salonCode = '' } = useParams();
  return <Navigate to={bookingServicePath({ salonCode })} replace />;
}
