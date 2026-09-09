import { useEffect, useState } from 'react';
import { apiBlob } from '@/api/client';

/** Load an image that sits behind authentication, as an object URL.
 *
 *  `<img src>` sends no Authorization header, so an authenticated image has to be fetched and
 *  handed to the DOM as a blob. That URL is owned by whoever created it and lives until it is
 *  revoked — so the revoke is the point of this hook, not an afterthought. Without it every
 *  image a reader scrolls past is retained for the life of the page.
 *
 *  `path` of null means "nothing to load yet", which is the ordinary state while a render job
 *  is still running.
 *
 *  The loaded URL is stored WITH the path it came from, and returned only while those still
 *  match. Clearing it on every transition instead would work too, and did — via three separate
 *  resets, none of which any single test could see, because each one alone was enough. Binding
 *  the URL to its path makes a stale image impossible rather than merely cleaned up: for one
 *  render after `path` changes, the old blob was still being returned under the new caller's
 *  identity, which for a library row is the wrong paper's first page beside the right title. */
export function useAuthenticatedImage(path: string | null): string | null {
  const [loaded, setLoaded] = useState<{ path: string; url: string } | null>(null);

  useEffect(() => {
    if (!path) return;
    let revoked = false;
    let created: string | null = null;
    void apiBlob(path)
      .then((blob) => {
        // Losing the race with unmount must still free the blob: the URL exists by now, and
        // dropping it on the floor is exactly the leak this hook is for.
        created = URL.createObjectURL(blob);
        if (revoked) { URL.revokeObjectURL(created); return; }
        setLoaded({ path, url: created });
      })
      .catch(() => { /* a missing image has nothing to say; the caller renders nothing */ });
    return () => {
      revoked = true;
      if (created) URL.revokeObjectURL(created);
    };
  }, [path]);

  return loaded && loaded.path === path ? loaded.url : null;
}
