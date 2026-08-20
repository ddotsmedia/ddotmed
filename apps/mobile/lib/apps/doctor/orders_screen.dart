/// Ordering, in three tabs.
///
/// The medication tab differs from the other two in one important way: it will
/// not let you submit until the safety check has run. A contraindication the
/// server calls absolute disables the button entirely — there is no override
/// affordance to reach for, because on a phone in a corridor there is no
/// pharmacist standing next to you to argue with.
library;

import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import 'orders_bloc.dart';

class OrdersScreen extends StatefulWidget {
  const OrdersScreen({
    super.key,
    required this.patientId,
    required this.encounterId,
    this.patientName,
    this.initialTab = 0,
  });

  final String patientId;
  final String? encounterId;
  final String? patientName;
  final int initialTab;

  @override
  State<OrdersScreen> createState() => _OrdersScreenState();
}

class _OrdersScreenState extends State<OrdersScreen> with SingleTickerProviderStateMixin {
  late final TabController _tabs =
      TabController(length: 3, vsync: this, initialIndex: widget.initialTab);

  @override
  void dispose() {
    _tabs.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('New order'),
        bottom: TabBar(
          controller: _tabs,
          tabs: const [
            Tab(icon: Icon(Icons.science_outlined), text: 'Lab'),
            Tab(icon: Icon(Icons.radio_button_checked), text: 'Radiology'),
            Tab(icon: Icon(Icons.medication_outlined), text: 'Medication'),
          ],
        ),
      ),
      body: BlocListener<OrdersBloc, OrdersState>(
        listenWhen: (previous, current) => current is OrdersSubmitted,
        listener: (context, state) {
          if (state is! OrdersSubmitted) return;
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(
              content: Text(
                state.queuedOffline
                    ? '${state.summary} — held on this device until you reconnect'
                    : state.summary,
              ),
              backgroundColor: state.queuedOffline ? const Color(0xFFD97706) : null,
            ),
          );
          Navigator.of(context).pop();
        },
        child: Column(
          children: [
            if (widget.patientName != null)
              Container(
                width: double.infinity,
                color: Theme.of(context).colorScheme.surfaceContainerHighest,
                padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
                child: Text(
                  'For ${widget.patientName}',
                  style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 13),
                ),
              ),
            Expanded(
              child: TabBarView(
                controller: _tabs,
                children: [
                  _LabTab(patientId: widget.patientId, encounterId: widget.encounterId),
                  _RadiologyTab(
                    patientId: widget.patientId,
                    encounterId: widget.encounterId,
                  ),
                  _MedicationTab(
                    patientId: widget.patientId,
                    encounterId: widget.encounterId,
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// Priority chips, shared by the lab and radiology tabs.
class _PrioritySelector extends StatelessWidget {
  const _PrioritySelector({required this.value, required this.onChanged});

  final OrderPriority value;
  final ValueChanged<OrderPriority> onChanged;

  @override
  Widget build(BuildContext context) {
    return Wrap(
      spacing: 8,
      children: [
        for (final priority in OrderPriority.values)
          ChoiceChip(
            label: Text(priority.label),
            selected: value == priority,
            onSelected: (_) => onChanged(priority),
            selectedColor: switch (priority) {
              OrderPriority.stat => const Color(0xFFFEE2E2),
              OrderPriority.urgent => const Color(0xFFFEF3C7),
              OrderPriority.routine => null,
            },
          ),
      ],
    );
  }
}

class _LabTab extends StatefulWidget {
  const _LabTab({required this.patientId, required this.encounterId});

  final String patientId;
  final String? encounterId;

  @override
  State<_LabTab> createState() => _LabTabState();
}

class _LabTabState extends State<_LabTab> {
  final _search = TextEditingController();
  final _notes = TextEditingController();
  CatalogueItem? _selected;
  OrderPriority _priority = OrderPriority.routine;

  @override
  void dispose() {
    _search.dispose();
    _notes.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        TextField(
          controller: _search,
          decoration: const InputDecoration(
            labelText: 'Search tests (LOINC)',
            hintText: 'Full blood count, creatinine…',
            prefixIcon: Icon(Icons.search),
            border: OutlineInputBorder(),
          ),
          onChanged: (value) => context.read<OrdersBloc>().add(CatalogueSearched('lab', value)),
        ),
        const SizedBox(height: 8),
        _CatalogueResults(
          kind: 'lab',
          selected: _selected,
          onSelected: (item) {
            setState(() => _selected = item);
            _search.text = item.display;
          },
        ),
        const SizedBox(height: 16),
        const Text('Priority', style: TextStyle(fontWeight: FontWeight.w600)),
        const SizedBox(height: 6),
        _PrioritySelector(
          value: _priority,
          onChanged: (value) => setState(() => _priority = value),
        ),
        const SizedBox(height: 16),
        TextField(
          controller: _notes,
          maxLines: 3,
          decoration: const InputDecoration(
            labelText: 'Clinical details',
            hintText: 'Why is this being requested?',
            border: OutlineInputBorder(),
          ),
        ),
        const SizedBox(height: 20),
        _SubmitButton(
          label: 'Request test',
          enabled: _selected != null,
          onPressed: () => context.read<OrdersBloc>().add(
                LabOrderSubmitted(
                  patientId: widget.patientId,
                  encounterId: widget.encounterId,
                  item: _selected!,
                  priority: _priority,
                  notes: _notes.text,
                ),
              ),
        ),
      ],
    );
  }
}

class _RadiologyTab extends StatefulWidget {
  const _RadiologyTab({required this.patientId, required this.encounterId});

  final String patientId;
  final String? encounterId;

  @override
  State<_RadiologyTab> createState() => _RadiologyTabState();
}

class _RadiologyTabState extends State<_RadiologyTab> {
  final _notes = TextEditingController();
  String? _modality;
  String? _bodySite;
  OrderPriority _priority = OrderPriority.routine;

  @override
  void dispose() {
    _notes.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        const Text('Modality', style: TextStyle(fontWeight: FontWeight.w600)),
        const SizedBox(height: 6),
        Wrap(
          spacing: 8,
          runSpacing: 4,
          children: [
            for (final modality in radiologyModalities)
              ChoiceChip(
                label: Text(modality),
                selected: _modality == modality,
                onSelected: (_) => setState(() => _modality = modality),
              ),
          ],
        ),
        const SizedBox(height: 16),
        const Text('Body part', style: TextStyle(fontWeight: FontWeight.w600)),
        const SizedBox(height: 6),
        Wrap(
          spacing: 8,
          runSpacing: 4,
          children: [
            for (final site in commonBodySites)
              ChoiceChip(
                label: Text(site),
                selected: _bodySite == site,
                onSelected: (_) => setState(() => _bodySite = site),
              ),
          ],
        ),
        const SizedBox(height: 16),
        const Text('Priority', style: TextStyle(fontWeight: FontWeight.w600)),
        const SizedBox(height: 6),
        _PrioritySelector(
          value: _priority,
          onChanged: (value) => setState(() => _priority = value),
        ),
        const SizedBox(height: 16),
        TextField(
          controller: _notes,
          maxLines: 3,
          decoration: const InputDecoration(
            labelText: 'Clinical question',
            hintText: 'What are you looking for?',
            border: OutlineInputBorder(),
          ),
        ),
        const SizedBox(height: 20),
        _SubmitButton(
          label: 'Request imaging',
          enabled: _modality != null && _bodySite != null,
          onPressed: () => context.read<OrdersBloc>().add(
                RadiologyOrderSubmitted(
                  patientId: widget.patientId,
                  encounterId: widget.encounterId,
                  modality: _modality!,
                  bodySite: _bodySite!,
                  priority: _priority,
                  notes: _notes.text,
                ),
              ),
        ),
      ],
    );
  }
}

class _MedicationTab extends StatefulWidget {
  const _MedicationTab({required this.patientId, required this.encounterId});

  final String patientId;
  final String? encounterId;

  @override
  State<_MedicationTab> createState() => _MedicationTabState();
}

class _MedicationTabState extends State<_MedicationTab> {
  final _search = TextEditingController();
  final _dose = TextEditingController();
  final _unit = TextEditingController(text: 'mg');
  final _instructions = TextEditingController();
  final _overrideReason = TextEditingController();

  CatalogueItem? _drug;
  String _route = medicationRoutes.first;
  String _frequency = medicationFrequencies[1];
  int? _durationDays;

  @override
  void dispose() {
    _search.dispose();
    _dose.dispose();
    _unit.dispose();
    _instructions.dispose();
    _overrideReason.dispose();
    super.dispose();
  }

  num? get _doseValue => num.tryParse(_dose.text.trim());

  bool get _formComplete => _drug != null && _doseValue != null && _unit.text.isNotEmpty;

  @override
  Widget build(BuildContext context) {
    return BlocBuilder<OrdersBloc, OrdersState>(
      builder: (context, state) {
        final warning = state is OrdersSafetyWarning ? state : null;
        final cleared = state is OrdersSafetyClear;
        final blocked = warning?.hasAbsolute ?? false;
        final needsReason = warning?.requiresReason ?? false;

        return ListView(
          padding: const EdgeInsets.all(16),
          children: [
            TextField(
              controller: _search,
              decoration: const InputDecoration(
                labelText: 'Search the formulary',
                prefixIcon: Icon(Icons.search),
                border: OutlineInputBorder(),
              ),
              onChanged: (value) {
                // Changing the drug invalidates any check already run.
                if (_drug != null) setState(() => _drug = null);
                context.read<OrdersBloc>().add(CatalogueSearched('drug', value));
              },
            ),
            const SizedBox(height: 8),
            _CatalogueResults(
              kind: 'drug',
              selected: _drug,
              onSelected: (item) {
                setState(() => _drug = item);
                _search.text = item.display;
              },
            ),
            const SizedBox(height: 16),
            Row(
              children: [
                Expanded(
                  flex: 2,
                  child: TextField(
                    controller: _dose,
                    keyboardType: const TextInputType.numberWithOptions(decimal: true),
                    decoration: const InputDecoration(
                      labelText: 'Dose',
                      border: OutlineInputBorder(),
                    ),
                    onChanged: (_) => setState(() {}),
                  ),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: TextField(
                    controller: _unit,
                    decoration: const InputDecoration(
                      labelText: 'Unit',
                      border: OutlineInputBorder(),
                    ),
                    onChanged: (_) => setState(() {}),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 12),
            DropdownButtonFormField<String>(
              value: _route,
              decoration: const InputDecoration(
                labelText: 'Route',
                border: OutlineInputBorder(),
              ),
              items: [
                for (final route in medicationRoutes)
                  DropdownMenuItem(value: route, child: Text(route)),
              ],
              onChanged: (value) => setState(() => _route = value ?? _route),
            ),
            const SizedBox(height: 12),
            DropdownButtonFormField<String>(
              value: _frequency,
              decoration: const InputDecoration(
                labelText: 'Frequency',
                border: OutlineInputBorder(),
              ),
              items: [
                for (final frequency in medicationFrequencies)
                  DropdownMenuItem(value: frequency, child: Text(frequency)),
              ],
              onChanged: (value) => setState(() => _frequency = value ?? _frequency),
            ),
            const SizedBox(height: 12),
            TextField(
              keyboardType: TextInputType.number,
              decoration: const InputDecoration(
                labelText: 'Duration (days, optional)',
                border: OutlineInputBorder(),
              ),
              onChanged: (value) => setState(() => _durationDays = int.tryParse(value.trim())),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _instructions,
              maxLines: 2,
              decoration: const InputDecoration(
                labelText: 'Instructions to the patient',
                border: OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: 16),

            // The safety gate.
            if (state is OrdersSubmitting)
              const Padding(
                padding: EdgeInsets.symmetric(vertical: 12),
                child: Center(child: CircularProgressIndicator()),
              )
            else if (cleared)
              const _SafetyPanel(
                colour: Color(0xFFD1FAE5),
                foreground: Color(0xFF065F46),
                icon: Icons.verified_outlined,
                title: 'No interactions or allergy conflicts found',
              )
            else if (warning != null)
              _WarningPanel(warning: warning),

            if (needsReason) ...[
              const SizedBox(height: 12),
              TextField(
                controller: _overrideReason,
                maxLines: 2,
                decoration: const InputDecoration(
                  labelText: 'Reason for proceeding (required)',
                  helperText: 'Recorded against the prescription and auditable',
                  border: OutlineInputBorder(),
                ),
                onChanged: (_) => setState(() {}),
              ),
            ],

            const SizedBox(height: 16),
            OutlinedButton.icon(
              icon: const Icon(Icons.health_and_safety_outlined, size: 18),
              label: const Text('Check interactions and allergies'),
              onPressed: !_formComplete
                  ? null
                  : () => context.read<OrdersBloc>().add(
                        InteractionCheckRequested(
                          patientId: widget.patientId,
                          drug: _drug!,
                          doseQuantity: _doseValue!,
                          route: _route,
                        ),
                      ),
            ),
            const SizedBox(height: 10),
            _SubmitButton(
              label: blocked ? 'Contraindicated — cannot prescribe' : 'Prescribe',
              // Nothing may be prescribed before the check has run, and nothing
              // at all when the server called it absolute.
              enabled: _formComplete &&
                  !blocked &&
                  (cleared || warning != null) &&
                  (!needsReason || _overrideReason.text.trim().length >= 5),
              danger: blocked,
              onPressed: () => context.read<OrdersBloc>().add(
                    PrescriptionSubmitted(
                      patientId: widget.patientId,
                      encounterId: widget.encounterId,
                      drug: _drug!,
                      doseQuantity: _doseValue!,
                      doseUnit: _unit.text.trim(),
                      route: _route,
                      frequency: _frequency,
                      durationDays: _durationDays,
                      instructions: _instructions.text,
                      overrideReason: needsReason ? _overrideReason.text.trim() : null,
                    ),
                  ),
            ),
            if (!cleared && warning == null && state is! OrdersSubmitting)
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Text(
                  'Run the safety check before prescribing.',
                  style: TextStyle(fontSize: 12, color: Colors.grey.shade600),
                ),
              ),
            const SizedBox(height: 24),
          ],
        );
      },
    );
  }
}

class _CatalogueResults extends StatelessWidget {
  const _CatalogueResults({
    required this.kind,
    required this.selected,
    required this.onSelected,
  });

  final String kind;
  final CatalogueItem? selected;
  final ValueChanged<CatalogueItem> onSelected;

  @override
  Widget build(BuildContext context) {
    return BlocBuilder<OrdersBloc, OrdersState>(
      buildWhen: (previous, current) =>
          current is OrdersResults || current is OrdersSearching || current is OrdersError,
      builder: (context, state) {
        if (selected != null) {
          return Card(
            color: Theme.of(context).colorScheme.primaryContainer,
            child: ListTile(
              dense: true,
              leading: const Icon(Icons.check_circle, size: 18),
              title: Text(selected!.display),
              subtitle: Text(selected!.code),
            ),
          );
        }
        if (state is OrdersSearching && state.kind == kind) {
          return const Padding(
            padding: EdgeInsets.all(12),
            child: Center(child: CircularProgressIndicator()),
          );
        }
        if (state is OrdersError) {
          return Text(
            state.message,
            style: TextStyle(color: Theme.of(context).colorScheme.error, fontSize: 12),
          );
        }
        if (state is! OrdersResults || state.kind != kind || state.items.isEmpty) {
          return const SizedBox.shrink();
        }

        return Card(
          margin: EdgeInsets.zero,
          child: Column(
            children: [
              for (final item in state.items.take(8))
                ListTile(
                  dense: true,
                  title: Text(item.display),
                  subtitle: Text(
                    [item.code, if (item.detail != null) item.detail!].join(' · '),
                  ),
                  onTap: () => onSelected(item),
                ),
            ],
          ),
        );
      },
    );
  }
}

class _SafetyPanel extends StatelessWidget {
  const _SafetyPanel({
    required this.colour,
    required this.foreground,
    required this.icon,
    required this.title,
    this.children = const [],
  });

  final Color colour;
  final Color foreground;
  final IconData icon;
  final String title;
  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(color: colour, borderRadius: BorderRadius.circular(8)),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(icon, size: 18, color: foreground),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  title,
                  style: TextStyle(fontWeight: FontWeight.w800, color: foreground),
                ),
              ),
            ],
          ),
          ...children,
        ],
      ),
    );
  }
}

class _WarningPanel extends StatelessWidget {
  const _WarningPanel({required this.warning});

  final OrdersSafetyWarning warning;

  @override
  Widget build(BuildContext context) {
    final absolute = warning.hasAbsolute;

    return _SafetyPanel(
      colour: absolute ? const Color(0xFFFEE2E2) : const Color(0xFFFEF3C7),
      foreground: absolute ? const Color(0xFF991B1B) : const Color(0xFF78350F),
      icon: absolute ? Icons.dangerous : Icons.warning_amber,
      title: absolute ? 'Contraindicated — this cannot be prescribed here' : 'Warnings raised',
      children: [
        const SizedBox(height: 6),
        for (final finding in warning.findings)
          Padding(
            padding: const EdgeInsets.only(top: 4),
            child: Text(
              '• ${finding.message}',
              style: TextStyle(
                fontSize: 12,
                color: absolute ? const Color(0xFF991B1B) : const Color(0xFF78350F),
              ),
            ),
          ),
        if (absolute) ...[
          const SizedBox(height: 8),
          const Text(
            'Discuss with pharmacy or prescribe from a workstation where the '
            'override can be reviewed.',
            style: TextStyle(fontSize: 12, color: Color(0xFF991B1B)),
          ),
        ],
      ],
    );
  }
}

class _SubmitButton extends StatelessWidget {
  const _SubmitButton({
    required this.label,
    required this.enabled,
    required this.onPressed,
    this.danger = false,
  });

  final String label;
  final bool enabled;
  final VoidCallback onPressed;
  final bool danger;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: double.infinity,
      child: FilledButton(
        onPressed: enabled ? onPressed : null,
        style: FilledButton.styleFrom(
          padding: const EdgeInsets.symmetric(vertical: 14),
          backgroundColor: danger ? const Color(0xFFDC2626) : null,
        ),
        child: Text(label),
      ),
    );
  }
}
