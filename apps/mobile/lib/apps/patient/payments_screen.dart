/// Invoices and payment.
///
/// The gateway is deliberately not stubbed. Taking a card needs a PCI-scoped SDK
/// and a merchant account chosen per deployment, and a fake "Pay" button that
/// appears to succeed is worse than an honest one that says what is missing — a
/// patient who believes they have paid stops chasing the bill.
///
/// What is wired is the half that does not change between gateways: the invoice
/// list, the balance, and the server-side payment intent.
library;

import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../core/models.dart';
import '../../core/ui/widgets.dart';
import 'patient_blocs.dart';

class PaymentsScreen extends StatelessWidget {
  const PaymentsScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return BlocConsumer<PaymentsBloc, PaymentsState>(
      listenWhen: (previous, current) => current is PaymentsError,
      listener: (context, state) {
        if (state is! PaymentsError) return;
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(state.message)));
      },
      builder: (context, state) => switch (state) {
        PaymentsLoading() => const Center(child: CircularProgressIndicator()),
        PaymentsError(:final message) => ErrorState(
            message: message,
            onRetry: () => context.read<PaymentsBloc>().add(const PaymentsRequested()),
          ),
        PaymentsReady() => _PaymentsBody(state: state),
      },
    );
  }
}

class _PaymentsBody extends StatelessWidget {
  const _PaymentsBody({required this.state});

  final PaymentsReady state;

  @override
  Widget build(BuildContext context) {
    final now = DateTime.now();
    final outstanding = state.outstanding;
    final settled = state.settled;

    if (outstanding.isEmpty && settled.isEmpty) {
      return const EmptyState(
        icon: Icons.receipt_long_outlined,
        title: 'No invoices',
        detail: 'Nothing has been billed to you.',
      );
    }

    return RefreshIndicator(
      onRefresh: () async => context.read<PaymentsBloc>().add(const PaymentsRequested()),
      child: ListView(
        padding: const EdgeInsets.only(bottom: 24),
        children: [
          Container(
            margin: const EdgeInsets.all(12),
            padding: const EdgeInsets.all(16),
            decoration: BoxDecoration(
              color: outstanding.isEmpty
                  ? const Color(0xFFD1FAE5)
                  : Theme.of(context).colorScheme.primaryContainer,
              borderRadius: BorderRadius.circular(12),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  outstanding.isEmpty ? 'Nothing outstanding' : 'You owe',
                  style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 12),
                ),
                const SizedBox(height: 4),
                Text(
                  formatMoney(state.totalOutstandingMinor, state.currency),
                  style: const TextStyle(fontSize: 28, fontWeight: FontWeight.w900),
                ),
                if (outstanding.any((i) => i.isOverdue(now)))
                  Padding(
                    padding: const EdgeInsets.only(top: 6),
                    child: Text(
                      '${outstanding.where((i) => i.isOverdue(now)).length} '
                      'invoice(s) past their due date',
                      style: const TextStyle(fontSize: 12, color: Color(0xFF991B1B)),
                    ),
                  ),
              ],
            ),
          ),
          if (outstanding.isNotEmpty) const _Heading('To pay'),
          for (final invoice in outstanding)
            _InvoiceCard(
              invoice: invoice,
              now: now,
              processing: state.processing == invoice.id,
            ),
          if (settled.isNotEmpty) const _Heading('Settled'),
          for (final invoice in settled)
            _InvoiceCard(invoice: invoice, now: now, processing: false),
        ],
      ),
    );
  }
}

class _Heading extends StatelessWidget {
  const _Heading(this.label);

  final String label;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 4),
      child: Text(
        label,
        style: Theme.of(context)
            .textTheme
            .labelLarge
            ?.copyWith(color: Theme.of(context).colorScheme.primary),
      ),
    );
  }
}

class _InvoiceCard extends StatelessWidget {
  const _InvoiceCard({
    required this.invoice,
    required this.now,
    required this.processing,
  });

  final Invoice invoice;
  final DateTime now;
  final bool processing;

  @override
  Widget build(BuildContext context) {
    final overdue = invoice.isOverdue(now);

    return Card(
      margin: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(12),
        side: BorderSide(
          color: overdue ? const Color(0xFFDC2626) : Colors.grey.shade300,
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
                    invoice.invoiceNumber.isEmpty ? 'Invoice' : invoice.invoiceNumber,
                    style: const TextStyle(
                      fontWeight: FontWeight.w700,
                      fontFamily: 'monospace',
                    ),
                  ),
                ),
                _StatusPill(status: invoice.status, overdue: overdue),
              ],
            ),
            const SizedBox(height: 8),
            Row(
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        formatMoney(
                          invoice.isOutstanding ? invoice.balanceMinor : invoice.totalMinor,
                          invoice.currency,
                        ),
                        style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w800),
                      ),
                      if (invoice.isOutstanding && invoice.paidMinor > 0)
                        Text(
                          '${formatMoney(invoice.paidMinor, invoice.currency)} already paid',
                          style: TextStyle(fontSize: 11, color: Colors.grey.shade600),
                        ),
                      if (invoice.dueAt != null)
                        Text(
                          'Due ${dayTime(invoice.dueAt!)}',
                          style: TextStyle(
                            fontSize: 11,
                            color: overdue ? const Color(0xFFDC2626) : Colors.grey.shade600,
                            fontWeight: overdue ? FontWeight.w700 : FontWeight.w400,
                          ),
                        ),
                    ],
                  ),
                ),
                if (invoice.isOutstanding)
                  FilledButton(
                    onPressed: processing ? null : () => _pay(context),
                    child: Text(processing ? '…' : 'Pay'),
                  ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  void _pay(BuildContext context) {
    showModalBottomSheet<void>(
      context: context,
      builder: (sheetContext) => Padding(
        padding: const EdgeInsets.all(20),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              'Pay ${formatMoney(invoice.balanceMinor, invoice.currency)}',
              style: Theme.of(sheetContext).textTheme.titleLarge,
            ),
            const SizedBox(height: 12),
            Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: const Color(0xFFFEF3C7),
                borderRadius: BorderRadius.circular(8),
              ),
              child: const Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Icon(Icons.info_outline, size: 18, color: Color(0xFF78350F)),
                  SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      'In-app card payment is not enabled on this build. No payment '
                      'gateway is configured, so nothing would be taken.',
                      style: TextStyle(fontSize: 12, color: Color(0xFF78350F)),
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 16),
            Text(
              'You can settle this invoice at the hospital cashier, or by calling '
              'the billing office with the invoice number above.',
              style: TextStyle(color: Colors.grey.shade700, fontSize: 13),
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

class _StatusPill extends StatelessWidget {
  const _StatusPill({required this.status, required this.overdue});

  final String status;
  final bool overdue;

  @override
  Widget build(BuildContext context) {
    final (background, foreground, label) = overdue
        ? (const Color(0xFFFEE2E2), const Color(0xFF991B1B), 'OVERDUE')
        : switch (status) {
            'paid' => (const Color(0xFFD1FAE5), const Color(0xFF065F46), 'paid'),
            'partially_paid' => (
                const Color(0xFFFEF3C7),
                const Color(0xFF78350F),
                'part paid',
              ),
            'cancelled' => (const Color(0xFFE2E8F0), const Color(0xFF475569), 'cancelled'),
            _ => (const Color(0xFFE0F2FE), const Color(0xFF075985), status),
          };

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
      decoration: BoxDecoration(color: background, borderRadius: BorderRadius.circular(4)),
      child: Text(
        label,
        style: TextStyle(fontSize: 10, color: foreground, fontWeight: FontWeight.w700),
      ),
    );
  }
}
