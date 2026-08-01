import { useEffect } from 'react';

/**
 * Sets the document title and meta description for a public page and restores
 * the previous values on unmount. The web app has no head-management library,
 * and index.html ships a single default title/description tuned for the
 * landing page — public routes call this hook to present route-specific
 * titles to search engines and browser tabs without affecting other routes.
 */
export function usePageMetadata(title: string, description: string) {
  useEffect(() => {
    const previousTitle = document.title;
    document.title = title;

    const meta = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    const created = meta ? null : document.createElement('meta');
    const tag = meta ?? created!;
    const previousDescription = meta ? meta.getAttribute('content') : null;
    if (created) {
      created.name = 'description';
      document.head.appendChild(created);
    }
    tag.setAttribute('content', description);

    return () => {
      document.title = previousTitle;
      if (created) {
        created.remove();
      } else if (previousDescription !== null) {
        tag.setAttribute('content', previousDescription);
      }
    };
  }, [title, description]);
}
