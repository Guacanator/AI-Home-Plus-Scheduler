"use strict";

const { loadEnv } = require("./loadEnv");

loadEnv();

const ZAPIER_WEBHOOK_URL = process.env.ZAPIER_WEBHOOK_URL;
const ZAPIER_ENABLED = /^true$/i.test(process.env.ZAPIER_ENABLED || "true");

module.exports = {
  ZAPIER_WEBHOOK_URL,
  ZAPIER_ENABLED,
};
