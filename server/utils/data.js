"use strict";

const { combineDateTime, hoursBetween, normalizeRange, toDate } = require("./time");

const DEFAULT_WEEKLY_CAP = 40;

function readField(record, keys) {
  for (const key of keys) {
    if (record && Object.prototype.hasOwnProperty.call(record, key)) return record[key];
  }
  const fields = record && record.fields;
  if (!fields) return undefined;
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(fields, key)) return fields[key];
  }
  return undefined;
}

function normalizeEmployees(records = []) {
  const map = new Map();
  records.forEach((record) => {
    const id = readField(record, ["id", "employee_id", "employeeId"]);
    if (!id) return;

    const role = String(readField(record, ["role"]) || "").trim().toUpperCase();
    const status = String(readField(record, ["status"]) || "Active").trim().toLowerCase();
    const weeklyCapRaw = readField(record, ["weekly_cap", "weeklyCap", "Weekly Cap"]);
    const weeklyCapNumber = Number.parseFloat(weeklyCapRaw);

    map.set(id, {
      id,
      name: readField(record, ["name", "Name"]) || "",
      role,
      status,
      weeklyCap:
        Number.isFinite(weeklyCapNumber) && weeklyCapNumber > 0
          ? weeklyCapNumber
          : DEFAULT_WEEKLY_CAP,
    });
  });
  return map;
}

function normalizeAvailability(records = []) {
  const availability = new Map();

  records.forEach((record) => {
    const fields = record && record.fields ? record.fields : record;

    const employeeField = readField(fields, [
      "employee_id",
      "employee",
      "Employee",
      "employees",
      "Employee ID",
    ]);

    const employeeIds = Array.isArray(employeeField)
      ? employeeField.filter(Boolean)
      : employeeField
      ? [employeeField]
      : [];

    if (employeeIds.length === 0) return;

    const typeRaw = readField(fields, ["type", "Type"]) || "Available";
    const type = String(typeRaw).trim().toLowerCase();
    if (type === "unavailable") return;

    const dateValue = readField(fields, ["date", "Date"]);
    const startValue = readField(fields, ["start_time", "start", "Start"]);
    const endValue = readField(fields, ["end_time", "end", "End"]);

    const start = combineDateTime(dateValue, startValue);
    const end = combineDateTime(dateValue, endValue);
    const range = normalizeRange(start, end);
    if (!range.start || !range.end) return;

    employeeIds.forEach((employeeId) => {
      if (!availability.has(employeeId)) availability.set(employeeId, []);
      availability.get(employeeId).push({
        start: range.start,
        end: range.end,
        preferred: type === "preferred",
        recordId: record.id || record.availability_id || record.availabilityId,
      });
    });
  });

  return availability;
}

function normalizeShiftRecords(records = []) {
  return records
    .map((record) => {
      const fields = record && record.fields ? record.fields : record;
      const id = readField(record, ["id", "shift_id", "Shift Id", "shiftId"]);
      if (!id) return null;

      const roleRaw = readField(fields, ["role_needed", "role", "Role"]);
      // Normalize; treat "Either" as no specific requirement
      let roleNeeded = String(roleRaw || "Either").trim().toUpperCase();
      if (roleNeeded === "EITHER") roleNeeded = "";

      const dateValue = readField(fields, ["date", "Date"]);
      const startValue = readField(fields, ["start_time", "start", "Start"]);
      const endValue = readField(fields, ["end_time", "end", "End"]);

      const start = combineDateTime(dateValue, startValue);
      const end = combineDateTime(dateValue, endValue);
      const range = normalizeRange(start, end);

      return {
        id,
        roleNeeded,
        start: range.start,
        end: range.end,
        hours: hoursBetween(range.start, range.end),
        fields,
      };
    })
    .filter(Boolean);
}

// role matcher used by scheduler and validator
function roleMatches(empRole, roleNeeded) {
  const e = String(empRole || "").trim().toUpperCase();
  const r = String(roleNeeded || "").trim().toUpperCase();
  if (!r) return true;                    // no requirement ⇒ any role ok
  if (e === r) return true;               // exact match
  if (r === "CNA_OR_CMA") return e === "CNA" || e === "CMA"; // either role ok
  return false;
}

function normalizeAssignments(records = []) {
  const map = new Map();
  if (Array.isArray(records)) {
    records.forEach((record) => {
      const shiftId = readField(record, ["shift_id", "shiftId", "id"]);
      const employeeId = readField(record, ["employee_id", "employeeId", "assigned_employee"]);
      if (shiftId && employeeId) map.set(shiftId, employeeId);
    });
    return map;
  }
  if (records && typeof records === "object") {
    Object.entries(records).forEach(([shiftId, employeeId]) => {
      if (shiftId && employeeId) map.set(shiftId, employeeId);
    });
  }
  return map;
}

function buildDateFilter(fieldName, range = {}) {
  const clauses = [];
  if (range.start) {
    const start = toDate(range.start);
    if (start) {
      const iso = start.toISOString().slice(0, 10);
      clauses.push(`IS_AFTER({${fieldName}}, DATEADD('${iso}', -1, 'day'))`);
    }
  }
  if (range.end) {
    const end = toDate(range.end);
    if (end) {
      const iso = end.toISOString().slice(0, 10);
      clauses.push(`IS_BEFORE({${fieldName}}, DATEADD('${iso}', 1, 'day'))`);
    }
  }
  if (clauses.length === 0) return undefined;
  if (clauses.length === 1) return clauses[0];
  return `AND(${clauses.join(", ")})`;
}

module.exports = {
  DEFAULT_WEEKLY_CAP,
  normalizeEmployees,
  normalizeAvailability,
  normalizeShiftRecords,
  normalizeAssignments,
  roleMatches,
  buildDateFilter,
};
