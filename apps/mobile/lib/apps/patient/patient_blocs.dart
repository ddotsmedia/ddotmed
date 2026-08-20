/// Blocs for the patient app.
///
/// Everything here is scoped to the signed-in patient by the server, from the
/// token — no screen sends a patient id, and there is no way to ask for someone
/// else's record by changing a parameter.
library;

import 'package:bloc/bloc.dart';
import 'package:equatable/equatable.dart';

import '../../core/api_client.dart';
import '../../core/models.dart';

// ── Dashboard ─────────────────────────────────────────────────────────────────

/// A wearable reading, from Apple Health or Google Fit.
///
/// Kept apart from [VitalReading] throughout the app, and labelled as
/// self-recorded wherever it is shown. A watch measurement is useful context and
/// is not a clinical observation; presenting the two in one list would invite a
/// clinician to treat them as equivalent.
class WearableSummary extends Equatable {
  const WearableSummary({
    this.steps,
    this.restingHeartRate,
    this.sleepHours,
    this.spo2,
    this.lastSyncedAt,
    this.available = false,
    this.permissionDenied = false,
  });

  final int? steps;
  final int? restingHeartRate;
  final double? sleepHours;
  final int? spo2;
  final DateTime? lastSyncedAt;

  /// False when the platform has no health store, or the plugin is unavailable.
  final bool available;
  final bool permissionDenied;

  bool get hasData =>
      steps != null || restingHeartRate != null || sleepHours != null || spo2 != null;

  @override
  List<Object?> get props =>
      [steps, restingHeartRate, sleepHours, spo2, lastSyncedAt, available, permissionDenied];
}

sealed class PatientDashboardEvent extends Equatable {
  const PatientDashboardEvent();
  @override
  List<Object?> get props => const [];
}

class PatientDashboardRequested extends PatientDashboardEvent {
  const PatientDashboardRequested();
}

class WearableDataReceived extends PatientDashboardEvent {
  const WearableDataReceived(this.summary);
  final WearableSummary summary;
  @override
  List<Object?> get props => [summary];
}

sealed class PatientDashboardState extends Equatable {
  const PatientDashboardState();
  @override
  List<Object?> get props => const [];
}

class PatientDashboardLoading extends PatientDashboardState {
  const PatientDashboardLoading();
}

class PatientDashboardReady extends PatientDashboardState {
  const PatientDashboardReady({
    required this.appointments,
    required this.results,
    required this.invoices,
    required this.medications,
    required this.loadedAt,
    this.wearable = const WearableSummary(),
  });

  final List<Appointment> appointments;
  final List<LabResult> results;
  final List<Invoice> invoices;
  final List<Prescription> medications;
  final DateTime loadedAt;
  final WearableSummary wearable;

  List<Appointment> get upcoming {
    final rows = appointments.where((a) => a.isUpcoming(loadedAt)).toList()
      ..sort((a, b) => a.start.compareTo(b.start));
    return rows;
  }

  List<Appointment> get past {
    final upcomingIds = upcoming.map((a) => a.id).toSet();
    final rows = appointments.where((a) => !upcomingIds.contains(a.id)).toList()
      ..sort((a, b) => b.start.compareTo(a.start));
    return rows;
  }

  /// The three most recent results, which is what the dashboard shows.
  List<LabResult> get recentResults => results.take(3).toList(growable: false);

  List<Invoice> get outstandingInvoices =>
      invoices.where((i) => i.isOutstanding).toList(growable: false);

  /// The next appointment that can be joined right now, if there is one.
  Appointment? joinableNow(DateTime now) {
    for (final appointment in upcoming) {
      if (appointment.joinable(now)) return appointment;
    }
    return null;
  }

  PatientDashboardReady copyWith({WearableSummary? wearable}) => PatientDashboardReady(
        appointments: appointments,
        results: results,
        invoices: invoices,
        medications: medications,
        loadedAt: loadedAt,
        wearable: wearable ?? this.wearable,
      );

  @override
  List<Object?> get props => [appointments, results, invoices, medications, loadedAt, wearable];
}

class PatientDashboardError extends PatientDashboardState {
  const PatientDashboardError(this.message);
  final String message;
  @override
  List<Object?> get props => [message];
}

class PatientDashboardBloc extends Bloc<PatientDashboardEvent, PatientDashboardState> {
  PatientDashboardBloc({required this.api, DateTime Function()? clock})
      : _clock = clock ?? DateTime.now,
        super(const PatientDashboardLoading()) {
    on<PatientDashboardRequested>(_onRequested);
    on<WearableDataReceived>(_onWearable);
  }

  final ApiClient api;
  final DateTime Function() _clock;

  Future<void> _onRequested(
    PatientDashboardRequested event,
    Emitter<PatientDashboardState> emit,
  ) async {
    emit(const PatientDashboardLoading());
    try {
      final results = await Future.wait([
        api.get<dynamic>('/portal/summary'),
        api.get<dynamic>('/portal/medications'),
      ]);

      final summary = results[0];
      if (summary is! Map<String, dynamic>) {
        emit(const PatientDashboardError('Your record could not be read'));
        return;
      }

      final labs = asRows(summary['results']).map(LabResult.fromJson).toList()
        ..sort((a, b) => b.performedAt.compareTo(a.performedAt));

      emit(PatientDashboardReady(
        appointments:
            asRows(summary['appointments']).map(Appointment.fromJson).toList(growable: false),
        results: labs,
        invoices: asRows(summary['invoices']).map(Invoice.fromJson).toList(growable: false),
        medications: asRows(results[1]).map(Prescription.fromJson).toList(growable: false),
        loadedAt: _clock(),
      ));
    } on ApiException catch (e) {
      emit(PatientDashboardError(e.message));
    }
  }

  void _onWearable(WearableDataReceived event, Emitter<PatientDashboardState> emit) {
    final current = state;
    if (current is! PatientDashboardReady) return;
    emit(current.copyWith(wearable: event.summary));
  }
}

// ── Booking ───────────────────────────────────────────────────────────────────

class Slot extends Equatable {
  const Slot({
    required this.id,
    required this.start,
    required this.end,
    this.practitionerId,
    this.practitionerName,
    this.locationName,
  });

  final String id;
  final DateTime start;
  final DateTime end;
  final String? practitionerId;
  final String? practitionerName;
  final String? locationName;

  static Slot fromJson(Map<String, dynamic> json) {
    final schedule = json['schedule'];
    final scheduleMap = schedule is Map<String, dynamic> ? schedule : null;
    return Slot(
      id: json['id'] as String,
      start: DateTime.parse(json['start'] as String).toLocal(),
      end: DateTime.parse(json['end'] as String).toLocal(),
      practitionerId: scheduleMap?['practitioner_id'] as String?,
      practitionerName: json['practitioner_name'] as String?,
      locationName: json['location_name'] as String?,
    );
  }

  @override
  List<Object?> get props => [id, start, end];
}

sealed class BookingEvent extends Equatable {
  const BookingEvent();
  @override
  List<Object?> get props => const [];
}

class SpecialtySelected extends BookingEvent {
  const SpecialtySelected(this.specialty);
  final String specialty;
  @override
  List<Object?> get props => [specialty];
}

class SlotsRequested extends BookingEvent {
  const SlotsRequested({required this.specialty, this.practitionerId, required this.from});
  final String specialty;
  final String? practitionerId;
  final DateTime from;
  @override
  List<Object?> get props => [specialty, practitionerId, from];
}

class BookingConfirmed extends BookingEvent {
  const BookingConfirmed({
    required this.slot,
    required this.serviceType,
    this.reason,
    this.telehealth = false,
  });

  final Slot slot;
  final String serviceType;
  final String? reason;
  final bool telehealth;

  @override
  List<Object?> get props => [slot, serviceType, reason, telehealth];
}

class BookingReset extends BookingEvent {
  const BookingReset();
}

sealed class BookingState extends Equatable {
  const BookingState();
  @override
  List<Object?> get props => const [];
}

class BookingIdle extends BookingState {
  const BookingIdle();
}

class BookingLoadingSlots extends BookingState {
  const BookingLoadingSlots();
}

class BookingSlotsReady extends BookingState {
  const BookingSlotsReady(this.specialty, this.slots);

  final String specialty;
  final List<Slot> slots;

  /// Grouped by calendar day, which is how a slot picker is read.
  Map<DateTime, List<Slot>> get byDay {
    final grouped = <DateTime, List<Slot>>{};
    for (final slot in slots) {
      final day = DateTime(slot.start.year, slot.start.month, slot.start.day);
      grouped.putIfAbsent(day, () => []).add(slot);
    }
    for (final list in grouped.values) {
      list.sort((a, b) => a.start.compareTo(b.start));
    }
    return grouped;
  }

  @override
  List<Object?> get props => [specialty, slots];
}

class BookingSubmitting extends BookingState {
  const BookingSubmitting();
}

class BookingConfirmedState extends BookingState {
  const BookingConfirmedState(this.appointmentId, this.start);
  final String appointmentId;
  final DateTime start;
  @override
  List<Object?> get props => [appointmentId, start];
}

class BookingError extends BookingState {
  const BookingError(this.message);
  final String message;
  @override
  List<Object?> get props => [message];
}

class BookingBloc extends Bloc<BookingEvent, BookingState> {
  BookingBloc({required this.api}) : super(const BookingIdle()) {
    on<SpecialtySelected>((event, emit) => emit(const BookingLoadingSlots()));
    on<SlotsRequested>(_onSlots);
    on<BookingConfirmed>(_onConfirm);
    on<BookingReset>((_, emit) => emit(const BookingIdle()));
  }

  final ApiClient api;

  Future<void> _onSlots(SlotsRequested event, Emitter<BookingState> emit) async {
    emit(const BookingLoadingSlots());
    try {
      final rows = await api.get<dynamic>('/appointments/availability', query: {
        'from': event.from.toUtc().toIso8601String(),
        'to': event.from.add(const Duration(days: 28)).toUtc().toIso8601String(),
        'service_type': event.specialty,
        if (event.practitionerId != null) 'practitioner_id': event.practitionerId,
      });
      emit(BookingSlotsReady(
        event.specialty,
        asRows(rows).map(Slot.fromJson).toList(growable: false),
      ));
    } on ApiException catch (e) {
      emit(BookingError(e.message));
    }
  }

  Future<void> _onConfirm(BookingConfirmed event, Emitter<BookingState> emit) async {
    emit(const BookingSubmitting());
    try {
      final response = await api.write('/appointments', {
        'slot_id': event.slot.id,
        if (event.slot.practitionerId != null) 'practitioner_id': event.slot.practitionerId,
        'service_type': event.serviceType,
        'start': event.slot.start.toUtc().toIso8601String(),
        'minutes_duration': event.slot.end.difference(event.slot.start).inMinutes,
        'channel': 'app',
        'is_telehealth': event.telehealth,
        if (event.reason != null && event.reason!.isNotEmpty) 'reason_text': event.reason,
      });

      if (response == null) {
        // Booking claims a slot; two people cannot both hold the last one, so
        // this can never be queued optimistically.
        emit(const BookingError('Booking needs a connection — the slot has to be held'));
        return;
      }

      emit(BookingConfirmedState(
        (response['id'] as String?) ?? '',
        event.slot.start,
      ));
    } on ApiException catch (e) {
      emit(BookingError(
        e.statusCode == 409 ? 'That slot has just been taken. Choose another.' : e.message,
      ));
    }
  }
}

// ── Records ───────────────────────────────────────────────────────────────────

class RecordDocument extends Equatable {
  const RecordDocument({
    required this.id,
    required this.title,
    required this.date,
    required this.kind,
    this.detail,
    this.downloadPath,
  });

  final String id;
  final String title;
  final DateTime date;

  /// `result`, `prescription` or `discharge`.
  final String kind;
  final String? detail;

  /// API path that yields the PDF, when the record has one.
  final String? downloadPath;

  @override
  List<Object?> get props => [id, kind, date];
}

sealed class RecordsEvent extends Equatable {
  const RecordsEvent();
  @override
  List<Object?> get props => const [];
}

class RecordsRequested extends RecordsEvent {
  const RecordsRequested();
}

sealed class RecordsState extends Equatable {
  const RecordsState();
  @override
  List<Object?> get props => const [];
}

class RecordsLoading extends RecordsState {
  const RecordsLoading();
}

class RecordsReady extends RecordsState {
  const RecordsReady({
    required this.results,
    required this.prescriptions,
    required this.discharges,
  });

  final List<LabResult> results;
  final List<Prescription> prescriptions;
  final List<RecordDocument> discharges;

  @override
  List<Object?> get props => [results, prescriptions, discharges];
}

class RecordsError extends RecordsState {
  const RecordsError(this.message);
  final String message;
  @override
  List<Object?> get props => [message];
}

class RecordsBloc extends Bloc<RecordsEvent, RecordsState> {
  RecordsBloc({required this.api}) : super(const RecordsLoading()) {
    on<RecordsRequested>(_onRequested);
  }

  final ApiClient api;

  Future<void> _onRequested(RecordsRequested event, Emitter<RecordsState> emit) async {
    emit(const RecordsLoading());
    try {
      final responses = await Future.wait([
        api.get<dynamic>('/portal/summary'),
        api.get<dynamic>('/portal/medications'),
      ]);

      final summary = responses[0];
      final summaryMap = summary is Map<String, dynamic> ? summary : const <String, dynamic>{};

      final results = asRows(summaryMap['results']).map(LabResult.fromJson).toList()
        ..sort((a, b) => b.performedAt.compareTo(a.performedAt));

      // Discharge summaries ride along on the summary payload when the server
      // includes them; an older server simply returns none.
      final discharges = asRows(summaryMap['discharge_summaries'])
          .map((row) => RecordDocument(
                id: (row['id'] as String?) ?? '',
                title: (row['title'] as String?) ?? 'Discharge summary',
                date: DateTime.tryParse((row['created_at'] as String?) ?? '')?.toLocal() ??
                    DateTime.now(),
                kind: 'discharge',
                detail: row['summary'] as String?,
                downloadPath: '/notes/${row['id']}/pdf',
              ))
          .toList(growable: false);

      emit(RecordsReady(
        results: results,
        prescriptions: asRows(responses[1]).map(Prescription.fromJson).toList(growable: false),
        discharges: discharges,
      ));
    } on ApiException catch (e) {
      emit(RecordsError(e.message));
    }
  }
}

// ── Payments ──────────────────────────────────────────────────────────────────

sealed class PaymentsEvent extends Equatable {
  const PaymentsEvent();
  @override
  List<Object?> get props => const [];
}

class PaymentsRequested extends PaymentsEvent {
  const PaymentsRequested();
}

class PaymentStarted extends PaymentsEvent {
  const PaymentStarted(this.invoice);
  final Invoice invoice;
  @override
  List<Object?> get props => [invoice];
}

sealed class PaymentsState extends Equatable {
  const PaymentsState();
  @override
  List<Object?> get props => const [];
}

class PaymentsLoading extends PaymentsState {
  const PaymentsLoading();
}

class PaymentsReady extends PaymentsState {
  const PaymentsReady(this.invoices, {this.processing});

  final List<Invoice> invoices;

  /// Invoice id with a payment in flight.
  final String? processing;

  List<Invoice> get outstanding => invoices.where((i) => i.isOutstanding).toList(growable: false);

  List<Invoice> get settled => invoices.where((i) => !i.isOutstanding).toList(growable: false);

  int get totalOutstandingMinor =>
      outstanding.fold(0, (sum, invoice) => sum + invoice.balanceMinor);

  String get currency => invoices.isEmpty ? 'AED' : invoices.first.currency;

  PaymentsReady copyWith({String? processing, bool clearProcessing = false}) =>
      PaymentsReady(invoices, processing: clearProcessing ? null : processing);

  @override
  List<Object?> get props => [invoices, processing];
}

class PaymentsError extends PaymentsState {
  const PaymentsError(this.message);
  final String message;
  @override
  List<Object?> get props => [message];
}

class PaymentsBloc extends Bloc<PaymentsEvent, PaymentsState> {
  PaymentsBloc({required this.api}) : super(const PaymentsLoading()) {
    on<PaymentsRequested>(_onRequested);
    on<PaymentStarted>(_onPay);
  }

  final ApiClient api;

  Future<void> _onRequested(PaymentsEvent event, Emitter<PaymentsState> emit) async {
    emit(const PaymentsLoading());
    try {
      final summary = await api.get<dynamic>('/portal/summary');
      final summaryMap = summary is Map<String, dynamic> ? summary : const <String, dynamic>{};
      emit(PaymentsReady(
        asRows(summaryMap['invoices']).map(Invoice.fromJson).toList(growable: false),
      ));
    } on ApiException catch (e) {
      emit(PaymentsError(e.message));
    }
  }

  /// Opens a payment.
  ///
  /// The gateway itself is not wired here: taking a card needs a PCI-scoped SDK
  /// and a merchant account per deployment, and stubbing one would be worse than
  /// admitting it is absent. What this does is ask the server to create a payment
  /// intent, which is the half that is the same whichever gateway is fitted.
  Future<void> _onPay(PaymentStarted event, Emitter<PaymentsState> emit) async {
    final current = state;
    if (current is! PaymentsReady) return;

    emit(current.copyWith(processing: event.invoice.id));
    try {
      final response = await api.write('/billing/payments/intent', {
        'invoice_id': event.invoice.id,
        'amount_minor': event.invoice.balanceMinor,
        'currency': event.invoice.currency,
      });

      if (response == null) {
        emit(const PaymentsError('Paying needs a connection'));
        return;
      }
      // The gateway hand-off happens in the UI layer, which owns the SDK.
      emit(current.copyWith(clearProcessing: true));
    } on ApiException catch (e) {
      emit(PaymentsError(e.message));
    }
  }
}
