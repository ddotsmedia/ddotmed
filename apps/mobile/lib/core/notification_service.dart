/// Push registration and foreground presentation.
///
/// Two things are true at once here. A critical lab value has to reach the
/// clinician who ordered it whether or not the app is open, which is what FCM and
/// APNs are for. And a push payload is a delivery mechanism that crosses Google's
/// and Apple's servers, so it carries an alert id and a category and nothing
/// else — never a name, never a value, never a diagnosis. The app fetches the
/// detail over the authenticated API once the clinician taps.
///
/// Everything is best-effort. A device with no Firebase configuration, or a user
/// who refused notifications, must still get a fully working app: the in-app
/// alerts screen is the durable channel, and push is the nudge towards it.
library;

import 'dart:async';

import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';

import 'api_client.dart';
import 'flavour.dart';

/// The minimum a push is allowed to carry. Anything clinical is fetched later.
class PushAlert {
  const PushAlert({
    required this.alertId,
    required this.category,
    required this.severity,
    this.title,
    this.body,
    this.patientId,
  });

  final String alertId;
  final String category;
  final String severity;

  /// Present only for non-clinical categories; a critical result shows a generic
  /// title until the app is open and the clinician is authenticated.
  final String? title;
  final String? body;
  final String? patientId;

  bool get isCritical => severity == 'critical' || severity == 'life-threatening';

  static PushAlert? fromData(Map<String, dynamic> data) {
    final id = data['alert_id'] ?? data['id'];
    if (id is! String || id.isEmpty) return null;
    return PushAlert(
      alertId: id,
      category: (data['category'] as String?) ?? 'general',
      severity: (data['severity'] as String?) ?? 'info',
      title: data['title'] as String?,
      body: data['body'] as String?,
      patientId: data['patient_id'] as String?,
    );
  }
}

class NotificationService {
  NotificationService({
    required ApiClient api,
    FirebaseMessaging? messaging,
    FlutterLocalNotificationsPlugin? local,
  })  : _api = api,
        _messaging = messaging,
        _local = local ?? FlutterLocalNotificationsPlugin();

  static const _criticalChannel = AndroidNotificationChannel(
    'medicore_critical',
    'Critical clinical alerts',
    description: 'Critical results and deterioration warnings that need a response now',
    importance: Importance.max,
  );

  static const _generalChannel = AndroidNotificationChannel(
    'medicore_general',
    'MediCore notifications',
    description: 'Appointments, tasks and routine updates',
    importance: Importance.defaultImportance,
  );

  final ApiClient _api;
  final FirebaseMessaging? _messaging;
  final FlutterLocalNotificationsPlugin _local;

  final _tapped = StreamController<PushAlert>.broadcast();

  /// Emits when the clinician taps a notification, so the shell can route to it.
  Stream<PushAlert> get onAlertTapped => _tapped.stream;

  StreamSubscription<RemoteMessage>? _foregroundSub;
  StreamSubscription<RemoteMessage>? _openedSub;
  bool _initialised = false;

  /// Registers for push and wires the handlers.
  ///
  /// Returns false when push is unavailable — no Firebase, permission refused, a
  /// simulator — which is information the settings screen shows rather than an
  /// error anybody has to handle.
  Future<bool> initialise() async {
    if (_initialised) return true;

    try {
      await _configureLocalNotifications();

      final messaging = _messaging ?? FirebaseMessaging.instance;
      final settings = await messaging.requestPermission(
        alert: true,
        badge: true,
        sound: true,
        // Critical alerts pierce Do Not Disturb and need an Apple entitlement.
        // Requested for the clinical flavours, and simply not granted on builds
        // that do not carry it — which degrades to an ordinary alert, not a failure.
        criticalAlert: FlavourConfig.current.holdsPhi,
      );

      final granted = settings.authorizationStatus == AuthorizationStatus.authorized ||
          settings.authorizationStatus == AuthorizationStatus.provisional;
      if (!granted) return false;

      final token = await messaging.getToken();
      if (token != null) await _registerToken(token);
      messaging.onTokenRefresh.listen(_registerToken);

      _foregroundSub = FirebaseMessaging.onMessage.listen(_onForegroundMessage);
      _openedSub = FirebaseMessaging.onMessageOpenedApp.listen(_onOpened);

      // A notification that launched the app from cold start is not delivered to
      // either stream; it has to be collected explicitly.
      final initial = await messaging.getInitialMessage();
      if (initial != null) _onOpened(initial);

      _initialised = true;
      return true;
    } catch (error) {
      debugPrint('Push registration unavailable: $error');
      return false;
    }
  }

  Future<void> _configureLocalNotifications() async {
    const settings = InitializationSettings(
      android: AndroidInitializationSettings('@mipmap/ic_launcher'),
      iOS: DarwinInitializationSettings(
        requestAlertPermission: true,
        requestBadgePermission: true,
        requestSoundPermission: true,
      ),
    );

    await _local.initialize(
      settings,
      onDidReceiveNotificationResponse: (response) {
        final payload = response.payload;
        if (payload == null) return;
        _tapped.add(PushAlert(alertId: payload, category: 'general', severity: 'info'));
      },
    );

    final android =
        _local.resolvePlatformSpecificImplementation<AndroidFlutterLocalNotificationsPlugin>();
    await android?.createNotificationChannel(_criticalChannel);
    await android?.createNotificationChannel(_generalChannel);
  }

  /// Tells the server which device to reach. A failure is logged and dropped —
  /// sign-in must never fail because a push token could not be filed.
  Future<void> _registerToken(String token) async {
    try {
      await _api.write('/notifications/devices', {
        'token': token,
        'platform': defaultTargetPlatform == TargetPlatform.iOS ? 'apns' : 'fcm',
        'app': FlavourConfig.current.flavour.name,
      });
    } catch (error) {
      debugPrint('Push token not registered: $error');
    }
  }

  /// iOS suppresses banners while the app is foregrounded, and Android shows
  /// nothing at all, so a foreground push is re-presented locally.
  Future<void> _onForegroundMessage(RemoteMessage message) async {
    final alert = PushAlert.fromData(message.data);
    if (alert == null) return;

    final channel = alert.isCritical ? _criticalChannel : _generalChannel;
    await _local.show(
      alert.alertId.hashCode,
      message.notification?.title ?? alert.title ?? _genericTitle(alert),
      message.notification?.body ?? alert.body ?? 'Open MediCore to review',
      NotificationDetails(
        android: AndroidNotificationDetails(
          channel.id,
          channel.name,
          channelDescription: channel.description,
          importance: channel.importance,
          priority: alert.isCritical ? Priority.max : Priority.defaultPriority,
          category: alert.isCritical ? AndroidNotificationCategory.alarm : null,
        ),
        iOS: DarwinNotificationDetails(
          interruptionLevel:
              alert.isCritical ? InterruptionLevel.timeSensitive : InterruptionLevel.active,
        ),
      ),
      payload: alert.alertId,
    );
  }

  void _onOpened(RemoteMessage message) {
    final alert = PushAlert.fromData(message.data);
    if (alert != null) _tapped.add(alert);
  }

  /// What a clinical alert says on a lock screen: enough to act on, nothing that
  /// identifies a patient to whoever is looking at the phone.
  static String _genericTitle(PushAlert alert) => switch (alert.category) {
        'lab-critical' => 'Critical result awaiting review',
        'ews' => 'Patient deterioration warning',
        'appointment' => 'Appointment update',
        'task' => 'Task due',
        _ => 'MediCore alert',
      };

  Future<void> dispose() async {
    await _foregroundSub?.cancel();
    await _openedSub?.cancel();
    await _tapped.close();
  }
}
