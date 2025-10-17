"use strict";

const { buildDateFilter } = require("./utils/data");

const API_ROOT = "https://api.airtable.com/v0";

class AirtableClient {
  constructor(options = {}) {
    this.apiKey = options.apiKey || process.env.AIRTABLE_API_KEY || "";
    this.baseId = options.baseId || process.env.AIRTABLE_BASE_ID || "";
    this.tables = {
      employees: options.employeesTable || process.env.AIRTABLE_EMPLOYEES_TABLE || "Employees",
      availability:
        options.availabilityTable || process.env.AIRTABLE_AVAILABILITY_TABLE || "Availability",
      shifts: options.shiftsTable || process.env.AIRTABLE_SHIFTS_TABLE || "Shifts",
    };
    this.shiftEmployeeField =
      options.shiftEmployeeField || process.env.AIRTABLE_SHIFT_EMPLOYEE_FIELD || "assigned_employee";
    this.shiftStatusField =
      options.shiftStatusField || process.env.AIRTABLE_SHIFT_STATUS_FIELD || "status";
  }

  assertConfigured() {
    if (!this.apiKey || !this.baseId) {
      throw new Error("Missing Airtable configuration. Provide AIRTABLE_API_KEY and AIRTABLE_BASE_ID.");
    }
  }

  async request(path, options = {}) {
    this.assertConfigured();
    const url = `${API_ROOT}/${this.baseId}${path}`;
    const response = await fetch(url, {
      method: options.method || "GET",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Airtable request failed (${response.status}): ${errorText}`);
    }

    if (response.status === 204) {
      return null;
    }

    return response.json();
  }

  async list(tableName, params = {}) {
    const search = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== "") {
        search.append(key, value);
      }
    });

    const records = [];
    let offset;
    do {
      if (offset) {
        search.set("offset", offset);
      }
      const query = search.toString();
      const data = await this.request(`/${encodeURIComponent(tableName)}${query ? `?${query}` : ""}`);
      records.push(...(data.records || []));
      offset = data.offset;
    } while (offset);

    return records;
  }

  async listEmployees() {
    return this.list(this.tables.employees, { pageSize: 100 });
  }

  async listAvailability(range = {}) {
    const filterByFormula = buildDateFilter("date", range);
    return this.list(this.tables.availability, {
      pageSize: 100,
      ...(filterByFormula ? { filterByFormula } : {}),
      sort: [{ field: "date", direction: "asc" }],
    });
  }

  async listShifts(range = {}) {
    const filterByFormula = buildDateFilter("date", range);
    return this.list(this.tables.shifts, {
      pageSize: 100,
      ...(filterByFormula ? { filterByFormula } : {}),
      sort: [{ field: "date", direction: "asc" }],
    });
  }

  async upsertAssignments(assignments = []) {
    if (!Array.isArray(assignments) || assignments.length === 0) {
      return [];
    }

    const updates = assignments
      .filter((assignment) => assignment && assignment.shiftId && assignment.employeeId)
      .map((assignment) => ({
        id: assignment.shiftId,
        fields: {
          [this.shiftEmployeeField]: [assignment.employeeId],
          ...(assignment.status ? { [this.shiftStatusField]: assignment.status } : {}),
        },
      }));

    if (updates.length === 0) {
      return [];
    }

    const chunks = [];
    for (let i = 0; i < updates.length; i += 10) {
      chunks.push(updates.slice(i, i + 10));
    }

    const results = [];
    for (const chunk of chunks) {
      const payload = { records: chunk, typecast: true };
      const data = await this.request(`/${encodeURIComponent(this.tables.shifts)}`, {
        method: "PATCH",
        body: payload,
      });
      results.push(...(data.records || []));
    }

    return results;
  }
}

module.exports = { AirtableClient };
