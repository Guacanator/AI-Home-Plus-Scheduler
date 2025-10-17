"use strict";

const { z } = require("./zod");

const ScheduleRequest = z.object({
  week_id: z.string().min(1),
  start_date: z.string().min(1),
  end_date: z.string().min(1),
});

const ScheduleResponse = z.object({
  assignments: z.array(z.any()),
  totalsByEmployee: z.record(z.any()),
  issues: z.array(z.any()),
});

module.exports = {
  ScheduleRequest,
  ScheduleResponse,
};
