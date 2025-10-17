"use strict";

// role helpers
const norm = (s) => String(s || "").trim().toUpperCase();
const accepts = (empRole, roleNeeded) => {
  const e = norm(empRole);
  const r = norm(roleNeeded);
  if (e === r) return true;
  if (r === "CNA_OR_CMA") return e === "CNA" || e === "CMA";
  return false;
};

const {
  normalizeEmployees,
  normalizeAvailability,
  normalizeShiftRecords,
  normalizeAssignments,
} = require("./utils/data");
const { overlaps } = require("./utils/time");

function summarizeTotals(employeeMap, totals, blocks) {
  const summary = {};
  for (const [id, employee] of employeeMap.entries()) {
    summary[id] = {
      employeeId: id,
      name: employee.name,
      role: employee.role,
      weeklyCap: employee.weeklyCap,
      hours: Number((totals.get(id) || 0).toFixed(2)),
      assignments: (blocks.get(id) || []).length,
    };
  }
  return summary;
}

function coverageForShift(windows = [], shiftStart, shiftEnd) {
  if (!shiftStart || !shiftEnd) return { available: false, preferred: false };

  let hasCoverage = false;
  let hasPreferred = false;

  windows.forEach((window) => {
    if (!window.start || !window.end) return;

    const start = window.start.getTime();
    const end = window.end.getTime();
    const shiftStartMs = shiftStart.getTime();
    let shiftEndMs = shiftEnd.getTime();
    if (shiftEndMs <= shiftStartMs) shiftEndMs += 24 * 60 * 60 * 1000;

    if (start <= shiftStartMs && end >= shiftEndMs) {
      hasCoverage = true;
      if (window.preferred) hasPreferred = true;
    }
  });

  return { available: hasCoverage, preferred: hasPreferred };
}

function schedule(
  shiftTemplate = [],
  employees = [],
  availability = [],
  existingAssignments = []
) {
  const employeeMap = normalizeEmployees(employees);
  const availabilityMap = normalizeAvailability(availability);
  const shifts = normalizeShiftRecords(shiftTemplate);
  const existing = normalizeAssignments(existingAssignments);

  const assignments = [];
  const issues = [];
  const totals = new Map();
  const blocks = new Map();

  function trackAssignment(employeeId, shift) {
    const hours = shift.hours || 0;
    totals.set(employeeId, (totals.get(employeeId) || 0) + hours);
    if (!blocks.has(employeeId)) blocks.set(employeeId, []);
    blocks.get(employeeId).push({ start: shift.start, end: shift.end, shiftId: shift.id });
  }

  shifts.forEach((shift) => {
    const existingEmployeeId = existing.get(shift.id);
    const shiftHours = shift.hours || 0;

    if (!shift.start || !shift.end) {
      const reason = "Shift is missing start or end time.";
      assignments.push({ shiftId: shift.id, employeeId: null, reason });
      issues.push({ shiftId: shift.id, reason });
      return;
    }

    // Normalize needed role once
    const needed = norm(shift.roleNeeded || shift.role_needed || "");

    if (existingEmployeeId) {
      const employee = employeeMap.get(existingEmployeeId);
      const coverage = availabilityMap.get(existingEmployeeId) || [];
      const coverageResult = coverageForShift(coverage, shift.start, shift.end);
      const currentHours = totals.get(existingEmployeeId) || 0;

      const canAssign =
        employee &&
        employee.status === "active" &&
        accepts(employee.role, needed) &&
        coverageResult.available &&
        currentHours + shiftHours <= employee.weeklyCap &&
        !overlaps(blocks.get(existingEmployeeId), shift.start, shift.end);

      if (canAssign) {
        assignments.push({ shiftId: shift.id, employeeId: existingEmployeeId });
        trackAssignment(existingEmployeeId, shift);
        return;
      }

      issues.push({
        shiftId: shift.id,
        employeeId: existingEmployeeId,
        reason: "Existing assignment violates scheduling rules and was released.",
      });
    }

    const activeEmployees = Array.from(employeeMap.values()).filter(
      (employee) => employee.status === "active" && accepts(employee.role, needed)
    );

    if (activeEmployees.length === 0) {
      const reason = `No employees available for role ${needed || "Either"}.`;
      assignments.push({ shiftId: shift.id, employeeId: null, reason });
      issues.push({ shiftId: shift.id, reason });
      return;
    }

    const availabilityCandidates = activeEmployees
      .map((employee) => ({
        employee,
        coverage: coverageForShift(availabilityMap.get(employee.id) || [], shift.start, shift.end),
      }))
      .filter((entry) => entry.coverage.available);

    if (availabilityCandidates.length === 0) {
      const reason = "No employees are available during the shift window.";
      assignments.push({ shiftId: shift.id, employeeId: null, reason });
      issues.push({ shiftId: shift.id, reason });
      return;
    }

    const withinCap = availabilityCandidates.filter((entry) => {
      const hoursSoFar = totals.get(entry.employee.id) || 0;
      return hoursSoFar + shiftHours <= entry.employee.weeklyCap;
    });

    if (withinCap.length === 0) {
      const reason = "All available employees would exceed their weekly cap.";
      assignments.push({ shiftId: shift.id, employeeId: null, reason });
      issues.push({ shiftId: shift.id, reason });
      return;
    }

    const withoutConflicts = withinCap.filter((entry) => {
      const employeeBlocks = blocks.get(entry.employee.id) || [];
      return !overlaps(employeeBlocks, shift.start, shift.end);
    });

    if (withoutConflicts.length === 0) {
      const reason = "All available employees have conflicting assignments.";
      assignments.push({ shiftId: shift.id, employeeId: null, reason });
      issues.push({ shiftId: shift.id, reason });
      return;
    }

    // tie-break: preferred coverage, then lowest hours, then fewest assignments, then name
    withoutConflicts.sort((a, b) => {
      if (a.coverage.preferred !== b.coverage.preferred) return a.coverage.preferred ? -1 : 1;
      const hoursA = totals.get(a.employee.id) || 0;
      const hoursB = totals.get(b.employee.id) || 0;
      if (hoursA !== hoursB) return hoursA - hoursB;
      const assignsA = (blocks.get(a.employee.id) || []).length;
      const assignsB = (blocks.get(b.employee.id) || []).length;
      if (assignsA !== assignsB) return assignsA - assignsB;
      return (a.employee.name || "").localeCompare(b.employee.name || "");
    });

    const chosen = withoutConflicts[0].employee;
    assignments.push({ shiftId: shift.id, employeeId: chosen.id });
    trackAssignment(chosen.id, shift);
  });

  return {
    assignments,
    issues,
    totalsByEmployee: summarizeTotals(employeeMap, totals, blocks),
  };
}

module.exports = { schedule };
