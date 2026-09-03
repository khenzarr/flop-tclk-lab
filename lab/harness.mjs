// SPDX-License-Identifier: Apache-2.0
//
// A deliberately tiny recorder. No test framework, no dependencies: the lab's only job is
// to call upstream and write down exactly what happened, including what it refuses to
// persist. Every secret the rehearsal generates is registered here, and the serializer
// drops it — by key name and by value — before anything reaches evidence/.

import assert from "node:assert/strict";

const DENY_KEYS = new Set([
  "secret",
  "preimage",
  "witness",
  "secretKey",
  "privateKey",
  "seed",
  "share",
  "shares",
  "sig",
  "signature",
  "s",
]);

export const REDACTED = "[REDACTED]";

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export class Recorder {
  #secrets = new Set();
  #sections = new Map();

  passed = 0;
  failed = 0;
  observations = 0;

  /** Register a value that must never be written to evidence or stdout. */
  secret(value) {
    if (typeof value === "string" && value.length >= 8) this.#secrets.add(value.toLowerCase());
    return value;
  }

  get secretsRegistered() {
    return this.#secrets.size;
  }

  containsSecret(text) {
    if (typeof text !== "string") return false;
    const low = text.toLowerCase();
    for (const s of this.#secrets) if (low.includes(s)) return true;
    return false;
  }

  /** Recursively strip secret-bearing keys and secret-bearing values. */
  redact(value) {
    if (typeof value === "string") return this.containsSecret(value) ? REDACTED : value;
    if (Array.isArray(value)) return value.map((v) => this.redact(v));
    if (value && typeof value === "object") {
      const out = {};
      for (const [k, v] of Object.entries(value)) {
        out[k] = DENY_KEYS.has(k) ? REDACTED : this.redact(v);
      }
      return out;
    }
    return value;
  }

  #section(id, title) {
    if (!this.#sections.has(id)) this.#sections.set(id, { id, title: title ?? id, cases: [] });
    const section = this.#sections.get(id);
    if (title) section.title = title;
    return section;
  }

  /** Bind a section so case bodies stay uncluttered. */
  section(id, title) {
    this.#section(id, title);
    return {
      case: (name, fn) => this.case(id, name, fn),
      observation: (name, detail) => this.observation(id, name, detail),
    };
  }

  async case(sectionId, name, fn) {
    const section = this.#section(sectionId);
    try {
      const detail = await fn();
      const entry = { name, status: "pass" };
      if (detail !== undefined) entry.detail = this.redact(detail);
      section.cases.push(entry);
      this.passed += 1;
      console.log(`  PASS  ${name}`);
      return detail;
    } catch (error) {
      this.failed += 1;
      const raw = error instanceof Error ? error.message : String(error);
      const message = this.containsSecret(raw) ? REDACTED : raw.split("\n")[0].slice(0, 400);
      section.cases.push({ name, status: "fail", error: message });
      console.log(`  FAIL  ${name} — ${message}`);
      return undefined;
    }
  }

  /**
   * A recorded fact about current upstream behaviour that is neither a pass nor a failure:
   * something the lab noticed and wants to carry into the contribution audit.
   */
  observation(sectionId, name, detail) {
    const section = this.#section(sectionId);
    section.cases.push({ name, status: "observed", detail: this.redact(detail) });
    this.observations += 1;
    console.log(`  OBS   ${name}`);
  }

  sections() {
    return [...this.#sections.values()];
  }

  summary() {
    const sections = {};
    for (const section of this.#sections.values()) {
      sections[section.id] = {
        total: section.cases.length,
        passed: section.cases.filter((c) => c.status === "pass").length,
        failed: section.cases.filter((c) => c.status === "fail").length,
        observations: section.cases.filter((c) => c.status === "observed").length,
      };
    }
    return {
      cases: this.passed + this.failed,
      passed: this.passed,
      failed: this.failed,
      observations: this.observations,
      sections,
    };
  }
}

/**
 * The fail-closed double check every negative case in this lab must satisfy:
 * the result says "no", AND the contract state did not move.
 */
export function rejects(tclk, state, frame, nowMs) {
  const before = JSON.stringify(state);
  const result = tclk.applyFrame(state, frame, nowMs);
  assert.equal(result.ok, false, "expected applyFrame to reject this frame");
  assert.equal(typeof result.reason, "string", "a rejection must carry a reason");
  assert.ok(result.reason.length > 0, "a rejection reason must not be empty");
  assert.equal(JSON.stringify(result.state), before, "state must be byte-identical after a rejection");
  assert.equal(result.state, state, "a rejection must hand back the same state object");
  return {
    ok: false,
    reason: result.reason,
    statusBefore: JSON.parse(before).status,
    statusAfter: result.state.status,
    stateUnchanged: true,
    sameStateObject: true,
  };
}

/** A permitted transition: records the resulting status and hands the new state back. */
export function accepts(tclk, state, frame, nowMs, expectedStatus) {
  const result = tclk.applyFrame(state, frame, nowMs);
  assert.equal(result.ok, true, `expected applyFrame to accept ${frame.type}: ${result.reason ?? ""}`);
  assert.equal(result.state.status, expectedStatus, `expected status ${expectedStatus}`);
  return result.state;
}

export function throwsWith(fn, fragment) {
  try {
    fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert.match(message, new RegExp(escapeRegExp(fragment)), `throw did not mention "${fragment}"`);
    return { threw: true, message };
  }
  assert.fail(`expected a throw mentioning "${fragment}"`);
}

export async function rejectsAsync(fn, fragment) {
  try {
    await fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert.match(message, new RegExp(escapeRegExp(fragment)), `rejection did not mention "${fragment}"`);
    return { rejected: true, message };
  }
  assert.fail(`expected a rejected promise mentioning "${fragment}"`);
}
