import axios from 'axios';

const API_URL = import.meta.env.VITE_API_URL || (import.meta.env.DEV ? 'http://localhost:3001' : '');

// Fetch the one-page property report as a PDF and hand it to the browser as a download.
export async function downloadReportPdf(type: string, id: string, name: string) {
  const res = await axios.get(`${API_URL}/api/dropbox/report.pdf`, { params: { type, id }, responseType: 'blob' });
  const url = URL.createObjectURL(res.data as Blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `databank-${(name || id).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')}.pdf`;
  a.click();
  URL.revokeObjectURL(url);
}
