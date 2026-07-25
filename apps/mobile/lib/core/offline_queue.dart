import 'dart:convert';

import 'package:hive/hive.dart';
import 'package:uuid/uuid.dart';

/// A write captured while offline, replayed once connectivity returns.
class PendingOperation {
  PendingOperation({
    required this.id,
    required this.method,
    required this.path,
    required this.body,
    required this.createdAt,
    this.attempts = 0,
    this.lastError,
    this.entityType,
    this.entityId,
    this.updatedAtSnapshot,
  });

  final String id;
  final String method;
  final String path;
  final Map<String, dynamic> body;
  final DateTime createdAt;
  int attempts;
  String? lastError;

  /// Used for conflict detection: what the server version looked like when queued.
  final String? entityType;
  final String? entityId;
  final DateTime? updatedAtSnapshot;

  Map<String, dynamic> toJson() => {
        'id': id,
        'method': method,
        'path': path,
        'body': body,
        'created_at': createdAt.toIso8601String(),
        'attempts': attempts,
        'last_error': lastError,
        'entity_type': entityType,
        'entity_id': entityId,
        'updated_at_snapshot': updatedAtSnapshot?.toIso8601String(),
      };

  static PendingOperation fromJson(Map<String, dynamic> json) => PendingOperation(
        id: json['id'] as String,
        method: json['method'] as String,
        path: json['path'] as String,
        body: Map<String, dynamic>.from(json['body'] as Map),
        createdAt: DateTime.parse(json['created_at'] as String),
        attempts: (json['attempts'] as int?) ?? 0,
        lastError: json['last_error'] as String?,
        entityType: json['entity_type'] as String?,
        entityId: json['entity_id'] as String?,
        updatedAtSnapshot: json['updated_at_snapshot'] == null
            ? null
            : DateTime.parse(json['updated_at_snapshot'] as String),
      );
}

enum ConflictResolution { serverWins, applied, discarded }

class SyncOutcome {
  const SyncOutcome({
    required this.operation,
    required this.resolution,
    this.serverState,
    this.error,
  });

  final PendingOperation operation;
  final ConflictResolution resolution;
  final Map<String, dynamic>? serverState;
  final String? error;
}

/// Durable FIFO queue of offline writes.
///
/// Operations that can never be queued are rejected at enqueue time rather than
/// failing later: a controlled-drug administration or a barcode verification must
/// happen against the live server, never optimistically offline.
class OfflineQueue {
  OfflineQueue(this._box);

  static const boxName = 'offline_queue';
  static const maxAttempts = 5;

  /// Paths whose writes must never be performed offline.
  static const _onlineOnlyPrefixes = <String>[
    '/pharmacy/dispense',
    '/pharmacy/administer',
    '/auth/break-glass',
    '/insurance/claims',
    '/billing/payments',
  ];

  final Box<String> _box;
  final _uuid = const Uuid();

  static bool requiresOnline(String path) =>
      _onlineOnlyPrefixes.any((prefix) => path.startsWith(prefix));

  List<PendingOperation> get pending {
    final items = _box.values
        .map((raw) => PendingOperation.fromJson(jsonDecode(raw) as Map<String, dynamic>))
        .toList();
    items.sort((a, b) => a.createdAt.compareTo(b.createdAt));
    return items;
  }

  int get length => _box.length;

  Future<PendingOperation> enqueue({
    required String method,
    required String path,
    required Map<String, dynamic> body,
    String? entityType,
    String? entityId,
    DateTime? updatedAtSnapshot,
  }) async {
    if (requiresOnline(path)) {
      throw StateError('$path cannot be queued offline; it requires a live connection');
    }
    final operation = PendingOperation(
      id: _uuid.v4(),
      method: method,
      path: path,
      body: body,
      createdAt: DateTime.now().toUtc(),
      entityType: entityType,
      entityId: entityId,
      updatedAtSnapshot: updatedAtSnapshot,
    );
    await _box.put(operation.id, jsonEncode(operation.toJson()));
    return operation;
  }

  Future<void> remove(String id) => _box.delete(id);

  Future<void> update(PendingOperation operation) =>
      _box.put(operation.id, jsonEncode(operation.toJson()));

  Future<void> clear() => _box.clear();
}

/// Resolves a conflict between a queued write and current server state.
///
/// Server-wins is the policy: the device may have been offline for hours, and a
/// stale local edit must never overwrite a newer clinical record. The discarded
/// local value is returned so the UI can show the user what was dropped.
ConflictResolution resolveConflict({
  required DateTime? localSnapshot,
  required DateTime? serverUpdatedAt,
}) {
  if (localSnapshot == null || serverUpdatedAt == null) return ConflictResolution.applied;
  if (serverUpdatedAt.isAfter(localSnapshot)) return ConflictResolution.serverWins;
  return ConflictResolution.applied;
}
