// bots/index.js
// Dispatcher – chooses which bot to run based on taskType

const { runPtEvaluationBot } = require("./bots/ptEvaluation.solo");
const { runPtVisitBot } = require("./bots/ptVisit.solo");
const { runPtReevalBot } = require("./bots/ptReeval.solo");
const { runPtDischargeBot } = require("./bots/ptDischarge.solo");


async function runKinnserBot(params) {
  const { taskType } = params;

  console.log("runKinnserBot dispatch:", { taskType });

  // Exact match from your UI dropdown
  if (taskType === "PT Evaluation") {
    return runPtEvaluationBot(params);
  }

  if (taskType === "PT Re-Evaluation") {
    return runPtReevalBot(params);
  }

  // Anything discharge-related routes to the discharge bot
  if (
    taskType === "PT Discharge w/Discharge Summary" ||
    taskType === "Discharge Summary (PT)" ||
    (taskType && taskType.toLowerCase().includes("discharge"))
  ) {
    return runPtDischargeBot(params);
  }

  // Default – treat everything else like a standard PT Visit
  return runPtVisitBot(params);
}

module.exports = { runKinnserBot };
