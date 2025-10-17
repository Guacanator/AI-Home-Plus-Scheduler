# A Home Plus Scheduler

This project provides a small collection of utilities for building employee schedules
against an Airtable base. It includes:

- A REST-like HTTP server that exposes a `/generate-schedule` endpoint.
- A constraint-based scheduler that assigns employees to CNA, CMA, and Night shifts while
  respecting availability, weekly hour caps, and overlap rules.
- A validator that can be used to double-check schedules in isolation.
- A minimal Airtable client that works with the official REST API.
- Node-based tests that cover the most important scheduling scenarios.

## Getting Started

1. Create a `.env` file based on `.env.example` and supply your Airtable API key and base id.
   Set `ALLOW_ORIGIN` to the Zapier webhook origin if you need cross-origin calls.
2. Run `npm install` to prepare the local environment (no external packages are required).
3. Execute `npm test` to run the built-in scheduler unit tests.
4. Start the HTTP server with `npm start` (or `npm run dev`) to expose `/generate-schedule`.

The repository intentionally avoids external dependencies so it can run in restricted
environments where installing packages from npm is not possible. Everything relies on
Node.js 18 or newer features, including the built-in `fetch` API and the native test
runner.

## API Overview

The server listens on the port supplied through the `PORT` environment variable (defaults
to `3000`). Incoming requests are validated with Zod schemas to ensure all scheduling
inputs match the expected Airtable shapes before planning begins.

```
POST /generate-schedule
Content-Type: application/json

{
  "week_id": "2024-W20",
  "shift_template": [
    {
      "shift_id": "shf_mon_day",
      "date": "2024-05-13",
      "role_needed": "CNA",
      "start_time": "07:00",
      "end_time": "19:00",
      "status": "Draft",
      "hours": 12
    }
  ],
  "employees": [
    {
      "employee_id": "emp_alice",
      "name": "Alice Johnson",
      "role": "CNA",
      "weekly_cap": 40,
      "status": "Active"
    }
  ],
  "availability": [
    {
      "availability_id": "avl_alice_mon",
      "employee_id": "emp_alice",
      "date": "2024-05-13",
      "start_time": "07:00",
      "end_time": "19:00",
      "type": "Available"
    }
  ],
  "existing_assignments": [
    { "shift_id": "shf_mon_day", "employee_id": "emp_alice" }
  ]
}
```

### Request Schema

| Field | Type | Description |
| --- | --- | --- |
| `week_id` | string | Optional identifier that groups the run (often the record id from the **Weeks** table). |
| `shift_template` | array | Collection of shift rows that mirrors the **Shifts** table payload. Each entry should provide `shift_id`, `date`, `role_needed`, `start_time`, `end_time`, optional `status`, and optional precomputed `hours`. |
| `employees` | array | Records from the **Employees** table. Each object should include `employee_id`, `name`, `role`, optional `weekly_cap`, optional `school_notes`, and `status`. |
| `availability` | array | Records from the **Availability** table for the target week, including `availability_id`, `employee_id`, `date`, `start_time`, `end_time`, and `type`. Unavailable rows are ignored by the scheduler. |
| `existing_assignments` | array | (Optional) Existing pairings of `shift_id` and `employee_id` from the **Shifts** table. If the pairing is still valid the scheduler will respect it; otherwise it will emit an issue explaining why it was dropped. |

### Response Schema

The server responds with a JSON body shaped as follows:

```json
{
  "weekId": "2024-W20",
  "assignments": [
    { "shiftId": "shf_mon_day", "employeeId": "emp_alice" }
  ],
  "totalsByEmployee": {
    "emp_alice": {
      "employeeId": "emp_alice",
      "name": "Alice Johnson",
      "role": "CNA",
      "weeklyCap": 40,
      "hours": 12,
      "assignments": 1
    }
  },
  "issues": [],
  "validationErrors": []
}
```

- `assignments` is the scheduler output, listing filled shifts and reasons for any gaps.
- `totalsByEmployee` summarizes assigned hours and counts per employee after the run.
- `issues` combines planning issues (e.g., no coverage) with validation findings.
- `validationErrors` repeats the validator output to aid debugging in clients.

## Testing

The project uses the native Node test runner. Add new test files under the `tests/`
directory—they will automatically be picked up by `npm test`.

### Local Scheduling Dry Run

You can experiment with the scheduler without Airtable by using the sample payloads
in `scripts/sample/`:

```
node scripts/runLocal.js
```

Pass a different directory to point at custom payloads and optionally include an
`existing_assignments.json` file:

```
node scripts/runLocal.js ./my-fixtures
node scripts/runLocal.js --sampleDir=./my-fixtures
```

When present, `existing_assignments.json` should contain an array of objects with
`shift_id` and `employee_id` keys.

## Airtable Schema

The scheduler expects the following Airtable schema:

- **Employees**: `employee_id` (primary key), `name`, `role` (CNA or CMA), `weekly_cap`,
  `school_notes`, `status` (Active or Inactive).
- **Availability**: `availability_id`, `employee_id` (linked to Employees), `date`,
  `start_time`, `end_time`, `type` (Available, Unavailable, Preferred).
- **Shifts**: `shift_id`, `date`, `role_needed` (CNA, CMA, Either), `start_time`,
  `end_time`, `assigned_employee`, `status` (Draft, Approved, Published),
  `hours` (formula: difference between end and start times in hours).

### Field Mapping Reference

| Request Payload Field | Airtable Table → Field |
| --- | --- |
| `week_id` | Weeks → `week_id` |
| `employees[].employee_id` | Employees → `employee_id` (primary field) |
| `employees[].role` | Employees → `role` |
| `employees[].weekly_cap` | Employees → `weekly_cap` |
| `employees[].status` | Employees → `status` |
| `availability[].availability_id` | Availability → `availability_id` |
| `availability[].employee_id` | Availability → `employee_id` (linked to Employees) |
| `availability[].date` | Availability → `date` |
| `availability[].start_time` | Availability → `start_time` (time-only) |
| `availability[].end_time` | Availability → `end_time` (time-only) |
| `availability[].type` | Availability → `type` |
| `shift_template[].shift_id` | Shifts → `shift_id` (primary field) |
| `shift_template[].date` | Shifts → `date` |
| `shift_template[].role_needed` | Shifts → `role_needed` |
| `shift_template[].start_time` | Shifts → `start_time` (time-only) |
| `shift_template[].end_time` | Shifts → `end_time` (time-only) |
| `shift_template[].assigned_employee` | Shifts → `assigned_employee` (optional in payload) |
| `shift_template[].status` | Shifts → `status` |
| `shift_template[].hours` | Shifts → `hours` (formula, optional override) |
| `existing_assignments[].shift_id` | Shifts → `shift_id` |
| `existing_assignments[].employee_id` | Employees → `employee_id` |

The minimal Airtable client in `server/airtableClient.js` can read and update these tables
through Airtable's REST API.

## Zapier Webhook

| Variable | Description | Default |
| --- | --- | --- |
| `ZAPIER_WEBHOOK_URL` | Target Zapier catch hook endpoint that receives schedule payloads. | `https://hooks.zapier.com/hooks/catch/23767558/u5mjpxl/` |
| `ZAPIER_ENABLED` | Toggle to enable or disable Zapier webhook delivery. | `true` |

Trigger schedule generation locally with a minimal payload:

```bash
curl -X POST "http://localhost:3000/generate-schedule" \
  -H "Content-Type: application/json" \
  -d '{
    "week_id": "2025-W42",
    "start_date": "2025-10-13",
    "end_date": "2025-10-27"
  }'
```

To re-post the same `week_id` to Zapier, add the `force=1` query parameter:

```bash
curl -X POST "http://localhost:3000/generate-schedule?force=1" \
  -H "Content-Type: application/json" \
  -d '{
    "week_id": "2025-W42",
    "start_date": "2025-10-13",
    "end_date": "2025-10-27"
  }'
```
