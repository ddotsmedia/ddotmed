/// Patient-facing state.
library;

import 'package:flutter_test/flutter_test.dart';
import 'package:medicore_mobile/apps/patient/patient_blocs.dart';
import 'package:medicore_mobile/core/api_client.dart';
import 'package:medicore_mobile/core/models.dart';
import 'package:medicore_mobile/core/offline_queue.dart';
import 'package:mocktail/mocktail.dart';

class _MockApi extends Mock implements ApiClient {}

class _FakeQueue extends Fake implements OfflineQueue {}

void main() {
  late _MockApi api;

  setUpAll(() => registerFallbackValue(<String, dynamic>{}));

  setUp(() {
    api = _MockApi();
    when(() => api.queue).thenReturn(_FakeQueue());
  });

  Appointment appointment({
    required String id,
    required DateTime start,
    bool telehealth = false,
    String status = 'booked',
  }) =>
      Appointment(
        id: id,
        start: start,
        serviceType: 'Follow-up',
        status: status,
        minutesDuration: 15,
        isTelehealth: telehealth,
      );

  group('dashboard', () {
    final now = DateTime(2026, 8, 21, 12);

    PatientDashboardReady ready(List<Appointment> appointments) => PatientDashboardReady(
          appointments: appointments,
          results: const [],
          invoices: const [],
          medications: const [],
          loadedAt: now,
        );

    test('finds the appointment that can be joined right now', () {
      final state = ready([
        appointment(id: 'later', start: now.add(const Duration(hours: 4)), telehealth: true),
        appointment(id: 'now', start: now.add(const Duration(minutes: 10)), telehealth: true),
      ]);

      expect(state.joinableNow(now)?.id, 'now');
    });

    test('offers nothing to join when the window has not opened', () {
      final state = ready([
        appointment(id: 'later', start: now.add(const Duration(hours: 4)), telehealth: true),
      ]);
      expect(state.joinableNow(now), isNull);
    });

    test('never offers to join an in-person appointment', () {
      final state = ready([
        appointment(id: 'soon', start: now.add(const Duration(minutes: 5))),
      ]);
      expect(state.joinableNow(now), isNull);
    });

    test('orders upcoming soonest first and past most recent first', () {
      final state = ready([
        appointment(id: 'b', start: now.add(const Duration(days: 2))),
        appointment(id: 'a', start: now.add(const Duration(hours: 2))),
        appointment(id: 'old', start: now.subtract(const Duration(days: 7))),
        appointment(id: 'recent', start: now.subtract(const Duration(days: 1))),
      ]);

      expect(state.upcoming.map((a) => a.id), ['a', 'b']);
      expect(state.past.map((a) => a.id), ['recent', 'old']);
    });

    test('shows only the three most recent results', () {
      final state = PatientDashboardReady(
        appointments: const [],
        results: [
          for (var i = 0; i < 6; i++)
            LabResult(
              id: 'r$i',
              display: 'Test $i',
              performedAt: now.subtract(Duration(days: i)),
            ),
        ],
        invoices: const [],
        medications: const [],
        loadedAt: now,
      );

      expect(state.recentResults.length, 3);
      expect(state.recentResults.first.id, 'r0');
    });

    test('counts only invoices that still owe money', () {
      final state = PatientDashboardReady(
        appointments: const [],
        results: const [],
        invoices: [
          Invoice.fromJson(const {
            'id': 'i1',
            'balance_minor': 5000,
            'total_minor': 5000,
            'paid_minor': 0,
            'status': 'issued',
            'currency': 'AED',
            'invoice_number': 'INV-1',
          }),
          Invoice.fromJson(const {
            'id': 'i2',
            'balance_minor': 0,
            'total_minor': 5000,
            'paid_minor': 5000,
            'status': 'paid',
            'currency': 'AED',
            'invoice_number': 'INV-2',
          }),
        ],
        medications: const [],
        loadedAt: now,
      );

      expect(state.outstandingInvoices.map((i) => i.id), ['i1']);
    });

    test('loads the portal summary and the medication list together', () async {
      when(() => api.get<dynamic>('/portal/summary')).thenAnswer((_) async => {
            'appointments': [
              {
                'id': 'a1',
                'start': '2026-08-22T09:00:00Z',
                'service_type': 'Follow-up',
                'status': 'booked',
                'minutes_duration': 15,
              },
            ],
            'results': <dynamic>[],
            'invoices': <dynamic>[],
          });
      when(() => api.get<dynamic>('/portal/medications')).thenAnswer((_) async => [
            {
              'id': 'm1',
              'code_display': 'Amoxicillin',
              'dose_quantity': 500,
              'dose_unit': 'mg',
              'route': 'oral',
              'frequency': 'TDS',
            },
          ]);

      final bloc = PatientDashboardBloc(api: api, clock: () => now);
      bloc.add(const PatientDashboardRequested());
      await Future<void>.delayed(Duration.zero);

      final state = bloc.state as PatientDashboardReady;
      expect(state.appointments.length, 1);
      expect(state.medications.single.display, 'Amoxicillin');
      await bloc.close();
    });

    test('a wearable reading updates only the wearable card', () async {
      when(() => api.get<dynamic>('/portal/summary')).thenAnswer((_) async => <String, dynamic>{});
      when(() => api.get<dynamic>('/portal/medications')).thenAnswer((_) async => []);

      final bloc = PatientDashboardBloc(api: api, clock: () => now);
      bloc.add(const PatientDashboardRequested());
      await Future<void>.delayed(Duration.zero);

      bloc.add(const WearableDataReceived(
        WearableSummary(steps: 8123, restingHeartRate: 58, available: true),
      ));
      await Future<void>.delayed(Duration.zero);

      final state = bloc.state as PatientDashboardReady;
      expect(state.wearable.steps, 8123);
      expect(state.wearable.hasData, isTrue);
      await bloc.close();
    });
  });

  group('WearableSummary', () {
    test('an unavailable store has no data and is not an error', () {
      const summary = WearableSummary();
      expect(summary.available, isFalse);
      expect(summary.hasData, isFalse);
    });

    test('a denied permission is distinguishable from no readings', () {
      const denied = WearableSummary(available: true, permissionDenied: true);
      const empty = WearableSummary(available: true);
      expect(denied.permissionDenied, isTrue);
      expect(empty.permissionDenied, isFalse);
      expect(denied.hasData, isFalse);
    });
  });

  group('booking', () {
    final slot = Slot(
      id: 's1',
      start: DateTime(2026, 8, 25, 10),
      end: DateTime(2026, 8, 25, 10, 15),
      practitionerId: 'pr1',
    );

    test('groups slots by calendar day for the picker', () {
      final state = BookingSlotsReady('Cardiology', [
        slot,
        Slot(id: 's2', start: DateTime(2026, 8, 25, 11), end: DateTime(2026, 8, 25, 11, 15)),
        Slot(id: 's3', start: DateTime(2026, 8, 26, 9), end: DateTime(2026, 8, 26, 9, 15)),
      ]);

      final byDay = state.byDay;
      expect(byDay.keys.length, 2);
      expect(byDay[DateTime(2026, 8, 25)]!.length, 2);
      // Within a day the times run in order.
      expect(byDay[DateTime(2026, 8, 25)]!.first.start.hour, 10);
    });

    test('refuses to book offline — a slot has to be held', () async {
      when(
        () => api.write(
          any(),
          any(),
          method: any(named: 'method'),
          entityType: any(named: 'entityType'),
          entityId: any(named: 'entityId'),
          updatedAtSnapshot: any(named: 'updatedAtSnapshot'),
        ),
      ).thenAnswer((_) async => null);

      final bloc = BookingBloc(api: api);
      bloc.add(BookingConfirmed(slot: slot, serviceType: 'Cardiology'));
      await Future<void>.delayed(Duration.zero);

      expect(bloc.state, isA<BookingError>());
      expect((bloc.state as BookingError).message, contains('has to be held'));
      await bloc.close();
    });

    test('explains a lost slot in plain words', () async {
      when(
        () => api.write(
          any(),
          any(),
          method: any(named: 'method'),
          entityType: any(named: 'entityType'),
          entityId: any(named: 'entityId'),
          updatedAtSnapshot: any(named: 'updatedAtSnapshot'),
        ),
      ).thenThrow(ApiException(409, null, 'Slot taken', null));

      final bloc = BookingBloc(api: api);
      bloc.add(BookingConfirmed(slot: slot, serviceType: 'Cardiology'));
      await Future<void>.delayed(Duration.zero);

      expect((bloc.state as BookingError).message, contains('just been taken'));
      await bloc.close();
    });

    test('sends the booking with the slot and the telehealth choice', () async {
      when(
        () => api.write(
          any(),
          any(),
          method: any(named: 'method'),
          entityType: any(named: 'entityType'),
          entityId: any(named: 'entityId'),
          updatedAtSnapshot: any(named: 'updatedAtSnapshot'),
        ),
      ).thenAnswer((_) async => <String, dynamic>{'id': 'a1'});

      final bloc = BookingBloc(api: api);
      bloc.add(BookingConfirmed(
        slot: slot,
        serviceType: 'Cardiology',
        telehealth: true,
        reason: 'Palpitations',
      ));
      await Future<void>.delayed(Duration.zero);

      final captured = verify(
        () => api.write(
          captureAny(),
          captureAny(),
          method: any(named: 'method'),
          entityType: any(named: 'entityType'),
          entityId: any(named: 'entityId'),
          updatedAtSnapshot: any(named: 'updatedAtSnapshot'),
        ),
      ).captured;

      expect(captured[0], '/appointments');
      final body = captured[1] as Map<String, dynamic>;
      expect(body['slot_id'], 's1');
      expect(body['is_telehealth'], isTrue);
      expect(body['minutes_duration'], 15);
      expect(body['channel'], 'app');
      expect(body['reason_text'], 'Palpitations');
      expect(bloc.state, isA<BookingConfirmedState>());
      await bloc.close();
    });
  });

  group('payments', () {
    Invoice invoice(String id, int balance, {String status = 'issued'}) => Invoice.fromJson({
          'id': id,
          'invoice_number': 'INV-$id',
          'currency': 'AED',
          'total_minor': 10000,
          'paid_minor': 10000 - balance,
          'balance_minor': balance,
          'status': status,
        });

    test('separates what is owed from what is settled', () {
      final state = PaymentsReady([
        invoice('1', 5000),
        invoice('2', 0, status: 'paid'),
        invoice('3', 2500),
      ]);

      expect(state.outstanding.map((i) => i.id), ['1', '3']);
      expect(state.settled.map((i) => i.id), ['2']);
      expect(state.totalOutstandingMinor, 7500);
    });

    test('totals zero when everything is settled', () {
      final state = PaymentsReady([invoice('1', 0, status: 'paid')]);
      expect(state.totalOutstandingMinor, 0);
      expect(state.outstanding, isEmpty);
    });

    test('falls back to a currency when there are no invoices', () {
      expect(const PaymentsReady([]).currency, 'AED');
    });
  });
}
