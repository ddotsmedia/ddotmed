/// The biometric wrapper.
///
/// The distinction being protected: unlocking the app may fall back to the device
/// passcode, but confirming a controlled drug may not. A passcode can be shared
/// and shoulder-surfed, and the controlled-drug register has to name a person.
library;

import 'package:flutter_test/flutter_test.dart';
import 'package:local_auth/local_auth.dart';
import 'package:medicore_mobile/core/biometric_auth.dart';
import 'package:mocktail/mocktail.dart';

class _MockLocalAuth extends Mock implements LocalAuthentication {}

void main() {
  late _MockLocalAuth localAuth;
  late BiometricAuth auth;

  setUpAll(() {
    registerFallbackValue(const AuthenticationOptions());
  });

  setUp(() {
    localAuth = _MockLocalAuth();
    auth = BiometricAuth(localAuth: localAuth);

    when(() => localAuth.isDeviceSupported()).thenAnswer((_) async => true);
    when(() => localAuth.canCheckBiometrics).thenAnswer((_) async => true);
    when(localAuth.getAvailableBiometrics).thenAnswer((_) async => [BiometricType.fingerprint]);
    when(
      () => localAuth.authenticate(
        localizedReason: any(named: 'localizedReason'),
        options: any(named: 'options'),
      ),
    ).thenAnswer((_) async => true);
  });

  group('unlock', () {
    test('succeeds and allows the device passcode as a fallback', () async {
      final result = await auth.unlock();
      expect(result.isSuccess, isTrue);

      final options = verify(
        () => localAuth.authenticate(
          localizedReason: any(named: 'localizedReason'),
          options: captureAny(named: 'options'),
        ),
      ).captured.single as AuthenticationOptions;

      // Wet fingers on a ward round must not lock a clinician out entirely.
      expect(options.biometricOnly, isFalse);
    });

    test('reports an unconfigured device rather than a bare failure', () async {
      when(() => localAuth.isDeviceSupported()).thenAnswer((_) async => false);

      final result = await auth.unlock();
      expect(result.outcome, BiometricOutcome.unavailable);
      expect(result.message, contains('no biometric or passcode'));
    });

    test('a dismissed prompt is a failure, not an error', () async {
      when(
        () => localAuth.authenticate(
          localizedReason: any(named: 'localizedReason'),
          options: any(named: 'options'),
        ),
      ).thenAnswer((_) async => false);

      final result = await auth.unlock();
      expect(result.outcome, BiometricOutcome.failed);
    });
  });

  group('confirm', () {
    test('demands a true biometric, never a passcode', () async {
      final result = await auth.confirm('Confirm administration of morphine');
      expect(result.isSuccess, isTrue);

      final options = verify(
        () => localAuth.authenticate(
          localizedReason: any(named: 'localizedReason'),
          options: captureAny(named: 'options'),
        ),
      ).captured.single as AuthenticationOptions;

      expect(options.biometricOnly, isTrue);
    });

    test('refuses when no fingerprint or face is enrolled', () async {
      when(localAuth.getAvailableBiometrics).thenAnswer((_) async => []);

      final result = await auth.confirm('Confirm administration');
      expect(result.outcome, BiometricOutcome.notEnrolled);
      // The message tells the nurse what to do about it.
      expect(result.message, contains('enrolled'));
      verifyNever(
        () => localAuth.authenticate(
          localizedReason: any(named: 'localizedReason'),
          options: any(named: 'options'),
        ),
      );
    });
  });

  group('platform errors', () {
    test('a lockout is reported as a lockout', () async {
      when(
        () => localAuth.authenticate(
          localizedReason: any(named: 'localizedReason'),
          options: any(named: 'options'),
        ),
      ).thenThrow(Exception('LockedOut: too many attempts'));

      final result = await auth.unlock();
      expect(result.outcome, BiometricOutcome.lockedOut);
      expect(result.message, contains('locked'));
    });

    test('a not-enrolled platform error is classified as such', () async {
      when(
        () => localAuth.authenticate(
          localizedReason: any(named: 'localizedReason'),
          options: any(named: 'options'),
        ),
      ).thenThrow(Exception('NotEnrolled'));

      expect((await auth.unlock()).outcome, BiometricOutcome.notEnrolled);
    });

    test('anything unrecognised becomes an error, never an uncaught throw', () async {
      when(
        () => localAuth.authenticate(
          localizedReason: any(named: 'localizedReason'),
          options: any(named: 'options'),
        ),
      ).thenThrow(Exception('something unexpected'));

      final result = await auth.unlock();
      expect(result.outcome, BiometricOutcome.error);
      expect(result.isSuccess, isFalse);
    });

    test('a throwing capability probe reports unavailable, not a crash', () async {
      when(() => localAuth.isDeviceSupported()).thenThrow(Exception('no plugin'));
      expect(await auth.isAvailable, isFalse);
    });

    test('a throwing enrolment probe reports none enrolled', () async {
      when(() => localAuth.canCheckBiometrics).thenThrow(Exception('no plugin'));
      expect(await auth.hasEnrolledBiometrics, isFalse);
    });
  });
}
