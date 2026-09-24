import { useEffect, useState } from 'react';

export interface Route {
  readonly page: string;
  readonly params: URLSearchParams;
}

function current(): Route {
  const [path = '', query = ''] = window.location.hash.replace(/^#\/?/, '').split('?');
  return { page: path || 'home', params: new URLSearchParams(query) };
}

/** A tiny hash router: `#/studio?hcrn=…` → { page: 'studio', params }. */
export function useRoute(): Route {
  const [route, setRoute] = useState(current);
  useEffect(() => {
    const update = () => {
      setRoute(current());
      window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);
  return route;
}

export function href(page: string, params: Record<string, string | number | undefined> = {}): string {
  const query = new URLSearchParams(
    Object.entries(params).filter((entry): entry is [string, string | number] => entry[1] !== undefined).map(([k, v]) => [k, String(v)]),
  ).toString();
  return `#/${page}${query ? `?${query}` : ''}`;
}
