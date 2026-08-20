/// Ordering safety and the Today list's ordering.
library;

import 'package:flutter_test/flutter_test.dart';
import 'package:medicore_mobile/apps/doctor/doctor_blocs.dart';
import 'package:medicore_mobile/apps/doctor/orders_bloc.dart';
import 'package:medicore_mobile/core/api_client.dart';
import 'package:medicore_mobile/core/models.dart';
import 'package:medicore_mobile/core/offline_queue.dart';
import 'package:mocktail/mocktail.dart';

class _MockApi extends Mock implements ApiClient {}

class _FakeQueue extends Fake implements OfflineQueue {}

const _drug = CatalogueItem(code: 'RX-1', display: 'Warfarin 5mg');

void main() {
  late _MockApi api;

  setUpAll(() => registerFallbackValue(<String, dynamic>{}));

  setUp(() {
    api = _MockApi();
    when(() => api.queue).thenReturn(_FakeQueue());
  });

  void stubWrite(Object? Function() answer) {
    when(
      () => api.write(
        any(),
        any(),
        method: any(named: 'method'),
        entityType: any(named: 'entityType'),
        entityId: any(named: 'entityId'),
        updatedAtSnapshot: any(named: 'updatedAtSnapshot'),
      ),
    ).thenAnswer((_) async => answer() as Map<String, dynamic>?);
  }

  group('interaction checking', () {
    test('a clean check clears the prescriber to proceed', () async {
      stubWrite(() => <String, dynamic>{'interactions': <dynamic>[], 'warnings': <dynamic>[]});

      final bloc = OrdersBloc(api: api);
      bloc.add(const InteractionCheckRequested(
        patientId: 'p1',
        drug: _drug,
        doseQuantity: 5,
        route: 'oral',
      ));
      await Future<void>.delayed(Duration.zero);

      expect(bloc.state, isA<OrdersSafetyClear>());
      await bloc.close();
    });

    test('an interaction comes back as an overridable warning', () async {
      stubWrite(() => <String, dynamic>{
            'interactions': [
              {
                'code': 'DDI-1',
                'message': 'Warfarin with aspirin increases bleeding risk',
                'severity': 'major',
                'override_allowed': true,
              },
            ],
          });

      final bloc = OrdersBloc(api: api);
      bloc.add(const InteractionCheckRequested(
        patientId: 'p1',
        drug: _drug,
        doseQuantity: 5,
        route: 'oral',
      ));
      await Future<void>.delayed(Duration.zero);

      final state = bloc.state as OrdersSafetyWarning;
      expect(state.hasAbsolute, isFalse);
      expect(state.requiresReason, isTrue);
      expect(state.findings.single.message, contains('bleeding risk'));
      await bloc.close();
    });

    test('a contraindication is absolute and cannot be overridden here', () async {
      stubWrite(() => <String, dynamic>{
            'allergy_warnings': [
              {
                'code': 'ALLERGY_CONTRAINDICATION',
                'message': 'Documented anaphylaxis to penicillin',
                'severity': 'contraindicated',
              },
            ],
          });

      final bloc = OrdersBloc(api: api);
      bloc.add(const InteractionCheckRequested(
        patientId: 'p1',
        drug: _drug,
        doseQuantity: 5,
        route: 'oral',
      ));
      await Future<void>.delayed(Duration.zero);

      final state = bloc.state as OrdersSafetyWarning;
      expect(state.hasAbsolute, isTrue);
      // No override affordance is offered for an absolute block.
      expect(state.requiresReason, isFalse);
      await bloc.close();
    });

    test('a 422 from the server is a refusal, not a warning to click past', () async {
      when(
        () => api.write(
          any(),
          any(),
          method: any(named: 'method'),
          entityType: any(named: 'entityType'),
          entityId: any(named: 'entityId'),
          updatedAtSnapshot: any(named: 'updatedAtSnapshot'),
        ),
      ).thenThrow(ApiException(
        422,
        'ALLERGY_CONTRAINDICATION',
        'Documented anaphylaxis',
        const {'override_allowed': false},
      ));

      final bloc = OrdersBloc(api: api);
      bloc.add(const InteractionCheckRequested(
        patientId: 'p1',
        drug: _drug,
        doseQuantity: 5,
        route: 'oral',
      ));
      await Future<void>.delayed(Duration.zero);

      expect((bloc.state as OrdersSafetyWarning).hasAbsolute, isTrue);
      await bloc.close();
    });

    test('a 409 with an allowed override is passable with a reason', () async {
      when(
        () => api.write(
          any(),
          any(),
          method: any(named: 'method'),
          entityType: any(named: 'entityType'),
          entityId: any(named: 'entityId'),
          updatedAtSnapshot: any(named: 'updatedAtSnapshot'),
        ),
      ).thenThrow(ApiException(
        409,
        'DRUG_INTERACTION',
        'Moderate interaction',
        const {'override_allowed': true},
      ));

      final bloc = OrdersBloc(api: api);
      bloc.add(const InteractionCheckRequested(
        patientId: 'p1',
        drug: _drug,
        doseQuantity: 5,
        route: 'oral',
      ));
      await Future<void>.delayed(Duration.zero);

      final state = bloc.state as OrdersSafetyWarning;
      expect(state.hasAbsolute, isFalse);
      expect(state.requiresReason, isTrue);
      await bloc.close();
    });

    test('an unrunnable check warns rather than passing as clear', () async {
      // Offline. Prescribing into an unknown interaction profile is not the same
      // as prescribing into a clean one.
      stubWrite(() => null);

      final bloc = OrdersBloc(api: api);
      bloc.add(const InteractionCheckRequested(
        patientId: 'p1',
        drug: _drug,
        doseQuantity: 5,
        route: 'oral',
      ));
      await Future<void>.delayed(Duration.zero);

      final state = bloc.state as OrdersSafetyWarning;
      expect(state.findings.single.code, 'CHECK_UNAVAILABLE');
      expect(state.findings.single.message, contains('not been screened'));
      await bloc.close();
    });
  });

  group('order submission', () {
    test('sends a lab order against the LOINC catalogue', () async {
      stubWrite(() => <String, dynamic>{'id': 'sr1'});

      final bloc = OrdersBloc(api: api);
      bloc.add(const LabOrderSubmitted(
        patientId: 'p1',
        encounterId: 'e1',
        item: CatalogueItem(code: '2160-0', display: 'Creatinine'),
        priority: OrderPriority.stat,
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

      expect(captured[0], '/service-requests');
      final body = captured[1] as Map<String, dynamic>;
      expect(body['category'], 'laboratory');
      expect(body['code'], '2160-0');
      expect(body['priority'], 'stat');
      expect(body['code_system'], contains('loinc'));
      await bloc.close();
    });

    test('sends a radiology order with the modality and body part', () async {
      stubWrite(() => <String, dynamic>{'id': 'sr2'});

      final bloc = OrdersBloc(api: api);
      bloc.add(const RadiologyOrderSubmitted(
        patientId: 'p1',
        encounterId: 'e1',
        modality: 'CT',
        bodySite: 'Chest',
        priority: OrderPriority.urgent,
      ));
      await Future<void>.delayed(Duration.zero);

      final captured = verify(
        () => api.write(
          any(),
          captureAny(),
          method: any(named: 'method'),
          entityType: any(named: 'entityType'),
          entityId: any(named: 'entityId'),
          updatedAtSnapshot: any(named: 'updatedAtSnapshot'),
        ),
      ).captured;

      final body = captured.last as Map<String, dynamic>;
      expect(body['category'], 'imaging');
      expect(body['code'], 'CT');
      expect(body['body_site'], 'Chest');
      expect(body['code_display'], 'CT Chest');
      await bloc.close();
    });

    test('reports an order held on the device as queued', () async {
      stubWrite(() => null);

      final bloc = OrdersBloc(api: api);
      bloc.add(const LabOrderSubmitted(
        patientId: 'p1',
        encounterId: 'e1',
        item: CatalogueItem(code: '2160-0', display: 'Creatinine'),
        priority: OrderPriority.routine,
      ));
      await Future<void>.delayed(Duration.zero);

      expect((bloc.state as OrdersSubmitted).queuedOffline, isTrue);
      await bloc.close();
    });

    test('carries the override reason onto the prescription', () async {
      stubWrite(() => <String, dynamic>{'id': 'm1'});

      final bloc = OrdersBloc(api: api);
      bloc.add(const PrescriptionSubmitted(
        patientId: 'p1',
        encounterId: 'e1',
        drug: _drug,
        doseQuantity: 5,
        doseUnit: 'mg',
        route: 'oral',
        frequency: 'OD',
        overrideReason: 'Benefit outweighs risk, INR monitored weekly',
      ));
      await Future<void>.delayed(Duration.zero);

      final captured = verify(
        () => api.write(
          any(),
          captureAny(),
          method: any(named: 'method'),
          entityType: any(named: 'entityType'),
          entityId: any(named: 'entityId'),
          updatedAtSnapshot: any(named: 'updatedAtSnapshot'),
        ),
      ).captured;

      final body = captured.last as Map<String, dynamic>;
      expect(body['override_reason'], contains('INR monitored'));
      await bloc.close();
    });
  });

  group('catalogue search', () {
    test('does not query on a single character', () async {
      final bloc = OrdersBloc(api: api);
      bloc.add(const CatalogueSearched('drug', 'w'));
      await Future<void>.delayed(Duration.zero);

      expect((bloc.state as OrdersResults).items, isEmpty);
      verifyNever(() => api.get<dynamic>(any(), query: any(named: 'query')));
      await bloc.close();
    });
  });

  group('priority labels', () {
    test('STAT reads as STAT, not as stat', () {
      expect(OrderPriority.stat.label, 'STAT');
      expect(OrderPriority.stat.wire, 'stat');
      expect(OrderPriority.routine.label, 'Routine');
    });
  });

  group('Today ordering', () {
    Patient patient(String id) => Patient(
          id: id,
          mrn: 'MRN$id',
          givenNames: const ['A'],
          familyName: 'B',
          ward: 'Ward A',
          bed: id,
        );

    VitalReading vital(String id, int score) => VitalReading(
          id: 'v$id',
          recordedAt: DateTime(2026, 8, 21, 8),
          ewsScore: score,
          ewsRisk: score >= 7 ? 'high' : 'low',
        );

    test('puts the sickest patient at the top, not the lowest bed number', () {
      final state = TodayReady(
        appointments: const [],
        inpatients: [patient('1'), patient('2'), patient('3')],
        latestVitals: {'1': vital('1', 1), '2': vital('2', 9), '3': vital('3', 4)},
        loadedAt: DateTime(2026, 8, 21, 9),
      );

      expect(state.inpatientsByAcuity.map((p) => p.id), ['2', '3', '1']);
    });

    test('sorts a patient with no observations last', () {
      final state = TodayReady(
        appointments: const [],
        inpatients: [patient('1'), patient('2')],
        latestVitals: {'2': vital('2', 0)},
        loadedAt: DateTime(2026, 8, 21, 9),
      );

      // No score is not the same as a score of zero; unknown sorts below known.
      expect(state.inpatientsByAcuity.first.id, '2');
    });

    test('splits the clinic list into upcoming and earlier', () {
      final now = DateTime(2026, 8, 21, 12);
      Appointment appointment(String id, int hour, {String status = 'booked'}) => Appointment(
            id: id,
            start: DateTime(2026, 8, 21, hour),
            serviceType: 'Follow-up',
            status: status,
            minutesDuration: 15,
          );

      final state = TodayReady(
        appointments: [
          appointment('past', 9),
          appointment('next', 14),
          appointment('later', 16),
          appointment('done', 15, status: 'fulfilled'),
        ],
        inpatients: const [],
        latestVitals: const {},
        loadedAt: now,
      );

      expect(state.upcoming.map((a) => a.id), ['next', 'later']);
      expect(state.earlier.map((a) => a.id), containsAll(['past', 'done']));
    });
  });
}
