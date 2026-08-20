/// The drug round, through the bloc.
///
/// These are the tests that matter most in the whole app. Each one asserts that
/// something dangerous is *refused*: administering to an unverified patient,
/// administering after a wrong-band scan, giving a controlled drug without a
/// fingerprint or a witness, recording an omission with no reason. A regression
/// here reaches a bloodstream.
library;

import 'package:bloc_test/bloc_test.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:medicore_mobile/apps/nurse/emar_bloc.dart';
import 'package:medicore_mobile/core/api_client.dart';
import 'package:medicore_mobile/core/offline_queue.dart';
import 'package:mocktail/mocktail.dart';

class _MockApi extends Mock implements ApiClient {}

class _FakeQueue extends Fake implements OfflineQueue {}

void main() {
  const patientBarcode = 'MRN26000001';

  late _MockApi api;

  final order = MedicationOrder.fromJson(const {
    'id': 'm1',
    'code_display': 'Amoxicillin 500mg',
    'dose_quantity': 500,
    'dose_unit': 'mg',
    'route': 'oral',
    'frequency': 'TDS',
    'code': 'DRUG-161',
    'is_controlled': false,
  });

  final controlled = MedicationOrder.fromJson(const {
    'id': 'm2',
    'code_display': 'Morphine 10mg',
    'dose_quantity': 10,
    'dose_unit': 'mg',
    'route': 'IV',
    'frequency': 'PRN',
    'code': 'DRUG-CD-01',
    'is_controlled': true,
  });

  setUpAll(() {
    registerFallbackValue(<String, dynamic>{});
  });

  setUp(() {
    api = _MockApi();
    when(() => api.queue).thenReturn(_FakeQueue());
    // Stubbed at the exact generic the bloc calls — mocktail matches on the
    // instantiated type, so a `get<dynamic>` stub would never fire here.
    when(() => api.get<List<dynamic>>(any(), query: any(named: 'query')))
        .thenAnswer((_) async => [order.toRow(), controlled.toRow()]);
    when(
      () => api.write(
        any(),
        any(),
        method: any(named: 'method'),
        entityType: any(named: 'entityType'),
        entityId: any(named: 'entityId'),
        updatedAtSnapshot: any(named: 'updatedAtSnapshot'),
      ),
    ).thenAnswer((_) async => <String, dynamic>{'id': 'admin-1'});
  });

  EmarBloc build({Future<bool> Function(String)? reauth}) =>
      EmarBloc(api: api, onControlledDrugReauth: reauth);

  /// Gets the bloc into the state after a correct wristband scan.
  Future<EmarBloc> verified() async {
    final bloc = build();
    bloc.add(const EmarLoaded('p1', patientBarcode));
    await Future<void>.delayed(Duration.zero);
    bloc.add(const EmarPatientScanned(patientBarcode));
    await Future<void>.delayed(Duration.zero);
    return bloc;
  }

  group('wristband scan', () {
    blocTest<EmarBloc, EmarState>(
      'a matching wristband unlocks the drug list',
      build: build,
      act: (bloc) async {
        bloc.add(const EmarLoaded('p1', patientBarcode));
        await Future<void>.delayed(Duration.zero);
        bloc.add(const EmarPatientScanned(patientBarcode));
      },
      verify: (bloc) {
        final state = bloc.state;
        expect(state, isA<EmarReady>());
        expect((state as EmarReady).patientVerified, isTrue);
      },
    );

    blocTest<EmarBloc, EmarState>(
      'ignores case and whitespace on the band',
      build: build,
      act: (bloc) async {
        bloc.add(const EmarLoaded('p1', patientBarcode));
        await Future<void>.delayed(Duration.zero);
        bloc.add(const EmarPatientScanned('  mrn26000001 '));
      },
      verify: (bloc) => expect((bloc.state as EmarReady).patientVerified, isTrue),
    );

    blocTest<EmarBloc, EmarState>(
      'a different patient blocks with a terminal wrong-patient state',
      build: build,
      act: (bloc) async {
        bloc.add(const EmarLoaded('p1', patientBarcode));
        await Future<void>.delayed(Duration.zero);
        bloc.add(const EmarPatientScanned('MRN26000099'));
      },
      verify: (bloc) {
        expect(bloc.state, isA<EmarWrongPatient>());
        final state = bloc.state as EmarWrongPatient;
        expect(state.scanned, 'MRN26000099');
        expect(state.expected, patientBarcode);
      },
    );

    blocTest<EmarBloc, EmarState>(
      'nothing can be administered from the wrong-patient state',
      build: build,
      act: (bloc) async {
        bloc.add(const EmarLoaded('p1', patientBarcode));
        await Future<void>.delayed(Duration.zero);
        bloc.add(const EmarPatientScanned('MRN26000099'));
        await Future<void>.delayed(Duration.zero);
        // A drug scan arriving while blocked must not reach the server.
        bloc.add(EmarMedicationScanned(order, order.barcode));
        await Future<void>.delayed(Duration.zero);
      },
      verify: (bloc) {
        expect(bloc.state, isA<EmarWrongPatient>());
        verifyNever(
          () => api.write(
            any(that: contains('administer')),
            any(),
            method: any(named: 'method'),
            entityType: any(named: 'entityType'),
            entityId: any(named: 'entityId'),
            updatedAtSnapshot: any(named: 'updatedAtSnapshot'),
          ),
        );
      },
    );
  });

  group('administration', () {
    test('records the administration once every right passes', () async {
      final bloc = await verified();
      bloc.add(EmarMedicationScanned(order, order.barcode));
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

      expect(captured[0], '/pharmacy/administer');
      final body = captured[1] as Map<String, dynamic>;
      expect(body['medication_id'], 'm1');
      expect(body['scanned_patient_barcode'], patientBarcode);
      expect(body['scanned_medication_barcode'], order.barcode);
      await bloc.close();
    });

    test('refuses a medication barcode that does not match the order', () async {
      final bloc = await verified();
      bloc.add(EmarMedicationScanned(order, 'DRUG-999'));
      await Future<void>.delayed(Duration.zero);

      expect(bloc.state, isA<EmarVerificationFailed>());
      verifyNever(
        () => api.write(
          any(that: contains('administer')),
          any(),
          method: any(named: 'method'),
          entityType: any(named: 'entityType'),
          entityId: any(named: 'entityId'),
          updatedAtSnapshot: any(named: 'updatedAtSnapshot'),
        ),
      );
      await bloc.close();
    });

    test('refuses to administer before the wristband has been scanned', () async {
      final bloc = build();
      bloc.add(const EmarLoaded('p1', patientBarcode));
      await Future<void>.delayed(Duration.zero);

      // Straight to the drug, with no patient verification.
      bloc.add(EmarMedicationScanned(order, order.barcode));
      await Future<void>.delayed(Duration.zero);

      expect(bloc.state, isA<EmarWrongPatient>());
      verifyNever(
        () => api.write(
          any(that: contains('administer')),
          any(),
          method: any(named: 'method'),
          entityType: any(named: 'entityType'),
          entityId: any(named: 'entityId'),
          updatedAtSnapshot: any(named: 'updatedAtSnapshot'),
        ),
      );
      await bloc.close();
    });

    test('surfaces a server wrong-patient decision as the full block', () async {
      when(
        () => api.write(
          any(),
          any(),
          method: any(named: 'method'),
          entityType: any(named: 'entityType'),
          entityId: any(named: 'entityId'),
          updatedAtSnapshot: any(named: 'updatedAtSnapshot'),
        ),
      ).thenThrow(ApiException(409, 'WRONG_PATIENT', 'Wrong patient', null));

      final bloc = await verified();
      bloc.add(EmarMedicationScanned(order, order.barcode));
      await Future<void>.delayed(Duration.zero);

      expect(bloc.state, isA<EmarWrongPatient>());
      await bloc.close();
    });
  });

  group('controlled drugs', () {
    test('will not proceed without a biometric confirmation', () async {
      final bloc = build(reauth: (_) async => false);
      bloc.add(const EmarLoaded('p1', patientBarcode));
      await Future<void>.delayed(Duration.zero);
      bloc.add(const EmarPatientScanned(patientBarcode));
      await Future<void>.delayed(Duration.zero);

      bloc.add(EmarMedicationScanned(controlled, controlled.barcode, witnessId: 'w1'));
      await Future<void>.delayed(Duration.zero);

      expect(bloc.state, isA<EmarError>());
      expect((bloc.state as EmarError).message, contains('Biometric'));
      verifyNever(
        () => api.write(
          any(that: contains('administer')),
          any(),
          method: any(named: 'method'),
          entityType: any(named: 'entityType'),
          entityId: any(named: 'entityId'),
          updatedAtSnapshot: any(named: 'updatedAtSnapshot'),
        ),
      );
      await bloc.close();
    });

    test('will not proceed without a witness, even with a fingerprint', () async {
      final bloc = build(reauth: (_) async => true);
      bloc.add(const EmarLoaded('p1', patientBarcode));
      await Future<void>.delayed(Duration.zero);
      bloc.add(const EmarPatientScanned(patientBarcode));
      await Future<void>.delayed(Duration.zero);

      bloc.add(EmarMedicationScanned(controlled, controlled.barcode));
      await Future<void>.delayed(Duration.zero);

      expect(bloc.state, isA<EmarError>());
      expect((bloc.state as EmarError).message, contains('witness'));
      await bloc.close();
    });

    test('records the witness on the administration when both are supplied', () async {
      final bloc = build(reauth: (_) async => true);
      bloc.add(const EmarLoaded('p1', patientBarcode));
      await Future<void>.delayed(Duration.zero);
      bloc.add(const EmarPatientScanned(patientBarcode));
      await Future<void>.delayed(Duration.zero);

      bloc.add(EmarMedicationScanned(controlled, controlled.barcode, witnessId: 'w1'));
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
      expect((captured.last as Map<String, dynamic>)['witness_id'], 'w1');
      await bloc.close();
    });

    test('an ordinary drug needs neither a fingerprint nor a witness', () async {
      // The reauth callback is absent entirely, which for a controlled drug
      // would be a refusal.
      final bloc = await verified();
      bloc.add(EmarMedicationScanned(order, order.barcode));
      await Future<void>.delayed(Duration.zero);

      verify(
        () => api.write(
          any(that: contains('administer')),
          any(),
          method: any(named: 'method'),
          entityType: any(named: 'entityType'),
          entityId: any(named: 'entityId'),
          updatedAtSnapshot: any(named: 'updatedAtSnapshot'),
        ),
      ).called(1);
      await bloc.close();
    });
  });

  group('missed doses', () {
    test('records the omission with its reason', () async {
      final bloc = await verified();
      bloc.add(EmarDoseMissed(order, 'Patient refused', notes: 'Declined twice'));
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
      expect(body['status'], 'not-done');
      expect(body['not_given_reason'], 'Patient refused');
      expect(body['notes'], 'Declined twice');
      // A missed dose is zero given, never the ordered amount.
      expect(body['dose_given'], 0);
      await bloc.close();
    });

    test('refuses an omission with no reason', () async {
      final bloc = await verified();
      bloc.add(EmarDoseMissed(order, '   '));
      await Future<void>.delayed(Duration.zero);

      expect(bloc.state, isA<EmarError>());
      verifyNever(
        () => api.write(
          any(that: contains('administer')),
          any(),
          method: any(named: 'method'),
          entityType: any(named: 'entityType'),
          entityId: any(named: 'entityId'),
          updatedAtSnapshot: any(named: 'updatedAtSnapshot'),
        ),
      );
      await bloc.close();
    });

    test('offers reasons an audit can actually count', () {
      expect(missedDoseReasons, contains('Patient refused'));
      expect(missedDoseReasons, contains('Nil by mouth'));
      expect(missedDoseReasons.length, greaterThanOrEqualTo(6));
    });
  });

  group('clearing a block', () {
    blocTest<EmarBloc, EmarState>(
      'returns to the initial state so the round can be restarted',
      build: build,
      act: (bloc) async {
        bloc.add(const EmarLoaded('p1', patientBarcode));
        await Future<void>.delayed(Duration.zero);
        bloc.add(const EmarPatientScanned('MRN26000099'));
        await Future<void>.delayed(Duration.zero);
        bloc.add(const EmarBlockCleared());
      },
      verify: (bloc) => expect(bloc.state, isA<EmarInitial>()),
    );
  });
}

/// Round-trips an order back to the JSON shape the API returns.
extension on MedicationOrder {
  Map<String, dynamic> toRow() => {
        'id': id,
        'code_display': display,
        'dose_quantity': doseQuantity,
        'dose_unit': doseUnit,
        'route': route,
        'frequency': frequency,
        'code': barcode,
        'is_controlled': isControlled,
      };
}
