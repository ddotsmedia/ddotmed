'use client';

import { useMutation, useQuery, useQueryClient, type UseQueryOptions } from '@tanstack/react-query';
import type { Paginated } from '@medicore/shared-types';
import { api } from './api-client';

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
  encounterConditions: (encounterId: string) => ['conditions', 'encounter', encounterId] as const,
  diagnosisSearch: (q: string) => ['conditions', 'search', q] as const,
  drugSearch: (q: string) => ['medications', 'formulary', q] as const,
  prescriptions: (patientId: string, status?: string) =>
    ['medications', patientId, status] as const,
  interaction: (a: string, b: string) => ['drug-interactions', a, b] as const,
  serviceRequests: (params?: unknown) => ['service-requests', params] as const,
  labResultsFor: (patientId: string) => ['lab-results', patientId] as const,
  notifications: (params?: unknown) => ['notifications', params] as const,
  notificationCount: () => ['notifications', 'unacknowledged-count'] as const,
  dispenseQueue: (locationId?: string) => ['pharmacy', 'queue', locationId] as const,
  bedList: (params?: unknown) => ['beds', 'list', params] as const,
  admissions: (params?: unknown) => ['admissions', params] as const,
  invoiceList: (params?: unknown) => ['invoices', 'list', params] as const,
  invoiceDetail: (id: string) => ['invoices', id] as const,
  billingDashboard: () => ['billing', 'dashboard'] as const,
  claimsFor: (invoiceId: string) => ['insurance-claims', invoiceId] as const,
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
  executive: () => ['analytics', 'executive'] as const,
  admissionTrend: (days: number) => ['analytics', 'trend', days] as const,
  clinicalAnalytics: (days: number) => ['analytics', 'clinical', days] as const,
  financialAnalytics: (days: number) => ['analytics', 'financial', days] as const,
  operationalAnalytics: (days: number) => ['analytics', 'operational', days] as const,
  reportFields: () => ['analytics', 'reports', 'fields'] as const,
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
    queryFn: () => api.get<Record<string, unknown>[]>(`/clinical-notes/encounter/${encounterId}`),
    enabled: Boolean(encounterId),
  });
}

export interface DrugMatch {
  rxnorm: string;
  atc: string;
  generic_name: string;
  brand_name?: string;
  strength: string;
  dose_form: string;
  drug_class: string;
  is_controlled?: boolean;
  controlled_schedule?: string;
  formulary_id?: string;
  source: 'tenant' | 'bundled';
  score: number;
}

/** Drug autocomplete by name, brand, RxNorm or ATC code. */
export function useDrugSearch(query: string) {
  return useQuery({
    queryKey: keys.drugSearch(query),
    queryFn: () => api.get<DrugMatch[]>('/medications/formulary/search', { q: query }),
    enabled: query.trim().length >= 2,
    staleTime: 5 * 60_000,
  });
}

export interface Prescription {
  id: string;
  code: string;
  code_display: string;
  dose_quantity: string | number;
  dose_unit: string;
  route: string;
  frequency: string;
  duration_days: number | null;
  quantity: number;
  refills: number;
  status: string;
  is_controlled: boolean;
  controlled_schedule: string | null;
  instructions: string | null;
  start_date: string | null;
  end_date: string | null;
  dispenses?: Array<{ id: string; quantity: number; dispensed_at: string }>;
}

export function usePrescriptions(patientId: string, status: string | undefined = 'active') {
  return useQuery({
    queryKey: keys.prescriptions(patientId, status),
    queryFn: () => api.get<Prescription[]>('/medications', { patientId, status }),
    enabled: Boolean(patientId),
  });
}

export interface InteractionLookup {
  found: boolean;
  drug_a: string;
  drug_b: string;
  severity: 'contraindicated' | 'major' | 'moderate' | 'minor' | null;
  action: 'block' | 'override' | 'warn' | null;
  mechanism: string | null;
  clinical_effect: string | null;
  management: string | null;
  explanation: string | null;
  source: 'tenant' | 'bundled' | null;
}

export interface LabOrder {
  id: string;
  order_number: string;
  barcode: string | null;
  code: string;
  code_display: string;
  status: string;
  priority: string;
  fasting_required: boolean;
  clinical_notes: string | null;
  created_at: string;
  encounter_id: string | null;
  patient?: { mrn: string; given_names: string[]; family_name: string };
  specimens?: Array<{ id: string; barcode: string | null; status: string }>;
  results?: Array<{ id: string; interpretation: string | null; is_critical: boolean; performed_at: string }>;
}

export function useServiceRequests(params: Record<string, string | undefined>) {
  const enabled = Boolean(params.patientId || params.encounterId);
  return useQuery({
    queryKey: keys.serviceRequests(params),
    queryFn: () => api.get<LabOrder[]>('/service-requests', params),
    enabled,
  });
}

export interface LabResultRow {
  id: string;
  loinc_code: string;
  display: string;
  unit: string | null;
  value_quantity: number | null;
  value_string: string | null;
  reference_low: number | null;
  reference_high: number | null;
  interpretation: string | null;
  is_critical: boolean;
  performed_at: string;
  encounter_id: string | null;
  service_request_id: string | null;
}

export interface ResultTrend {
  loinc_code: string;
  display: string;
  unit: string | null;
  reference_low: number | null;
  reference_high: number | null;
  points: Array<{
    id: string;
    performed_at: string;
    value: number | null;
    value_string: string | null;
    unit: string | null;
    interpretation: string | null;
    is_critical: boolean;
  }>;
  latest: ResultTrend['points'][number];
  delta: number | null;
  direction: 'up' | 'down' | 'flat' | null;
  has_critical: boolean;
}

export function useLabResultsFor(patientId: string) {
  return useQuery({
    queryKey: keys.labResultsFor(patientId),
    queryFn: () =>
      api.get<{ results: LabResultRow[]; trends: ResultTrend[] }>('/lab-results', { patientId }),
    enabled: Boolean(patientId),
  });
}

export interface AppNotification {
  id: string;
  category: string;
  severity: string;
  title: string;
  body: string;
  patient_id: string | null;
  resource_id: string | null;
  requires_acknowledgement: boolean;
  acknowledged_at: string | null;
  created_at: string;
}

export function useNotifications(params: Record<string, string | undefined> = {}) {
  return useQuery({
    queryKey: keys.notifications(params),
    queryFn: () => api.get<AppNotification[]>('/notifications', params),
    refetchInterval: 30_000,
  });
}

export function useEncounterConditions(encounterId: string) {
  return useQuery({
    queryKey: keys.encounterConditions(encounterId),
    queryFn: () => api.get<Record<string, unknown>[]>(`/conditions/encounter/${encounterId}`),
    enabled: Boolean(encounterId),
  });
}

export interface DiagnosisMatch {
  code: string;
  display: string;
  chapter: string;
  score: number;
}

/** ICD-10 autocomplete. Two characters is the server's own floor for guessing. */
export function useDiagnosisSearch(query: string) {
  return useQuery({
    queryKey: keys.diagnosisSearch(query),
    queryFn: () => api.get<DiagnosisMatch[]>('/conditions/search', { q: query }),
    enabled: query.trim().length >= 2,
    staleTime: 5 * 60_000,
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

export interface DispenseQueueEntry {
  id: string;
  code: string;
  code_display: string;
  dose_quantity: string | number;
  dose_unit: string;
  route: string;
  frequency: string;
  quantity: number;
  is_controlled: boolean;
  controlled_schedule: string | null;
  created_at: string;
  queue_priority: 'urgent' | 'high' | 'routine';
  waiting_minutes: number;
  queue_reason: string;
  patient: { id: string; mrn: string; given_names: string[]; family_name: string };
  formulary?: { generic_name: string; strength: string; is_high_alert: boolean } | null;
}

export function useDispenseQueue(locationId?: string) {
  return useQuery({
    queryKey: keys.dispenseQueue(locationId),
    queryFn: () =>
      api.get<DispenseQueueEntry[]>('/pharmacy/queue', locationId ? { locationId } : undefined),
    refetchInterval: 30_000,
  });
}

export interface StockItem {
  id: string;
  item_code: string;
  name: string;
  category: string;
  batch_number: string | null;
  expiry_date: string | null;
  quantity_on_hand: number;
  safety_stock: number;
  reorder_quantity: number;
  unit: string;
  unit_cost_minor: number;
  currency: string;
  location_id: string | null;
  is_recalled: boolean;
}

export function useStock(params: Record<string, string | undefined>) {
  return useQuery({
    queryKey: keys.inventory(params),
    queryFn: () => api.get<Paginated<StockItem>>('/inventory', params),
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

export interface BedRow {
  id: string;
  bed_number: string;
  room: string;
  ward: string;
  ward_id: string | null;
  location_id: string;
  bed_type: string;
  status: string;
  housekeeping_status: 'clean' | 'dirty' | 'in_progress';
  isolation_flag: boolean;
  isolation_reason: string | null;
  gender_restriction: string | null;
  tone: 'available' | 'occupied' | 'dirty' | 'isolation' | 'blocked';
  admittable: boolean;
  blocker: string | null;
  admission: {
    id: string;
    admission_number: string;
    admitted_at: string;
    length_of_stay_days: number;
    expected_discharge_at: string | null;
    days_remaining: number | null;
    overdue: boolean;
    days_overdue: number;
    patient: {
      id: string;
      mrn: string;
      given_names: string[];
      family_name: string;
      gender: string;
      birth_date: string;
    };
  } | null;
}

export function useBedList(params: Record<string, string | undefined>) {
  return useQuery({
    queryKey: keys.bedList(params),
    queryFn: () => api.get<BedRow[]>('/beds', params),
    refetchInterval: 30_000,
  });
}

export interface AdmissionRow {
  id: string;
  admission_number: string;
  status: string;
  admission_type: string;
  admitted_at: string;
  discharged_at: string | null;
  length_of_stay_days: number;
  expected_discharge_at: string | null;
  days_remaining: number | null;
  overdue: boolean;
  days_overdue: number;
  patient: { id: string; mrn: string; given_names: string[]; family_name: string };
  bed: { id: string; ward: string; room: string; bed_number: string; isolation_flag: boolean } | null;
}

export function useAdmissions(params: Record<string, string | undefined>) {
  return useQuery({
    queryKey: keys.admissions(params),
    queryFn: () => api.get<AdmissionRow[]>('/admissions', params),
    refetchInterval: 60_000,
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

export interface InvoiceLine {
  id: string;
  charge_code: string;
  description: string;
  quantity: number;
  unit_price_minor: number;
  discount_minor: number;
  tax_rate_bp: number;
  tax_minor: number;
  total_minor: number;
}

export interface InvoiceRow {
  id: string;
  invoice_number: string;
  patient_id: string;
  encounter_id: string | null;
  status: string;
  payer_type: 'cash' | 'insurance' | 'corporate';
  currency: string;
  subtotal_minor: number;
  discount_minor: number;
  tax_minor: number;
  total_minor: number;
  paid_minor: number;
  balance_minor: number;
  issued_at: string | null;
  due_at: string | null;
  created_at: string;
  line_items?: InvoiceLine[];
  payments?: Array<{
    id: string;
    receipt_number: string;
    method: string;
    amount_minor: number;
    received_at: string;
  }>;
  claims?: Array<{ id: string; claim_number: string; status: string; claimed_minor: number }>;
  patient?: { id: string; mrn: string; given_names: string[]; family_name: string };
}

export function useInvoiceList(params: Record<string, string | undefined>) {
  return useQuery({
    queryKey: keys.invoiceList(params),
    queryFn: () => api.get<Paginated<InvoiceRow>>('/invoices', params),
  });
}

export function useInvoiceDetail(id: string) {
  return useQuery({
    queryKey: keys.invoiceDetail(id),
    queryFn: () => api.get<InvoiceRow>(`/invoices/${id}`),
    enabled: Boolean(id),
  });
}

export interface BillingDashboard {
  period_start: string;
  aging: {
    buckets: Array<{ bucket: string; invoice_count: number; balance_minor: number }>;
    total_outstanding_minor: number;
    over_90_minor: number;
  };
  collection: { billed_minor: number; collected_minor: number; rate_bp: number };
  denials: { responses: number; denied: number; rate_bp: number; denied_minor: number };
  top_denial_reasons: Array<{ code: string; count: number; denied_minor: number }>;
  revenue_by_payer: Array<{
    payer_type: string;
    invoice_count: number;
    billed_minor: number;
    collected_minor: number;
    outstanding_minor: number;
  }>;
}

export function useBillingDashboard() {
  return useQuery({
    queryKey: keys.billingDashboard(),
    queryFn: () => api.get<BillingDashboard>('/billing/dashboard'),
    refetchInterval: 5 * 60_000,
  });
}

export interface CodingSuggestion {
  system: string;
  code: string;
  display: string;
  confidence: number;
  rationale?: string | null;
  already_on_claim: boolean;
  low_confidence: boolean;
}

export interface ClaimSubmitResult {
  claim: { id: string; claim_number: string; status: string; claimed_minor: number };
  denial_risk: {
    risk_bp: number;
    level: 'low' | 'medium' | 'high';
    factors: Array<{ code: string; weight_bp: number; detail: string; remedy: string }>;
    recommended_actions: string[];
  };
  coding_suggestions: CodingSuggestion[];
  coding_model_version: string | null;
  requires_approval: true;
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

// ── analytics ─────────────────────────────────────────────────────────────────

export interface ExecutiveKpis {
  inpatients_today: number;
  bed_occupancy_pct: number;
  opd_visits_today: number;
  revenue_today_minor: number;
  revenue_currency: string;
  pending_critical_labs: number;
  denial_rate_mtd: number;
  avg_los_days: number | null;
  new_patients_today: number;
  beds_total: number;
  beds_occupied: number;
  generated_at: string;
}

export interface TrendPoint {
  date: string;
  admissions: number;
  discharges: number;
}

export interface ClinicalAnalytics {
  period_days: number;
  readmission_rate_30d: { discharges: number; readmissions: number; rate_bp: number };
  alos_by_ward: Array<{ ward: string; discharges: number; alos_days: number }>;
  top_diagnoses: Array<{ code: string; display: string | null; count: number }>;
  infection_alerts_active: number;
  medication_error_count_mtd: number;
}

export interface FinancialAnalytics {
  period_days: number;
  currency: string;
  revenue_by_department: Array<{ department: string; line_count: number; billed_minor: number }>;
  ar_aging: {
    current_minor: number;
    '30_minor': number;
    '60_minor': number;
    '90_minor': number;
    over90_minor: number;
    total_minor: number;
    buckets: Array<{ bucket: string; invoice_count: number; balance_minor: number }>;
  };
  collection_rate_mtd: { billed_minor: number; collected_minor: number; rate_bp: number };
  denial_rate_mtd: { responses: number; denied: number; rate_bp: number; denied_minor: number };
  top_denial_reasons: Array<{ code: string; count: number; denied_minor: number }>;
  revenue_by_payer: Array<{
    payer_type: string;
    invoice_count: number;
    billed_minor: number;
    collected_minor: number;
    outstanding_minor: number;
  }>;
}

export interface OperationalAnalytics {
  period_days: number;
  avg_wait_minutes_opd: number | null;
  bed_turnover_rate: number;
  discharge_delay_count: number;
  ot_utilisation_pct: number;
  ot_beds_total: number;
  lab_tat_avg_minutes: number | null;
  radiology_tat_avg_minutes: number | null;
  discharges_in_period: number;
}

/** The executive strip. Sixty seconds matches the server-side cache exactly. */
export function useExecutiveKpis() {
  return useQuery({
    queryKey: keys.executive(),
    queryFn: () => api.get<ExecutiveKpis>('/analytics/executive'),
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
  });
}

export function useAdmissionTrend(days = 7) {
  return useQuery({
    queryKey: keys.admissionTrend(days),
    queryFn: () => api.get<{ days: number; points: TrendPoint[] }>('/analytics/trend', { days }),
    refetchInterval: 5 * 60_000,
  });
}

export function useClinicalAnalytics(days: number) {
  return useQuery({
    queryKey: keys.clinicalAnalytics(days),
    queryFn: () => api.get<ClinicalAnalytics>('/analytics/clinical', { days }),
  });
}

export function useFinancialAnalytics(days: number) {
  return useQuery({
    queryKey: keys.financialAnalytics(days),
    queryFn: () => api.get<FinancialAnalytics>('/analytics/financial', { days }),
  });
}

export function useOperationalAnalytics(days: number) {
  return useQuery({
    queryKey: keys.operationalAnalytics(days),
    queryFn: () => api.get<OperationalAnalytics>('/analytics/operational', { days }),
  });
}

export interface ReportFieldDef {
  key: string;
  label: string;
  kind: 'string' | 'number' | 'date' | 'boolean';
  groupable?: boolean;
  summable?: boolean;
  phi?: boolean;
}

export interface ReportCatalogue {
  sources: Array<{ source: string; date_field: string; fields: ReportFieldDef[] }>;
  operators: string[];
  max_rows: number;
  preview_rows: number;
}

/** The whitelist itself. The builder can only offer what the server will accept. */
export function useReportFields() {
  return useQuery({
    queryKey: keys.reportFields(),
    queryFn: () => api.get<ReportCatalogue>('/analytics/reports/fields'),
    staleTime: 30 * 60_000,
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
