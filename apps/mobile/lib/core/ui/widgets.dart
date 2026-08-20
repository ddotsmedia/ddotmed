/// Widgets shared by the three apps.
///
/// The clinical ones here follow a single rule: never encode meaning in colour
/// alone. A red EWS badge also carries the number and the word; an abnormal lab
/// carries an H or an L as well as its colour. Colour-blindness is common, ward
/// lighting is bad, and a phone screen at arm's length in a corridor is not a
/// controlled viewing environment.
library;

import 'package:flutter/material.dart';

import '../ews.dart';
import '../models.dart';
import '../sync_status.dart';

/// EWS score with its risk band. Shows the number, a word and an icon.
class EwsBadge extends StatelessWidget {
  const EwsBadge({super.key, required this.score, required this.risk, this.compact = false});

  /// Builds from a stored reading, preferring the server's own score so the badge
  /// cannot disagree with the chart it came from.
  factory EwsBadge.fromVital(VitalReading vital, {bool compact = false}) {
    final risk = switch (vital.ewsRisk) {
      'high' => EwsRisk.high,
      'medium' => EwsRisk.medium,
      _ => EwsRisk.low,
    };
    return EwsBadge(score: vital.ewsScore, risk: risk, compact: compact);
  }

  final int? score;
  final EwsRisk risk;
  final bool compact;

  static (Color background, Color foreground, IconData icon, String word) _style(EwsRisk risk) =>
      switch (risk) {
        EwsRisk.high => (
            const Color(0xFFDC2626),
            Colors.white,
            Icons.priority_high,
            'High',
          ),
        EwsRisk.medium => (
            const Color(0xFFFEF3C7),
            const Color(0xFF78350F),
            Icons.warning_amber,
            'Medium',
          ),
        EwsRisk.low => (
            const Color(0xFFD1FAE5),
            const Color(0xFF065F46),
            Icons.check,
            'Low',
          ),
      };

  @override
  Widget build(BuildContext context) {
    if (score == null) {
      return const Text('EWS —', style: TextStyle(fontSize: 12, color: Colors.grey));
    }
    final (background, foreground, icon, word) = _style(risk);
    return Semantics(
      label: 'Early warning score $score, $word risk',
      child: Container(
        padding: EdgeInsets.symmetric(horizontal: compact ? 6 : 8, vertical: compact ? 2 : 4),
        decoration: BoxDecoration(
          color: background,
          borderRadius: BorderRadius.circular(6),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: compact ? 12 : 14, color: foreground),
            const SizedBox(width: 4),
            Text(
              compact ? 'EWS $score' : 'EWS $score · $word',
              style: TextStyle(
                color: foreground,
                fontWeight: FontWeight.w700,
                fontSize: compact ? 11 : 12,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// The allergy banner at the top of every chart.
///
/// Red for a high-criticality allergy, amber for anything else, and an explicit
/// "no known allergies" when the list is empty — because a blank space is
/// ambiguous between "none recorded" and "nobody has asked".
class AllergyBanner extends StatelessWidget {
  const AllergyBanner({super.key, required this.allergies, this.loading = false});

  final List<Allergy> allergies;
  final bool loading;

  @override
  Widget build(BuildContext context) {
    if (loading) {
      return const _Banner(
        background: Color(0xFFF1F5F9),
        foreground: Color(0xFF334155),
        icon: Icons.hourglass_empty,
        title: 'Checking allergies…',
      );
    }

    if (allergies.isEmpty) {
      return const _Banner(
        background: Color(0xFFD1FAE5),
        foreground: Color(0xFF065F46),
        icon: Icons.check_circle_outline,
        title: 'No known allergies',
      );
    }

    final high = allergies.where((a) => a.isHigh).toList();
    final isHigh = high.isNotEmpty;
    final listed = (isHigh ? high : allergies).map((a) => a.substance).join(', ');

    return _Banner(
      background: isHigh ? const Color(0xFFDC2626) : const Color(0xFFFEF3C7),
      foreground: isHigh ? Colors.white : const Color(0xFF78350F),
      icon: isHigh ? Icons.dangerous : Icons.warning_amber,
      title: isHigh ? 'HIGH-RISK ALLERGY' : 'Allergies',
      detail: listed,
      subdetail: isHigh && allergies.length > high.length
          ? '+${allergies.length - high.length} other recorded'
          : null,
    );
  }
}

class _Banner extends StatelessWidget {
  const _Banner({
    required this.background,
    required this.foreground,
    required this.icon,
    required this.title,
    this.detail,
    this.subdetail,
  });

  final Color background;
  final Color foreground;
  final IconData icon;
  final String title;
  final String? detail;
  final String? subdetail;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(color: background, borderRadius: BorderRadius.circular(8)),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, color: foreground),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  title,
                  style: TextStyle(color: foreground, fontWeight: FontWeight.w800),
                ),
                if (detail != null && detail!.isNotEmpty)
                  Padding(
                    padding: const EdgeInsets.only(top: 2),
                    child: Text(detail!, style: TextStyle(color: foreground)),
                  ),
                if (subdetail != null)
                  Padding(
                    padding: const EdgeInsets.only(top: 2),
                    child: Text(
                      subdetail!,
                      style: TextStyle(color: foreground, fontSize: 12),
                    ),
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// A lab value with its H/L flag. Panic values are red, ordinary abnormals amber.
class LabFlagChip extends StatelessWidget {
  const LabFlagChip({super.key, required this.result});

  final LabResult result;

  @override
  Widget build(BuildContext context) {
    final flag = result.flag;
    if (flag == null) {
      return Text(result.valueLabel, style: const TextStyle(fontWeight: FontWeight.w600));
    }

    final panic = result.isPanic;
    final background = panic ? const Color(0xFFDC2626) : const Color(0xFFFEF3C7);
    final foreground = panic ? Colors.white : const Color(0xFF78350F);

    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Text(result.valueLabel, style: const TextStyle(fontWeight: FontWeight.w700)),
        const SizedBox(width: 6),
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 1),
          decoration: BoxDecoration(
            color: background,
            borderRadius: BorderRadius.circular(4),
          ),
          child: Text(
            flag,
            style: TextStyle(
              color: foreground,
              fontSize: 11,
              fontWeight: FontWeight.w900,
            ),
          ),
        ),
      ],
    );
  }
}

/// A minimal trend line for a vitals series.
///
/// Deliberately axis-free: at this size a scale would be unreadable, and the
/// question it answers is "which way is this going", not "what is the value".
/// The latest figure is printed beside it for anyone who needs the number.
class Sparkline extends StatelessWidget {
  const Sparkline({
    super.key,
    required this.values,
    this.color = const Color(0xFF0369A1),
    this.height = 32,
    this.width = 96,
  });

  final List<double> values;
  final Color color;
  final double height;
  final double width;

  @override
  Widget build(BuildContext context) {
    if (values.length < 2) {
      return SizedBox(
        width: width,
        height: height,
        child: const Center(
          child: Text('—', style: TextStyle(color: Colors.grey, fontSize: 12)),
        ),
      );
    }
    return SizedBox(
      width: width,
      height: height,
      child: CustomPaint(painter: _SparklinePainter(values: values, color: color)),
    );
  }
}

class _SparklinePainter extends CustomPainter {
  const _SparklinePainter({required this.values, required this.color});

  final List<double> values;
  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    final min = values.reduce((a, b) => a < b ? a : b);
    final max = values.reduce((a, b) => a > b ? a : b);
    // A flat series would divide by zero; draw it down the middle instead.
    final range = (max - min).abs() < 0.0001 ? 1.0 : max - min;

    final path = Path();
    for (var i = 0; i < values.length; i++) {
      final x = size.width * (i / (values.length - 1));
      final normalised = (values[i] - min) / range;
      final y = size.height - (normalised * size.height);
      if (i == 0) {
        path.moveTo(x, y);
      } else {
        path.lineTo(x, y);
      }
    }

    canvas.drawPath(
      path,
      Paint()
        ..color = color
        ..strokeWidth = 1.8
        ..style = PaintingStyle.stroke
        ..strokeJoin = StrokeJoin.round,
    );

    // Mark the most recent point, which is the one being asked about.
    final lastX = size.width;
    final lastY = size.height - (((values.last - min) / range) * size.height);
    canvas.drawCircle(Offset(lastX, lastY), 2.5, Paint()..color = color);
  }

  @override
  bool shouldRepaint(_SparklinePainter oldDelegate) =>
      oldDelegate.values != values || oldDelegate.color != color;
}

/// The sync chip carried in every app bar.
class SyncChip extends StatelessWidget {
  const SyncChip({super.key, required this.status, this.onTap});

  final SyncStatus status;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final (color, icon) = switch (status.phase) {
      SyncPhase.synced => (const Color(0xFF059669), Icons.cloud_done_outlined),
      SyncPhase.pending => (const Color(0xFFD97706), Icons.cloud_upload_outlined),
      SyncPhase.syncing => (const Color(0xFF0284C7), Icons.sync),
      SyncPhase.error => (const Color(0xFFDC2626), Icons.cloud_off),
      SyncPhase.offline => (const Color(0xFF64748B), Icons.wifi_off),
    };

    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(6),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: 16, color: color),
            const SizedBox(width: 4),
            Text(status.label, style: TextStyle(fontSize: 12, color: color)),
          ],
        ),
      ),
    );
  }
}

/// One consistent empty state, so a screen with nothing in it never looks broken.
class EmptyState extends StatelessWidget {
  const EmptyState({
    super.key,
    required this.icon,
    required this.title,
    this.detail,
    this.action,
  });

  final IconData icon;
  final String title;
  final String? detail;
  final Widget? action;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: 48, color: Colors.grey.shade400),
            const SizedBox(height: 12),
            Text(title, style: Theme.of(context).textTheme.titleMedium),
            if (detail != null) ...[
              const SizedBox(height: 6),
              Text(
                detail!,
                textAlign: TextAlign.center,
                style: TextStyle(color: Colors.grey.shade600),
              ),
            ],
            if (action != null) ...[const SizedBox(height: 16), action!],
          ],
        ),
      ),
    );
  }
}

/// An error state that offers the retry rather than making the user guess.
class ErrorState extends StatelessWidget {
  const ErrorState({super.key, required this.message, this.onRetry});

  final String message;
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.error_outline, size: 44, color: Theme.of(context).colorScheme.error),
            const SizedBox(height: 12),
            Text(message, textAlign: TextAlign.center),
            if (onRetry != null) ...[
              const SizedBox(height: 16),
              OutlinedButton.icon(
                onPressed: onRetry,
                icon: const Icon(Icons.refresh),
                label: const Text('Try again'),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

/// A titled card, used for every grouped block so spacing stays consistent.
class SectionCard extends StatelessWidget {
  const SectionCard({
    super.key,
    required this.title,
    required this.child,
    this.trailing,
    this.icon,
  });

  final String title;
  final Widget child;
  final Widget? trailing;
  final IconData? icon;

  @override
  Widget build(BuildContext context) {
    return Card(
      margin: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                if (icon != null) ...[
                  Icon(icon, size: 18, color: Theme.of(context).colorScheme.primary),
                  const SizedBox(width: 6),
                ],
                Expanded(
                  child: Text(
                    title,
                    style: Theme.of(context)
                        .textTheme
                        .titleSmall
                        ?.copyWith(fontWeight: FontWeight.w700),
                  ),
                ),
                if (trailing != null) trailing!,
              ],
            ),
            const SizedBox(height: 8),
            child,
          ],
        ),
      ),
    );
  }
}

/// `14:05` in local time — the only clock format any of these screens uses.
String hhmm(DateTime value) {
  final local = value.toLocal();
  return '${local.hour.toString().padLeft(2, '0')}:${local.minute.toString().padLeft(2, '0')}';
}

/// `19 Aug 14:05`, for anything that may not be today.
String dayTime(DateTime value) {
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  final local = value.toLocal();
  return '${local.day} ${months[local.month - 1]} ${hhmm(local)}';
}

/// A short relative age — `4m`, `3h`, `2d` — for feed timestamps.
String relativeAge(DateTime value, DateTime now) {
  final diff = now.difference(value);
  if (diff.inMinutes < 1) return 'now';
  if (diff.inMinutes < 60) return '${diff.inMinutes}m';
  if (diff.inHours < 24) return '${diff.inHours}h';
  return '${diff.inDays}d';
}
