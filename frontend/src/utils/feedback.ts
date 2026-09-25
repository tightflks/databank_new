// Lets any component open the feedback widget with context pre-filled (e.g. "Search returned
// no results for: ...") without prop-drilling through App.tsx down to FeedbackWidget, same
// pattern as utils/navigate.ts.
export function openFeedback(prefill?: string): void {
  window.dispatchEvent(new CustomEvent('databank:open-feedback', { detail: { prefill } }));
}
