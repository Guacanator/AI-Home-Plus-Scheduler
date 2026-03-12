"use strict";

/**
 * runWeek.js
 * 
 * Drop this into server/ and wire it into index.js like this:
 * 
 *   const { runWeek } = require("./runWeek");
 *   app.post("/run-week", async (req, res) => {
 *     try {
 *       const { week_id, start_date, end_date, house } = req.body || {};
 *       if (!week_id || !start_date || !end_date) {
 *         return res.status(400).json({ error: "week_id, start_date, and end_date are required" });
 *       }
 *       const result = await runWeek({ week_id, start_date, end_date, house });
 *       return res.json(result);
 *     } catch (err) {
 *       console.error(err);
 *       return res.status(500).json({ error: err.message || "internal error" });
 *     }
 *   });
 */

const { AirtableClient } = require("./airtableClient");
const { schedule } = require("./scheduler");
const { postSchedule } = require("./zapierClient");
const { ZAPIER_ENABLED, ZAPIER_WEBHOOK_URL } = require("./config");

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Generate an array of YYYY-MM-DD strings for every day in [startDate, endDate] inclusive.
 */
function expandDateRange(startDate, endDate) {
  const dates = [];
  const cursor = new Date(startDate + "T00:00:00");
  const end = new Date(endDate + "T00:00:00");
  while (cursor <= end) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setDate(cursor.getDate() + 1);
  }
  return dates;
}

/**
 * Build a unique shift_id for a generated shift.
 * e.g. "CNA_DAY_07_19__2026-03-15"
 */
function makeShiftId(templateId, date) {
  return `${templateId}__${date}`;
}

/**
 * Read a field from either top-level or nested .fields (Airtable REST shape).
 */
function f(record, ...keys) {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null && record[key] !== "") return record[key];
    if (record.fields && record.fields[key] !== undefined && record.fields[key] !== null && record.fields[key] !== "") return record.fields[key];
  }
  return null;
}

// ─── Airtable helpers not yet on AirtableClient ─────────────────────────────

/**
 * Fetch all shift templates from the "Shift Templates" table.
 * Adds listShiftTemplates and createShifts to the client instance at runtime
 * so we don't have to modify airtableClient.js.
 */
function extendClient(client) {
  /**
   * List all shift templates.
   */
  client.listShiftTemplates = async function () {
    return this.list("Shift Templates", { pageSize: 100 });
  };

  /**
   * Create shift records in Airtable in batches of 10.
   * Each item in `shifts` should be a plain fields object.
   */
  client.createShifts = async function (shifts = []) {
    if (!shifts.length) return [];
    const chunks = [];
    for (let i = 0; i < shifts.length; i += 10) {
      chunks.push(shifts.slice(i, i + 10));
    }
    const results = [];
    for (const chunk of chunks) {
      const payload = {
        records: chunk.map((fields) => ({ fields })),
        typecast: true,
      };
      const data = await this.request(`/${encodeURIComponent(this.tables.shifts)}`, {
        method: "POST",
        body: payload,
      });
      results.push(...(data.records || []));
    }
    return results;
  };

  /**
   * Mark unfilled shifts (employeeId null) with status "Unfilled".
   */
  client.markUnfilled = async function (assignments = []) {
    const unfilled = assignments.filter((a) => !a.employeeId && a.shiftId);
    if (!unfilled.length) return [];
    const updates = unfilled.map((a) => ({
      id: a.shiftId,
      fields: { [this.shiftStatusField]: "Unfilled" },
    }));
    const chunks = [];
    for (let i = 0; i < updates.length; i += 10) chunks.push(updates.slice(i, i + 10));
    const results = [];
    for (const chunk of chunks) {
      const data = await this.request(`/${encodeURIComponent(this.tables.shifts)}`, {
        method: "PATCH",
        body: { records: chunk, typecast: true },
      });
      results.push(...(data.records || []));
    }
    return results;
  };

  return client;
}

// ─── Main ────────────────────────────────────────────────────────────────────

/**
 * runWeek({ week_id, start_date, end_date, house })
 *
 * house: optional — "House A", "House B", or omit for both.
 *
 * Returns a summary object with assignments, issues, and zapier status.
 */
async function runWeek({ week_id, start_date, end_date, house = null }) {
  const client = extendClient(new AirtableClient());

  console.log(`[runWeek] Starting week=${week_id} ${start_date} → ${end_date} house=${house || "ALL"}`);

  // ── 1. Fetch shift templates ───────────────────────────────────────────────
  const templateRecords = await client.listShiftTemplates();
  console.log(`[runWeek] Loaded ${templateRecords.length} shift templates`);

  // Filter by house if specified
  const filteredTemplates = house
    ? templateRecords.filter((r) => {
        const h = f(r, "house");
        // Include templates with no house (applies to all) or matching house
        return !h || h === house;
      })
    : templateRecords;

  // Skip "Nurse On Call" or any template missing a template_id
  const validTemplates = filteredTemplates.filter((r) => {
    const tid = f(r, "template_id");
    const role = f(r, "role");
    return tid && role && role !== "Nurse On Call";
  });

  console.log(`[runWeek] ${validTemplates.length} valid templates after filtering`);

  // ── 2. Expand templates into dated shift records ───────────────────────────
  const dates = expandDateRange(start_date, end_date);
  console.log(`[runWeek] Expanding across ${dates.length} days: ${dates[0]} → ${dates[dates.length - 1]}`);

  const shiftFieldsToCreate = [];
  for (const date of dates) {
    for (const tmpl of validTemplates) {
      const templateId = f(tmpl, "template_id");
      const role = f(tmpl, "role");
      const startHour = f(tmpl, "start_hour");
      const endHour = f(tmpl, "end_hour");
      const isRequired = f(tmpl, "is_required");
      const tmplHouse = f(tmpl, "house");

      shiftFieldsToCreate.push({
        shift_id: makeShiftId(templateId, date),
        date,
        role_needed: role,
        start_hour: startHour,
        end_hour: endHour,
        status: "Open",
        week: week_id,
        ...(tmplHouse ? { house: tmplHouse } : {}),
        ...(isRequired !== null ? { is_required: Boolean(isRequired) } : {}),
      });
    }
  }

  console.log(`[runWeek] Creating ${shiftFieldsToCreate.length} shift records in Airtable...`);
  const createdShifts = await client.createShifts(shiftFieldsToCreate);
  console.log(`[runWeek] Created ${createdShifts.length} shift records`);

  // Build shift objects for the scheduler (use created record IDs as shiftId)
  const shiftTemplate = createdShifts.map((record) => ({
    id: record.id, // Airtable record ID — used for upsertAssignments
    shift_id: record.id,
    fields: record.fields,
  }));

  // ── 3. Fetch employees and availability ───────────────────────────────────
  const [employeeRecords, availabilityRecords] = await Promise.all([
    client.listEmployees(),
    client.listAvailability({ start: start_date, end: end_date }),
  ]);

  console.log(`[runWeek] Employees: ${employeeRecords.length}, Availability records: ${availabilityRecords.length}`);

  // ── 4. Run the scheduler ──────────────────────────────────────────────────
  const result = schedule(shiftTemplate, employeeRecords, availabilityRecords, []);
  console.log(`[runWeek] Scheduler produced ${result.assignments.length} assignments, ${result.issues.length} issues`);

  // ── 5. Write filled assignments back to Airtable ─────────────────────────
  const filled = result.assignments.filter((a) => a.employeeId);
  if (filled.length) {
    await client.upsertAssignments(filled.map((a) => ({ ...a, status: "Assigned" })));
    console.log(`[runWeek] Wrote ${filled.length} filled assignments to Airtable`);
  }

  // Mark unfilled shifts
  const unfilled = result.assignments.filter((a) => !a.employeeId);
  if (unfilled.length) {
    await client.markUnfilled(unfilled);
    console.log(`[runWeek] Marked ${unfilled.length} shifts as Unfilled`);
  }

  // ── 6. Fire Zapier webhook ────────────────────────────────────────────────
  const zapierPayload = {
    week_id,
    start_date,
    end_date,
    house: house || "ALL",
    assignments: result.assignments,
    totalsByEmployee: result.totalsByEmployee,
    issues: result.issues,
    shift_template: shiftTemplate, // needed by Zapier code step
  };

  let zapierResult = null;
  if (ZAPIER_ENABLED && ZAPIER_WEBHOOK_URL) {
    try {
      zapierResult = await postSchedule(zapierPayload);
      console.log(`[runWeek] Zapier webhook fired: status=${zapierResult?.status}`);
    } catch (err) {
      console.error("[runWeek] Zapier webhook failed:", err.message);
      zapierResult = { ok: false, status: 0, text: err.message };
    }
  }

  // ── 7. Return summary ─────────────────────────────────────────────────────
  return {
    ok: true,
    week_id,
    start_date,
    end_date,
    house: house || "ALL",
    shifts_created: createdShifts.length,
    assignments_filled: filled.length,
    assignments_unfilled: unfilled.length,
    issues: result.issues,
    totalsByEmployee: result.totalsByEmployee,
    zapier: zapierResult
      ? { ok: Boolean(zapierResult.ok), status: zapierResult.status }
      : { ok: false, status: 0, reason: "Zapier disabled or not configured" },
  };
}

module.exports = { runWeek };
