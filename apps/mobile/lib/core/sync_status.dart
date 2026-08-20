/// Broadcasts sync state to every screen.
///
/// Implemented as a Cubit rather than a ChangeNotifier so the whole app stays on
/// one state library — the codebase uses BLoC exclusively, and a second
/// notification mechanism would mean two ways to rebuild a widget.
///
/// The value this carries is not decoration. A nurse who has just filed
/// observations on a ward with no signal needs to know the reading is held on the
/// device and not yet on the server, because until it syncs nobody else can see
/// it. "Pending 3" is that sentence, rendered in a chip.
library;

import 'dart:async';

import 'package:bloc/bloc.dart';
import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:equatable/equatable.dart';

import 'api_client.dart';
import 'offline_queue.dart';

enum SyncPhase {
  /// Everything written locally has reached the server.
  synced,

  /// Writes are held on the device, waiting for a connection.
  pending,

  /// Actively draining the queue.
  syncing,

  /// The last drain failed, or a queued write was given up on.
  error,

  /// No connection at all. Distinct from `pending`: there may be nothing queued.
  offline,
}

class SyncStatus extends Equatable {
  const SyncStatus({
    required this.phase,
    this.pendingCount = 0,
    this.lastSyncedAt,
    this.message,
    this.discarded = const [],
  });

  const SyncStatus.initial() : this(phase: SyncPhase.synced);

  final SyncPhase phase;
  final int pendingCount;
  final DateTime? lastSyncedAt;
  final String? message;

  /// Writes abandoned after exhausting their retries. Surfaced rather than
  /// swallowed: the clinician has to know what never made it.
  final List<PendingOperation> discarded;

  bool get hasPending => pendingCount > 0;

  String get label => switch (phase) {
        SyncPhase.synced => 'Synced',
        SyncPhase.pending => 'Pending $pendingCount',
        SyncPhase.syncing => 'Syncing…',
        SyncPhase.error => message ?? 'Sync failed',
        SyncPhase.offline => pendingCount > 0 ? 'Offline · $pendingCount held' : 'Offline',
      };

  SyncStatus copyWith({
    SyncPhase? phase,
    int? pendingCount,
    DateTime? lastSyncedAt,
    String? message,
    List<PendingOperation>? discarded,
  }) =>
      SyncStatus(
        phase: phase ?? this.phase,
        pendingCount: pendingCount ?? this.pendingCount,
        lastSyncedAt: lastSyncedAt ?? this.lastSyncedAt,
        message: message,
        discarded: discarded ?? this.discarded,
      );

  @override
  List<Object?> get props => [phase, pendingCount, lastSyncedAt, message, discarded.length];
}

class SyncStatusCubit extends Cubit<SyncStatus> {
  SyncStatusCubit({
    required ApiClient api,
    Stream<bool>? connectivity,
  })  : _api = api,
        super(const SyncStatus.initial()) {
    _outcomeSub = _api.syncEvents.listen(_onOutcome);
    _connectivitySub = (connectivity ?? _defaultConnectivity()).listen(_onConnectivity);
    refreshPending();
  }

  final ApiClient _api;
  StreamSubscription<SyncOutcome>? _outcomeSub;
  StreamSubscription<bool>? _connectivitySub;
  bool _draining = false;

  static Stream<bool> _defaultConnectivity() => Connectivity()
      .onConnectivityChanged
      .map((results) => !results.contains(ConnectivityResult.none));

  /// Recomputes the pending count from the queue itself rather than tracking it
  /// incrementally — an increment that drifts is worse than a cheap recount.
  void refreshPending() {
    final count = _api.queue.length;
    if (count == 0) {
      emit(state.copyWith(
        phase: state.phase == SyncPhase.offline ? SyncPhase.offline : SyncPhase.synced,
        pendingCount: 0,
      ));
      return;
    }
    emit(state.copyWith(
      phase: state.phase == SyncPhase.offline ? SyncPhase.offline : SyncPhase.pending,
      pendingCount: count,
    ));
  }

  void _onConnectivity(bool online) {
    if (!online) {
      emit(state.copyWith(phase: SyncPhase.offline, pendingCount: _api.queue.length));
      return;
    }
    // Reconnected: drain whatever accumulated while the signal was gone.
    unawaited(drain());
  }

  void _onOutcome(SyncOutcome outcome) {
    if (outcome.resolution != ConflictResolution.discarded) return;
    emit(state.copyWith(
      phase: SyncPhase.error,
      message: 'A queued write could not be saved and was dropped',
      discarded: [...state.discarded, outcome.operation],
    ));
  }

  /// Drains the offline queue, guarding against two overlapping drains — a
  /// reconnect event and a manual pull-to-refresh can arrive together, and
  /// replaying the same operation twice would duplicate a clinical record.
  Future<void> drain() async {
    if (_draining) return;
    _draining = true;
    emit(state.copyWith(phase: SyncPhase.syncing, pendingCount: _api.queue.length));
    try {
      final outcomes = await _api.sync();
      final remaining = _api.queue.length;
      final failed = outcomes.where((o) => o.resolution == ConflictResolution.discarded).toList();
      emit(SyncStatus(
        phase: failed.isNotEmpty
            ? SyncPhase.error
            : remaining > 0
                ? SyncPhase.pending
                : SyncPhase.synced,
        pendingCount: remaining,
        lastSyncedAt: DateTime.now(),
        message: failed.isEmpty ? null : '${failed.length} write(s) could not be saved',
        discarded: [...state.discarded, ...failed.map((o) => o.operation)],
      ));
    } catch (error) {
      emit(state.copyWith(
        phase: SyncPhase.error,
        pendingCount: _api.queue.length,
        message: '$error',
      ));
    } finally {
      _draining = false;
    }
  }

  /// Clears the record of dropped writes once the clinician has seen them.
  void acknowledgeDiscarded() {
    emit(SyncStatus(
      phase: _api.queue.length > 0 ? SyncPhase.pending : SyncPhase.synced,
      pendingCount: _api.queue.length,
      lastSyncedAt: state.lastSyncedAt,
    ));
  }

  @override
  Future<void> close() async {
    await _outcomeSub?.cancel();
    await _connectivitySub?.cancel();
    return super.close();
  }
}
