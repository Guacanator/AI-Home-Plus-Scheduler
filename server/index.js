"use strict";

const http = require("http");
const { randomUUID } = require("crypto");
const express = require("./express");
const { z } = require("./zod");
const logger = require("./logger");
const { schedule } = require("./scheduler");
const { validate } = require("./validator");
const { ZAPIER_ENABLED, ZAPIER_WEBHOOK_URL } = require("./config");
const { postSchedule } = require("./zapierClient");
const { ScheduleRequest } = require("./schemas");

const PORT = Number.parseInt(process.env.PORT || "3000", 10);
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN ? process.env.ALLOW_ORIGIN.trim() : "";

const stringOrDate = z.union([z.string(), z.date()]);
const nullableStringOrDate = z.union([stringOrDate, z.null()]).optional();

const baseRecordSchema = z
  .object({ id: z.string().min(1).optional(), fields: z.record(z.any()).optional() })
  .passthrough();

const employeeRecordSchema = baseRecordSchema
  .extend({ employee_id: z.string().min(1).optional(), employeeId: z.string().min(1).optional() })
  .passthrough()
  .refine((v) => {
    if (v.id && v.id.trim()) return true;
    if (typeof v.employee_id === "string" && v.employee_id.trim()) return true;
    if (typeof v.employeeId === "string" && v.employeeId.trim()) return true;
    const f = v.fields || {};
    return Boolean(
      (typeof f.employee_id === "string" && f.employee_id.trim()) ||
        (typeof f.employeeId === "string" && f.employeeId.trim()) ||
        (typeof f.id === "string" && f.id.trim()),
    );
  }, { message: "Employee record requires an id", path: ["id"] });

const availabilityRecordSchema = baseRecordSchema
  .extend({
    availability_id: z.string().min(1).optional(),
    availabilityId: z.string().min(1).optional(),
    employee_id: z.union([z.string(), z.array(z.string())]).optional(),
    employeeId: z.union([z.string(), z.array(z.string())]).optional(),
    employee: z.union([z.string(), z.array(z.string())]).optional(),
  })
  .passthrough();

const shiftRecordSchema = baseRecordSchema
  .extend({
    shift_id: z.string().min(1).optional(),
    shiftId: z.string().min(1).optional(),
    date: nullableStringOrDate,
    role_needed: z.union([z.string(), z.null()]).optional(),
    start_time: nullableStringOrDate,
    end_time: nullableStringOrDate,
    assigned_employee: z.union([z.string(), z.null()]).optional(),
  })
  .passthrough()
  .refine((v) => {
    if (v.id && v.id.trim()) return true;
    if (typeof v.shift_id === "string" && v.shift_id.trim()) return true;
    if (typeof v.shiftId === "string" && v.shiftId.trim()) return true;
    const f = v.fields || {};
    return Boolean(
      (typeof f.shift_id === "string" && f.shift_id.trim()) ||
        (typeof f.shiftId === "string" && f.shiftId.trim()) ||
        (typeof f.id === "string" && f.id.trim()),
    );
  }, { message: "Shift record requires an id", path: ["shift_id"] });

const assignmentRecordSchema = baseRecordSchema
  .extend({
    shift_id: z.union([z.string().min(1), z.null()]).optional(),
    shiftId: z.union([z.string().min(1), z.null()]).optional(),
    employee_id: z.union([z.string().min(1), z.null()]).optional(),
    employeeId: z.union([z.string().min(1), z.null()]).optional(),
    assigned_employee: z.union([z.string().min(1), z.null()]).optional(),
  })
  .passthrough();

const scheduleRequestSchema = ScheduleRequest.extend({
  shift_template: z.array(shiftRecordSchema).default([]),
  employees: z.array(employeeRecordSchema).default([]),
  availability: z.array(availabilityRecordSchema).default([]),
  existing_assignments: z.union([z.array(assignmentRecordSchema), z.record(z.string())]).optional(),
}).passthrough();

function createApp() {
  const app = express();

  app.use(express.json({ limit: "1mb" }));

  app.use((req, res, next) => {
    if (ALLOW_ORIGIN) {
      res.setHeader("Access-Control-Allow-Origin", ALLOW_ORIGIN);
      res.setHeader("Vary", "Origin");
    }
    next();
  });

  app.use((req, _res, next) => {
    const requestId = randomUUID();
    req.requestId = requestId;
    req.logger = logger.child ? logger.child({ requestId }) : logger;
    next();
  });

  app.options("/generate-schedule", (req, res) => {
    if (!ALLOW_ORIGIN) return res.status(403).send("");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Max-Age", "600");
    res.status(204).send("");
  });

  app.get("/health", (_req, res) => res.json({ ok: true }));
  app.get("/", (_req, res) => res.send("Server online"));

  app.post("/generate-schedule", async (req, res) => {
    const requestId = req.requestId || randomUUID();
    const requestLogger = req.logger || logger;

    try {
      const payload = req.body || {};
      const parsed = scheduleRequestSchema.parse(payload);

      const weekId = parsed.week_id;
      const startDate = parsed.start_date;
      const endDate = parsed.end_date;
      const forcePost = req.query && req.query.force === "1";

      const shiftTemplate = parsed.shift_template;
      const employees = parsed.employees;
      const availability = parsed.availability;
      const existingAssignments = parsed.existing_assignments || [];

      const result = schedule(shiftTemplate, employees, availability, existingAssignments);
      const validationErrors = validate(result.assignments, shiftTemplate, employees, availability);

      const combinedIssues = [
        ...result.issues,
        ...validationErrors.map((e) => ({
          shiftId: e.shiftId,
          employeeId: e.employeeId,
          reason: e.message,
          type: e.type,
        })),
      ];

      const zapierPayload = {
        week_id: weekId,
        start_date: startDate,
        end_date: endDate,
        assignments: result.assignments,
        totalsByEmployee: result.totalsByEmployee,
        issues: combinedIssues,
      };

      let zapierResult = null;
      if (ZAPIER_ENABLED && ZAPIER_WEBHOOK_URL) {
        try {
          zapierResult = await postSchedule(zapierPayload, { force: forcePost });
        } catch (err) {
          const message = err && err.message ? err.message : String(err);
          console.error("Zapier webhook threw", JSON.stringify({ message }));
          zapierResult = { ok: false, status: 0, text: message };
        }
      }

      const responseZapier = zapierResult
        ? {
            ok: Boolean(zapierResult.ok),
            status: zapierResult.status,
            ...(zapierResult.text && !zapierResult.ok ? { text: zapierResult.text } : {}),
          }
        : { ok: false, status: 0 };

      requestLogger.info(
        {
          requestId,
          status: 200,
          weekId,
          startDate,
          endDate,
          shiftCount: shiftTemplate.length,
          assignmentCount: result.assignments.length,
          issueCount: combinedIssues.length,
          validationErrorCount: validationErrors.length,
          forcePost,
          zapier: responseZapier,
        },
        "Generated schedule",
      );

      res.status(200).json({
        success: true,
        week_id: weekId,
        start_date: startDate,
        end_date: endDate,
        assignments: result.assignments,
        totalsByEmployee: result.totalsByEmployee,
        issues: combinedIssues,
        zapier: responseZapier,
      });
    } catch (error) {
      const reqId = (req && req.requestId) || randomUUID();
      const requestLogger2 = (req && req.logger) || logger;
      const isZodError = error && Array.isArray(error.issues);

      if (isZodError) {
        requestLogger2.error(
          {
            requestId: reqId,
            status: 400,
            error: "Invalid schedule request payload.",
            validationErrors: error.issues.map((i) => ({
              path: i.path.join("."),
              message: i.message,
            })),
          },
          "Failed to generate schedule",
        );
        return res.status(400).json({
          error: "Invalid schedule request payload.",
          details: error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        });
      }

      requestLogger2.error(
        {
          requestId: reqId,
          status: 500,
          error: error && error.message ? error.message : "Unable to process request.",
          stack: error && error.stack ? error.stack : undefined,
        },
        "Failed to generate schedule",
      );
      res.status(500).json({ error: "Unable to process request." });
    }
  });

  app.use((err, req, res, _next) => {
    const status = err && Number.isFinite(err.statusCode) ? err.statusCode : 500;
    const message = err && err.message ? err.message : "Unexpected error";
    const reqId = (req && req.requestId) || randomUUID();
    const requestLogger3 = (req && req.logger) || logger;

    if (status >= 500) {
      requestLogger3.error({ requestId: reqId, status, error: message }, "Unhandled error");
      return res.status(500).json({ error: "Unable to process request." });
    }
    res.status(status).json({ error: message });
  });

  app.use((_req, res) => res.status(404).json({ error: "Not Found" }));

  return app;
}

function createServer() {
  const app = createApp();
  return http.createServer(app);
}

if (require.main === module) {
  const app = createApp();
  app.listen(PORT, () => {
    logger.info({ port: PORT }, "Scheduler server listening");
  });
}

module.exports = { createServer, createApp };
