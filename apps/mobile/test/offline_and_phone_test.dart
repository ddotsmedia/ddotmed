import 'package:flutter_test/flutter_test.dart';
import 'package:medicore_mobile/core/offline_queue.dart';
import 'package:medicore_mobile/core/phone.dart';

void main() {
  group('OfflineQueue.requiresOnline', () {
    test('refuses to queue actions that need live verification', () {
      expect(OfflineQueue.requiresOnline('/pharmacy/administer'), isTrue);
      expect(OfflineQueue.requiresOnline('/pharmacy/dispense'), isTrue);
      expect(OfflineQueue.requiresOnline('/auth/break-glass'), isTrue);
      expect(OfflineQueue.requiresOnline('/billing/payments'), isTrue);
      expect(OfflineQueue.requiresOnline('/insurance/claims'), isTrue);
    });

    test('allows ordinary clinical documentation to queue', () {
      expect(OfflineQueue.requiresOnline('/vitals'), isFalse);
      expect(OfflineQueue.requiresOnline('/notes'), isFalse);
      expect(OfflineQueue.requiresOnline('/conditions'), isFalse);
    });
  });

  group('resolveConflict', () {
    final queuedAt = DateTime.utc(2026, 7, 25, 8);

    test('server wins when the record changed after the local snapshot', () {
      expect(
        resolveConflict(
          localSnapshot: queuedAt,
          serverUpdatedAt: DateTime.utc(2026, 7, 25, 9),
        ),
        ConflictResolution.serverWins,
      );
    });

    test('applies the local write when the server has not moved on', () {
      expect(
        resolveConflict(
          localSnapshot: queuedAt,
          serverUpdatedAt: DateTime.utc(2026, 7, 25, 7),
        ),
        ConflictResolution.applied,
      );
      expect(
        resolveConflict(localSnapshot: queuedAt, serverUpdatedAt: queuedAt),
        ConflictResolution.applied,
      );
    });

    test('applies when either side has no timestamp to compare', () {
      expect(
        resolveConflict(localSnapshot: null, serverUpdatedAt: DateTime.utc(2026)),
        ConflictResolution.applied,
      );
      expect(
        resolveConflict(localSnapshot: queuedAt, serverUpdatedAt: null),
        ConflictResolution.applied,
      );
    });
  });

  group('toE164', () {
    test('normalises a UAE mobile with a trunk zero', () {
      expect(toE164('050 123 4567', 'AE').e164, '+971501234567');
    });

    test('accepts an already-international number', () {
      expect(toE164('+971501234567', 'AE').e164, '+971501234567');
      expect(toE164('00971501234567', 'AE').e164, '+971501234567');
    });

    test('normalises Indian and US numbers', () {
      expect(toE164('09876543210', 'IN').e164, '+919876543210');
      expect(toE164('(415) 555-0132', 'US').e164, '+14155550132');
    });

    test('rejects a number of the wrong length', () {
      final result = toE164('12345', 'AE');
      expect(result.valid, isFalse);
      expect(result.error, contains('Expected 9 digits'));
    });

    test('rejects a number belonging to another country', () {
      expect(toE164('+14155550132', 'AE').valid, isFalse);
    });

    test('rejects an unsupported country', () {
      expect(toE164('123456789', 'ZZ').valid, isFalse);
    });

    test('strips formatting characters', () {
      expect(toE164('+971-50-123 45 67', 'AE').e164, '+971501234567');
    });
  });
}
