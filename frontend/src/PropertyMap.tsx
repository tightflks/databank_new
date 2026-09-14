import { useState } from 'react';
import { ExternalLink, MapPin } from 'lucide-react';

interface Props {
  name?: string;
  address: string;
  city?: string;
  zip?: string;
  state?: string;
}

// Address string Google Maps understands; the property name helps disambiguate rural addresses.
function mapQuery({ name, address, city, zip, state = 'GA' }: Props): string {
  return [address, city, [state, zip].filter(Boolean).join(' ')].filter((s) => s && s.trim()).join(', ') || (name ?? '');
}

function googleMapsUrl(p: Props): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(mapQuery(p))}`;
}

// "View on map" toggle with a keyless Google Maps embed (no API usage, no cost) and a link that
// opens the same address in Google Maps for directions / Street View.
export default function PropertyMap(p: Props) {
  const [open, setOpen] = useState(false);
  if (!p.address?.trim()) return null;
  const q = mapQuery(p);
  return (
    <div className="rounded-xl border border-gray-200 overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-2 bg-gray-50 text-sm">
        <button onClick={() => setOpen((o) => !o)} className="inline-flex items-center gap-1.5 font-semibold text-[#0b1f5c] hover:underline">
          <MapPin className="w-4 h-4" /> {open ? 'Hide map' : 'View on map'}
        </button>
        <span className="text-gray-400 truncate flex-1">{q}</span>
        <a href={googleMapsUrl(p)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-gray-600 hover:text-[#0b1f5c] shrink-0">
          Open in Google Maps <ExternalLink className="w-3.5 h-3.5" />
        </a>
      </div>
      {open && (
        <>
          <iframe
            title={`Map of ${q}`}
            src={`https://maps.google.com/maps?q=${encodeURIComponent(q)}&z=16&output=embed`}
            className="w-full h-64 sm:h-80 border-0"
            loading="lazy"
            referrerPolicy="no-referrer-when-downgrade"
          />
          <p className="px-4 py-1.5 text-xs text-gray-500 bg-white border-t border-gray-100">
            Map by Google Maps, located by address. The pin shows the closest match Google has for this address and may
            be a short distance from the property itself.
          </p>
        </>
      )}
    </div>
  );
}
