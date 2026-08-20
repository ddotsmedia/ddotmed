/// A thin wrapper over `local_auth`.
///
/// Exists so that the two very different things the apps ask of biometrics are
/// named separately. Unlocking the app after it has been backgrounded may fall
/// back to the device passcode — locking a clinician out of a ward round because
/// their finger is wet helps nobody. Confirming a controlled-drug administration
/// may not: that signature has to be a biometric, because a passcode can be
/// shoulder-surfed and shared, and the register has to name a person.
///
/// Every failure path returns a typed outcome rather than throwing. A plugin
/// exception mid-administration must surface as a refusal the nurse can read,
/// never as a red screen.
library;

import 'package:local_auth/local_auth.dart';

enum BiometricOutcome {
  /// The user proved who they are.
  success,

  /// The prompt was shown and dismissed or failed.
  failed,

  /// No biometric and no device credential is configured.
  unavailable,

  /// Hardware exists but no fingerprint or face has been enrolled.
  notEnrolled,

  /// Too many attempts; the platform has locked biometrics out.
  lockedOut,

  /// The plugin raised something unexpected.
  error,
}

class BiometricResult {
  const BiometricResult(this.outcome, [this.detail]);

  final BiometricOutcome outcome;
  final String? detail;

  bool get isSuccess => outcome == BiometricOutcome.success;

  /// What to put in front of the user. Deliberately actionable — "not enrolled"
  /// tells them to go and add a fingerprint, which "authentication failed" does not.
  String get message => switch (outcome) {
        BiometricOutcome.success => 'Verified',
        BiometricOutcome.failed => 'Verification was not completed',
        BiometricOutcome.unavailable => 'This device has no biometric or passcode lock configured',
        BiometricOutcome.notEnrolled => 'No fingerprint or face is enrolled on this device',
        BiometricOutcome.lockedOut =>
          'Biometrics are locked after too many attempts; unlock the device first',
        BiometricOutcome.error => detail ?? 'Verification failed',
      };
}

class BiometricAuth {
  BiometricAuth({LocalAuthentication? localAuth}) : _auth = localAuth ?? LocalAuthentication();

  final LocalAuthentication _auth;

  /// Whether anything at all can be used to prove identity on this device.
  Future<bool> get isAvailable async {
    try {
      return await _auth.isDeviceSupported();
    } catch (_) {
      return false;
    }
  }

  /// Whether a true biometric — not just a passcode — is enrolled.
  Future<bool> get hasEnrolledBiometrics async {
    try {
      if (!await _auth.canCheckBiometrics) return false;
      final enrolled = await _auth.getAvailableBiometrics();
      return enrolled.isNotEmpty;
    } catch (_) {
      return false;
    }
  }

  /// Unlocking the app. Device credential is an acceptable fallback here.
  Future<BiometricResult> unlock({String reason = 'Unlock MediCore'}) =>
      _authenticate(reason: reason, biometricOnly: false);

  /// Confirming a clinical action that is signed for — a controlled drug, a
  /// break-glass access. Biometric only: this stands in for a signature.
  Future<BiometricResult> confirm(String reason) =>
      _authenticate(reason: reason, biometricOnly: true);

  Future<BiometricResult> _authenticate({
    required String reason,
    required bool biometricOnly,
  }) async {
    try {
      if (!await _auth.isDeviceSupported()) {
        return const BiometricResult(BiometricOutcome.unavailable);
      }
      if (biometricOnly && !await hasEnrolledBiometrics) {
        return const BiometricResult(BiometricOutcome.notEnrolled);
      }

      final ok = await _auth.authenticate(
        localizedReason: reason,
        options: AuthenticationOptions(
          stickyAuth: true,
          biometricOnly: biometricOnly,
          // The prompt must survive the app being backgrounded mid-scan.
          useErrorDialogs: true,
        ),
      );
      return ok
          ? const BiometricResult(BiometricOutcome.success)
          : const BiometricResult(BiometricOutcome.failed);
    } catch (error) {
      return BiometricResult(_classify('$error'), '$error');
    }
  }

  /// The plugin reports platform errors as strings; these are the ones worth
  /// telling apart, because each has a different remedy.
  static BiometricOutcome _classify(String error) {
    final lower = error.toLowerCase();
    if (lower.contains('notenrolled') || lower.contains('not enrolled')) {
      return BiometricOutcome.notEnrolled;
    }
    if (lower.contains('lockedout') || lower.contains('locked out')) {
      return BiometricOutcome.lockedOut;
    }
    if (lower.contains('notavailable') || lower.contains('no hardware')) {
      return BiometricOutcome.unavailable;
    }
    return BiometricOutcome.error;
  }
}
