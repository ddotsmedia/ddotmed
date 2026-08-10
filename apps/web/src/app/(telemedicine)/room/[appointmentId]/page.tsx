'use client';

/**
 * The video consultation room.
 *
 * Mobile-first and deliberately plain: on a phone the call fills the screen and
 * there are two controls, join and hang up. Everything else — the countdown, the
 * permission prompt, the fallback — exists because a patient on a 4G connection
 * gets one attempt at this before they give up and telephone the clinic.
 *
 * The provider's prebuilt UI is embedded as an iframe rather than through
 * `@daily-co/daily-js`: the prebuilt call object is the same either way, and an
 * iframe keeps the room working when the SDK bundle cannot be fetched.
 */

import { use, useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api, ApiError } from '@/lib/api-client';
import { useI18n } from '@/lib/i18n';
import { useSession } from '@/lib/session';
import { QueryState } from '@/components/ui';

interface JoinPayload {
  appointment_id: string;
  session_id: string;
  provider: string;
  room_id: string;
  room_url: string;
  token: string | null;
  expires_at: string;
  role: 'patient' | 'practitioner' | null;
  is_host: boolean;
  is_mock: boolean;
  joinable: boolean;
  starts_at: string;
}

interface EndPayload {
  encounter_id: string | null;
  note_id: string | null;
  duration_seconds: number;
  already_ended: boolean;
}

type MediaState = 'idle' | 'requesting' | 'granted' | 'denied';

/** The prebuilt UI takes its meeting token on the query string. */
function embedUrl(join: JoinPayload): string {
  if (!join.token) return join.room_url;
  const separator = join.room_url.includes('?') ? '&' : '?';
  return `${join.room_url}${separator}t=${encodeURIComponent(join.token)}`;
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export default function TeleconsultRoomPage({
  params,
}: {
  params: Promise<{ appointmentId: string }>;
}) {
  const { appointmentId } = use(params);
  const { t, date } = useI18n();
  const { user, isRestoring } = useSession();
  const router = useRouter();

  // This route sits outside AppShell, so it has to own the signed-out redirect.
  useEffect(() => {
    if (!isRestoring && !user) router.replace('/login');
  }, [isRestoring, user, router]);

  const [joined, setJoined] = useState(false);
  const [media, setMedia] = useState<MediaState>('idle');
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const previewRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const join = useQuery<JoinPayload>({
    queryKey: ['teleconsult', 'token', appointmentId],
    queryFn: () => api.get<JoinPayload>('/telemedicine/token', { appointmentId }),
    enabled: Boolean(user),
    // The token expires with the room; do not serve a stale one from cache.
    staleTime: 0,
    retry: false,
  });

  const end = useMutation<EndPayload, Error>({
    mutationFn: () =>
      api.post<EndPayload>(`/telemedicine/sessions/${join.data!.session_id}/end`, {}),
  });

  // Release the camera whenever this screen goes away, however it goes away.
  const stopPreview = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  useEffect(() => stopPreview, [stopPreview]);

  useEffect(() => {
    if (!joined) return;
    const started = Date.now();
    const timer = window.setInterval(
      () => setElapsed(Math.floor((Date.now() - started) / 1000)),
      1000,
    );
    return () => window.clearInterval(timer);
  }, [joined]);

  /**
   * Asks for the camera and microphone before the call, not during it.
   *
   * A permission prompt that appears once the room is already loading is the most
   * common way a teleconsultation fails silently: the patient is in the room, and
   * nobody can hear them.
   */
  const requestMedia = useCallback(async () => {
    setMedia('requesting');
    setMediaError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      streamRef.current = stream;
      if (previewRef.current) previewRef.current.srcObject = stream;
      setMedia('granted');
    } catch (error) {
      setMedia('denied');
      setMediaError(
        error instanceof DOMException && error.name === 'NotAllowedError'
          ? 'Camera and microphone access was blocked. Allow it in your browser settings, then try again.'
          : 'No camera or microphone could be opened on this device.',
      );
    }
  }, []);

  const handleJoin = useCallback(async () => {
    if (media !== 'granted') await requestMedia();
    setJoined(true);
  }, [media, requestMedia]);

  /**
   * Hangs up, then sends the clinician to the chart.
   *
   * The redirect is the point: a consultation that ends on a "call ended" screen
   * is a consultation that gets written up from memory an hour later, if at all.
   */
  const handleEnd = useCallback(async () => {
    stopPreview();
    setJoined(false);
    try {
      const result = await end.mutateAsync();
      if (result.encounter_id && join.data?.role === 'practitioner') {
        router.push(`/encounters/${result.encounter_id}`);
        return;
      }
    } catch {
      // The call is over either way; a failed end call must not trap the user here.
    }
    router.push(join.data?.role === 'patient' ? '/portal' : '/appointments');
  }, [end, join.data?.role, router, stopPreview]);

  const data = join.data;
  const startsAt = data ? new Date(data.starts_at) : null;
  const minutesAway = startsAt ? Math.round((startsAt.getTime() - Date.now()) / 60_000) : 0;

  return (
    <main className="mx-auto flex min-h-dvh max-w-3xl flex-col p-3 sm:p-4">
      <header className="mb-3 flex flex-wrap items-center gap-2">
        <h1 className="text-lg font-bold text-slate-900 dark:text-slate-50">
          Video consultation
        </h1>
        {data?.is_mock && (
          <span className="rounded bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900">
            development mode
          </span>
        )}
        {joined && (
          <span className="ms-auto tabular-nums rounded bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-900">
            ● {formatDuration(elapsed)}
          </span>
        )}
      </header>

      <QueryState isLoading={join.isLoading} error={join.error}>
        {data && (
          <>
            {!joined ? (
              <section className="card">
                <p className="text-sm text-slate-600 dark:text-slate-300">
                  {startsAt && date(startsAt.toISOString(), true)}
                </p>
                <p className="mt-1 text-sm">
                  {data.role === 'practitioner'
                    ? 'You are the host of this consultation.'
                    : 'Your clinician will join this room.'}
                </p>

                {!data.joinable && minutesAway > 0 && (
                  <p className="mt-3 rounded bg-sky-50 px-3 py-2 text-sm text-sky-900" role="status">
                    This room opens 15 minutes before the appointment — about{' '}
                    {minutesAway - 15} minute{minutesAway - 15 === 1 ? '' : 's'} from now.
                  </p>
                )}

                <div className="mt-3 overflow-hidden rounded-lg bg-slate-900">
                  {/* Muted and playsInline so the self-view never fights the call audio. */}
                  <video
                    ref={previewRef}
                    className="aspect-video w-full object-cover"
                    autoPlay
                    playsInline
                    muted
                    aria-label="Camera preview"
                  />
                </div>

                {media !== 'granted' && (
                  <button
                    type="button"
                    className="btn-secondary mt-3 w-full"
                    onClick={() => void requestMedia()}
                    disabled={media === 'requesting'}
                  >
                    {media === 'requesting'
                      ? 'Waiting for permission…'
                      : 'Test camera and microphone'}
                  </button>
                )}

                {mediaError && (
                  <p className="mt-2 rounded bg-red-50 px-3 py-2 text-sm text-red-800" role="alert">
                    {mediaError}
                  </p>
                )}

                <button
                  type="button"
                  className="btn-primary mt-3 w-full py-3 text-base"
                  onClick={() => void handleJoin()}
                >
                  Join call
                </button>

                <Link
                  href={`/messages?appointmentId=${data.appointment_id}`}
                  className="btn-secondary mt-2 block w-full text-center"
                >
                  Send a message instead
                </Link>
              </section>
            ) : (
              <section className="flex min-h-0 flex-1 flex-col">
                {data.is_mock ? (
                  /* No provider credentials: the local preview stands in for the
                     call so the whole flow can be walked in development. */
                  <div className="flex flex-1 flex-col items-center justify-center rounded-lg bg-slate-900 p-4 text-center text-slate-200">
                    <video
                      ref={previewRef}
                      className="aspect-video w-full max-w-lg rounded object-cover"
                      autoPlay
                      playsInline
                      muted
                    />
                    <p className="mt-3 text-sm">
                      Mock room <span className="font-mono">{data.room_id}</span>
                    </p>
                    <p className="text-xs opacity-75">
                      Set DAILY_API_KEY to connect a real video provider.
                    </p>
                  </div>
                ) : (
                  <iframe
                    title="Video consultation"
                    src={embedUrl(data)}
                    className="min-h-[60vh] w-full flex-1 rounded-lg border-0 bg-slate-900"
                    allow="camera; microphone; fullscreen; speaker; display-capture; autoplay"
                  />
                )}

                <button
                  type="button"
                  className="btn-primary mt-3 w-full bg-red-600 py-3 text-base hover:bg-red-700"
                  onClick={() => void handleEnd()}
                  disabled={end.isPending}
                >
                  {end.isPending ? 'Ending…' : 'End call'}
                </button>
              </section>
            )}

            {end.isError && (
              <p className="mt-2 rounded bg-red-50 px-3 py-2 text-sm text-red-800" role="alert">
                {end.error instanceof ApiError ? end.error.message : t('errors.generic')}
              </p>
            )}
          </>
        )}
      </QueryState>
    </main>
  );
}
