import { readAutomationLimits } from './format.js';
/** Imported during boot; never silently clamp an invalid deployment override. */
export const automationLimits = readAutomationLimits(process.env);
