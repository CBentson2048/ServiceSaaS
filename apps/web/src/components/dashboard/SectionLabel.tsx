import type { ReactNode } from 'react';
import { AppText } from '../../design';

export interface SectionLabelProps {
  children: ReactNode;
}

export function SectionLabel({ children }: SectionLabelProps) {
  return (
    <AppText
      as="div"
      variant="micro"
      weight="medium"
      tone="muted"
      uppercase
      className="mb-3 tracking-[0.1em]"
    >
      {children}
    </AppText>
  );
}
