/// Shift handover, one SBAR note per patient.
///
/// The AI draft button is offered per patient rather than for the whole ward,
/// because a handover is signed per patient and a bulk draft encourages bulk
/// signing. Every drafted note is labelled as drafted until the nurse signs it,
/// and editing a signed note revokes the signature — what was signed is no longer
/// what is written.
library;

import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../core/models.dart';
import '../../core/ui/widgets.dart';
import 'handover_bloc.dart';

class HandoverScreen extends StatelessWidget {
  const HandoverScreen({super.key, required this.ward});

  final String ward;

  @override
  Widget build(BuildContext context) {
    return BlocConsumer<HandoverBloc, HandoverState>(
      listenWhen: (previous, current) => current is HandoverReady && current.message != null,
      listener: (context, state) {
        if (state is! HandoverReady || state.message == null) return;
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(state.message!)));
      },
      builder: (context, state) => switch (state) {
        HandoverLoading() => const Center(child: CircularProgressIndicator()),
        HandoverError(:final message) => ErrorState(
            message: message,
            onRetry: () => context.read<HandoverBloc>().add(HandoverRequested(ward)),
          ),
        HandoverReady() => _HandoverList(state: state, ward: ward),
      },
    );
  }
}

class _HandoverList extends StatelessWidget {
  const _HandoverList({required this.state, required this.ward});

  final HandoverReady state;
  final String ward;

  @override
  Widget build(BuildContext context) {
    if (state.patients.isEmpty) {
      return const EmptyState(
        icon: Icons.groups_outlined,
        title: 'No patients on this ward',
        detail: 'There is nothing to hand over.',
      );
    }

    return RefreshIndicator(
      onRefresh: () async => context.read<HandoverBloc>().add(HandoverRequested(ward)),
      child: ListView(
        padding: const EdgeInsets.only(bottom: 24),
        children: [
          Container(
            margin: const EdgeInsets.fromLTRB(12, 10, 12, 4),
            padding: const EdgeInsets.all(10),
            decoration: BoxDecoration(
              color: state.outstanding == 0
                  ? const Color(0xFFD1FAE5)
                  : Theme.of(context).colorScheme.surfaceContainerHighest,
              borderRadius: BorderRadius.circular(8),
            ),
            child: Row(
              children: [
                Icon(
                  state.outstanding == 0 ? Icons.check_circle : Icons.assignment_outlined,
                  size: 18,
                  color: state.outstanding == 0 ? const Color(0xFF065F46) : null,
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    state.outstanding == 0
                        ? 'Every patient handed over'
                        : '${state.outstanding} of ${state.patients.length} '
                            'still to hand over',
                    style: TextStyle(
                      fontWeight: FontWeight.w700,
                      color: state.outstanding == 0 ? const Color(0xFF065F46) : null,
                    ),
                  ),
                ),
              ],
            ),
          ),
          for (final patient in state.patients)
            _HandoverCard(
              patient: patient,
              note: state.noteFor(patient.id),
              expanded: state.selectedPatientId == patient.id,
              signed: state.signed.contains(patient.id),
              aiDrafted: state.aiDrafted.contains(patient.id),
              drafting: state.drafting == patient.id,
            ),
        ],
      ),
    );
  }
}

class _HandoverCard extends StatelessWidget {
  const _HandoverCard({
    required this.patient,
    required this.note,
    required this.expanded,
    required this.signed,
    required this.aiDrafted,
    required this.drafting,
  });

  final Patient patient;
  final SbarNote note;
  final bool expanded;
  final bool signed;
  final bool aiDrafted;
  final bool drafting;

  @override
  Widget build(BuildContext context) {
    return Card(
      margin: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(12),
        side: BorderSide(
          color: signed ? const Color(0xFF059669) : Colors.grey.shade300,
          width: signed ? 1.5 : 1,
        ),
      ),
      child: Column(
        children: [
          ListTile(
            leading: CircleAvatar(child: Text(patient.initials)),
            title: Text(
              patient.fullName,
              style: const TextStyle(fontWeight: FontWeight.w700),
            ),
            subtitle: Text(
              [patient.mrn, if (patient.location != null) patient.location!].join(' · '),
            ),
            trailing: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                if (signed)
                  const Icon(Icons.verified, color: Color(0xFF059669), size: 20)
                else if (!note.isEmpty)
                  const Icon(Icons.edit_note, color: Color(0xFFD97706), size: 20),
                Icon(expanded ? Icons.expand_less : Icons.expand_more),
              ],
            ),
            onTap: () => context.read<HandoverBloc>().add(HandoverPatientSelected(patient.id)),
          ),
          if (expanded)
            _SbarEditor(
              patient: patient,
              note: note,
              signed: signed,
              aiDrafted: aiDrafted,
              drafting: drafting,
            ),
        ],
      ),
    );
  }
}

class _SbarEditor extends StatefulWidget {
  const _SbarEditor({
    required this.patient,
    required this.note,
    required this.signed,
    required this.aiDrafted,
    required this.drafting,
  });

  final Patient patient;
  final SbarNote note;
  final bool signed;
  final bool aiDrafted;
  final bool drafting;

  @override
  State<_SbarEditor> createState() => _SbarEditorState();
}

class _SbarEditorState extends State<_SbarEditor> {
  late final _situation = TextEditingController(text: widget.note.situation);
  late final _background = TextEditingController(text: widget.note.background);
  late final _assessment = TextEditingController(text: widget.note.assessment);
  late final _recommendation = TextEditingController(text: widget.note.recommendation);

  @override
  void didUpdateWidget(_SbarEditor oldWidget) {
    super.didUpdateWidget(oldWidget);
    // A freshly generated draft has to replace what is in the fields; a keystroke
    // the nurse just made must not.
    if (widget.note != oldWidget.note && widget.note != _current) {
      _situation.text = widget.note.situation;
      _background.text = widget.note.background;
      _assessment.text = widget.note.assessment;
      _recommendation.text = widget.note.recommendation;
    }
  }

  @override
  void dispose() {
    _situation.dispose();
    _background.dispose();
    _assessment.dispose();
    _recommendation.dispose();
    super.dispose();
  }

  SbarNote get _current => SbarNote(
        situation: _situation.text,
        background: _background.text,
        assessment: _assessment.text,
        recommendation: _recommendation.text,
      );

  void _push() => context.read<HandoverBloc>().add(HandoverEdited(widget.patient.id, _current));

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 0, 12, 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (widget.aiDrafted && !widget.signed)
            Container(
              width: double.infinity,
              margin: const EdgeInsets.only(bottom: 10),
              padding: const EdgeInsets.all(10),
              decoration: BoxDecoration(
                color: const Color(0xFFFEF3C7),
                borderRadius: BorderRadius.circular(8),
              ),
              child: const Row(
                children: [
                  Icon(Icons.smart_toy_outlined, size: 16, color: Color(0xFF78350F)),
                  SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      'AI draft — read and correct it before signing. Your signature '
                      'makes it yours.',
                      style: TextStyle(fontSize: 12, color: Color(0xFF78350F)),
                    ),
                  ),
                ],
              ),
            ),
          _SbarField(
            controller: _situation,
            label: 'Situation',
            hint: 'Why is this patient here, right now?',
            onChanged: _push,
          ),
          _SbarField(
            controller: _background,
            label: 'Background',
            hint: 'Relevant history and what has happened this admission',
            onChanged: _push,
          ),
          _SbarField(
            controller: _assessment,
            label: 'Assessment',
            hint: 'How are they? Trend, score, concerns',
            onChanged: _push,
          ),
          _SbarField(
            controller: _recommendation,
            label: 'Recommendation',
            hint: 'What must the next shift do, and by when?',
            onChanged: _push,
          ),
          const SizedBox(height: 8),
          Row(
            children: [
              Expanded(
                child: OutlinedButton.icon(
                  icon: widget.drafting
                      ? const SizedBox(
                          width: 14,
                          height: 14,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : const Icon(Icons.smart_toy_outlined, size: 16),
                  label: const Text('AI draft'),
                  onPressed: widget.drafting
                      ? null
                      : () => context
                          .read<HandoverBloc>()
                          .add(HandoverDraftRequested(widget.patient.id)),
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                flex: 2,
                child: FilledButton.icon(
                  icon: Icon(widget.signed ? Icons.verified : Icons.draw, size: 16),
                  label: Text(widget.signed ? 'Signed' : 'Approve and sign'),
                  style: FilledButton.styleFrom(
                    backgroundColor: widget.signed ? const Color(0xFF059669) : null,
                  ),
                  onPressed: widget.signed || !_current.isComplete
                      ? null
                      : () => context.read<HandoverBloc>().add(HandoverSigned(widget.patient.id)),
                ),
              ),
            ],
          ),
          if (!_current.isComplete && !_current.isEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Text(
                'All four sections are needed before this can be signed.',
                style: TextStyle(fontSize: 11, color: Colors.grey.shade600),
              ),
            ),
        ],
      ),
    );
  }
}

class _SbarField extends StatelessWidget {
  const _SbarField({
    required this.controller,
    required this.label,
    required this.hint,
    required this.onChanged,
  });

  final TextEditingController controller;
  final String label;
  final String hint;
  final VoidCallback onChanged;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: TextField(
        controller: controller,
        maxLines: 3,
        minLines: 2,
        decoration: InputDecoration(
          labelText: label,
          hintText: hint,
          hintStyle: TextStyle(fontSize: 12, color: Colors.grey.shade500),
          border: const OutlineInputBorder(),
          isDense: true,
        ),
        onChanged: (_) => onChanged(),
      ),
    );
  }
}
