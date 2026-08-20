/// The shift task board.
///
/// One list, ordered overdue-first then by due time, because that is the order a
/// nurse works in. Overdue is carried by colour, an icon and the word OVERDUE
/// together — a red row alone is invisible to a colour-blind nurse under ward
/// lighting, and this is the row that matters most.
library;

import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../core/ui/widgets.dart';
import 'task_board_bloc.dart';

class TaskBoardScreen extends StatelessWidget {
  const TaskBoardScreen({super.key, required this.ward});

  final String ward;

  @override
  Widget build(BuildContext context) {
    return BlocBuilder<TaskBoardBloc, TaskBoardState>(
      builder: (context, state) => switch (state) {
        TaskBoardLoading() => const Center(child: CircularProgressIndicator()),
        TaskBoardError(:final message) => ErrorState(
            message: message,
            onRetry: () => context.read<TaskBoardBloc>().add(TaskBoardRequested(ward)),
          ),
        TaskBoardReady() => _Board(state: state, ward: ward),
      },
    );
  }
}

class _Board extends StatelessWidget {
  const _Board({required this.state, required this.ward});

  final TaskBoardReady state;
  final String ward;

  @override
  Widget build(BuildContext context) {
    final tasks = state.sorted;

    if (tasks.isEmpty) {
      return RefreshIndicator(
        onRefresh: () async => context.read<TaskBoardBloc>().add(TaskBoardRequested(ward)),
        child: ListView(
          children: const [
            SizedBox(height: 120),
            EmptyState(
              icon: Icons.task_alt,
              title: 'Nothing outstanding',
              detail: 'Every task for this shift has been completed.',
            ),
          ],
        ),
      );
    }

    return RefreshIndicator(
      onRefresh: () async => context.read<TaskBoardBloc>().add(TaskBoardRequested(ward)),
      child: ListView(
        padding: const EdgeInsets.only(bottom: 24),
        children: [
          if (state.overdueCount > 0)
            Container(
              margin: const EdgeInsets.fromLTRB(12, 10, 12, 6),
              padding: const EdgeInsets.all(10),
              decoration: BoxDecoration(
                color: const Color(0xFFDC2626),
                borderRadius: BorderRadius.circular(8),
              ),
              child: Row(
                children: [
                  const Icon(Icons.warning_amber, color: Colors.white, size: 18),
                  const SizedBox(width: 8),
                  Text(
                    '${state.overdueCount} task${state.overdueCount == 1 ? '' : 's'} overdue',
                    style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w800),
                  ),
                ],
              ),
            ),
          for (final task in tasks) _TaskRow(task: task, now: state.now),
        ],
      ),
    );
  }
}

class _TaskRow extends StatelessWidget {
  const _TaskRow({required this.task, required this.now});

  final WardTask task;
  final DateTime now;

  @override
  Widget build(BuildContext context) {
    final overdue = task.isOverdue(now);
    final minutesLate = overdue ? now.difference(task.dueAt).inMinutes : 0;

    return Card(
      margin: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
      color: overdue ? const Color(0xFFFEF2F2) : null,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(12),
        side: BorderSide(
          color: overdue ? const Color(0xFFDC2626) : Colors.grey.shade300,
          width: overdue ? 1.5 : 1,
        ),
      ),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            _KindIcon(kind: task.kind, overdue: overdue),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    task.title,
                    style: const TextStyle(fontWeight: FontWeight.w700),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    [task.patientName, task.patientMrn].where((p) => p.isNotEmpty).join(' · '),
                    style: TextStyle(fontSize: 12, color: Colors.grey.shade700),
                  ),
                  const SizedBox(height: 4),
                  Row(
                    children: [
                      Icon(
                        overdue ? Icons.alarm : Icons.schedule,
                        size: 13,
                        color: overdue ? const Color(0xFFDC2626) : Colors.grey.shade600,
                      ),
                      const SizedBox(width: 4),
                      Text(
                        overdue
                            ? 'OVERDUE by ${_lateness(minutesLate)} · due ${hhmm(task.dueAt)}'
                            : 'Due ${hhmm(task.dueAt)}',
                        style: TextStyle(
                          fontSize: 12,
                          fontWeight: overdue ? FontWeight.w800 : FontWeight.w400,
                          color: overdue ? const Color(0xFFDC2626) : Colors.grey.shade700,
                        ),
                      ),
                    ],
                  ),
                ],
              ),
            ),
            IconButton(
              tooltip: 'Mark complete',
              icon: const Icon(Icons.check_circle_outline),
              color: const Color(0xFF059669),
              onPressed: () => context.read<TaskBoardBloc>().add(TaskCompleted(task.id)),
            ),
          ],
        ),
      ),
    );
  }

  static String _lateness(int minutes) {
    if (minutes < 60) return '${minutes}m';
    final hours = minutes ~/ 60;
    final remainder = minutes % 60;
    return remainder == 0 ? '${hours}h' : '${hours}h ${remainder}m';
  }
}

class _KindIcon extends StatelessWidget {
  const _KindIcon({required this.kind, required this.overdue});

  final String kind;
  final bool overdue;

  @override
  Widget build(BuildContext context) {
    final (icon, colour) = switch (kind.toLowerCase()) {
      'medication' => (Icons.medication, const Color(0xFF7C3AED)),
      'vitals' || 'observation' => (Icons.monitor_heart, const Color(0xFFDB2777)),
      'procedure' => (Icons.medical_services, const Color(0xFF0284C7)),
      'nursing' || 'nursing_care' => (Icons.healing, const Color(0xFF059669)),
      _ => (Icons.task_alt, const Color(0xFF64748B)),
    };

    return Container(
      width: 38,
      height: 38,
      decoration: BoxDecoration(
        color: (overdue ? const Color(0xFFDC2626) : colour).withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(10),
      ),
      child: Icon(icon, size: 20, color: overdue ? const Color(0xFFDC2626) : colour),
    );
  }
}
