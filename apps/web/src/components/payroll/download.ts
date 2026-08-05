import type { BlobDownload } from '../../auth/api';

/**
 * Hand a fetched export to the browser as a file download. The server's
 * Content-Disposition name wins when present; the caller supplies a sensible
 * fallback for when it isn't.
 */
export function saveDownload(download: BlobDownload, fallbackName: string): void {
  const url = URL.createObjectURL(download.blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = download.filename ?? fallbackName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

/** "Jess Barnes-O'Neill" → "jess-barnes-o-neill" for filenames. */
export function filenameSlug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'export'
  );
}
