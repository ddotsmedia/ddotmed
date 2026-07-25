import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../blocs/auth_bloc.dart';
import '../blocs/scribe_bloc.dart';
import '../core/api_client.dart';

class DoctorHome extends StatefulWidget {
  const DoctorHome({super.key});

  @override
  State<DoctorHome> createState() => _DoctorHomeState();
}

class _DoctorHomeState extends State<DoctorHome> {
  int _tab = 0;

  @override
  Widget build(BuildContext context) {
    final api = context.read<ApiClient>();
    return Scaffold(
      appBar: AppBar(
        title: const Text('MediCore Doctor'),
        actions: [
          IconButton(
            icon: const Icon(Icons.logout),
            onPressed: () => context.read<AuthBloc>().add(const AuthSignOutRequested()),
          ),
        ],
      ),
      body: IndexedStack(
        index: _tab,
        children: [
          const _TodayList(),
          BlocProvider(
            create: (_) => ScribeBloc(api: api),
            child: const ScribeScreen(patientId: '', encounterId: ''),
          ),
          const _AlertsFeed(),
        ],
      ),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _tab,
        onDestinationSelected: (i) => setState(() => _tab = i),
        destinations: const [
          NavigationDestination(icon: Icon(Icons.people), label: 'Today'),
          NavigationDestination(icon: Icon(Icons.mic), label: 'Scribe'),
          NavigationDestination(icon: Icon(Icons.notifications_active), label: 'Alerts'),
        ],
      ),
    );
  }
}

class _TodayList extends StatelessWidget {
  const _TodayList();

  @override
  Widget build(BuildContext context) {
    return FutureBuilder<List<dynamic>>(
      future: context.read<ApiClient>().get<List<dynamic>>('/appointments'),
      builder: (context, snapshot) {
        if (snapshot.connectionState != ConnectionState.done) {
          return const Center(child: CircularProgressIndicator());
        }
        if (snapshot.hasError) return Center(child: Text('${snapshot.error}'));
        final rows = (snapshot.data ?? const []).cast<Map<String, dynamic>>();
        if (rows.isEmpty) return const Center(child: Text('No patients scheduled'));

        return ListView.builder(
          itemCount: rows.length,
          itemBuilder: (context, index) {
            final appointment = rows[index];
            final patient = appointment['patient'] as Map<String, dynamic>?;
            return ListTile(
              title: Text('${patient?['given_names']?[0] ?? ''} ${patient?['family_name'] ?? ''}'),
              subtitle: Text('${patient?['mrn'] ?? ''} · ${appointment['service_type']}'),
              trailing: Text(
                DateTime.parse(appointment['start'] as String).toLocal().toString().substring(11, 16),
              ),
            );
          },
        );
      },
    );
  }
}

class ScribeScreen extends StatelessWidget {
  const ScribeScreen({super.key, required this.patientId, required this.encounterId});

  final String patientId;
  final String encounterId;

  @override
  Widget build(BuildContext context) {
    return BlocBuilder<ScribeBloc, ScribeState>(
      builder: (context, state) => switch (state) {
        ScribeIdle() => Center(
            child: FilledButton.icon(
              icon: const Icon(Icons.mic),
              label: const Text('Start ambient scribe'),
              onPressed: () => context
                  .read<ScribeBloc>()
                  .add(ScribeStartRequested(patientId, encounterId)),
            ),
          ),
        ScribeRecording(:final durationMs, :final partial) => Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              children: [
                const Icon(Icons.mic, size: 64, color: Colors.red),
                Text('${durationMs ~/ 1000}s', style: Theme.of(context).textTheme.headlineMedium),
                const SizedBox(height: 16),
                Expanded(child: SingleChildScrollView(child: Text(partial))),
                FilledButton(
                  onPressed: () => context.read<ScribeBloc>().add(const ScribeStopRequested()),
                  child: const Text('Stop and draft'),
                ),
              ],
            ),
          ),
        ScribeProcessing() => const Center(child: CircularProgressIndicator()),
        ScribeError(:final message) => Center(child: Text(message)),
        ScribeReview() => _ReviewView(state: state),
      },
    );
  }
}

class _ReviewView extends StatelessWidget {
  const _ReviewView({required this.state});

  final ScribeReview state;

  @override
  Widget build(BuildContext context) {
    final sections = <String, String>{
      'Subjective': state.draft.subjective,
      'Objective': state.draft.objective,
      'Assessment': state.draft.assessment,
      'Plan': state.draft.plan,
    };

    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        Container(
          padding: const EdgeInsets.all(12),
          color: Colors.amber.shade100,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text('Requires clinician approval',
                  style: TextStyle(fontWeight: FontWeight.bold)),
              if (state.lowConfidence)
                const Text('Low confidence — review carefully'),
              Text('${state.modelVersion} · ${(state.confidence * 100).round()}%'),
            ],
          ),
        ),
        const SizedBox(height: 16),
        for (final entry in sections.entries) ...[
          Text(entry.key, style: Theme.of(context).textTheme.titleMedium),
          TextFormField(
            initialValue: entry.value,
            maxLines: null,
            decoration: const InputDecoration(border: OutlineInputBorder()),
          ),
          // Each sentence is playable back against the audio that produced it.
          Wrap(
            spacing: 6,
            children: [
              for (final evidence in state.evidence.where((e) => entry.value.contains(e.sentence)))
                ActionChip(
                  avatar: const Icon(Icons.play_arrow, size: 16),
                  label: Text(
                    '${(evidence.audioOffsetMs / 1000).toStringAsFixed(1)}s · '
                    '${(evidence.confidence * 100).round()}%',
                  ),
                  onPressed: () {},
                ),
            ],
          ),
          const SizedBox(height: 16),
        ],
        Row(
          children: [
            Expanded(
              child: FilledButton(
                onPressed: () => context.read<ScribeBloc>().add(const ScribeApproved()),
                child: const Text('Approve'),
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: OutlinedButton(
                onPressed: () => context.read<ScribeBloc>().add(const ScribeDiscarded()),
                child: const Text('Discard'),
              ),
            ),
          ],
        ),
      ],
    );
  }
}

class _AlertsFeed extends StatelessWidget {
  const _AlertsFeed();

  @override
  Widget build(BuildContext context) {
    return FutureBuilder<List<dynamic>>(
      future: context.read<ApiClient>().get<List<dynamic>>('/lab/critical-pending'),
      builder: (context, snapshot) {
        if (snapshot.connectionState != ConnectionState.done) {
          return const Center(child: CircularProgressIndicator());
        }
        final rows = (snapshot.data ?? const []).cast<Map<String, dynamic>>();
        if (rows.isEmpty) return const Center(child: Text('No critical alerts'));

        return ListView.builder(
          itemCount: rows.length,
          itemBuilder: (context, index) {
            final result = rows[index];
            final patient = result['patient'] as Map<String, dynamic>?;
            return Card(
              color: Colors.red.shade50,
              child: ListTile(
                leading: Icon(Icons.warning, color: Colors.red.shade700),
                title: Text('${result['display']}: ${result['value_quantity'] ?? ''} ${result['unit'] ?? ''}'),
                subtitle: Text('${patient?['family_name'] ?? ''} ${patient?['mrn'] ?? ''}'),
              ),
            );
          },
        );
      },
    );
  }
}
