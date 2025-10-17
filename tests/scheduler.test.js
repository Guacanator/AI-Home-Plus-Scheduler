const test = require("node:test");
const assert = require("node:assert/strict");
const { schedule } = require("../server/scheduler");

const dayShift = (id, date, startHour) => {
  const start = `${date}T${String(startHour).padStart(2, "0")}:00:00.000Z`;
  const endHour = (startHour + 12) % 24;
  const startDate = new Date(`${date}T00:00:00.000Z`);
  const endDate = new Date(startDate);
  if (endHour <= startHour) {
    endDate.setUTCDate(endDate.getUTCDate() + 1);
  }
  const endDateString = endDate.toISOString().slice(0, 10);
  const end = `${endDateString}T${String(endHour).padStart(2, "0")}:00:00.000Z`;
  return {
    id,
    role_needed: startHour === 7 ? "CNA" : startHour === 8 ? "CMA" : "Either",
    date,
    start_time: start,
    end_time: end,
  };
};

const employee = (id, role, weeklyCap = 40, extras = {}) => ({
  id,
  role,
  weekly_cap: weeklyCap,
  status: "Active",
  name: id,
  ...extras,
});

const availabilityWindow = (id, employeeId, date, startHour) => ({
  id,
  employee_id: employeeId,
  date,
  start_time: `${String(startHour).padStart(2, "0")}:00`,
  end_time: `${String((startHour + 12) % 24).padStart(2, "0")}:00`,
  type: "Available",
});

test("leaves shift unfilled when no eligible employee", () => {
  const result = schedule(
    [dayShift("shift1", "2024-05-01", 7)],
    [employee("emp1", "CMA")],
    [availabilityWindow("avail1", "emp1", "2024-05-01", 7)],
  );

  assert.equal(result.assignments[0].employeeId, null);
  assert.match(result.assignments[0].reason, /No employees available/);
});

test("respects 40 hour weekly cap", () => {
  const shifts = [
    dayShift("shift1", "2024-05-01", 7),
    dayShift("shift2", "2024-05-02", 7),
    dayShift("shift3", "2024-05-03", 7),
    dayShift("shift4", "2024-05-04", 7),
  ];
  const employees = [employee("emp1", "CNA")];
  const availability = shifts.map((shift, index) =>
    availabilityWindow(`avail${index}`, "emp1", shift.date, 7),
  );

  const result = schedule(shifts, employees, availability);

  const filled = result.assignments.filter((assignment) => assignment.employeeId === "emp1");
  assert.equal(filled.length, 3);
  const unfilled = result.assignments.find((assignment) => assignment.employeeId === null);
  assert.match(unfilled.reason, /weekly cap/);
});

test("blocks role mismatches", () => {
  const shifts = [dayShift("shift1", "2024-05-01", 8)];
  const employees = [employee("emp1", "CNA"), employee("emp2", "CMA")];
  const availability = [
    availabilityWindow("avail1", "emp1", "2024-05-01", 8),
    availabilityWindow("avail2", "emp2", "2024-05-01", 8),
  ];

  const result = schedule(shifts, employees, availability);
  assert.equal(result.assignments[0].employeeId, "emp2");
});

test("prevents overlapping assignments", () => {
  const shifts = [
    dayShift("shift1", "2024-05-01", 7),
    { ...dayShift("shift2", "2024-05-01", 7), start_time: "2024-05-01T13:00:00.000Z", end_time: "2024-05-01T19:00:00.000Z" },
  ];
  const employees = [employee("emp1", "CNA")];
  const availability = [
    availabilityWindow("avail1", "emp1", "2024-05-01", 7),
    { ...availabilityWindow("avail2", "emp1", "2024-05-01", 7), start_time: "07:00", end_time: "23:00" },
  ];

  const result = schedule(shifts, employees, availability);
  assert.equal(result.assignments[1].employeeId, null);
  assert.match(result.assignments[1].reason, /conflicting/);
});

test("balances assignments when multiple employees qualify", () => {
  const shifts = [
    dayShift("shift1", "2024-05-01", 7),
    dayShift("shift2", "2024-05-02", 7),
  ];
  const employees = [employee("emp1", "CNA"), employee("emp2", "CNA")];
  const availability = [
    availabilityWindow("avail1", "emp1", "2024-05-01", 7),
    availabilityWindow("avail2", "emp1", "2024-05-02", 7),
    availabilityWindow("avail3", "emp2", "2024-05-01", 7),
    availabilityWindow("avail4", "emp2", "2024-05-02", 7),
  ];

  const result = schedule(shifts, employees, availability);
  const assignedEmployees = result.assignments.map((assignment) => assignment.employeeId).filter(Boolean);
  assert.deepEqual(assignedEmployees.sort(), ["emp1", "emp2"]);
});
