const test = require("node:test");
const assert = require("node:assert/strict");

function loadClient() {
  process.env.ZAPIER_WEBHOOK_URL = "https://hooks.example.com/test";
  delete require.cache[require.resolve("../server/config")];
  delete require.cache[require.resolve("../server/zapierClient")];
  return require("../server/zapierClient");
}

test("postSchedule retries on server errors", async () => {
  const originalFetch = global.fetch;
  const { postSchedule, postedWeeks } = loadClient();
  postedWeeks.clear();

  let attempts = 0;
  global.fetch = async () => {
    attempts += 1;
    if (attempts < 3) {
      return {
        ok: false,
        status: 500,
        text: async () => "fail",
      };
    }
    return {
      ok: true,
      status: 200,
      text: async () => "ok",
    };
  };

  const payload = {
    week_id: "week-500",
    start_date: "2025-01-06",
    end_date: "2025-01-13",
    assignments: [],
    totalsByEmployee: {},
    issues: [],
  };

  try {
    const result = await postSchedule(payload);
    assert.equal(result.ok, true);
    assert.equal(result.status, 200);
    assert.equal(attempts, 3);
    assert.equal(postedWeeks.has("week-500"), true);
  } finally {
    global.fetch = originalFetch;
  }
});

test("postSchedule skips duplicate weeks unless forced", async () => {
  const originalFetch = global.fetch;
  const { postSchedule, postedWeeks } = loadClient();
  postedWeeks.clear();

  let attempts = 0;
  global.fetch = async () => {
    attempts += 1;
    return {
      ok: true,
      status: 200,
      text: async () => "ok",
    };
  };

  const payload = {
    week_id: "week-dup",
    start_date: "2025-02-03",
    end_date: "2025-02-10",
    assignments: [],
    totalsByEmployee: {},
    issues: [],
  };

  try {
    const first = await postSchedule(payload);
    assert.equal(first.ok, true);
    assert.equal(attempts, 1);

    const second = await postSchedule(payload);
    assert.equal(second.status, 204);
    assert.equal(attempts, 1);

    const forced = await postSchedule(payload, { force: true });
    assert.equal(forced.ok, true);
    assert.equal(attempts, 2);
  } finally {
    global.fetch = originalFetch;
  }
});
