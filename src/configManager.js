import { config } from './config.js';

// Runtime AI model selection, split by task type:
//   - 'conversation' — the everyday chat model the agent replies with.
//   - 'development'  — the model used for source-editing tasks (self_fix).
//
// The selection is seeded from config.js (which reads .env) and can be changed
// at runtime via the setters below. The setters only move the live value; the
// /set_dev_model command additionally writes OPENROUTER_DEV_MODEL back to .env,
// because self_fix ends in a restart and a development model that reset on every
// reboot would silently send the next run to the default instead of the choice
// Oscar made.
const state = {
  conversationModel: config.defaultModelName,
  developmentModel: config.developmentModelName,
};

// The full config object for a task type. 'development' → the dev model,
// anything else → the conversation model.
export function getActiveModelConfig(taskType) {
  const type = taskType === 'development' ? 'development' : 'conversation';
  const model = type === 'development' ? state.developmentModel : state.conversationModel;
  return { taskType: type, model };
}

// Alias kept for the task-facing API name; identical to getActiveModelConfig.
export function getAIConfig(taskType) {
  return getActiveModelConfig(taskType);
}

// Point the conversation model at `modelName` (ignored if blank). Returns the
// resulting value.
export function setDefaultModel(modelName) {
  const value = String(modelName ?? '').trim();
  if (value) state.conversationModel = value;
  return state.conversationModel;
}

// Point the development-task model at `modelName` (ignored if blank). Returns
// the resulting value.
export function setDevelopmentModel(modelName) {
  const value = String(modelName ?? '').trim();
  if (value) state.developmentModel = value;
  return state.developmentModel;
}

export function getDefaultModelName() {
  return state.conversationModel;
}

export function getDevelopmentModelName() {
  return state.developmentModel;
}
