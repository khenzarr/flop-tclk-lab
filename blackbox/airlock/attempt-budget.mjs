// SPDX-License-Identifier: Apache-2.0
//
// PHASE 3A.10.4 — DURABLE ONE-SHOT ATTEMPT BUDGET.
//
// WHY THIS EXISTS. `MAX_REAL_SIGNATURES=1` in ./budget.mjs is a process-local permit book. A real
// operator run proved that scope is not the scope that matters: the Phase 3A4R4 command was
// executed twice in two separate process invocations, and each fresh process handed itself a fresh
// permit. Sanitized observation: local nonce 1, then local nonce 2. Both verified locally, neither
// was submitted. Classification: CROSS_PROCESS_REAL_SIGNATURE_BUDGET_BYPASS.
//
// THE PRIMITIVE. One irreversible transition, AVAILABLE -> SPENT, carried by the atomic exclusive
// creation of a marker file (O_CREAT|O_EXCL). Existence of the marker IS the SPENT state, so:
//
//   * there is no read-then-write window to lose a race in;
//   * a second process cannot acquire the same budget, because the kernel already refused it;
//   * a torn, truncated, malformed, or foreign marker still refuses — every non-ENOENT outcome is
//     SPENT, never AVAILABLE;
//   * a crash at any point after a successful create leaves the budget SPENT, because the create
//     happens before the irreversible operation and nothing ever removes it.
//
// THERE IS NO RELEASE, RESET, ROLLBACK, OR UNSPEND FUNCTION, AND THERE MUST NEVER BE ONE. An
// un-spend API would be precisely the bypass this module was written to close.
//
// The marker is non-secret operation metadata: purpose, operation class, subject identity, a
// timestamp, and a pid. No key, passphrase, signature, SignedOperation, credential, or preimage
// ever enters this state, and no field of it is an authorization. It is a spend record, not a
// permit: a marker cannot grant anything, it can only refuse.
//
// This module is deliberately dependency-free (node builtins only). Its refusal must not depend on
// the upstream pin clone, the canonical worktree, custody, or a signer being present.

import { createHash } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, statSync, writeSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ATTEMPT_BUDGET_SCHEMA = 'tclk-attempt-budget/v1';

/** A one-shot budget is exactly one attempt. This is not configurable. */
export const MAX_ONE_SHOT_ATTEMPTS = 1;

const BLACKBOX_ROOT = fileURLToPath(new URL('../', import.meta.url));

/**
 * The durable state root. A code constant, never argv, an environment variable, or a CLI flag:
 * a caller-selectable root in production would be a rename-your-way-out-of-the-budget bypass.
 * Tests pass an explicit fixture root under the OS temporary directory instead.
 *
 * It lives beside the code that reads it and is deliberately NOT inside the DPAPI custody root
 * (`%LOCALAPPDATA%\TechnocoreAgent`). This module never reads or writes protected custody state.
 */
export const BUDGET_ROOT = resolve(BLACKBOX_ROOT, 'state', 'attempt-budget');

/** Identity tokens are restricted so a budget identity can never traverse or escape the root. */
const IDENTITY_TOKEN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/;

export class AttemptBudgetRefused extends Error {
  constructor(message, code, budgetId, finding = null) {
    super(message);
    this.name = 'AttemptBudgetRefused';
    this.code = code;
    this.budgetId = budgetId;
    this.finding = finding;
  }
}

const sha256 = value => createHash('sha256').update(value, 'utf8').digest('hex');

function requireToken(name, value) {
  if (typeof value !== 'string' || !IDENTITY_TOKEN.test(value)) {
    throw new TypeError(`attempt-budget: ${name} must be a short token matching ${IDENTITY_TOKEN}`);
  }
  return value;
}

/**
 * A stable budget identity: what the budget is for, what class of operation it covers, and which
 * approved subject it is bound to. `subject` is the approved request fingerprint (or equivalent
 * request identity) where one exists; a null subject means the budget covers the operation class
 * as a whole. `|` and `=` cannot appear in a token, so this encoding is unambiguous.
 */
export function budgetIdentity({ purpose, operationClass, subject = null }) {
  const identity = Object.freeze({
    purpose: requireToken('purpose', purpose),
    operationClass: requireToken('operationClass', operationClass),
    subject: subject === null || subject === undefined ? null : requireToken('subject', subject),
  });
  return identity;
}

export function budgetId(identity) {
  const { purpose, operationClass, subject } = budgetIdentity(identity);
  return sha256(`TCLK::attempt-budget::v1|purpose=${purpose}|operationClass=${operationClass}|subject=${subject ?? 'NONE'}`);
}

const slug = token => token.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);

/** Read-only path derivation. Exposed for inspection and tests; it mutates nothing. */
export function oneShotAttemptPath(identity, { root = BUDGET_ROOT } = {}) {
  const id = budgetId(identity);
  return resolve(root, `${slug(budgetIdentity(identity).purpose)}-${id.slice(0, 32)}.spent.json`);
}

function spent(id, path, finding, acquiredAt = null) {
  return Object.freeze({ state: 'SPENT', available: false, budgetId: id, path, finding, acquiredAt });
}

/**
 * Read the durable state. ADVISORY ONLY.
 *
 * A caller must never gate an irreversible operation on this function: between an AVAILABLE read
 * and the operation there is a window, and closing that window is the whole point of
 * `acquireOneShotAttempt`, which is the only safe gate. This exists for preflight display,
 * evidence, and tests.
 *
 * Documented initialization semantics: a missing marker (and a missing root) is AVAILABLE. Every
 * other outcome — present, truncated, malformed, foreign, unreadable, or not a regular file — is
 * SPENT. Absence is the only open state.
 */
export function inspectOneShotAttempt(identity, { root = BUDGET_ROOT } = {}) {
  const id = budgetId(identity);
  const path = oneShotAttemptPath(identity, { root });
  let stat;
  try {
    stat = statSync(path);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return Object.freeze({ state: 'AVAILABLE', available: true, budgetId: id, path, finding: null, acquiredAt: null });
    }
    // Anything else (EACCES, EPERM, ENOTDIR, EIO) is an unreadable state, so it fails closed.
    return spent(id, path, 'SPENT_STATE_UNREADABLE');
  }
  if (!stat.isFile()) return spent(id, path, 'SPENT_STATE_NOT_A_FILE');
  if (stat.size === 0) return spent(id, path, 'SPENT_STATE_TRUNCATED');
  let record;
  try {
    record = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return spent(id, path, 'SPENT_STATE_UNREADABLE');
  }
  if (!record || typeof record !== 'object' || Array.isArray(record)) return spent(id, path, 'SPENT_STATE_MALFORMED');
  if (record.schema !== ATTEMPT_BUDGET_SCHEMA) return spent(id, path, 'SPENT_STATE_SCHEMA_MISMATCH');
  if (record.budgetId !== id) return spent(id, path, 'SPENT_STATE_IDENTITY_MISMATCH');
  if (record.state !== 'SPENT') return spent(id, path, 'SPENT_STATE_MALFORMED');
  return spent(id, path, null, typeof record.acquiredAt === 'string' ? record.acquiredAt : null);
}

/**
 * Take the one-shot budget, durably, for the whole machine.
 *
 * CALL THIS IMMEDIATELY BEFORE THE IRREVERSIBLE BOUNDARY AND NEVER AFTER IT. An operation that
 * fails after the boundary has still happened; spending on success would license unlimited retries,
 * which is the failure mode of the process-local budget this replaces.
 *
 * Throws on refusal rather than returning false, because a caller that ignored a boolean would
 * perform the irreversible operation twice, and this is the one guard that must not be ignorable.
 *
 * Crash semantics, exactly:
 *   * crash before the exclusive create      -> AVAILABLE (nothing irreversible happened either);
 *   * crash after the create, before write    -> SPENT (zero-length marker, SPENT_STATE_TRUNCATED);
 *   * crash after the create, mid-write       -> SPENT (partial marker, SPENT_STATE_UNREADABLE);
 *   * crash after the irreversible operation  -> SPENT.
 * The marker is created and fsynced before the operation, and no code path removes it, so a
 * killed, aborted, or power-lost process can never present the budget as AVAILABLE again.
 * Durability is against process restart and crash. It is not a defence against an operator who
 * deliberately deletes local state; that is a visible human act, and any operation whose closure
 * must survive it is closed in source instead (see PHASE3A4R4_CLOSURE in ./budget.mjs).
 */
export function acquireOneShotAttempt(identity, { root = BUDGET_ROOT } = {}) {
  const { purpose, operationClass, subject } = budgetIdentity(identity);
  const id = budgetId(identity);
  const path = oneShotAttemptPath(identity, { root });
  try {
    mkdirSync(root, { recursive: true });
  } catch (error) {
    throw new AttemptBudgetRefused(
      `ATTEMPT_BUDGET_REFUSED: durable budget state root is unusable (${error.code ?? 'UNKNOWN'})`,
      'ONE_SHOT_BUDGET_STATE_UNUSABLE', id, 'STATE_ROOT_UNUSABLE',
    );
  }

  let fd;
  try {
    // The atomic transition. O_CREAT|O_EXCL: exactly one caller on this machine can win, whether
    // the loser is a loop in this process, a second invocation, or a simultaneous double-launch.
    fd = openSync(path, 'wx', 0o600);
  } catch (error) {
    if (error.code === 'EEXIST' || error.code === 'EISDIR' || error.code === 'EPERM' || error.code === 'EACCES') {
      const finding = inspectOneShotAttempt(identity, { root }).finding;
      throw new AttemptBudgetRefused(
        `ATTEMPT_BUDGET_REFUSED: REAL_EXECUTION_BUDGET_EXHAUSTED — the one-shot budget for `
        + `${purpose}/${operationClass} is already SPENT${finding ? ` (${finding})` : ''}. `
        + 'It is never rolled back; a further attempt needs a new, separately reviewed operation identity.',
        'ONE_SHOT_BUDGET_SPENT', id, finding,
      );
    }
    throw new AttemptBudgetRefused(
      `ATTEMPT_BUDGET_REFUSED: durable budget state is unusable (${error.code ?? 'UNKNOWN'})`,
      'ONE_SHOT_BUDGET_STATE_UNUSABLE', id, 'STATE_UNUSABLE',
    );
  }

  // The budget is ALREADY SPENT at this point. Everything below is record-keeping: a failure here
  // must not, and does not, hand the budget back.
  const acquiredAt = new Date().toISOString();
  const record = {
    schema: ATTEMPT_BUDGET_SCHEMA,
    state: 'SPENT',
    budgetId: id,
    purpose,
    operationClass,
    subject,
    acquiredAt,
    pid: process.pid,
    contains: 'NO_SECRET_MATERIAL',
    note: 'Existence of this file means the one-shot budget is SPENT. Nothing rolls it back.',
  };
  try {
    writeSync(fd, `${JSON.stringify(record, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    try { closeSync(fd); } catch { /* the marker exists; a close failure cannot un-spend it */ }
  }
  return Object.freeze({
    acquired: true, budgetId: id, path, purpose, operationClass, subject, acquiredAt,
    of: MAX_ONE_SHOT_ATTEMPTS,
  });
}
