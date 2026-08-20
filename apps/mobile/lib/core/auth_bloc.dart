import 'package:bloc/bloc.dart';
import 'package:equatable/equatable.dart';
import 'package:local_auth/local_auth.dart';

import '../core/api_client.dart';
import '../core/flavour.dart';

sealed class AuthEvent extends Equatable {
  const AuthEvent();
  @override
  List<Object?> get props => const [];
}

class AuthStarted extends AuthEvent {
  const AuthStarted();
}

class AuthLoginRequested extends AuthEvent {
  const AuthLoginRequested(this.tenant, this.email, this.password);
  final String tenant;
  final String email;
  final String password;
  @override
  List<Object?> get props => [tenant, email, password];
}

class AuthMfaSubmitted extends AuthEvent {
  const AuthMfaSubmitted(this.code);
  final String code;
  @override
  List<Object?> get props => [code];
}

class AuthBiometricUnlockRequested extends AuthEvent {
  const AuthBiometricUnlockRequested({this.reason = 'Unlock MediCore'});
  final String reason;
  @override
  List<Object?> get props => [reason];
}

class AuthSignOutRequested extends AuthEvent {
  const AuthSignOutRequested();
}

sealed class AuthState extends Equatable {
  const AuthState();
  @override
  List<Object?> get props => const [];
}

class AuthInitial extends AuthState {
  const AuthInitial();
}

class AuthLoading extends AuthState {
  const AuthLoading();
}

class AuthMfaRequired extends AuthState {
  const AuthMfaRequired(this.mfaToken);
  final String mfaToken;
  @override
  List<Object?> get props => [mfaToken];
}

class AuthLocked extends AuthState {
  const AuthLocked();
}

class AuthAuthenticated extends AuthState {
  const AuthAuthenticated({required this.userId, required this.email, required this.roles});
  final String userId;
  final String email;
  final List<String> roles;
  @override
  List<Object?> get props => [userId, email, roles];
}

class AuthFailure extends AuthState {
  const AuthFailure(this.message);
  final String message;
  @override
  List<Object?> get props => [message];
}

class AuthBloc extends Bloc<AuthEvent, AuthState> {
  AuthBloc({required this.api, LocalAuthentication? localAuth})
      : _localAuth = localAuth ?? LocalAuthentication(),
        super(const AuthInitial()) {
    on<AuthStarted>(_onStarted);
    on<AuthLoginRequested>(_onLogin);
    on<AuthMfaSubmitted>(_onMfa);
    on<AuthBiometricUnlockRequested>(_onBiometric);
    on<AuthSignOutRequested>(_onSignOut);
  }

  final ApiClient api;
  final LocalAuthentication _localAuth;
  String? _pendingMfaToken;

  Future<void> _onStarted(AuthStarted event, Emitter<AuthState> emit) async {
    // A clinical flavour that already holds a session still starts locked; PHI is
    // only revealed after a biometric (or device credential) unlock.
    if (FlavourConfig.current.holdsPhi && FlavourConfig.current.requireBiometricUnlock) {
      emit(const AuthLocked());
    } else {
      emit(const AuthInitial());
    }
  }

  Future<void> _onLogin(AuthLoginRequested event, Emitter<AuthState> emit) async {
    emit(const AuthLoading());
    try {
      final response = await api.write('/auth/login', {
        'tenant': event.tenant,
        'email': event.email,
        'password': event.password,
      });
      if (response == null) {
        emit(const AuthFailure('Sign-in requires a network connection'));
        return;
      }
      if (response['mfa_required'] == true) {
        _pendingMfaToken = response['mfa_token'] as String;
        emit(AuthMfaRequired(_pendingMfaToken!));
        return;
      }
      await _completeSignIn(response, emit);
    } on ApiException catch (e) {
      emit(AuthFailure(e.message));
    }
  }

  Future<void> _onMfa(AuthMfaSubmitted event, Emitter<AuthState> emit) async {
    final token = _pendingMfaToken;
    if (token == null) {
      emit(const AuthFailure('No MFA challenge in progress'));
      return;
    }
    emit(const AuthLoading());
    try {
      final response = await api.write('/auth/mfa/verify', {
        'mfa_token': token,
        'code': event.code,
      });
      if (response == null) {
        emit(const AuthFailure('Verification requires a network connection'));
        return;
      }
      await _completeSignIn(response, emit);
    } on ApiException catch (e) {
      emit(AuthFailure(e.message));
    }
  }

  Future<void> _completeSignIn(Map<String, dynamic> response, Emitter<AuthState> emit) async {
    await api.storeTokens(
      response['access_token'] as String,
      (response['refresh_token'] as String?) ?? '',
    );
    final user = response['user'] as Map<String, dynamic>?;
    _pendingMfaToken = null;
    emit(AuthAuthenticated(
      userId: (user?['id'] as String?) ?? '',
      email: (user?['email'] as String?) ?? '',
      roles: ((user?['roles'] as List<dynamic>?) ?? const []).cast<String>(),
    ));
  }

  Future<void> _onBiometric(AuthBiometricUnlockRequested event, Emitter<AuthState> emit) async {
    try {
      final available = await _localAuth.canCheckBiometrics || await _localAuth.isDeviceSupported();
      if (!available) {
        emit(const AuthFailure('This device has no biometric or passcode lock configured'));
        return;
      }
      final ok = await _localAuth.authenticate(
        localizedReason: event.reason,
        options: const AuthenticationOptions(
          stickyAuth: true,
          biometricOnly: false,
        ),
      );
      if (!ok) {
        emit(const AuthLocked());
        return;
      }
      emit(const AuthInitial());
    } catch (e) {
      emit(AuthFailure('Biometric unlock failed: $e'));
    }
  }

  /// Controlled-drug actions demand a fresh biometric confirmation each time.
  Future<bool> confirmWithBiometric(String reason) async {
    try {
      return await _localAuth.authenticate(
        localizedReason: reason,
        options: const AuthenticationOptions(stickyAuth: true, biometricOnly: true),
      );
    } catch (_) {
      return false;
    }
  }

  Future<void> _onSignOut(AuthSignOutRequested event, Emitter<AuthState> emit) async {
    await api.signOut();
    emit(const AuthInitial());
  }
}
