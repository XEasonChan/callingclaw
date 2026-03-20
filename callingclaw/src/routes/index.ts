// CallingClaw 2.0 — Route Assembly
// Combines all domain-specific route modules into a single ordered list

import type { Services, RouteHandler } from "./types";
import { coreRoutes } from "./core-routes";
import { voiceRoutes } from "./voice-routes";
import { computerRoutes } from "./computer-routes";
import { meetingRoutes } from "./meeting-routes";
import { automationRoutes } from "./automation-routes";
import { calendarRoutes } from "./calendar-routes";
import { contextRoutes } from "./context-routes";
import { taskRoutes } from "./task-routes";
import { recoveryRoutes } from "./recovery-routes";
import { screenRoutes } from "./screen-routes";
import { googleRoutes } from "./google-routes";
import { eventRoutes } from "./event-routes";
import { schedulerRoutes } from "./scheduler-routes";
import { postmeetingRoutes } from "./postmeeting-routes";
import { debugRoutes } from "./debug-routes";

export type { Services, RouteHandler } from "./types";

export function buildAllRoutes(services: Services): RouteHandler[] {
  return [
    coreRoutes(services),
    voiceRoutes(services),
    computerRoutes(services),
    meetingRoutes(services),
    automationRoutes(services),
    calendarRoutes(services),
    contextRoutes(services),
    taskRoutes(services),
    recoveryRoutes(services),
    screenRoutes(services),
    googleRoutes(services),
    eventRoutes(services),
    schedulerRoutes(services),
    postmeetingRoutes(services),
    debugRoutes(services),
  ];
}
