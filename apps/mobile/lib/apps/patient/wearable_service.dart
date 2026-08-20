/// Apple Health / Google Fit, behind one call.
///
/// Read-only and opt-in. The app never writes to the health store and never asks
/// for more types than it displays: steps, resting heart rate, sleep and blood
/// oxygen. Anything else on the watch is none of a hospital app's business.
///
/// Every failure path returns an unavailable summary rather than throwing. A
/// patient without a watch, on a platform without a health store, or who declined
/// the permission must still get a working dashboard — the wearable card simply
/// does not appear.
library;

import 'package:flutter/foundation.dart';
import 'package:health/health.dart';

import 'patient_blocs.dart';

class WearableService {
  WearableService({Health? health}) : _health = health ?? Health();

  final Health _health;

  /// Exactly what the dashboard renders, and nothing more.
  static const _types = <HealthDataType>[
    HealthDataType.STEPS,
    HealthDataType.RESTING_HEART_RATE,
    HealthDataType.SLEEP_ASLEEP,
    HealthDataType.BLOOD_OXYGEN,
  ];

  static final _permissions = List<HealthDataAccess>.filled(_types.length, HealthDataAccess.READ);

  /// Asks for permission and reads the last 24 hours.
  Future<WearableSummary> read({DateTime? now}) async {
    final end = now ?? DateTime.now();
    final start = end.subtract(const Duration(hours: 24));

    try {
      final granted = await _health.requestAuthorization(_types, permissions: _permissions);
      if (!granted) {
        return const WearableSummary(available: true, permissionDenied: true);
      }

      final points = await _health.getHealthDataFromTypes(
        types: _types,
        startTime: start,
        endTime: end,
      );

      if (points.isEmpty) {
        return WearableSummary(available: true, lastSyncedAt: end);
      }

      return WearableSummary(
        // Steps accumulate, so they are summed; the others are point readings and
        // the most recent one is the answer.
        steps: _sum(points, HealthDataType.STEPS)?.round(),
        restingHeartRate: _latest(points, HealthDataType.RESTING_HEART_RATE)?.round(),
        sleepHours: _sleepHours(points),
        spo2: _latest(points, HealthDataType.BLOOD_OXYGEN)?.round(),
        lastSyncedAt: _mostRecentTimestamp(points) ?? end,
        available: true,
      );
    } catch (error) {
      debugPrint('Health data unavailable: $error');
      return const WearableSummary();
    }
  }

  static double? _numericValue(HealthDataPoint point) {
    final value = point.value;
    return value is NumericHealthValue ? value.numericValue.toDouble() : null;
  }

  static double? _sum(List<HealthDataPoint> points, HealthDataType type) {
    final values =
        points.where((p) => p.type == type).map(_numericValue).whereType<double>().toList();
    if (values.isEmpty) return null;
    return values.reduce((a, b) => a + b);
  }

  static double? _latest(List<HealthDataPoint> points, HealthDataType type) {
    final matching = points.where((p) => p.type == type).toList()
      ..sort((a, b) => b.dateTo.compareTo(a.dateTo));
    if (matching.isEmpty) return null;
    return _numericValue(matching.first);
  }

  /// Sleep arrives as intervals; the total is their summed duration.
  static double? _sleepHours(List<HealthDataPoint> points) {
    final asleep = points.where((p) => p.type == HealthDataType.SLEEP_ASLEEP);
    if (asleep.isEmpty) return null;
    final minutes = asleep.fold<int>(
      0,
      (sum, p) => sum + p.dateTo.difference(p.dateFrom).inMinutes,
    );
    if (minutes <= 0) return null;
    return (minutes / 60 * 10).round() / 10;
  }

  static DateTime? _mostRecentTimestamp(List<HealthDataPoint> points) {
    if (points.isEmpty) return null;
    return points.map((p) => p.dateTo).reduce((a, b) => a.isAfter(b) ? a : b);
  }
}
