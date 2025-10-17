"use strict";

let expressModule = null;
try {
  expressModule = require("express");
} catch (error) {
  expressModule = null;
}

if (expressModule) {
  module.exports = expressModule;
  return;
}

const http = require("http");

function toQueryObject(searchParams) {
  const result = {};
  for (const [key, value] of searchParams.entries()) {
    if (Object.prototype.hasOwnProperty.call(result, key)) {
      const existing = result[key];
      if (Array.isArray(existing)) {
        existing.push(value);
      } else {
        result[key] = [existing, value];
      }
    } else {
      result[key] = value;
    }
  }
  return result;
}

function createJsonMiddleware(options = {}) {
  const limitBytes = (() => {
    if (!options.limit) {
      return 1_000_000;
    }
    if (typeof options.limit === "number") {
      return options.limit;
    }
    if (typeof options.limit === "string") {
      const match = options.limit.match(/^(\d+)(kb|mb)?$/i);
      if (!match) {
        return 1_000_000;
      }
      const value = Number.parseInt(match[1], 10);
      const unit = (match[2] || "").toLowerCase();
      if (unit === "kb") {
        return value * 1024;
      }
      if (unit === "mb") {
        return value * 1024 * 1024;
      }
      return value;
    }
    return 1_000_000;
  })();

  return function jsonMiddleware(req, res, next) {
    if (req.body !== undefined) {
      next();
      return;
    }

    const contentType = req.headers["content-type"] || "";
    if (!contentType.toLowerCase().includes("application/json")) {
      req.body = {};
      next();
      return;
    }

    let body = "";
    let aborted = false;

    req.on("data", (chunk) => {
      if (aborted) {
        return;
      }
      body += chunk;
      if (body.length > limitBytes) {
        aborted = true;
        req.destroy();
        const error = new Error("Payload too large");
        error.statusCode = 413;
        next(error);
      }
    });

    req.on("error", (error) => {
      if (aborted) {
        return;
      }
      aborted = true;
      next(error);
    });

    req.on("end", () => {
      if (aborted) {
        return;
      }
      if (!body) {
        req.body = {};
        next();
        return;
      }
      try {
        req.body = JSON.parse(body);
        next();
      } catch (error) {
        const parseError = new Error("Invalid JSON payload");
        parseError.statusCode = 400;
        next(parseError);
      }
    });
  };
}

function applyResponseHelpers(res) {
  if (res.__expressPatched) {
    return;
  }
  res.__expressPatched = true;

  res.status = function status(code) {
    res.statusCode = code;
    return res;
  };

  res.json = function json(payload) {
    if (res.writableEnded) {
      return res;
    }
    const body = JSON.stringify(payload, null, 2);
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Content-Length", Buffer.byteLength(body));
    res.end(body);
    return res;
  };

  res.send = function send(payload) {
    if (res.writableEnded) {
      return res;
    }
    if (payload === undefined || payload === null) {
      res.end();
      return res;
    }
    if (typeof payload === "object" && !Buffer.isBuffer(payload)) {
      return res.json(payload);
    }
    const buffer = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload));
    res.setHeader("Content-Length", buffer.length);
    res.end(buffer);
    return res;
  };

  res.sendStatus = function sendStatus(code) {
    res.status(code);
    res.send(String(code));
    return res;
  };
}

function expressFallback() {
  const layers = [];

  const app = function app(req, res) {
    applyResponseHelpers(res);

    const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    req.originalUrl = req.url;
    req.path = requestUrl.pathname;
    req.query = toQueryObject(requestUrl.searchParams);

    let idx = 0;

    const runLayer = (error) => {
      if (res.writableEnded) {
        return;
      }

      if (idx >= layers.length) {
        if (error) {
          const status =
            error && Number.isFinite(error.statusCode) ? error.statusCode : 500;
          res.status(status).json({ error: error && error.message ? error.message : "Server Error" });
          return;
        }
        res.status(404).json({ error: "Not Found" });
        return;
      }

      const layer = layers[idx++];

      try {
        if (layer.type === "middleware") {
          if (error) {
            if (layer.handler.length === 4) {
              Promise.resolve(layer.handler(error, req, res, runLayer)).catch(runLayer);
              return;
            }
            runLayer(error);
            return;
          }

          if (layer.handler.length === 4) {
            runLayer();
            return;
          }

          Promise.resolve(layer.handler(req, res, runLayer)).catch(runLayer);
          return;
        }

        if (error) {
          runLayer(error);
          return;
        }

        if (layer.method !== req.method) {
          runLayer();
          return;
        }

        if (layer.path && layer.path !== req.path) {
          runLayer();
          return;
        }

        Promise.resolve(layer.handler(req, res, runLayer)).catch(runLayer);
      } catch (err) {
        runLayer(err);
      }
    };

    runLayer();
  };

  app.use = function use(handler) {
    layers.push({ type: "middleware", handler });
    return app;
  };

  ["get", "post", "options"].forEach((method) => {
    app[method] = function register(path, handler) {
      layers.push({ type: "route", method: method.toUpperCase(), path, handler });
      return app;
    };
  });

  app.listen = function listen(port, callback) {
    const server = http.createServer(app);
    return server.listen(port, callback);
  };

  return app;
}

expressFallback.json = createJsonMiddleware;
expressFallback.Router = () => expressFallback();

module.exports = expressFallback;
