import { useCallback, useEffect, useRef, useState } from 'react';
import { LAB_INACTIVITY_TIMEOUT_MS } from '@sheer/auth';
import { shouldSuspendInactivityLock, type LabActivityEvent } from '@sheer/lab-core';

export function useLabInactivityLock(onLock: () => void) {
  const [lastActivityAt, setLastActivityAt] = useState(() => Date.now());
  const [isFormulaInteractionActive, setIsFormulaInteractionActive] = useState(false);
  const onLockRef = useRef(onLock);

  useEffect(() => {
    onLockRef.current = onLock;
  }, [onLock]);

  const recordActivity = useCallback((event: LabActivityEvent) => {
    setLastActivityAt(Date.now());
    setIsFormulaInteractionActive(shouldSuspendInactivityLock(event));
  }, []);

  useEffect(() => {
    const interval = setInterval(() => {
      if (isFormulaInteractionActive) {
        return;
      }

      if (Date.now() - lastActivityAt >= LAB_INACTIVITY_TIMEOUT_MS) {
        onLockRef.current();
      }
    }, 30_000);

    return () => clearInterval(interval);
  }, [isFormulaInteractionActive, lastActivityAt]);

  return {
    lastActivityAt,
    isFormulaInteractionActive,
    recordActivity,
  };
}
