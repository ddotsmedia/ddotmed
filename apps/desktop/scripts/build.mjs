#!/usr/bin/env node
/**
 * Builds the Tauri bundle when a Rust toolchain is available.
 *
 * The desktop shell is optional: web, core-api, ai-service and mobile all build
 * without Rust. Rather than breaking the whole workspace build on a machine that
 * has no toolchain, skip loudly and exit 0. CI installs Rust, so the bundle is
 * still built and verified there.
 */
import { spawnSync } from 'node:child_process';

const probe = spawnSync('cargo', ['--version'], { stdio: 'ignore', shell: true });

if (probe.status !== 0) {
  console.warn(
    '[desktop] Rust toolchain not found — skipping the Tauri bundle.\n' +
      '[desktop] Install it from https://rustup.rs to build the desktop app.',
  );
  process.exit(0);
}

const result = spawnSync('pnpm', ['exec', 'tauri', 'build'], {
  stdio: 'inherit',
  shell: true,
});
process.exit(result.status ?? 1);
