'use client';

import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';

export interface IdCardPatient {
  id: string;
  mrn: string;
  given_names: string[];
  family_name: string;
  birth_date: string;
  gender: string;
  blood_group?: string | null;
  photo_url?: string | null;
}

/**
 * Printable patient ID card with a scannable QR code.
 *
 * The QR encodes only the MRN, not a URL or any demographic detail: a card is
 * routinely dropped, photographed and left on desks, and an MRN alone is useless
 * without an authenticated session to look it up in.
 */
export function IdCard({
  patient,
  facilityName,
  onClose,
}: {
  patient: IdCardPatient;
  facilityName: string;
  onClose: () => void;
}) {
  const [qr, setQr] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    QRCode.toDataURL(patient.mrn, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 320,
      color: { dark: '#0f172a', light: '#ffffff' },
    })
      .then((url) => {
        if (!cancelled) setQr(url);
      })
      .catch(() => {
        if (!cancelled) setError('Could not generate the QR code');
      });
    return () => {
      cancelled = true;
    };
  }, [patient.mrn]);

  /**
   * Prints the card alone by opening a minimal document, rather than adding
   * print styles that would have to fight the app's own stylesheet.
   */
  const print = () => {
    const markup = cardRef.current?.innerHTML;
    if (!markup) return;
    const win = window.open('', '_blank', 'width=420,height=640');
    if (!win) {
      setError('Allow pop-ups to print the card');
      return;
    }
    win.document.write(`<!doctype html><html><head><title>${patient.mrn}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:ui-sans-serif,system-ui,sans-serif;padding:12mm;color:#0f172a}
  .card{width:86mm;height:54mm;border:1px solid #cbd5e1;border-radius:3mm;padding:4mm;
        display:flex;gap:4mm;align-items:center}
  .qr{width:26mm;height:26mm}
  .photo{width:18mm;height:22mm;object-fit:cover;border-radius:1.5mm;border:1px solid #cbd5e1}
  .name{font-size:11pt;font-weight:700}
  .meta{font-size:7.5pt;color:#475569;margin-top:1mm;line-height:1.5}
  .mrn{font-family:ui-monospace,monospace;font-size:9pt;font-weight:600;margin-top:1mm}
  .facility{font-size:6.5pt;text-transform:uppercase;letter-spacing:.05em;color:#64748b}
  @page{size:auto;margin:8mm}
</style></head><body>${markup}</body></html>`);
    win.document.close();
    win.focus();
    // Give the QR image a tick to decode before the print dialog freezes the page.
    setTimeout(() => win.print(), 250);
  };

  const fullName = `${patient.given_names.join(' ')} ${patient.family_name}`;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="idcard-title"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="w-full max-w-md rounded-t-xl bg-white p-4 shadow-xl sm:rounded-xl dark:bg-slate-800">
        <h2 id="idcard-title" className="text-lg font-bold">
          Patient ID card
        </h2>

        <div ref={cardRef} className="mt-3">
          <div className="card flex items-center gap-3 border-slate-300">
            {patient.photo_url ? (
              <img src={patient.photo_url} alt="" className="photo h-20 w-16 rounded object-cover" />
            ) : null}

            <div className="min-w-0 flex-1">
              <p className="facility text-[10px] uppercase tracking-wide text-slate-500">
                {facilityName}
              </p>
              <p className="name truncate font-bold">{fullName}</p>
              <p className="meta text-xs text-slate-600">
                {patient.birth_date.slice(0, 10)} · {patient.gender}
                {patient.blood_group && patient.blood_group !== 'unknown'
                  ? ` · ${patient.blood_group}`
                  : ''}
              </p>
              <p className="mrn font-mono text-sm font-semibold">{patient.mrn}</p>
            </div>

            {qr && <img src={qr} alt={`QR code for ${patient.mrn}`} className="qr size-24" />}
          </div>
        </div>

        <p className="mt-2 text-xs text-slate-500">
          The QR encodes the MRN only — no personal details are stored on the card.
        </p>

        {error && (
          <p className="mt-2 rounded bg-amber-50 px-3 py-2 text-sm text-amber-900" role="alert">
            {error}
          </p>
        )}

        <div className="mt-4 flex gap-2">
          <button type="button" className="btn-primary flex-1" onClick={print} disabled={!qr}>
            Print
          </button>
          <button type="button" className="btn-secondary flex-1" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
