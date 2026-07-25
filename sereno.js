// Sereno — Structured JSON logging for stdout
//
// Emits single-line JSON logs compliant with the Sereno data contract.
// W3C Trace Context propagation without heavy OpenTelemetry SDKs.
//
//   import { tracer, LogLevel } from "./sereno.js";
//   tracer.emit(LogLevel.Info, "request received", { action_type: "lifecycle" });

import { randomBytes } from "node:crypto";

function newTraceId() {
  return randomBytes(16).toString("hex");
}

function newSpanId() {
  return randomBytes(8).toString("hex");
}

export const LogLevel = Object.freeze({
  Debug: "debug",
  Info: "info",
  Warn: "warn",
  Error: "error",
  Fatal: "fatal",
});

export class Tracer {
  constructor(app, agentRole, traceId, spanId, parentSpanId = null) {
    this.app = app;
    this.agentRole = agentRole;
    this.traceId = traceId;
    this.spanId = spanId;
    this.parentSpanId = parentSpanId;
  }

  static root(app, agentRole) {
    return new Tracer(app, agentRole, newTraceId(), newSpanId(), null);
  }

  static fromTraceparent(app, agentRole, traceparent) {
    const parts = traceparent.split("-");
    if (parts.length !== 4) return null;
    return new Tracer(app, agentRole, parts[1], newSpanId(), parts[2]);
  }

  traceparent() {
    const parent = this.parentSpanId ?? "0000000000000000";
    return `00-${this.traceId}-${parent}-01`;
  }

  emit(level, message, fields = {}) {
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      app: this.app,
      agent_role: this.agentRole,
      trace_id: this.traceId,
      span_id: this.spanId,
      message,
    };
    if (this.parentSpanId) entry.parent_span_id = this.parentSpanId;

    if (fields.action_type) {
      entry.action = { type: fields.action_type };
      if (fields.action_name) entry.action.name = fields.action_name;
    }
    if (fields.latency_ms != null) entry.latency_ms = fields.latency_ms;

    if (fields.action_type === "llm_inference" || fields.tokens_prompt != null) {
      const prompt = fields.tokens_prompt ?? 0;
      const completion = fields.tokens_completion ?? 0;
      entry.llm_metrics = {
        tokens_prompt: prompt,
        tokens_completion: completion,
        tokens_total: fields.tokens_total ?? prompt + completion,
      };
      if (fields.model) entry.llm_metrics.model = fields.model;
      if (fields.cost_usd != null) entry.llm_metrics.cost_usd = fields.cost_usd;
    }

    if (fields.tool_args != null) entry.tool_args = fields.tool_args;
    if (fields.error != null) entry.error = fields.error;
    if (fields.user_id != null) entry.user_id = fields.user_id;
    if (fields.session_id != null) entry.session_id = fields.session_id;
    if (fields.tenant != null) entry.namespace = fields.tenant;

    if (fields.extra && typeof fields.extra === "object") {
      Object.assign(entry, fields.extra);
    }

    process.stdout.write(JSON.stringify(entry) + "\n");
  }
}
