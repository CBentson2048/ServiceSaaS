import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { CrmClientSearchResult } from '@sheer/domain';
import { searchCrmClients } from '../../auth/api';
import { useAuth } from '../../auth/AuthProvider';
import { useDebounce } from '../../hooks/useDebounce';

/**
 * Live duplicate warning for new-client forms: as staff type an email or phone
 * number, the fuzzy client search runs behind the scenes and surfaces matching
 * existing clients BEFORE the form is submitted — preventing duplicates at the
 * moment they're about to be made instead of erroring afterwards. Renders
 * nothing while there is no plausible match.
 */
export function DuplicateClientHint({
  email,
  phone,
  onUse,
}: {
  email: string;
  phone: string;
  /** Offered as "Use this client" when provided (e.g. the booking flow). */
  onUse?: (client: CrmClientSearchResult) => void;
}) {
  const { session } = useAuth();
  const accessToken = session?.accessToken;
  const [matches, setMatches] = useState<CrmClientSearchResult[]>([]);
  // One debounced key for both fields so a burst of typing settles into a
  // single lookup round.
  const debounced = useDebounce(`${email.trim()}|${phone.trim()}`, 400);
  const reloadIdRef = useRef(0);

  useEffect(() => {
    if (!accessToken) return;
    const [emailTerm = '', phoneTerm = ''] = debounced.split('|');
    // Only search once a value is identity-shaped: an email with an @, or a
    // phone with enough digits to be more than a dialling-code prefix.
    const terms = [
      emailTerm.includes('@') ? emailTerm : '',
      phoneTerm.replace(/\D/g, '').length >= 7 ? phoneTerm : '',
    ].filter(Boolean);
    if (terms.length === 0) {
      reloadIdRef.current += 1;
      setMatches([]);
      return;
    }
    const requestId = ++reloadIdRef.current;
    void Promise.all(
      terms.map((term) =>
        searchCrmClients(accessToken, { q: term, pageSize: 3 }).catch(() => null),
      ),
    ).then((responses) => {
      if (requestId !== reloadIdRef.current) return;
      const byId = new Map<string, CrmClientSearchResult>();
      for (const response of responses) {
        for (const client of response?.results ?? []) byId.set(client.id, client);
      }
      setMatches([...byId.values()].slice(0, 2));
    });
  }, [accessToken, debounced]);

  if (matches.length === 0) return null;

  return (
    <div className="rounded-input-lg border border-border bg-surface-alt/60 px-4 py-3 text-[13px] sm:col-span-2">
      <p className="font-medium text-warning">
        {matches.length === 1 ? 'A client with these details already exists' : 'Clients with these details already exist'}
        {' '}— avoid creating a duplicate:
      </p>
      <ul className="mt-2 space-y-1.5">
        {matches.map((client) => (
          <li key={client.id} className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="font-medium text-text-primary">{client.displayName}</span>
            <span className="text-[12px] text-text-secondary">
              Q code {client.clientCode}
              {client.phone ? ` · ${client.phone}` : ''}
              {client.email ? ` · ${client.email}` : ''}
            </span>
            {onUse ? (
              <button
                type="button"
                onClick={() => onUse(client)}
                className="rounded-pill bg-primary px-3 py-1 text-[12px] font-semibold text-text-on-primary transition hover:bg-primary-deep"
              >
                Use this client
              </button>
            ) : null}
            <Link
              to={`/crm/clients/${client.id}`}
              className="text-[12px] font-medium text-primary hover:text-primary-deep"
            >
              Open record
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
