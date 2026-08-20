import 'package:bloc/bloc.dart';
import 'package:equatable/equatable.dart';

import '../../core/api_client.dart';

class WardTask extends Equatable {
  const WardTask({
    required this.id,
    required this.title,
    required this.patientName,
    required this.patientMrn,
    required this.dueAt,
    required this.kind,
    this.completed = false,
  });

  final String id;
  final String title;
  final String patientName;
  final String patientMrn;
  final DateTime dueAt;
  final String kind;
  final bool completed;

  bool isOverdue(DateTime now) => !completed && dueAt.isBefore(now);

  @override
  List<Object?> get props => [id, dueAt, completed];
}

sealed class TaskBoardEvent extends Equatable {
  const TaskBoardEvent();
  @override
  List<Object?> get props => const [];
}

class TaskBoardRequested extends TaskBoardEvent {
  const TaskBoardRequested(this.ward);
  final String ward;
  @override
  List<Object?> get props => [ward];
}

class TaskCompleted extends TaskBoardEvent {
  const TaskCompleted(this.taskId);
  final String taskId;
  @override
  List<Object?> get props => [taskId];
}

sealed class TaskBoardState extends Equatable {
  const TaskBoardState();
  @override
  List<Object?> get props => const [];
}

class TaskBoardLoading extends TaskBoardState {
  const TaskBoardLoading();
}

class TaskBoardReady extends TaskBoardState {
  const TaskBoardReady(this.tasks, this.now);
  final List<WardTask> tasks;
  final DateTime now;

  /// Overdue first, then by due time. This ordering is the whole point of the board.
  List<WardTask> get sorted {
    final pending = tasks.where((t) => !t.completed).toList()
      ..sort((a, b) {
        final aOverdue = a.isOverdue(now);
        final bOverdue = b.isOverdue(now);
        if (aOverdue != bOverdue) return aOverdue ? -1 : 1;
        return a.dueAt.compareTo(b.dueAt);
      });
    return pending;
  }

  int get overdueCount => tasks.where((t) => t.isOverdue(now)).length;

  @override
  List<Object?> get props => [tasks, now];
}

class TaskBoardError extends TaskBoardState {
  const TaskBoardError(this.message);
  final String message;
  @override
  List<Object?> get props => [message];
}

class TaskBoardBloc extends Bloc<TaskBoardEvent, TaskBoardState> {
  TaskBoardBloc({required this.api, DateTime Function()? clock})
      : _clock = clock ?? DateTime.now,
        super(const TaskBoardLoading()) {
    on<TaskBoardRequested>(_onRequested);
    on<TaskCompleted>(_onCompleted);
  }

  final ApiClient api;
  final DateTime Function() _clock;

  Future<void> _onRequested(TaskBoardRequested event, Emitter<TaskBoardState> emit) async {
    emit(const TaskBoardLoading());
    try {
      final rows = await api.get<List<dynamic>>(
        '/beds/housekeeping',
        query: {'ward': event.ward},
      );
      final tasks = rows.cast<Map<String, dynamic>>().map((json) {
        return WardTask(
          id: json['id'] as String,
          title: (json['task_type'] as String?) ?? 'task',
          patientName: (json['patient_name'] as String?) ?? '',
          patientMrn: (json['patient_mrn'] as String?) ?? '',
          dueAt: DateTime.parse(
            (json['due_at'] as String?) ?? (json['requested_at'] as String),
          ),
          kind: (json['task_type'] as String?) ?? 'task',
          completed: json['status'] == 'completed',
        );
      }).toList(growable: false);
      emit(TaskBoardReady(tasks, _clock()));
    } on ApiException catch (e) {
      emit(TaskBoardError(e.message));
    }
  }

  Future<void> _onCompleted(TaskCompleted event, Emitter<TaskBoardState> emit) async {
    final current = state;
    if (current is! TaskBoardReady) return;
    try {
      await api.write('/beds/housekeeping/${event.taskId}/complete', const {});
      emit(TaskBoardReady(
        [
          for (final task in current.tasks)
            if (task.id == event.taskId)
              WardTask(
                id: task.id,
                title: task.title,
                patientName: task.patientName,
                patientMrn: task.patientMrn,
                dueAt: task.dueAt,
                kind: task.kind,
                completed: true,
              )
            else
              task,
        ],
        _clock(),
      ));
    } on ApiException catch (e) {
      emit(TaskBoardError(e.message));
    }
  }
}
