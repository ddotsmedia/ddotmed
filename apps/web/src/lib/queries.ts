'use client';

import { useMutation, useQuery, useQueryClient, type UseQueryOptions } from '@tanstack/react-query';
import type { Paginated } from '@medicore/shared-types';
import { api } from './api';

/** Query key factory — every key is derived here so invalidation stays consistent. */
export const keys = {
  patients: (params?: unknown) => ['patients', params] as const,
  patient: (id: string) => ['patient', id] as const,
  timeline: (id: string) => ['patient', id, 'timeline'] as const,
  allergies: (patientId: string) => ['allergies', patientId] as const,
  medications: (patientId: string) => ['medications', patientId] as const,
  vitals: (patientId: string) => ['vitals', patientId] as const,
  vitalsTrend: (patientId: string) => ['vitals', patientId, 'trend'] as const,
  encounter: (id: string) => ['encounter', id] as const,
  encounters: (patientId: string) => ['encounters', patientId] as const,
  notes: (encounterId: string) => ['notes', encounterId] as const,
  labResults: (patientId: string) => ['lab', 'results', patientId] as const,
  labWorklist: () => ['lab', 'worklist'] as const,
  labCritical: () => ['lab', 'critical'] as const,
  radiologyWorklist: () => ['radiology', 'worklist'] as const,
  pharmacyQueue: () => ['pharmacy', 'queue'] as const,
  emar: (patientId: string) => ['pharmacy', 'emar', patientId] as const,
  bedBoard: (ward?: string) => ['beds', 'board', ward] as const,
  housekeeping: () => ['beds', 'housekeeping'] as const,
  appointments: (params?: unknown) => ['appointments', params] as const,
  availability: (params?: unknown) => ['appointments', 'availability', params] as const,
  queue: (name: string) => ['queue', name] as const,
  invoices: (params?: unknown) => ['invoices', params] as const,
  invoice: (id: string) => ['invoice', id] as const,
  denials: () => ['claims', 'denials'] as const,
  inventory: (params?: unknown) => ['inventory', params] as const,
  reorder: () => ['inventory', 'reorder'] as const,
  roster: (params?: unknown) => ['hr', 'roster', params] as const,
  nurseRatios: () => ['hr', 'nurse-ratios'] as const,
  expiringCredentials: () => ['hr', 'credentials', 'expiring'] as const,
  audit: (params?: unknown) => ['audit', params] as const,
};

type Options<T> = Omit<UseQueryOptions<T, Error, T, readonly unknown[]>, 'queryKey' | 'queryFn'>;

export function usePatients(params: Record<string, string | number | undefined>, options?: Options<Paginated<PatientRow>>) {
  return useQuery({
    queryKey: keys.patients(params),
    queryFn: () => api.get<Paginated<PatientRow>>('/patients', params),
    ...options,
  });
}

export interface PatientRow {
  id: string;
  mrn: string;
  given_names: string[];
  family_name: string;
  gender: string;
  birth_date: string;
  is_vip: boolean;
}

export function usePatient(id: string, options?: Options<Record<string, unknown>>) {
  return useQuery({
    queryKey: keys.patient(id),
    queryFn: () => api.get<Record<string, unknown>>(`/patients/${id}`),
    enabled: Boolean(id),
    ...options,
  });
}

export interface TimelineEntry {
  type: string;
  at: string;
  id: string;
  summary: string;
  data: Record<string, unknown>;
}

export function usePatientTimeline(id: string) {
  return useQuery({
    queryKey: keys.timeline(id),
    queryFn: () => api.get<TimelineEntry[]>(`/patients/${id}/timeline`),
    enabled: Boolean(id),
  });
}

export function useAllergies(patientId: string) {
  return useQuery({
    queryKey: keys.allergies(patientId),
    queryFn: () => api.get<Record<string, unknown>[]>(`/allergies/patient/${patientId}`),
    enabled: Boolean(patientId),
  });
}

export function useMedications(patientId: string) {
  return useQuery({
    queryKey: keys.medications(patientId),
    queryFn: () => api.get<Record<string, unknown>[]>(`/medications/patient/${patientId}`),
    enabled: Boolean(patientId),
  });
}

export function useVitals(patientId: string) {
  return useQuery({
    queryKey: keys.vitals(patientId),
    queryFn: () => api.get<Record<string, unknown>[]>(`/vitals/patient/${patientId}`),
    enabled: Boolean(patientId),
  });
}

export function useVitalsTrend(patientId: string, hours = 48) {
  return useQuery({
    queryKey: [...keys.vitalsTrend(patientId), hours],
    queryFn: () => api.get<Record<string, unknown>[]>(`/vitals/patient/${patientId}/trend`, { hours }),
    enabled: Boolean(patientId),
  });
}

export function useEncounter(id: string) {
  return useQuery({
    queryKey: keys.encounter(id),
    queryFn: () => api.get<Record<string, unknown>>(`/encounters/${id}`),
    enabled: Boolean(id),
  });
}

export function useNotes(encounterId: string) {
  return useQuery({
    queryKey: keys.notes(encounterId),
    queryFn: () => api.get<Record<string, unknown>[]>(`/notes/encounter/${encounterId}`),
    enabled: Boolean(encounterId),
  });
}

export function useLabResults(patientId: string) {
  return useQuery({
    queryKey: keys.labResults(patientId),
    queryFn: () => api.get<Record<string, unknown>[]>(`/lab/results/patient/${patientId}`),
    enabled: Boolean(patientId),
  });
}

export function useLabWorklist() {
  return useQuery({ queryKey: keys.labWorklist(), queryFn: () => api.get<Record<string, unknown>[]>('/lab/worklist') });
}

export function useCriticalResults() {
  return useQuery({
    queryKey: keys.labCritical(),
    queryFn: () => api.get<Record<string, unknown>[]>('/lab/critical-pending'),
    refetchInterval: 30_000,
  });
}

export function useRadiologyWorklist() {
  return useQuery({
    queryKey: keys.radiologyWorklist(),
    queryFn: () => api.get<Record<string, unknown>[]>('/radiology/worklist'),
  });
}

export function usePharmacyQueue() {
  return useQuery({
    queryKey: keys.pharmacyQueue(),
    queryFn: () => api.get<Record<string, unknown>[]>('/pharmacy/queue'),
    refetchInterval: 30_000,
  });
}

export function useEmar(patientId: string) {
  return useQuery({
    queryKey: keys.emar(patientId),
    queryFn: () => api.get<Record<string, unknown>[]>(`/pharmacy/emar/${patientId}`),
    enabled: Boolean(patientId),
  });
}

export interface BedBoard {
  wards: Array<{
    ward: string;
    total: number;
    occupied: number;
    available: number;
    occupancy_pct: number;
    beds: Array<Record<string, unknown>>;
  }>;
  totals: { total: number; occupied: number; available: number };
}

export function useBedBoard(ward?: string) {
  return useQuery({
    queryKey: keys.bedBoard(ward),
    queryFn: () => api.get<BedBoard>('/beds/board', ward ? { ward } : undefined),
    refetchInterval: 20_000,
  });
}

export function useAppointments(params: Record<string, string | undefined>) {
  return useQuery({
    queryKey: keys.appointments(params),
    queryFn: () => api.get<Record<string, unknown>[]>('/appointments', params),
  });
}

export function useQueueState(name: string) {
  return useQuery({
    queryKey: keys.queue(name),
    queryFn: () => api.get<Record<string, unknown>[]>(`/appointments/queue/${name}`),
    refetchInterval: 10_000,
  });
}

export function useInvoices(params: Record<string, string | number | undefined>) {
  return useQuery({
    queryKey: keys.invoices(params),
    queryFn: () => api.get<Paginated<Record<string, unknown>>>('/billing/invoices', params),
  });
}

export function useInvoice(id: string) {
  return useQuery({
    queryKey: keys.invoice(id),
    queryFn: () => api.get<Record<string, unknown>>(`/billing/invoices/${id}`),
    enabled: Boolean(id),
  });
}

export function useDenialQueue() {
  return useQuery({
    queryKey: keys.denials(),
    queryFn: () => api.get<Paginated<Record<string, unknown>>>('/insurance/denials'),
  });
}

export function useInventory(params: Record<string, string | undefined>) {
  return useQuery({
    queryKey: keys.inventory(params),
    queryFn: () => api.get<Paginated<Record<string, unknown>>>('/inventory', params),
  });
}

export function useReorderReport() {
  return useQuery({ queryKey: keys.reorder(), queryFn: () => api.get<Record<string, unknown>[]>('/inventory/reorder-report') });
}

export function useRoster(params: Record<string, string | undefined>) {
  return useQuery({ queryKey: keys.roster(params), queryFn: () => api.get<Record<string, unknown>[]>('/hr/roster', params) });
}

export function useNurseRatios() {
  return useQuery({
    queryKey: keys.nurseRatios(),
    queryFn: () => api.get<Record<string, unknown>>('/hr/nurse-ratios'),
    refetchInterval: 60_000,
  });
}

/** Generic mutation helper that invalidates the supplied keys on success. */
export function useApiMutation<TBody, TResult>(
  path: string | ((body: TBody) => string),
  invalidate: ReadonlyArray<readonly unknown[]> = [],
  method: 'post' | 'patch' = 'post',
) {
  const queryClient = useQueryClient();
  return useMutation<TResult, Error, TBody>({
    mutationFn: (body) => api[method]<TResult>(typeof path === 'function' ? path(body) : path, body),
    onSuccess: () => {
      for (const key of invalidate) void queryClient.invalidateQueries({ queryKey: key });
    },
  });
}
