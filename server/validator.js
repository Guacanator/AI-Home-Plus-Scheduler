"use strict";

const {
  normalizeEmployees,
  normalizeAvailability,
  normalizeShiftRecords,
} = require("./utils/data");
const { overlaps } = require("./utils/time");

function validate(assignments = [], shifts = [], employees = [], availability = []) {
  const errors = [];
  const employeeMap = normalizeEmployees(employees);
  const availabilityMap = normalizeAvailability(availability);
  const shiftMap = new Map();

  normalizeShiftRecords(shifts).forEach((shift) => {
    shiftMap.set(shift.id, shift);
  });

  const hoursByEmployee = new Map();
  const blocksByEmployee = new Map();

  assignments.forEach((assignment) => {
    const shiftId = assignment.shiftId || assignment.shift_id;
    const employeeId = assignment.employeeId || assignment.employee_id;

    if (!shiftId || !employeeId) {
      return;
    }

    const shift = shiftMap.get(shiftId);
    const employee = employeeMap.get(employeeId);

    if (!shift) {
      errors.push({
        type: "missing_shift",
        shiftId,
        employeeId,
        message: `Shift ${shiftId} referenced by assignment was not provided.`,
      });
      return;
    }

    if (!employee) {
      errors.push({
        type: "missing_employee",
        shiftId,
        employeeId,
        message: `Employee ${employeeId} referenced by assignment was not provided.`,
      });
      return;
    }

    if (employee.status !== "active") {
      errors.push({
        type: "inactive_employee",
        shiftId,
        employeeId,
        message: `${employee.name || employeeId} is not active.`,
      });
    }

    if (shift.roleNeeded !== "EITHER" && employee.role !== shift.roleNeeded) {
      errors.push({
        type: "role_mismatch",
        shiftId,
        employeeId,
        message: `${employee.name || employeeId} does not match required role ${shift.roleNeeded}.`,
      });
    }

    const windows = availabilityMap.get(employeeId) || [];
    const hasCoverage = windows.some((window) => {
      if (!window.start || !window.end || !shift.start || !shift.end) {
        return false;
      }
      const start = window.start.getTime();
      const end = window.end.getTime();
      const shiftStart = shift.start.getTime();
      let shiftEnd = shift.end.getTime();
      if (shiftEnd <= shiftStart) {
        shiftEnd += 24 * 60 * 60 * 1000;
      }
      return start <= shiftStart && end >= shiftEnd;
    });

    if (!hasCoverage) {
      errors.push({
        type: "availability",
        shiftId,
        employeeId,
        message: `${employee.name || employeeId} is not available for shift ${shiftId}.`,
      });
    }

    const hours = shift.hours || 0;
    hoursByEmployee.set(employeeId, (hoursByEmployee.get(employeeId) || 0) + hours);

    if (!blocksByEmployee.has(employeeId)) {
      blocksByEmployee.set(employeeId, []);
    }
    blocksByEmployee.get(employeeId).push({
      start: shift.start,
      end: shift.end,
      shiftId,
    });
  });

  for (const [employeeId, hours] of hoursByEmployee.entries()) {
    const employee = employeeMap.get(employeeId);
    if (employee && hours > employee.weeklyCap) {
      errors.push({
        type: "weekly_cap",
        employeeId,
        message: `${employee.name || employeeId} exceeds weekly cap (${hours.toFixed(2)} > ${employee.weeklyCap}).`,
      });
    }
  }

  for (const [employeeId, blocks] of blocksByEmployee.entries()) {
    const employee = employeeMap.get(employeeId);
    for (let i = 0; i < blocks.length; i += 1) {
      for (let j = i + 1; j < blocks.length; j += 1) {
        if (overlaps([blocks[i]], blocks[j].start, blocks[j].end)) {
          errors.push({
            type: "overlap",
            employeeId,
            shiftId: `${blocks[i].shiftId},${blocks[j].shiftId}`,
            message: `${employee ? employee.name : employeeId} has overlapping shifts ${blocks[i].shiftId} and ${blocks[j].shiftId}.`,
          });
        }
      }
    }
  }

  return errors;
}

module.exports = {
  validate,
};
