// Client redirect URI allowlist. Patterns look like scheme://host[:port][/path]
// where host, port, and path may contain `*`; a missing path allows any path.
// URIs are parsed and compared part by part so userinfo tricks
// (http://localhost@evil.example) cannot slip through.

const MAX_REDIRECT_URI_LENGTH = 2048;
const PATTERN_RE = /^([a-z][a-z0-9+.-]*):\/\/([^/]*)(\/.*)?$/i;

function globToRegExp(glob: string, starPattern: string): RegExp {
  const escaped = glob
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replaceAll('*', starPattern);
  return new RegExp(`^${escaped}$`, 'i');
}

function matchesPattern(url: URL, pattern: string): boolean {
  const match = PATTERN_RE.exec(pattern);
  if (!match) return false;
  const [, scheme = '', hostPort = '', path] = match;
  if (url.protocol.toLowerCase() !== `${scheme.toLowerCase()}:`) return false;
  if (!globToRegExp(hostPort, '[^/]*').test(url.host)) return false;
  return path === undefined || globToRegExp(path, '.*').test(url.pathname);
}

/**
 * Reports whether `uri` is absolute, free of userinfo and fragment, and
 * matched by one of the glob `patterns`.
 */
export function isAllowedRedirect(
  uri: string,
  patterns: readonly string[],
): boolean {
  if (uri.length > MAX_REDIRECT_URI_LENGTH) return false;
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.username || url.password || url.hash) return false;
  return patterns.some(pattern => matchesPattern(url, pattern));
}
