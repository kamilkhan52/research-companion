import { useEffect, useState } from 'react';
import { apiBlob } from '@/api/client';

/** Load an image that sits behind authentication, as an object URL.
 *
 *  `<img src>` sends no Authorization header, so an authenticated image has to be fetched and
 *  handed to the DOM as a blob. That URL is owned by whoever created it and lives until it is
 *  revoked — so the revoke is the point of this hook, not an afterthought. Without it every
 *  cover a reader scrolls past is retained for the life of the page.
 *
 *  `path` of null means "nothing to load yet", which is the ordinary state while a render job
 *  is still running. */
export function useAuthenticatedImage(path: string | null): string | null {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!path) { setUrl(null); return; }
    let revoked = false;
    let created: string | null = null;
    void apiBlob(path)
      .then((blob) => {
        // Losing the race with unmount must still free the blob: the URL exists by now, and
        // dropping it on the floor is exactly the leak this hook is for.
        created = URL.createObjectURL(blob);
        if (revoked) { URL.revokeObjectURL(created); return; }
        setUrl(created);
      })
      .catch(() => { if (!revoked) setUrl(null); });
    return () => {
      revoked = true;
      if (created) URL.revokeObjectURL(created);
      setUrl(null);
    };
  }, [path]);

  return url;
}
