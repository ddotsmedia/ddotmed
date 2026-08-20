/// Records: results, prescriptions and discharge summaries.
///
/// Every item expands rather than navigating, so a patient comparing two results
/// does not lose their place. Results carry their reference range and their flag,
/// and never an interpretation — a phone app telling somebody their liver
/// function is "abnormal" without a clinician attached to the sentence is how
/// people end up in an emergency department at midnight.
library;

import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:share_plus/share_plus.dart';

import '../../core/models.dart';
import '../../core/ui/widgets.dart';
import 'patient_blocs.dart';

class RecordsScreen extends StatelessWidget {
  const RecordsScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return DefaultTabController(
      length: 3,
      child: Column(
        children: [
          const TabBar(
            tabs: [
              Tab(text: 'Results'),
              Tab(text: 'Prescriptions'),
              Tab(text: 'Summaries'),
            ],
          ),
          Expanded(
            child: BlocBuilder<RecordsBloc, RecordsState>(
              builder: (context, state) => switch (state) {
                RecordsLoading() => const Center(child: CircularProgressIndicator()),
                RecordsError(:final message) => ErrorState(
                    message: message,
                    onRetry: () => context.read<RecordsBloc>().add(const RecordsRequested()),
                  ),
                RecordsReady() => TabBarView(
                    children: [
                      _ResultsTab(results: state.results),
                      _PrescriptionsTab(prescriptions: state.prescriptions),
                      _SummariesTab(documents: state.discharges),
                    ],
                  ),
              },
            ),
          ),
        ],
      ),
    );
  }
}

class _ResultsTab extends StatelessWidget {
  const _ResultsTab({required this.results});

  final List<LabResult> results;

  @override
  Widget build(BuildContext context) {
    if (results.isEmpty) {
      return const EmptyState(
        icon: Icons.science_outlined,
        title: 'No results yet',
        detail: 'Results appear here once your clinician has reviewed and '
            'released them.',
      );
    }

    return ListView(
      padding: const EdgeInsets.only(bottom: 24),
      children: [
        for (final result in results)
          Card(
            margin: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
            child: ExpansionTile(
              shape: const Border(),
              title: Text(
                result.display,
                style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 14),
              ),
              subtitle: Text(
                dayTime(result.performedAt),
                style: TextStyle(fontSize: 11, color: Colors.grey.shade600),
              ),
              trailing: LabFlagChip(result: result),
              childrenPadding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
              children: [
                _DetailRow(label: 'Result', value: result.valueLabel),
                if (result.referenceLabel != null)
                  _DetailRow(label: 'Usual range', value: result.referenceLabel!),
                if (result.status != null) _DetailRow(label: 'Status', value: result.status!),
                if (result.isAbnormal)
                  Container(
                    width: double.infinity,
                    margin: const EdgeInsets.only(top: 8),
                    padding: const EdgeInsets.all(10),
                    decoration: BoxDecoration(
                      color: const Color(0xFFFEF3C7),
                      borderRadius: BorderRadius.circular(6),
                    ),
                    child: const Text(
                      'This is outside the usual range. That is common and often '
                      'not a problem — your clinician will tell you what it means '
                      'for you.',
                      style: TextStyle(fontSize: 12, color: Color(0xFF78350F)),
                    ),
                  ),
                Align(
                  alignment: Alignment.centerRight,
                  child: TextButton.icon(
                    icon: const Icon(Icons.ios_share, size: 16),
                    label: const Text('Share'),
                    onPressed: () => _share(
                      context,
                      '${result.display}: ${result.valueLabel}'
                      '${result.referenceLabel == null ? '' : ' (usual range ${result.referenceLabel})'}'
                      '\nTaken ${dayTime(result.performedAt)}',
                    ),
                  ),
                ),
              ],
            ),
          ),
      ],
    );
  }
}

class _PrescriptionsTab extends StatelessWidget {
  const _PrescriptionsTab({required this.prescriptions});

  final List<Prescription> prescriptions;

  @override
  Widget build(BuildContext context) {
    if (prescriptions.isEmpty) {
      return const EmptyState(
        icon: Icons.medication_outlined,
        title: 'No prescriptions',
        detail: 'Medications prescribed to you appear here.',
      );
    }

    return ListView(
      padding: const EdgeInsets.only(bottom: 24),
      children: [
        for (final prescription in prescriptions)
          Card(
            margin: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
            child: ExpansionTile(
              shape: const Border(),
              title: Text(
                prescription.display,
                style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 14),
              ),
              subtitle: Text(
                prescription.doseLabel,
                style: TextStyle(fontSize: 12, color: Colors.grey.shade700),
              ),
              childrenPadding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
              children: [
                if (prescription.instructions != null)
                  _DetailRow(label: 'How to take it', value: prescription.instructions!),
                if (prescription.endDate != null)
                  _DetailRow(
                    label: 'Until',
                    value: dayTime(prescription.endDate!),
                  ),
                if (prescription.refills != null)
                  _DetailRow(
                    label: 'Repeats',
                    value: '${prescription.refillsUsed ?? 0} of ${prescription.refills} used',
                  ),
                Align(
                  alignment: Alignment.centerRight,
                  child: TextButton.icon(
                    icon: const Icon(Icons.ios_share, size: 16),
                    label: const Text('Share'),
                    onPressed: () => _share(
                      context,
                      '${prescription.display}\n${prescription.doseLabel}'
                      '${prescription.instructions == null ? '' : '\n${prescription.instructions}'}',
                    ),
                  ),
                ),
              ],
            ),
          ),
      ],
    );
  }
}

class _SummariesTab extends StatelessWidget {
  const _SummariesTab({required this.documents});

  final List<RecordDocument> documents;

  @override
  Widget build(BuildContext context) {
    if (documents.isEmpty) {
      return const EmptyState(
        icon: Icons.description_outlined,
        title: 'No discharge summaries',
        detail: 'A summary appears here after an admission ends.',
      );
    }

    return ListView(
      padding: const EdgeInsets.only(bottom: 24),
      children: [
        for (final document in documents)
          Card(
            margin: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
            child: ExpansionTile(
              shape: const Border(),
              leading: const Icon(Icons.description_outlined),
              title: Text(
                document.title,
                style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 14),
              ),
              subtitle: Text(
                dayTime(document.date),
                style: TextStyle(fontSize: 11, color: Colors.grey.shade600),
              ),
              childrenPadding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
              children: [
                if (document.detail != null)
                  Text(document.detail!, style: const TextStyle(fontSize: 13)),
                const SizedBox(height: 8),
                Align(
                  alignment: Alignment.centerRight,
                  child: TextButton.icon(
                    icon: const Icon(Icons.ios_share, size: 16),
                    label: const Text('Share'),
                    onPressed: () => _share(
                      context,
                      '${document.title}\n${dayTime(document.date)}'
                      '${document.detail == null ? '' : '\n\n${document.detail}'}',
                    ),
                  ),
                ),
              ],
            ),
          ),
      ],
    );
  }
}

class _DetailRow extends StatelessWidget {
  const _DetailRow({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 110,
            child: Text(
              label,
              style: TextStyle(fontSize: 12, color: Colors.grey.shade600),
            ),
          ),
          Expanded(child: Text(value, style: const TextStyle(fontSize: 13))),
        ],
      ),
    );
  }
}

/// Shares the record as text.
///
/// Text rather than a generated PDF: the document a patient forwards to another
/// clinician has to be one the hospital issued, and minting a PDF on the handset
/// would produce an official-looking artefact with no provenance behind it. The
/// server-issued PDF is fetched by link where the record has one.
void _share(BuildContext context, String text) {
  final box = context.findRenderObject() as RenderBox?;
  SharePlus.instance.share(
    ShareParams(
      text: text,
      subject: 'MediCore health record',
      // iPad needs an anchor for the share sheet or it throws.
      sharePositionOrigin: box == null ? null : box.localToGlobal(Offset.zero) & box.size,
    ),
  );
}
