"use strict";

const MS_IN_HOUR = 60 * 60 * 1000;
const MS_IN_DAY = 24 * MS_IN_HOUR;

function toDate(value) {
  if (!value) {
    return null;
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function combineDateTime(dateValue, timeValue) {
  if (!dateValue && !timeValue) {
    return null;
  }

  if (timeValue && typeof timeValue === "string" && timeValue.includes("T")) {
    return toDate(timeValue);
  }

  const baseDate = toDate(dateValue);
  if (!baseDate) {
    return toDate(timeValue);
  }

  if (!timeValue) {
    return new Date(baseDate);
  }

  const timeString = typeof timeValue === "string" ? timeValue : "";
  const [hours = "0", minutes = "0"] = timeString.split(":");
  const date = new Date(baseDate);
  date.setHours(Number.parseInt(hours, 10) || 0, Number.parseInt(minutes, 10) || 0, 0, 0);
  return date;
}

function normalizeRange(start, end) {
  const startDate = toDate(start);
  const endDate = toDate(end);
  if (!startDate || !endDate) {
    return { start: null, end: null };
  }

  if (endDate.getTime() <= startDate.getTime()) {
    return {
      start: startDate,
      end: new Date(endDate.getTime() + MS_IN_DAY),
    };
  }

  return { start: startDate, end: endDate };
}

function hoursBetween(start, end) {
  const range = normalizeRange(start, end);
  if (!range.start || !range.end) {
    return 0;
  }
  const diff = (range.end.getTime() - range.start.getTime()) / MS_IN_HOUR;
  return Number.isFinite(diff) ? diff : 0;
}

function overlaps(blocks, start, end) {
  if (!Array.isArray(blocks) || blocks.length === 0) {
    return false;
  }
  const candidate = normalizeRange(start, end);
  if (!candidate.start || !candidate.end) {
    return false;
  }

  return blocks.some((block) => {
    const normalized = normalizeRange(block.start, block.end);
    if (!normalized.start || !normalized.end) {
      return false;
    }

    const startA = normalized.start.getTime();
    const endA = normalized.end.getTime();
    let startB = candidate.start.getTime();
    let endB = candidate.end.getTime();

    if (endB <= startB) {
      endB += MS_IN_DAY;
    }
    if (endA <= startA) {
      return false;
    }

    return startA < endB && startB < endA;
  });
}

module.exports = {
  toDate,
  combineDateTime,
  normalizeRange,
  hoursBetween,
  overlaps,
  MS_IN_DAY,
};
