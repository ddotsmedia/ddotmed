/// Vitals submission and shift handover.
library;

import 'package:flutter_test/flutter_test.dart';
import 'package:medicore_mobile/apps/nurse/handover_bloc.dart';
import 'package:medicore_mobile/apps/nurse/vitals_bloc.dart';
import 'package:medicore_mobile/core/api_client.dart';
import 'package:medicore_mobile/core/ews.dart';
import 'package:medicore_mobile/core/models.dart';
import 'package:medicore_mobile/core/offline_queue.dart';
import 'package:mocktail/mocktail.dart';

class _MockApi extends Mock implements ApiClient {}

class _FakeQueue extends Fake implements OfflineQueue {}

final _patient = Patient.fromJson(const {
  'id': 'p1',
  'mrn': 'MRN26000001',
  'given_names': ['Amina'],
  'family_name': 'Rahman',
});

void main() {
  late _MockApi api;

  setUpAll(() => registerFallbackValue(<String, dynamic>{}));

  setUp(() {
    api = _MockApi();
    when(() => api.queue).thenReturn(_FakeQueue());
    when(
      () => api.write(
        any(),
        any(),
        method: any(named: 'method'),
        entityType: any(named: 'entityType'),
        entityId: any(named: 'entityId'),
        updatedAtSnapshot: any(named: 'updatedAtSnapshot'),
      ),
    ).thenAnswer((_) async => <String, dynamic>{'id': 'v1'});
  });

  Future<VitalsBloc> selected() async {
    final bloc = VitalsBloc(api: api);
    bloc.add(VitalsPatientSelected(_patient));
    await Future<void>.delayed(Duration.zero);
    return bloc;
  }

  group('vitals entry', () {
    test('starts empty, and an empty form is not a real score', () async {
      final bloc = await selected();
      final state = bloc.state as VitalsEntry;
      expect(state.isEmpty, isTrue);
      // Supplemental oxygen contributes even with nothing entered, so score
      // alone cannot be the emptiness test.
      expect(state.result.missing.length, 6);
      await bloc.close();
    });

    test('recomputes the score as fields are filled', () async {
      final bloc = await selected();
      bloc.add(const VitalsFieldChanged(EwsInput(
        respiratoryRate: 22,
        spo2: 92,
        heartRate: 100,
        systolicBp: 120,
        temperatureC: 37,
        consciousness: Consciousness.alert,
      )));
      await Future<void>.delayed(Duration.zero);

      final state = bloc.state as VitalsEntry;
      expect(state.result.score, 5);
      expect(state.result.risk, EwsRisk.medium);
      expect(state.isEmpty, isFalse);
      await bloc.close();
    });

    test('surfaces a critical value alongside the aggregate', () async {
      final bloc = await selected();
      bloc.add(const VitalsFieldChanged(EwsInput(spo2: 84)));
      await Future<void>.delayed(Duration.zero);

      final state = bloc.state as VitalsEntry;
      expect(state.critical.single.parameter, 'SpO2');
      await bloc.close();
    });

    test('sends the readings and the score it showed the nurse', () async {
      final bloc = await selected();
      bloc.add(const VitalsSubmitted(
        input: EwsInput(
          respiratoryRate: 18,
          spo2: 97,
          systolicBp: 118,
          heartRate: 76,
          temperatureC: 36.9,
          consciousness: Consciousness.alert,
        ),
        diastolicBp: 78,
        painScore: 2,
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

      expect(captured[0], '/vitals');
      final body = captured[1] as Map<String, dynamic>;
      expect(body['patient_id'], 'p1');
      expect(body['respiratory_rate'], 18);
      expect(body['diastolic_bp'], 78);
      expect(body['pain_score'], 2);
      // The band the nurse acted on travels with the reading.
      expect(body['ews_score'], 0);
      expect(body['ews_risk'], 'low');
      await bloc.close();
    });

    test('omits a parameter that was not recorded rather than sending null', () async {
      final bloc = await selected();
      bloc.add(const VitalsSubmitted(input: EwsInput(spo2: 97)));
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
      expect(body.containsKey('spo2'), isTrue);
      expect(body.containsKey('heart_rate'), isFalse);
      await bloc.close();
    });

    test('reports a queued write as held on the device', () async {
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

      final bloc = await selected();
      bloc.add(const VitalsSubmitted(input: EwsInput(spo2: 97)));
      await Future<void>.delayed(Duration.zero);

      final state = bloc.state as VitalsSaved;
      expect(state.queuedOffline, isTrue);
      await bloc.close();
    });
  });

  group('SbarNote', () {
    const full = SbarNote(
      situation: 'Day 3 post-op',
      background: 'Elective hemicolectomy',
      assessment: 'Stable, NEWS2 1',
      recommendation: 'Mobilise, remove catheter tomorrow',
    );

    test('is complete only when every section says something', () {
      expect(full.isComplete, isTrue);
      expect(full.copyWith(recommendation: '').isComplete, isFalse);
      expect(full.copyWith(recommendation: '   ').isComplete, isFalse);
    });

    test('is empty only when nothing has been written', () {
      expect(const SbarNote().isEmpty, isTrue);
      expect(full.isEmpty, isFalse);
      expect(const SbarNote(situation: 'x').isEmpty, isFalse);
    });

    test('renders a flat body for readers that do not know SBAR', () {
      expect(full.body, contains('S: Day 3 post-op'));
      expect(full.body, contains('R: Mobilise'));
    });

    test('round-trips through JSON', () {
      expect(SbarNote.fromJson(full.toJson()), full);
    });

    test('tolerates a partial draft from the server', () {
      final note = SbarNote.fromJson(const {'situation': 'Only this'});
      expect(note.situation, 'Only this');
      expect(note.background, '');
      expect(note.isComplete, isFalse);
    });
  });

  group('handover', () {
    HandoverReady ready({
      Map<String, SbarNote> notes = const {},
      Set<String> signed = const {},
      Set<String> aiDrafted = const {},
    }) =>
        HandoverReady(
          patients: [_patient],
          notes: notes,
          aiDrafted: aiDrafted,
          signed: signed,
        );

    test('counts patients still to hand over', () {
      expect(ready().outstanding, 1);
      expect(ready(signed: {'p1'}).outstanding, 0);
    });

    test('gives an empty note for a patient nobody has written up', () {
      expect(ready().noteFor('p1'), const SbarNote());
    });

    test('refuses to sign an incomplete note', () async {
      final bloc = HandoverBloc(api: api);
      bloc.emit(ready(notes: {'p1': const SbarNote(situation: 'Only this')}));

      bloc.add(const HandoverSigned('p1'));
      await Future<void>.delayed(Duration.zero);

      final state = bloc.state as HandoverReady;
      expect(state.signed, isEmpty);
      expect(state.message, contains('Complete every SBAR section'));
      verifyNever(
        () => api.write(
          any(that: contains('notes')),
          any(),
          method: any(named: 'method'),
          entityType: any(named: 'entityType'),
          entityId: any(named: 'entityId'),
          updatedAtSnapshot: any(named: 'updatedAtSnapshot'),
        ),
      );
      await bloc.close();
    });

    test('files a complete note and marks it signed', () async {
      final bloc = HandoverBloc(api: api);
      bloc.emit(ready(notes: {'p1': full}, aiDrafted: {'p1'}));

      bloc.add(const HandoverSigned('p1'));
      await Future<void>.delayed(Duration.zero);

      expect((bloc.state as HandoverReady).signed, contains('p1'));

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
      expect(body['type'], 'sbar');
      // The record says a model drafted it, so an audit can find those notes.
      expect(body['ai_drafted'], isTrue);
      await bloc.close();
    });

    test('editing a signed note revokes the signature', () async {
      final bloc = HandoverBloc(api: api);
      bloc.emit(ready(notes: {'p1': full}, signed: {'p1'}));

      bloc.add(HandoverEdited('p1', full.copyWith(assessment: 'Deteriorating')));
      await Future<void>.delayed(Duration.zero);

      // What was signed is no longer what is written.
      expect((bloc.state as HandoverReady).signed, isEmpty);
      await bloc.close();
    });
  });
}

const full = SbarNote(
  situation: 'Day 3 post-op',
  background: 'Elective hemicolectomy',
  assessment: 'Stable, NEWS2 1',
  recommendation: 'Mobilise, remove catheter tomorrow',
);
