/// Ambient scribe.
///
/// The rule this screen exists to enforce: nothing a model wrote reaches the
/// record until a clinician has looked at it and said yes. Sections arrive one at
/// a time, none is approved by default, and the file button stays disabled while
/// any section is still outstanding. Silence is not approval.
///
/// Linked evidence is what makes that review possible rather than ceremonial.
/// Tapping a drafted sentence shows the point in the recording it came from, so
/// a clinician can check a claim instead of trusting it.
library;

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../core/ui/widgets.dart';
import 'scribe_bloc.dart';

class ScribeScreen extends StatelessWidget {
  const ScribeScreen({
    super.key,
    required this.patientId,
    required this.encounterId,
    this.patientName,
  });

  final String patientId;
  final String encounterId;
  final String? patientName;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Ambient scribe'),
        bottom: patientName == null
            ? null
            : PreferredSize(
                preferredSize: const Size.fromHeight(20),
                child: Padding(
                  padding: const EdgeInsets.only(bottom: 6),
                  child: Text(
                    patientName!,
                    style: const TextStyle(fontSize: 12),
                  ),
                ),
              ),
      ),
      body: BlocConsumer<ScribeBloc, ScribeState>(
        listener: (context, state) {
          if (state is ScribeIdle) {
            ScaffoldMessenger.of(context).showSnackBar(
              const SnackBar(content: Text('Note filed for approval')),
            );
          }
        },
        builder: (context, state) => switch (state) {
          ScribeIdle() => _StartView(patientId: patientId, encounterId: encounterId),
          ScribeRecording() => _RecordingView(state: state),
          ScribeProcessing() => const _ProcessingView(),
          ScribeError(:final message) => ErrorState(
              message: message,
              onRetry: () => context.read<ScribeBloc>().add(const ScribeDiscarded()),
            ),
          ScribeReview() => _ReviewView(state: state),
        },
      ),
    );
  }
}

class _StartView extends StatelessWidget {
  const _StartView({required this.patientId, required this.encounterId});

  final String patientId;
  final String encounterId;

  @override
  Widget build(BuildContext context) {
    final hasEncounter = encounterId.isNotEmpty;

    return Center(
      child: Padding(
        padding: const EdgeInsets.all(28),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.mic_none, size: 72, color: Theme.of(context).colorScheme.primary),
            const SizedBox(height: 20),
            Text(
              'Ambient documentation',
              style: Theme.of(context).textTheme.titleLarge,
            ),
            const SizedBox(height: 8),
            Text(
              'The consultation is transcribed and drafted into a SOAP note. '
              'Nothing is filed until you approve each section.',
              textAlign: TextAlign.center,
              style: TextStyle(color: Colors.grey.shade700),
            ),
            const SizedBox(height: 20),
            Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: const Color(0xFFFEF3C7),
                borderRadius: BorderRadius.circular(8),
              ),
              child: const Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Icon(Icons.campaign_outlined, size: 18, color: Color(0xFF78350F)),
                  SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      'Tell the patient they are being recorded and obtain consent '
                      'before you start.',
                      style: TextStyle(fontSize: 12, color: Color(0xFF78350F)),
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 24),
            FilledButton.icon(
              icon: const Icon(Icons.fiber_manual_record),
              label: const Text('Start recording'),
              style: FilledButton.styleFrom(
                padding: const EdgeInsets.symmetric(horizontal: 28, vertical: 14),
              ),
              onPressed: !hasEncounter
                  ? null
                  : () =>
                      context.read<ScribeBloc>().add(ScribeStartRequested(patientId, encounterId)),
            ),
            if (!hasEncounter) ...[
              const SizedBox(height: 10),
              Text(
                'Open an encounter for this patient before recording — a note has '
                'to attach to a visit.',
                textAlign: TextAlign.center,
                style: TextStyle(fontSize: 12, color: Colors.grey.shade600),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

class _RecordingView extends StatelessWidget {
  const _RecordingView({required this.state});

  final ScribeRecording state;

  @override
  Widget build(BuildContext context) {
    final seconds = state.durationMs ~/ 1000;

    return Padding(
      padding: const EdgeInsets.all(16),
      child: Column(
        children: [
          Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Container(
                width: 12,
                height: 12,
                decoration: const BoxDecoration(
                  color: Color(0xFFDC2626),
                  shape: BoxShape.circle,
                ),
              ),
              const SizedBox(width: 8),
              Text(
                'Recording  ${(seconds ~/ 60).toString().padLeft(2, '0')}:'
                '${(seconds % 60).toString().padLeft(2, '0')}',
                style: Theme.of(context)
                    .textTheme
                    .titleLarge
                    ?.copyWith(fontFeatures: const [FontFeature.tabularFigures()]),
              ),
            ],
          ),
          const SizedBox(height: 12),
          Expanded(
            child: Container(
              width: double.infinity,
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: Colors.grey.shade100,
                borderRadius: BorderRadius.circular(8),
              ),
              child: SingleChildScrollView(
                reverse: true,
                child: Text(
                  state.partial.isEmpty
                      ? 'Listening… the transcript appears here as it is recognised.'
                      : state.partial,
                  style: TextStyle(
                    fontSize: 14,
                    height: 1.5,
                    color: state.partial.isEmpty ? Colors.grey.shade500 : null,
                  ),
                ),
              ),
            ),
          ),
          const SizedBox(height: 12),
          SizedBox(
            width: double.infinity,
            child: FilledButton.icon(
              icon: const Icon(Icons.stop),
              label: const Text('Stop and draft'),
              style: FilledButton.styleFrom(
                padding: const EdgeInsets.symmetric(vertical: 14),
              ),
              onPressed: () => context.read<ScribeBloc>().add(const ScribeStopRequested()),
            ),
          ),
        ],
      ),
    );
  }
}

class _ProcessingView extends StatelessWidget {
  const _ProcessingView();

  @override
  Widget build(BuildContext context) {
    return const Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          CircularProgressIndicator(),
          SizedBox(height: 16),
          Text('Drafting the note…'),
        ],
      ),
    );
  }
}

class _ReviewView extends StatelessWidget {
  const _ReviewView({required this.state});

  final ScribeReview state;

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        Expanded(
          child: ListView(
            padding: const EdgeInsets.all(12),
            children: [
              _ApprovalBanner(state: state),
              const SizedBox(height: 12),
              for (final section in SoapSection.values)
                if (state.textFor(section).trim().isNotEmpty)
                  _SectionCard(section: section, state: state),
              if (state.selectedEvidence != null) _EvidenceDetail(state: state),
              const SizedBox(height: 80),
            ],
          ),
        ),
        _FileBar(state: state),
      ],
    );
  }
}

class _ApprovalBanner extends StatelessWidget {
  const _ApprovalBanner({required this.state});

  final ScribeReview state;

  @override
  Widget build(BuildContext context) {
    final lowConfidence = state.lowConfidence;

    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: lowConfidence ? const Color(0xFFFEE2E2) : const Color(0xFFFEF3C7),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(
                lowConfidence ? Icons.error_outline : Icons.rule,
                size: 18,
                color: lowConfidence ? const Color(0xFF991B1B) : const Color(0xFF78350F),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  lowConfidence
                      ? 'Low-confidence draft — read every line'
                      : 'Requires clinician approval',
                  style: TextStyle(
                    fontWeight: FontWeight.w800,
                    color: lowConfidence ? const Color(0xFF991B1B) : const Color(0xFF78350F),
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 6),
          Text(
            'Drafted by ${state.modelVersion} · confidence '
            '${(state.confidence * 100).toStringAsFixed(0)}%. '
            'Approve, edit or discard each section.',
            style: TextStyle(
              fontSize: 12,
              color: lowConfidence ? const Color(0xFF991B1B) : const Color(0xFF78350F),
            ),
          ),
        ],
      ),
    );
  }
}

class _SectionCard extends StatelessWidget {
  const _SectionCard({required this.section, required this.state});

  final SoapSection section;
  final ScribeReview state;

  @override
  Widget build(BuildContext context) {
    final text = state.textFor(section);
    final approved = state.approved.contains(section);
    final discarded = state.discarded.contains(section);

    // Sentences the model traced back to the audio, for this section only.
    final evidence = state.evidence.where((e) => text.contains(e.sentence)).toList();

    return Card(
      margin: const EdgeInsets.only(bottom: 10),
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(12),
        side: BorderSide(
          color: approved
              ? const Color(0xFF059669)
              : discarded
                  ? const Color(0xFFDC2626)
                  : Colors.grey.shade300,
          width: approved || discarded ? 1.5 : 1,
        ),
      ),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text(
                    section.label,
                    style: const TextStyle(fontWeight: FontWeight.w800),
                  ),
                ),
                if (approved)
                  const _StatusTag(
                    label: 'Approved',
                    colour: Color(0xFF059669),
                    icon: Icons.check_circle,
                  )
                else if (discarded)
                  const _StatusTag(
                    label: 'Discarded',
                    colour: Color(0xFFDC2626),
                    icon: Icons.cancel,
                  )
                else
                  const _StatusTag(
                    label: 'Not reviewed',
                    colour: Color(0xFF64748B),
                    icon: Icons.radio_button_unchecked,
                  ),
              ],
            ),
            const SizedBox(height: 8),
            if (discarded)
              Text(
                text,
                style: TextStyle(
                  color: Colors.grey.shade500,
                  decoration: TextDecoration.lineThrough,
                  height: 1.4,
                ),
              )
            else
              _EvidenceText(text: text, evidence: evidence),
            const SizedBox(height: 10),
            Row(
              children: [
                TextButton.icon(
                  onPressed: approved
                      ? null
                      : () => context.read<ScribeBloc>().add(ScribeSectionApproved(section)),
                  icon: const Icon(Icons.check, size: 16),
                  label: const Text('Approve'),
                ),
                TextButton.icon(
                  onPressed: () => _edit(context, text),
                  icon: const Icon(Icons.edit, size: 16),
                  label: const Text('Edit'),
                ),
                TextButton.icon(
                  onPressed: discarded
                      ? null
                      : () => context.read<ScribeBloc>().add(ScribeSectionDiscarded(section)),
                  icon: const Icon(Icons.delete_outline, size: 16),
                  label: const Text('Discard'),
                  style: TextButton.styleFrom(foregroundColor: const Color(0xFFDC2626)),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _edit(BuildContext context, String current) async {
    final bloc = context.read<ScribeBloc>();
    final controller = TextEditingController(text: current);

    final edited = await showModalBottomSheet<String>(
      context: context,
      isScrollControlled: true,
      builder: (sheetContext) => Padding(
        padding: EdgeInsets.only(
          left: 16,
          right: 16,
          top: 16,
          bottom: MediaQuery.of(sheetContext).viewInsets.bottom + 16,
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              'Edit ${section.label.toLowerCase()}',
              style: Theme.of(sheetContext).textTheme.titleMedium,
            ),
            const SizedBox(height: 12),
            TextField(
              controller: controller,
              maxLines: 8,
              autofocus: true,
              decoration: const InputDecoration(border: OutlineInputBorder()),
            ),
            const SizedBox(height: 12),
            Row(
              children: [
                Expanded(
                  child: OutlinedButton(
                    onPressed: () => Navigator.of(sheetContext).pop(),
                    child: const Text('Cancel'),
                  ),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: FilledButton(
                    onPressed: () => Navigator.of(sheetContext).pop(controller.text),
                    child: const Text('Save and approve'),
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );

    controller.dispose();
    if (edited != null) bloc.add(ScribeSectionEdited(section, edited));
  }
}

class _StatusTag extends StatelessWidget {
  const _StatusTag({required this.label, required this.colour, required this.icon});

  final String label;
  final Color colour;
  final IconData icon;

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Icon(icon, size: 14, color: colour),
        const SizedBox(width: 4),
        Text(
          label,
          style: TextStyle(fontSize: 11, color: colour, fontWeight: FontWeight.w600),
        ),
      ],
    );
  }
}

/// Renders the section, making every traced sentence tappable.
///
/// A sentence with evidence behind it is underlined; tapping it reveals where in
/// the recording it came from. Untraced text renders plainly, which is itself a
/// signal — it means the model wrote something the transcript does not support.
class _EvidenceText extends StatelessWidget {
  const _EvidenceText({required this.text, required this.evidence});

  final String text;
  final List<LinkedEvidence> evidence;

  @override
  Widget build(BuildContext context) {
    if (evidence.isEmpty) {
      return Text(text, style: const TextStyle(height: 1.45));
    }

    final spans = <InlineSpan>[];
    var cursor = 0;

    // Walk the section in order of where each traced sentence actually appears.
    final ordered = [...evidence]
      ..sort((a, b) => text.indexOf(a.sentence).compareTo(text.indexOf(b.sentence)));

    for (final item in ordered) {
      final index = text.indexOf(item.sentence, cursor);
      if (index < 0) continue;
      if (index > cursor) {
        spans.add(TextSpan(text: text.substring(cursor, index)));
      }
      spans.add(
        TextSpan(
          text: item.sentence,
          style: TextStyle(
            decoration: TextDecoration.underline,
            decorationStyle: TextDecorationStyle.dotted,
            color: Theme.of(context).colorScheme.primary,
          ),
          recognizer: _tap(context, item),
        ),
      );
      cursor = index + item.sentence.length;
    }

    if (cursor < text.length) spans.add(TextSpan(text: text.substring(cursor)));

    return RichText(
      text: TextSpan(
        style: DefaultTextStyle.of(context).style.copyWith(height: 1.45),
        children: spans,
      ),
    );
  }

  TapGestureRecognizer _tap(BuildContext context, LinkedEvidence item) {
    final bloc = context.read<ScribeBloc>();
    return TapGestureRecognizer()..onTap = () => bloc.add(ScribeEvidenceSelected(item));
  }
}

class _EvidenceDetail extends StatelessWidget {
  const _EvidenceDetail({required this.state});

  final ScribeReview state;

  @override
  Widget build(BuildContext context) {
    final item = state.selectedEvidence!;
    final seconds = item.audioOffsetMs ~/ 1000;

    return Card(
      color: Theme.of(context).colorScheme.primaryContainer,
      margin: const EdgeInsets.only(bottom: 10),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                const Icon(Icons.graphic_eq, size: 18),
                const SizedBox(width: 8),
                Text(
                  'Heard at ${(seconds ~/ 60).toString().padLeft(2, '0')}:'
                  '${(seconds % 60).toString().padLeft(2, '0')}',
                  style: const TextStyle(fontWeight: FontWeight.w700),
                ),
                const Spacer(),
                Text(
                  '${(item.confidence * 100).toStringAsFixed(0)}% confident',
                  style: const TextStyle(fontSize: 11),
                ),
                IconButton(
                  icon: const Icon(Icons.close, size: 18),
                  onPressed: () =>
                      context.read<ScribeBloc>().add(const ScribeEvidenceSelected(null)),
                ),
              ],
            ),
            const SizedBox(height: 4),
            Text('“${item.sentence}”', style: const TextStyle(fontStyle: FontStyle.italic)),
          ],
        ),
      ),
    );
  }
}

class _FileBar extends StatelessWidget {
  const _FileBar({required this.state});

  final ScribeReview state;

  @override
  Widget build(BuildContext context) {
    final outstanding = state.outstanding;

    return SafeArea(
      top: false,
      child: Container(
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(
          color: Theme.of(context).colorScheme.surface,
          border: Border(top: BorderSide(color: Colors.grey.shade300)),
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (outstanding.isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(bottom: 8),
                child: Text(
                  'Still to review: ${outstanding.map((s) => s.label).join(', ')}',
                  style: TextStyle(fontSize: 12, color: Colors.grey.shade700),
                ),
              ),
            Row(
              children: [
                Expanded(
                  child: OutlinedButton(
                    onPressed: () => context.read<ScribeBloc>().add(const ScribeDiscarded()),
                    child: const Text('Discard all'),
                  ),
                ),
                const SizedBox(width: 8),
                Expanded(
                  flex: 2,
                  child: FilledButton.icon(
                    icon: const Icon(Icons.save_outlined, size: 18),
                    label: Text(
                      state.approved.isEmpty
                          ? 'File note'
                          : 'File ${state.approved.length} section'
                              '${state.approved.length == 1 ? '' : 's'}',
                    ),
                    onPressed: !state.canFile
                        ? null
                        : () => context.read<ScribeBloc>().add(const ScribeApproved()),
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
