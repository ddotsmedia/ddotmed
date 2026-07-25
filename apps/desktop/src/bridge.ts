/**
 * Typed bridge between the hosted web app and the Tauri native layer.
 * The web app calls these only when `isDesktop()` is true, so the same bundle
 * runs unchanged in a browser.
 */

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export interface ScannerInfo {
  vendor_id: number;
  product_id: number;
  manufacturer: string | null;
  product: string | null;
}

export interface SerialPortInfo {
  name: string;
  port_type: string;
}

export interface CardReaderInfo {
  name: string;
  card_present: boolean;
}

export interface ScanResult {
  file_path: string;
  page_count: number;
}

export interface LocalSyncStatus {
  connected: boolean;
  pending_operations: number;
  last_sync_at: string | null;
  message: string;
}

export interface LabelRequest {
  port: string;
  baud_rate?: number;
  line1: string;
  line2: string;
  barcode_data: string;
}

export function isDesktop(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export const desktop = {
  listBarcodeScanners: () => invoke<ScannerInfo[]>('list_barcode_scanners'),
  listSerialPorts: () => invoke<SerialPortInfo[]>('list_serial_ports'),
  printLabel: (request: LabelRequest) => invoke<void>('print_zpl_label', { request }),
  listCardReaders: () => invoke<CardReaderInfo[]>('list_card_readers'),
  readCardAtr: (readerName: string) => invoke<string>('read_card_atr', { readerName }),
  scanDocument: (outputDir: string) => invoke<ScanResult>('scan_document', { outputDir }),
  localSyncStatus: (databaseUrl: string) =>
    invoke<LocalSyncStatus>('local_sync_status', { databaseUrl }),
  setAlertCount: (count: number) => invoke<void>('set_alert_count', { count }),
  alertCount: () => invoke<number>('alert_count'),
  onSyncRequested: (handler: () => void) => listen('medicore://sync-requested', handler),
};

/**
 * USB HID scanners emulate a keyboard, so a "scan" arrives as a fast burst of
 * keystrokes ending in Enter. This distinguishes it from human typing by timing.
 */
export function attachHidScannerListener(
  onScan: (code: string) => void,
  { maxIntervalMs = 40, minLength = 4 }: { maxIntervalMs?: number; minLength?: number } = {},
): () => void {
  let buffer = '';
  let lastKeyAt = 0;

  const handler = (event: KeyboardEvent) => {
    const now = Date.now();
    if (now - lastKeyAt > maxIntervalMs) buffer = '';
    lastKeyAt = now;

    if (event.key === 'Enter') {
      if (buffer.length >= minLength) {
        onScan(buffer);
        // Prevent the burst from also submitting whatever form has focus.
        event.preventDefault();
      }
      buffer = '';
      return;
    }
    if (event.key.length === 1) buffer += event.key;
  };

  window.addEventListener('keydown', handler, true);
  return () => window.removeEventListener('keydown', handler, true);
}
