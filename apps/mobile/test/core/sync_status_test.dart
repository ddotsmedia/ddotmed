/// Sync state as the clinician sees it.
///
/// The label is the contract here. A nurse looking at "Pending 3" is being told
/// that three observations exist only on this handset and that nobody at the
/// nurses' station can see them. Getting that wrong — showing "Synced" while
/// writes are queued — is worse than showing nothing.
library;

import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:medicore_mobile/core/api_client.dart';
import 'package:medicore_mobile/core/offline_queue.dart';
import 'package:medicore_mobile/core/sync_status.dart';
import 'package:mocktail/mocktail.dart';

class _MockApi extends Mock implements ApiClient {}

class _MockQueue extends Mock implements OfflineQueue {}

PendingOperation _operation(String id) => PendingOperation(
      id: id,
      method: 'POST',
      path: '/vitals',
      body: const {'patient_id': 'p1'},
      createdAt: DateTime(2026, 8, 21, 9),
    );

void main() {
  late _MockApi api;
  late _MockQueue queue;
  late StreamController<SyncOutcome> outcomes;
  late StreamController<bool> connectivity;

  setUp(() {
    api = _MockApi();
    queue = _MockQueue();
    outcomes = StreamController<SyncOutcome>.broadcast();
    connectivity = StreamController<bool>.broadcast();

    when(() => api.queue).thenReturn(queue);
    when(() => api.syncEvents).thenAnswer((_) => outcomes.stream);
    when(() => queue.length).thenReturn(0);
    when(api.sync).thenAnswer((_) async => const []);
  });

  tearDown(() async {
    await outcomes.close();
    await connectivity.close();
  });

  SyncStatusCubit build() => SyncStatusCubit(api: api, connectivity: connectivity.stream);

  group('labels', () {
    test('an empty queue reads as synced', () {
      final cubit = build();
      expect(cubit.state.phase, SyncPhase.synced);
      expect(cubit.state.label, 'Synced');
      expect(cubit.state.hasPending, isFalse);
    });

    test('a queued write says how many are held', () {
      when(() => queue.length).thenReturn(3);
      final cubit = build();
      expect(cubit.state.phase, SyncPhase.pending);
      expect(cubit.state.label, 'Pending 3');
      expect(cubit.state.hasPending, isTrue);
    });

    test('offline with nothing queued still says offline', () {
      final cubit = build();
      connectivity.add(false);
      return Future<void>.delayed(Duration.zero, () {
        expect(cubit.state.phase, SyncPhase.offline);
        expect(cubit.state.label, 'Offline');
      });
    });

    test('offline with writes held says both', () async {
      when(() => queue.length).thenReturn(2);
      final cubit = build();
      connectivity.add(false);
      await Future<void>.delayed(Duration.zero);
      expect(cubit.state.label, 'Offline · 2 held');
    });
  });

  group('draining', () {
    test('reports synced when the queue empties', () async {
      when(() => queue.length).thenReturn(2);
      final cubit = build();

      // The queue empties as the drain succeeds.
      when(() => queue.length).thenReturn(0);
      await cubit.drain();

      expect(cubit.state.phase, SyncPhase.synced);
      expect(cubit.state.pendingCount, 0);
      expect(cubit.state.lastSyncedAt, isNotNull);
    });

    test('stays pending when writes remain', () async {
      when(() => queue.length).thenReturn(3);
      final cubit = build();
      when(() => queue.length).thenReturn(1);

      await cubit.drain();
      expect(cubit.state.phase, SyncPhase.pending);
      expect(cubit.state.pendingCount, 1);
    });

    test('surfaces a dropped write as an error rather than silence', () async {
      when(api.sync).thenAnswer((_) async => [
            SyncOutcome(
              operation: _operation('o1'),
              resolution: ConflictResolution.discarded,
              error: 'gave up after 5 attempts',
            ),
          ]);

      final cubit = build();
      await cubit.drain();

      expect(cubit.state.phase, SyncPhase.error);
      expect(cubit.state.message, contains('could not be saved'));
      expect(cubit.state.discarded, hasLength(1));
    });

    test('a thrown drain becomes an error state, not an exception', () async {
      when(api.sync).thenThrow(Exception('socket closed'));
      final cubit = build();
      await cubit.drain();
      expect(cubit.state.phase, SyncPhase.error);
    });

    test('two overlapping drains only replay the queue once', () async {
      var calls = 0;
      when(api.sync).thenAnswer((_) async {
        calls += 1;
        await Future<void>.delayed(const Duration(milliseconds: 20));
        return const [];
      });

      final cubit = build();
      // A reconnect and a pull-to-refresh arriving together must not replay a
      // clinical write twice.
      await Future.wait([cubit.drain(), cubit.drain()]);
      expect(calls, 1);
    });
  });

  group('reconnection', () {
    test('drains automatically when the signal comes back', () async {
      when(() => queue.length).thenReturn(1);
      final cubit = build();

      connectivity.add(true);
      await Future<void>.delayed(const Duration(milliseconds: 10));

      verify(api.sync).called(greaterThanOrEqualTo(1));
      await cubit.close();
    });
  });

  group('discarded writes', () {
    test('are cleared once the clinician has seen them', () async {
      when(api.sync).thenAnswer((_) async => [
            SyncOutcome(
              operation: _operation('o1'),
              resolution: ConflictResolution.discarded,
            ),
          ]);

      final cubit = build();
      await cubit.drain();
      expect(cubit.state.discarded, isNotEmpty);

      cubit.acknowledgeDiscarded();
      expect(cubit.state.discarded, isEmpty);
      expect(cubit.state.phase, SyncPhase.synced);
    });

    test('a server-wins resolution is not reported as a failure', () async {
      final cubit = build();
      outcomes.add(SyncOutcome(
        operation: _operation('o1'),
        resolution: ConflictResolution.serverWins,
        serverState: const {'id': 'v1'},
      ));
      await Future<void>.delayed(Duration.zero);

      expect(cubit.state.phase, isNot(SyncPhase.error));
    });
  });

  group('refreshPending', () {
    test('recounts from the queue rather than tracking a delta', () {
      final cubit = build();
      expect(cubit.state.pendingCount, 0);

      when(() => queue.length).thenReturn(5);
      cubit.refreshPending();
      expect(cubit.state.pendingCount, 5);
      expect(cubit.state.phase, SyncPhase.pending);
    });
  });
}
