import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../blocs/auth_bloc.dart';
import '../core/api_client.dart';

class PatientHome extends StatefulWidget {
  const PatientHome({super.key});

  @override
  State<PatientHome> createState() => _PatientHomeState();
}

class _PatientHomeState extends State<PatientHome> {
  int _tab = 0;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('MediCore'),
        actions: [
          IconButton(
            icon: const Icon(Icons.logout),
            onPressed: () => context.read<AuthBloc>().add(const AuthSignOutRequested()),
          ),
        ],
      ),
      body: IndexedStack(
        index: _tab,
        children: const [
          _HealthDashboard(),
          _AppointmentsTab(),
          _RecordsTab(),
          _BillingTab(),
        ],
      ),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _tab,
        onDestinationSelected: (i) => setState(() => _tab = i),
        destinations: const [
          NavigationDestination(icon: Icon(Icons.favorite), label: 'Health'),
          NavigationDestination(icon: Icon(Icons.event), label: 'Appointments'),
          NavigationDestination(icon: Icon(Icons.description), label: 'Records'),
          NavigationDestination(icon: Icon(Icons.payment), label: 'Billing'),
        ],
      ),
    );
  }
}

class _HealthDashboard extends StatelessWidget {
  const _HealthDashboard();

  @override
  Widget build(BuildContext context) {
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        Card(
          child: ListTile(
            leading: const Icon(Icons.monitor_heart),
            title: const Text('Wearable vitals'),
            subtitle: const Text('Connect a device to sync heart rate and activity'),
            trailing: FilledButton(onPressed: () {}, child: const Text('Connect')),
          ),
        ),
        Card(
          child: ListTile(
            leading: const Icon(Icons.medication_liquid),
            title: const Text('Medication reminders'),
            subtitle: const Text('Manage reminders and request refills'),
          ),
        ),
        Card(
          child: ListTile(
            leading: const Icon(Icons.psychology_alt),
            title: const Text('Symptom checker'),
            subtitle: const Text('Pre-appointment triage. Not a diagnosis.'),
            onTap: () => showDialog<void>(
              context: context,
              builder: (dialogContext) => AlertDialog(
                title: const Text('Before you start'),
                content: const Text(
                  'This tool helps prepare for your appointment. It does not diagnose. '
                  'If you have severe symptoms, contact emergency services immediately.',
                ),
                actions: [
                  TextButton(
                    onPressed: () => Navigator.of(dialogContext).pop(),
                    child: const Text('Understood'),
                  ),
                ],
              ),
            ),
          ),
        ),
      ],
    );
  }
}

class _AppointmentsTab extends StatelessWidget {
  const _AppointmentsTab();

  @override
  Widget build(BuildContext context) {
    return FutureBuilder<Map<String, dynamic>>(
      future: context.read<ApiClient>().get<Map<String, dynamic>>('/portal/summary'),
      builder: (context, snapshot) {
        if (snapshot.connectionState != ConnectionState.done) {
          return const Center(child: CircularProgressIndicator());
        }
        final appointments =
            ((snapshot.data?['appointments'] as List<dynamic>?) ?? const []).cast<Map<String, dynamic>>();
        if (appointments.isEmpty) return const Center(child: Text('No appointments'));

        return ListView.builder(
          itemCount: appointments.length,
          itemBuilder: (context, index) {
            final appointment = appointments[index];
            final telehealth = appointment['is_telehealth'] == true;
            return ListTile(
              title: Text(appointment['service_type'] as String),
              subtitle: Text(DateTime.parse(appointment['start'] as String).toLocal().toString()),
              trailing: telehealth
                  ? FilledButton(onPressed: () {}, child: const Text('Join'))
                  : Text(appointment['status'] as String),
            );
          },
        );
      },
    );
  }
}

class _RecordsTab extends StatelessWidget {
  const _RecordsTab();

  @override
  Widget build(BuildContext context) {
    return FutureBuilder<Map<String, dynamic>>(
      future: context.read<ApiClient>().get<Map<String, dynamic>>('/portal/summary'),
      builder: (context, snapshot) {
        if (snapshot.connectionState != ConnectionState.done) {
          return const Center(child: CircularProgressIndicator());
        }
        final results =
            ((snapshot.data?['results'] as List<dynamic>?) ?? const []).cast<Map<String, dynamic>>();
        return ListView.builder(
          itemCount: results.length,
          itemBuilder: (context, index) {
            final result = results[index];
            final critical = result['interpretation'] == 'HH' || result['interpretation'] == 'LL';
            return ListTile(
              tileColor: critical ? Colors.red.shade50 : null,
              title: Text(result['display'] as String),
              subtitle: Text('${result['value_quantity'] ?? ''} ${result['unit'] ?? ''}'),
              // Results are shown, never interpreted for the patient.
              trailing: critical
                  ? const Text('Contact your clinician', style: TextStyle(color: Colors.red))
                  : null,
            );
          },
        );
      },
    );
  }
}

class _BillingTab extends StatelessWidget {
  const _BillingTab();

  @override
  Widget build(BuildContext context) {
    return FutureBuilder<Map<String, dynamic>>(
      future: context.read<ApiClient>().get<Map<String, dynamic>>('/portal/summary'),
      builder: (context, snapshot) {
        if (snapshot.connectionState != ConnectionState.done) {
          return const Center(child: CircularProgressIndicator());
        }
        final invoices =
            ((snapshot.data?['invoices'] as List<dynamic>?) ?? const []).cast<Map<String, dynamic>>();
        return ListView.builder(
          itemCount: invoices.length,
          itemBuilder: (context, index) {
            final invoice = invoices[index];
            final balanceMinor = (invoice['balance_minor'] as num?) ?? 0;
            return ListTile(
              title: Text(invoice['invoice_number'] as String),
              subtitle: Text('${invoice['currency']} ${(balanceMinor / 100).toStringAsFixed(2)}'),
              trailing: balanceMinor > 0
                  ? FilledButton(onPressed: () {}, child: const Text('Pay'))
                  : const Icon(Icons.check_circle, color: Colors.green),
            );
          },
        );
      },
    );
  }
}
