'use client';

/**
 * Asynchronous messaging between a patient and the clinician on an appointment.
 *
 * The thread is scoped to one appointment, which is what keeps it clinically
 * useful: a question always arrives attached to the consultation it is about,
 * rather than as a loose message in an inbox nobody owns.
 *
 * Attachments never pass through the API. The browser asks for a presigned MinIO
 * URL, PUTs the file straight to the object store, and then posts the message
 * carrying only the object key.
 */

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { WS_EVENTS } from '@medicore/shared-types';
import { api, ApiError } from '@/lib/api-client';
import { useI18n } from '@/lib/i18n';
import { useSession } from '@/lib/session';
import { useChannel, useRealtime } from '@/lib/realtime';
import { PageHeader, QueryState, Field } from '@/components/ui';

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

interface ThreadMessage {
  id: string;
  sender_role: 'patient' | 'practitioner';
  is_mine: boolean;
  body: string | null;
  attachment_name: string | null;
  attachment_content_type: string | null;
  attachment_size_bytes: number | null;
  attachment_url: string | null;
  read_at: string | null;
  created_at: string;
}

interface Thread {
  appointment_id: string;
  viewer_role: 'patient' | 'practitioner';
  attachments_enabled: boolean;
  messages: ThreadMessage[];
}

interface AppointmentOption {
  id: string;
  start: string;
  service_type: string;
  status: string;
  is_telehealth: boolean;
  patient?: { given_names: string[]; family_name: string };
}

interface PresignedUpload {
  object_key: string;
  upload_url: string;
  expires_at: string;
  max_bytes: number;
  required_headers: Record<string, string>;
}

const humanSize = (bytes: number): string =>
  bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;

export default function MessagesPage() {
  return (
    // useSearchParams needs a boundary; without one the route cannot prerender.
    <Suspense fallback={null}>
      <MessagesScreen />
    </Suspense>
  );
}

function MessagesScreen() {
  const { t } = useI18n();
  const { user, isRestoring } = useSession();
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();

  // This route sits outside AppShell, so it has to own the signed-out redirect.
  useEffect(() => {
    if (!isRestoring && !user) router.replace('/login');
  }, [isRestoring, user, router]);

  const selected = searchParams.get('appointmentId');
  const isPatient = (user?.roles ?? []).includes('patient');

  const select = useCallback(
    (appointmentId: string) => router.replace(`/messages?appointmentId=${appointmentId}`),
    [router],
  );

  const appointments = useAppointmentOptions(isPatient, Boolean(user));

  // Land on the most recent appointment rather than an empty screen.
  useEffect(() => {
    if (selected || !appointments.data?.length) return;
    select(appointments.data[0].id);
  }, [selected, appointments.data, select]);

  return (
    <main className="mx-auto flex min-h-dvh max-w-3xl flex-col p-3 sm:p-4">
      <PageHeader
        title="Messages"
        subtitle="Questions and documents between appointments"
        actions={
          selected && (
            <Link href={`/room/${selected}`} className="btn-secondary">
              Video
            </Link>
          )
        }
      />

      <Field label="Appointment">
        <select
          className="input"
          value={selected ?? ''}
          onChange={(e) => select(e.target.value)}
          disabled={!appointments.data?.length}
        >
          {!selected && <option value="">Select an appointment</option>}
          {(appointments.data ?? []).map((a) => (
            <option key={a.id} value={a.id}>
              {new Date(a.start).toISOString().slice(0, 16).replace('T', ' ')} · {a.service_type}
              {a.patient ? ` · ${a.patient.given_names.join(' ')} ${a.patient.family_name}` : ''}
            </option>
          ))}
        </select>
      </Field>

      <QueryState
        isLoading={appointments.isLoading}
        error={appointments.error}
        isEmpty={!appointments.isLoading && (appointments.data ?? []).length === 0}
        emptyMessage="No appointments to message about yet."
      >
        {selected ? (
          <ThreadPanel appointmentId={selected} queryClient={queryClient} />
        ) : (
          <p className="card text-sm text-slate-500">{t('common.noData')}</p>
        )}
      </QueryState>
    </main>
  );
}

/**
 * The appointment list, from whichever endpoint the caller is entitled to.
 *
 * A patient reads their own portal summary; staff read the clinic diary. Neither
 * can see the other's, which is why this is not one call with a role flag.
 */
function useAppointmentOptions(isPatient: boolean, enabled: boolean) {
  const window = useMemo(() => {
    const from = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const to = new Date(Date.now() + 30 * 86_400_000).toISOString();
    return { from, to };
  }, []);

  return useQuery<AppointmentOption[]>({
    queryKey: ['messages', 'appointments', isPatient, window.from],
    enabled,
    queryFn: async () => {
      if (isPatient) {
        const summary = await api.get<{ appointments: AppointmentOption[] }>('/portal/summary');
        return summary.appointments;
      }
      const rows = await api.get<AppointmentOption[]>('/appointments', window);
      return [...rows].sort((a, b) => b.start.localeCompare(a.start));
    },
  });
}

function ThreadPanel({
  appointmentId,
  queryClient,
}: {
  appointmentId: string;
  queryClient: ReturnType<typeof useQueryClient>;
}) {
  const { t } = useI18n();
  const { on } = useRealtime();
  const [draft, setDraft] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const bottom = useRef<HTMLDivElement | null>(null);

  // Memoised so the socket subscription below is not torn down on every render.
  const queryKey = useMemo(() => ['messages', 'thread', appointmentId], [appointmentId]);

  const thread = useQuery<Thread>({
    queryKey,
    queryFn: () => api.get<Thread>('/messages', { appointmentId }),
    refetchInterval: 30_000,
  });

  // Live updates for this thread; the poll above is the fallback when the socket
  // is down, which on a hospital guest network it regularly is.
  useChannel(`appointment:${appointmentId}`);
  useEffect(
    () =>
      on<{ appointment_id: string }>(WS_EVENTS.MESSAGE_CREATED, (payload) => {
        if (payload.appointment_id !== appointmentId) return;
        void queryClient.invalidateQueries({ queryKey });
      }),
    [appointmentId, on, queryClient, queryKey],
  );

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [thread.data?.messages.length]);

  const send = useMutation<unknown, Error>({
    mutationFn: async () => {
      let attachment: Partial<{
        attachment_key: string;
        attachment_name: string;
        attachment_content_type: string;
        attachment_size_bytes: number;
      }> = {};

      if (file) {
        const presigned = await api.post<PresignedUpload>('/messages/attachments', {
          appointment_id: appointmentId,
          filename: file.name,
          content_type: file.type || 'application/octet-stream',
          size_bytes: file.size,
        });

        // Straight to MinIO: no session cookie, and exactly the signed headers.
        const upload = await fetch(presigned.upload_url, {
          method: 'PUT',
          headers: presigned.required_headers,
          body: file,
        });
        if (!upload.ok) {
          throw new Error(`The file could not be uploaded (${upload.status}).`);
        }

        attachment = {
          attachment_key: presigned.object_key,
          attachment_name: file.name,
          attachment_content_type: file.type || 'application/octet-stream',
          attachment_size_bytes: file.size,
        };
      }

      return api.post('/messages', {
        appointment_id: appointmentId,
        body: draft.trim() || undefined,
        ...attachment,
      });
    },
    onSuccess: () => {
      setDraft('');
      setFile(null);
      if (fileInput.current) fileInput.current.value = '';
      void queryClient.invalidateQueries({ queryKey });
    },
  });

  const pickFile = (chosen: File | null) => {
    setUploadError(null);
    if (chosen && chosen.size > MAX_ATTACHMENT_BYTES) {
      setUploadError(`Attachments are limited to 10 MB; that one is ${humanSize(chosen.size)}.`);
      if (fileInput.current) fileInput.current.value = '';
      return;
    }
    setFile(chosen);
  };

  const canSend = Boolean(draft.trim() || file) && !send.isPending;

  return (
    <section className="mt-3 flex min-h-0 flex-1 flex-col">
      <QueryState
        isLoading={thread.isLoading}
        error={thread.error}
        isEmpty={thread.data?.messages.length === 0}
        emptyMessage="No messages yet — send the first one."
      >
        <ul className="space-y-2">
          {(thread.data?.messages ?? []).map((message) => (
            <li
              key={message.id}
              className={
                message.is_mine
                  ? 'ms-auto max-w-[85%] rounded-lg bg-sky-600 px-3 py-2 text-white'
                  : 'me-auto max-w-[85%] rounded-lg bg-slate-100 px-3 py-2 dark:bg-slate-800'
              }
            >
              {message.body && <p className="whitespace-pre-wrap text-sm">{message.body}</p>}

              {message.attachment_name && (
                <a
                  href={message.attachment_url ?? undefined}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={`mt-1 flex items-center gap-2 text-xs underline ${
                    message.attachment_url ? '' : 'pointer-events-none opacity-60'
                  }`}
                >
                  <span aria-hidden>📎</span>
                  <span className="truncate">{message.attachment_name}</span>
                  {message.attachment_size_bytes !== null && (
                    <span className="opacity-75">
                      {humanSize(message.attachment_size_bytes)}
                    </span>
                  )}
                </a>
              )}

              <p
                className={`mt-1 text-[10px] ${
                  message.is_mine ? 'text-sky-100' : 'text-slate-500'
                }`}
              >
                {message.sender_role} ·{' '}
                {new Date(message.created_at).toISOString().slice(11, 16)}
              </p>
            </li>
          ))}
        </ul>
        <div ref={bottom} />
      </QueryState>

      <div className="sticky bottom-0 mt-3 border-t border-slate-200 bg-white pt-2 dark:border-slate-700 dark:bg-slate-900">
        <textarea
          className="input min-h-20"
          placeholder="Write a message"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          maxLength={5000}
        />

        {thread.data?.attachments_enabled === false ? (
          <p className="mt-1 text-xs text-slate-500">
            File attachments are unavailable — object storage is not configured.
          </p>
        ) : (
          <input
            ref={fileInput}
            type="file"
            className="mt-2 w-full text-xs"
            onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
            aria-label="Attach a file, 10 MB maximum"
          />
        )}

        {file && (
          <p className="mt-1 text-xs text-slate-600 dark:text-slate-300">
            {file.name} · {humanSize(file.size)}
            <button
              type="button"
              className="ms-2 text-sky-700 underline"
              onClick={() => pickFile(null)}
            >
              {t('common.cancel')}
            </button>
          </p>
        )}

        {(uploadError || send.isError) && (
          <p className="mt-2 rounded bg-red-50 px-3 py-2 text-sm text-red-800" role="alert">
            {uploadError ??
              (send.error instanceof ApiError ? send.error.message : send.error?.message)}
          </p>
        )}

        <button
          type="button"
          className="btn-primary mt-2 w-full"
          disabled={!canSend}
          onClick={() => send.mutate()}
        >
          {send.isPending ? 'Sending…' : 'Send'}
        </button>
      </div>
    </section>
  );
}
