"use strict";

const { setTimeout: delay } = require("timers/promises");
const { z } = require("./zod");
const { ZAPIER_WEBHOOK_URL } = require("./config");

const postedWeeks = new Set();

const payloadSchema = z.object({
  week_id: z.string().min(1),
  start_date: z.string().min(1),
  end_date: z.string().min(1),
  assignments: z.array(z.any()),
  totalsByEmployee: z.record(z.any()),
  issues: z.array(z.any()),
});

async function postSchedule(payload, options = {}) {
  const parsed = payloadSchema.parse(payload);
  const force = Boolean(options.force);

  if (!force && postedWeeks.has(parsed.week_id)) {
    return { ok: true, status: 204, text: "Duplicate week skipped" };
  }

  if (!ZAPIER_WEBHOOK_URL) {
    return { ok: false, status: 0, text: "Missing Zapier webhook URL" };
  }

  const attempts = 3;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    try {
      const response = await fetch(ZAPIER_WEBHOOK_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(parsed),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      const text = await response.text();
      if (response.ok || response.status < 500) {
        if (response.ok && response.status >= 200 && response.status < 300) {
          postedWeeks.add(parsed.week_id);
        }
        return { ok: response.ok, status: response.status, text };
      }

      console.error(
        "Zapier webhook failed",
        JSON.stringify({ status: response.status, text, attempt: attempt + 1 })
      );

      if (attempt < attempts - 1) {
        await delay(250 * 2 ** attempt);
      }
    } catch (error) {
      clearTimeout(timeout);
      console.error(
        "Zapier webhook error",
        JSON.stringify({ message: error && error.message ? error.message : String(error), attempt: attempt + 1 })
      );
      if (attempt < attempts - 1) {
        await delay(250 * 2 ** attempt);
        continue;
      }
      return { ok: false, status: 0, text: error && error.message ? error.message : String(error) };
    }
  }

  return { ok: false, status: 500, text: "Zapier webhook failed after retries" };
}

module.exports = {
  postSchedule,
  postedWeeks,
};
