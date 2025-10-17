"use strict";

const OpenAI = require("openai");
const { schedule } = require("./scheduler");

const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const USE_AI_FLAG = String(process.env.USE_AI || "").toLowerCase() === "true";

function toContentText(text) {
  return [{ type: "text", text }];
}

function extractToolCalls(response) {
  if (!response || !Array.isArray(response.output)) {
    return [];
  }

  const toolCalls = [];

  for (const item of response.output) {
    if (item && item.type === "tool_call") {
      toolCalls.push(item);
      continue;
    }

    if (item && item.type === "message" && Array.isArray(item.content)) {
      for (const contentItem of item.content) {
        if (contentItem && contentItem.type === "tool_call") {
          toolCalls.push(contentItem);
        }
      }
    }
  }

  return toolCalls;
}

function normalizeToolCallId(toolCall) {
  if (!toolCall) {
    return undefined;
  }
  return toolCall.id || toolCall.tool_call_id || toolCall.call_id;
}

function ensureOpenAIClient() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("Missing OPENAI_API_KEY environment variable.");
  }
  return new OpenAI({ apiKey });
}

function runLocalScheduler(args = {}) {
  const {
    shiftTemplate = [],
    employees = [],
    availability = [],
    existing = [],
  } = args;

  const result = schedule(shiftTemplate, employees, availability, existing);

  return {
    assignments: result.assignments,
    issues: result.issues,
    totalsByEmployee: result.totalsByEmployee,
    metadata: {
      mode: "local",
    },
  };
}

async function invokeAiPlanner(args = {}) {
  const {
    shiftTemplate = [],
    employees = [],
    availability = [],
    existing = [],
  } = args;

  const client = ensureOpenAIClient();

  const conversation = [
    {
      role: "system",
      content: toContentText(
        "You orchestrate a scheduling workflow for a care facility. You must call the provided schedule function to compute assignments and then confirm the plan."
      ),
    },
    {
      role: "user",
      content: toContentText(
        `Generate an updated schedule using this data: ${JSON.stringify({
          shift_template: shiftTemplate,
          employees,
          availability,
          existing,
        })}`
      ),
    },
  ];

  const scheduleTool = {
    type: "function",
    function: {
      name: "schedule",
      description:
        "Generate shift assignments that respect role coverage, hour limits, availability, and overlap constraints.",
      parameters: {
        type: "object",
        properties: {
          shift_template: { type: "array", items: {} },
          employees: { type: "array", items: {} },
          availability: { type: "array", items: {} },
          existing: { type: "array", items: {} },
        },
        required: ["shift_template", "employees", "availability"],
      },
    },
  };

  let response;
  try {
    response = await client.responses.create({
      model: OPENAI_MODEL,
      input: conversation,
      tools: [scheduleTool],
      tool_choice: { type: "function", function: { name: "schedule" } },
    });
  } catch (error) {
    throw new Error(`OpenAI Responses API error: ${error.message}`);
  }

  const toolCalls = extractToolCalls(response);
  if (!toolCalls.length) {
    throw new Error("OpenAI response did not request the schedule tool.");
  }

  const toolCall = toolCalls[0];
  const toolCallId = normalizeToolCallId(toolCall);

  const localResult = schedule(shiftTemplate, employees, availability, existing);

  conversation.push({
    role: "assistant",
    content: [
      {
        type: "tool_call",
        id: toolCallId,
        name: "schedule",
        arguments:
          toolCall && typeof toolCall.arguments === "string"
            ? toolCall.arguments
            : JSON.stringify({
                shift_template: shiftTemplate.length,
                employees: employees.length,
                availability: availability.length,
                existing: existing.length,
              }),
      },
    ],
  });

  conversation.push({
    role: "tool",
    tool_call_id: toolCallId,
    content: [
      {
        type: "output_text",
        text: JSON.stringify(localResult),
      },
    ],
  });

  try {
    response = await client.responses.create({
      model: OPENAI_MODEL,
      input: conversation,
    });
  } catch (error) {
    throw new Error(`OpenAI follow-up response failed: ${error.message}`);
  }

  return {
    assignments: localResult.assignments,
    issues: localResult.issues,
    totalsByEmployee: localResult.totalsByEmployee,
    metadata: {
      mode: "ai",
      responseId: response.id,
      summary: response.output_text || null,
    },
  };
}

async function planSchedule(args = {}) {
  if (!USE_AI_FLAG) {
    return runLocalScheduler(args);
  }

  try {
    return await invokeAiPlanner(args);
  } catch (error) {
    const fallback = runLocalScheduler(args);
    const issues = fallback.issues ? [...fallback.issues] : [];
    issues.push({
      shift_id: null,
      employee_id: null,
      reason: `AI planner failed: ${error.message}`,
      type: "ai_planner_error",
    });
    return {
      assignments: fallback.assignments,
      issues,
      totalsByEmployee: fallback.totalsByEmployee,
      metadata: {
        mode: "fallback",
        error: error.message,
      },
    };
  }
}

module.exports = { planSchedule, USE_AI_FLAG };
