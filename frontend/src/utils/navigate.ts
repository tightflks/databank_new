// Lightweight client-side navigation to a property's full page (/property/:type/:id), usable
// from anywhere without prop-drilling a callback through every component that can link to a
// property. App.tsx listens for 'popstate' and re-reads the URL, so dispatching a synthetic
// popstate after pushState is enough to make it pick up the change immediately.
export function propertyUrl(type: string, id: string): string {
  return `/property/${encodeURIComponent(type)}/${encodeURIComponent(id)}`;
}

export function navigateToProperty(type: string, id: string): void {
  window.history.pushState(null, '', propertyUrl(type, id));
  window.dispatchEvent(new PopStateEvent('popstate'));
  window.scrollTo({ top: 0 });
}
