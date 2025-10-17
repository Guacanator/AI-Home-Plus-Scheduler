"use strict";

function createZodStub() {
  class ZodError extends Error {
    constructor(issues) {
      super("Zod validation error");
      this.issues = issues;
    }
  }

  function makeSchema(parseImpl, extraMethods = {}) {
    const schema = {
      parse(value) {
        const issues = [];
        const result = parseImpl(value, [], issues);
        if (issues.length > 0) {
          throw new ZodError(issues);
        }
        return result;
      },
      _parse(value, path, issues) {
        return parseImpl(value, path, issues);
      },
      optional() {
        const inner = this;
        return makeSchema((value, path, issues) => {
          if (value === undefined) {
            return undefined;
          }
          return inner._parse(value, path, issues);
        });
      },
      default(defaultValue) {
        const inner = this;
        return makeSchema((value, path, issues) => {
          let actual = value;
          if (actual === undefined) {
            actual = typeof defaultValue === "function" ? defaultValue() : defaultValue;
          }
          return inner._parse(actual, path, issues);
        });
      },
      refine(check, message) {
        const inner = this;
        return makeSchema((value, path, issues) => {
          const result = inner._parse(value, path, issues);
          if (!check(result)) {
            issues.push({
              path,
              message: typeof message === "string" ? message : message.message || "Invalid value",
            });
          }
          return result;
        });
      },
    };

    return Object.assign(schema, extraMethods);
  }

  function string() {
    let minLength = null;
    const schema = makeSchema((value, path, issues) => {
      if (typeof value !== "string") {
        issues.push({ path, message: "Expected string" });
        return value;
      }
      if (minLength !== null && value.length < minLength) {
        issues.push({
          path,
          message: `String must contain at least ${minLength} character(s)`,
        });
      }
      return value;
    });
    schema.min = (length) => {
      minLength = length;
      return schema;
    };
    return schema;
  }

  function date() {
    return makeSchema((value, path, issues) => {
      if (!(value instanceof Date)) {
        issues.push({ path, message: "Expected Date" });
        return value;
      }
      return value;
    });
  }

  function zNull() {
    return makeSchema((value, path, issues) => {
      if (value !== null) {
        issues.push({ path, message: "Expected null" });
      }
      return value;
    });
  }

  function any() {
    return makeSchema((value) => value);
  }

  function union(schemas) {
    return makeSchema((value, path, issues) => {
      for (const schema of schemas) {
        const candidateIssues = [];
        const result = schema._parse(value, path, candidateIssues);
        if (candidateIssues.length === 0) {
          return result;
        }
      }
      issues.push({ path, message: "Value did not match any union type" });
      return value;
    });
  }

  function array(schema) {
    return makeSchema((value, path, issues) => {
      if (!Array.isArray(value)) {
        issues.push({ path, message: "Expected array" });
        return [];
      }
      return value.map((item, index) => schema._parse(item, path.concat(index), issues));
    });
  }

  function record(valueSchema) {
    return makeSchema((value, path, issues) => {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        issues.push({ path, message: "Expected object" });
        return {};
      }
      const result = {};
      for (const key of Object.keys(value)) {
        result[key] = valueSchema._parse(value[key], path.concat(key), issues);
      }
      return result;
    });
  }

  function object(shape) {
    const state = {
      shape: { ...shape },
      passthrough: false,
      refinements: [],
    };

    const schema = makeSchema((value, path, issues) => {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        issues.push({ path, message: "Expected object" });
        return {};
      }
      const result = state.passthrough ? { ...value } : {};
      for (const key of Object.keys(state.shape)) {
        const childSchema = state.shape[key];
        const childValue = childSchema._parse(value[key], path.concat(key), issues);
        if (childValue !== undefined || Object.prototype.hasOwnProperty.call(value, key)) {
          result[key] = childValue;
        }
      }
      for (const refine of state.refinements) {
        if (!refine.check(result)) {
          const refinePath = refine.path && refine.path.length > 0 ? path.concat(refine.path) : path;
          issues.push({ path: refinePath, message: refine.message });
        }
      }
      return result;
    }, {
      passthrough() {
        state.passthrough = true;
        return this;
      },
      extend(additional) {
        const extended = object({ ...state.shape, ...additional });
        if (state.passthrough) {
          extended.passthrough();
        }
        state.refinements.forEach((refine) => extended._addRefinement(refine));
        return extended;
      },
      refine(check, message) {
        state.refinements.push({
          check,
          message: typeof message === "string" ? message : message.message || "Invalid value",
          path: (message && message.path) || [],
        });
        return this;
      },
      _addRefinement(refine) {
        state.refinements.push(refine);
      },
    });

    return schema;
  }

  return {
    z: {
      string,
      date,
      null: zNull,
      union,
      array,
      record,
      object,
      any,
    },
    ZodError,
  };
}

let exported;
try {
  exported = require("zod");
} catch (error) {
  exported = createZodStub();
}

module.exports = exported;
