import 'dart:async';

import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:dio/dio.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import 'flavour.dart';
import 'offline_queue.dart';

class ApiException implements Exception {
  ApiException(this.statusCode, this.code, this.message, this.body);

  final int statusCode;
  final String? code;
  final String message;
  final dynamic body;

  bool get isWrongPatient => code == 'WRONG_PATIENT';
  bool get isClinicalBlock => const {
        'ALLERGY_CONTRAINDICATION',
        'DRUG_INTERACTION',
        'WRONG_PATIENT',
        'FIVE_RIGHTS_FAILED',
        'WITNESS_REQUIRED',
      }.contains(code);

  @override
  String toString() => message;
}

/// HTTP client with token refresh, offline queueing and server-wins sync.
class ApiClient {
  ApiClient({required this.queue, Dio? dio, FlutterSecureStorage? storage})
      : _dio = dio ?? Dio(BaseOptions(baseUrl: FlavourConfig.current.apiBaseUrl)),
        _storage = storage ?? const FlutterSecureStorage() {
    _dio.interceptors.add(
      InterceptorsWrapper(
        onRequest: (options, handler) async {
          final token = await _storage.read(key: _accessTokenKey);
          if (token != null) options.headers['authorization'] = 'Bearer $token';
          handler.next(options);
        },
        onError: (error, handler) async {
          if (error.response?.statusCode == 401 && !_refreshing) {
            final refreshed = await _refresh();
            if (refreshed) {
              final retried = await _dio.fetch<dynamic>(error.requestOptions);
              return handler.resolve(retried);
            }
            await signOut();
          }
          handler.next(error);
        },
      ),
    );
  }

  static const _accessTokenKey = 'medicore.access_token';
  static const _refreshTokenKey = 'medicore.refresh_token';

  final OfflineQueue queue;
  final Dio _dio;
  final FlutterSecureStorage _storage;
  bool _refreshing = false;

  final _syncController = StreamController<SyncOutcome>.broadcast();
  Stream<SyncOutcome> get syncEvents => _syncController.stream;

  Future<bool> get isOnline async {
    final result = await Connectivity().checkConnectivity();
    return !result.contains(ConnectivityResult.none);
  }

  Future<void> storeTokens(String access, String refresh) async {
    await _storage.write(key: _accessTokenKey, value: access);
    await _storage.write(key: _refreshTokenKey, value: refresh);
  }

  Future<void> signOut() async {
    await _storage.delete(key: _accessTokenKey);
    await _storage.delete(key: _refreshTokenKey);
  }

  Future<bool> _refresh() async {
    _refreshing = true;
    try {
      final refresh = await _storage.read(key: _refreshTokenKey);
      if (refresh == null) return false;
      final response = await Dio(BaseOptions(baseUrl: FlavourConfig.current.apiBaseUrl))
          .post<Map<String, dynamic>>('/auth/refresh', data: {'refresh_token': refresh});
      final data = response.data;
      if (data == null) return false;
      await storeTokens(data['access_token'] as String, data['refresh_token'] as String);
      return true;
    } catch (_) {
      return false;
    } finally {
      _refreshing = false;
    }
  }

  ApiException _toException(DioException error) {
    final body = error.response?.data;
    final map = body is Map<String, dynamic> ? body : const <String, dynamic>{};
    return ApiException(
      error.response?.statusCode ?? 0,
      map['code'] as String?,
      (map['message'] as String?) ?? error.message ?? 'Request failed',
      body,
    );
  }

  Future<T> get<T>(String path, {Map<String, dynamic>? query}) async {
    try {
      final response = await _dio.get<T>(path, queryParameters: query);
      return response.data as T;
    } on DioException catch (e) {
      throw _toException(e);
    }
  }

  /// Writes go straight to the server when online. When offline they queue —
  /// unless the operation is one that must never happen without live verification.
  Future<Map<String, dynamic>?> write(
    String path,
    Map<String, dynamic> body, {
    String method = 'POST',
    String? entityType,
    String? entityId,
    DateTime? updatedAtSnapshot,
  }) async {
    if (await isOnline) {
      try {
        final response = method == 'PATCH'
            ? await _dio.patch<Map<String, dynamic>>(path, data: body)
            : await _dio.post<Map<String, dynamic>>(path, data: body);
        return response.data;
      } on DioException catch (e) {
        // A 4xx is a decision by the server and must surface, not be queued.
        final status = e.response?.statusCode ?? 0;
        if (status >= 400 && status < 500) throw _toException(e);
        if (OfflineQueue.requiresOnline(path)) throw _toException(e);
      }
    } else if (OfflineQueue.requiresOnline(path)) {
      throw ApiException(0, 'OFFLINE_NOT_PERMITTED',
          'This action requires a live connection and cannot be queued', null);
    }

    await queue.enqueue(
      method: method,
      path: path,
      body: body,
      entityType: entityType,
      entityId: entityId,
      updatedAtSnapshot: updatedAtSnapshot,
    );
    return null;
  }

  /// Drains the offline queue. Conflicts resolve server-wins.
  Future<List<SyncOutcome>> sync() async {
    if (!await isOnline) return const [];

    final outcomes = <SyncOutcome>[];
    for (final operation in queue.pending) {
      try {
        if (operation.entityType != null && operation.entityId != null) {
          final current = await get<Map<String, dynamic>>(
            '/${operation.entityType}/${operation.entityId}',
          );
          final serverUpdatedAt = current['updated_at'] == null
              ? null
              : DateTime.parse(current['updated_at'] as String);
          final resolution = resolveConflict(
            localSnapshot: operation.updatedAtSnapshot,
            serverUpdatedAt: serverUpdatedAt,
          );
          if (resolution == ConflictResolution.serverWins) {
            await queue.remove(operation.id);
            final outcome = SyncOutcome(
              operation: operation,
              resolution: ConflictResolution.serverWins,
              serverState: current,
            );
            outcomes.add(outcome);
            _syncController.add(outcome);
            continue;
          }
        }

        if (operation.method == 'PATCH') {
          await _dio.patch<dynamic>(operation.path, data: operation.body);
        } else {
          await _dio.post<dynamic>(operation.path, data: operation.body);
        }

        await queue.remove(operation.id);
        final outcome = SyncOutcome(operation: operation, resolution: ConflictResolution.applied);
        outcomes.add(outcome);
        _syncController.add(outcome);
      } on DioException catch (e) {
        operation.attempts += 1;
        operation.lastError = e.message;
        if (operation.attempts >= OfflineQueue.maxAttempts) {
          // Give up rather than retry forever; the user is told what was dropped.
          await queue.remove(operation.id);
          final outcome = SyncOutcome(
            operation: operation,
            resolution: ConflictResolution.discarded,
            error: e.message,
          );
          outcomes.add(outcome);
          _syncController.add(outcome);
        } else {
          await queue.update(operation);
        }
      }
    }
    return outcomes;
  }

  void dispose() => _syncController.close();
}
