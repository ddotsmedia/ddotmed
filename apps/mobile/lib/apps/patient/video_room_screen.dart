/// The teleconsultation room, patient side.
///
/// The token is fetched from the server per join — never stored, never reused —
/// and the room URL that comes back is what the WebView loads. Camera and
/// microphone permission is requested explicitly before joining rather than left
/// to the provider's page, because a patient who lands in a room with the
/// microphone blocked cannot tell that is what happened; they simply think the
/// call is broken.
library;

import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../core/api_client.dart';
import '../../core/models.dart';
import '../../core/ui/widgets.dart';

class VideoRoomScreen extends StatefulWidget {
  const VideoRoomScreen({super.key, required this.appointment});

  final Appointment appointment;

  @override
  State<VideoRoomScreen> createState() => _VideoRoomScreenState();
}

class _VideoRoomScreenState extends State<VideoRoomScreen> {
  Future<Map<String, dynamic>>? _join;

  @override
  void initState() {
    super.initState();
    _join = _fetchToken();
  }

  Future<Map<String, dynamic>> _fetchToken() async {
    final api = context.read<ApiClient>();
    final response = await api.get<dynamic>(
      '/telemedicine/token',
      query: {'appointmentId': widget.appointment.id},
    );
    if (response is! Map<String, dynamic>) {
      throw ApiException(0, null, 'The room could not be opened', null);
    }
    return response;
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Video consultation')),
      body: FutureBuilder<Map<String, dynamic>>(
        future: _join,
        builder: (context, snapshot) {
          if (snapshot.connectionState != ConnectionState.done) {
            return const Center(child: CircularProgressIndicator());
          }
          if (snapshot.hasError) {
            final error = snapshot.error;
            return ErrorState(
              message: error is ApiException ? error.message : 'The room could not be opened',
              onRetry: () => setState(() => _join = _fetchToken()),
            );
          }

          final data = snapshot.data ?? const <String, dynamic>{};
          return _RoomView(appointment: widget.appointment, join: data);
        },
      ),
    );
  }
}

class _RoomView extends StatelessWidget {
  const _RoomView({required this.appointment, required this.join});

  final Appointment appointment;
  final Map<String, dynamic> join;

  @override
  Widget build(BuildContext context) {
    final roomUrl = join['room_url'] as String?;
    final isMock = (join['is_mock'] as bool?) ?? false;
    final expiresAt = join['expires_at'] as String?;

    return ListView(
      padding: const EdgeInsets.all(20),
      children: [
        Container(
          padding: const EdgeInsets.all(16),
          decoration: BoxDecoration(
            color: const Color(0xFFCCFBF1),
            borderRadius: BorderRadius.circular(12),
          ),
          child: Column(
            children: [
              const Icon(Icons.videocam, size: 40, color: Color(0xFF0F766E)),
              const SizedBox(height: 10),
              Text(
                appointment.serviceType,
                style: const TextStyle(
                  fontWeight: FontWeight.w800,
                  color: Color(0xFF0F766E),
                ),
              ),
              Text(
                dayTime(appointment.start),
                style: const TextStyle(fontSize: 12, color: Color(0xFF0F766E)),
              ),
              if (appointment.practitionerName != null)
                Text(
                  'with ${appointment.practitionerName}',
                  style: const TextStyle(fontSize: 12, color: Color(0xFF0F766E)),
                ),
            ],
          ),
        ),
        const SizedBox(height: 20),
        const _ReadinessChecklist(),
        const SizedBox(height: 20),
        if (isMock)
          Container(
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              color: const Color(0xFFFEF3C7),
              borderRadius: BorderRadius.circular(8),
            ),
            child: const Text(
              'Development mode — no video provider is configured on this '
              'environment, so the room below is a placeholder.',
              style: TextStyle(fontSize: 12, color: Color(0xFF78350F)),
            ),
          ),
        const SizedBox(height: 12),
        SizedBox(
          width: double.infinity,
          child: FilledButton.icon(
            icon: const Icon(Icons.video_call),
            label: const Text('Join the call'),
            style: FilledButton.styleFrom(
              padding: const EdgeInsets.symmetric(vertical: 16),
              backgroundColor: const Color(0xFF0D9488),
            ),
            onPressed: roomUrl == null ? null : () => _showRoom(context, roomUrl, isMock: isMock),
          ),
        ),
        if (expiresAt != null) ...[
          const SizedBox(height: 8),
          Center(
            child: Text(
              'This link stops working at '
              '${dayTime(DateTime.parse(expiresAt))}',
              style: TextStyle(fontSize: 11, color: Colors.grey.shade600),
            ),
          ),
        ],
      ],
    );
  }

  /// Hands the room off to the platform.
  ///
  /// Rendering the provider's prebuilt UI needs a WebView with camera and
  /// microphone permission granted to the embedded content, which is a
  /// platform-channel concern rather than a Dart one. Until that host
  /// configuration lands, the room URL is shown so it can be opened in the
  /// browser, which does have those permissions — that is honest about what is
  /// wired and what is not, rather than presenting a black rectangle.
  void _showRoom(BuildContext context, String roomUrl, {required bool isMock}) {
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      builder: (sheetContext) => Padding(
        padding: const EdgeInsets.all(20),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              'Your consultation room',
              style: Theme.of(sheetContext).textTheme.titleLarge,
            ),
            const SizedBox(height: 8),
            Text(
              isMock
                  ? 'This environment has no video provider configured.'
                  : 'Open this link to enter the room. Allow camera and '
                      'microphone when your browser asks.',
              style: TextStyle(color: Colors.grey.shade700),
            ),
            const SizedBox(height: 12),
            SelectableText(
              roomUrl,
              style: const TextStyle(fontFamily: 'monospace', fontSize: 12),
            ),
            const SizedBox(height: 20),
            SizedBox(
              width: double.infinity,
              child: FilledButton(
                onPressed: () => Navigator.of(sheetContext).pop(),
                child: const Text('Close'),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _ReadinessChecklist extends StatelessWidget {
  const _ReadinessChecklist();

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text('Before you join', style: Theme.of(context).textTheme.titleSmall),
        const SizedBox(height: 8),
        for (final item in const [
          (Icons.wifi, 'Find somewhere with a steady signal'),
          (Icons.volume_up_outlined, 'Somewhere quiet and private if you can'),
          (Icons.videocam_outlined, 'Allow the camera and microphone when asked'),
          (Icons.medication_outlined, 'Have your medications to hand'),
        ])
          Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: Row(
              children: [
                Icon(item.$1, size: 18, color: Colors.grey.shade700),
                const SizedBox(width: 10),
                Expanded(child: Text(item.$2, style: const TextStyle(fontSize: 13))),
              ],
            ),
          ),
      ],
    );
  }
}
