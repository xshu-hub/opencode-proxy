import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { ApiError } from './protocol.mjs';

// Heartbeats never call progress(): downstream liveness is not upstream work.
export class RequestLifecycle {
  constructor(config, parent, catalogMs = 0) {
    this.config = config;
    this.id = randomUUID();
    this.started = performance.now();
    this.controller = new AbortController();
    this.signal = parent ? AbortSignal.any([parent, this.controller.signal]) : this.controller.signal;
    this.timings = { catalogMs };
    this.phase = 'startup';
    this.stage('startup');
    this.arm('startup', config.startupTimeoutMs);
    if (config.timeoutMs > 0) this.totalTimer = setTimeout(() => this.expire('total', config.timeoutMs), Math.max(0, config.timeoutMs - catalogMs));
  }
  stage(name) {
    this.phase = name;
    this.timings[name] ??= Math.round(performance.now() - this.started);
    return name;
  }
  expire(kind, limit) {
    if (this.signal.aborted) return;
    this.stop();
    this.timeoutKind = kind;
    this.controller.abort(new ApiError(`OpenCode ${kind} timeout after ${limit} ms during ${this.phase} (request ${this.id}).`, 504, null, 'opencode_timeout'));
  }
  arm(kind, limit) {
    clearTimeout(this.stageTimer);
    this.stageTimer = setTimeout(() => this.expire(kind, limit), limit);
  }
  inference() {
    this.stage('inference');
    this.arm('first_output', this.config.firstOutputTimeoutMs);
  }
  progress() {
    if (this.completed || this.signal.aborted) return;
    this.stage('firstModelEvent');
    this.phase = 'streaming';
    this.arm('idle', this.config.idleTimeoutMs);
  }
  clientOutput() { this.stage('firstClientChunk'); this.phase = this.completed ? 'completion' : 'streaming'; }
  complete() {
    this.completed = true;
    this.stage('completion');
    clearTimeout(this.stageTimer);
  }
  stop() { clearTimeout(this.stageTimer); clearTimeout(this.totalTimer); }
  report(extra = {}) {
    return { requestId: this.id, elapsedMs: Math.round(performance.now() - this.started) + this.timings.catalogMs, phase: this.phase, timings: this.timings, timeoutKind: this.timeoutKind, ...extra };
  }
}
