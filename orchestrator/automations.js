"use strict";
// Macros (step sequences), automations ("when this, do that"), the
// location used for sunrise/sunset triggers, and the timer that fires
// time-of-day triggers - plus the /api/macros, /api/automations and
// /api/settings routes.
const fs = require("fs");
const path = require("path");
const { instances, driverEvents, readInstanceState } = require("./instances");
const { broadcast } = require("./broadcast");
const { loadJsonArray, saveJsonArray, sendJson, readJsonBody } = require("./http-util");

const MACROS_PATH = process.env.OAK_MACROS || path.join(__dirname, "macros.json");
const AUTOMATIONS_PATH = process.env.OAK_AUTOMATIONS || path.join(__dirname, "automations.json");
const SETTINGS_PATH = process.env.OAK_SETTINGS || path.join(__dirname, "settings.json");

/**
 * One instance state compared with a value (see evalCondition).
 * @typedef {{instanceId: string, stateId: string, stateSuffix?: string, op: "==" | "!=" | ">" | "<" | ">=" | "<=", value: any}} Condition
 */
/**
 * @typedef {{type: "event", instanceId: string, eventId: string}} EventTrigger
 * @typedef {{type: "time", time?: string, mode?: "fixed" | "sunrise" | "sunset", offsetMin?: number, days?: number[]}} TimeTrigger
 * @typedef {EventTrigger | TimeTrigger} Trigger
 */
/**
 * @typedef {{type: "action", instanceId: string, actionId: string, params?: object}
 *   | {type: "condition", conditions: Condition[], then?: MacroStep[], else?: MacroStep[]}
 *   | {type: "delay", ms: number}} MacroStep
 * @typedef {{id: string, name: string, steps: MacroStep[], trigger?: Trigger, conditions?: Condition[]}} Macro
 */
/**
 * @typedef {{kind: "action", instanceId: string, actionId: string, params?: object} | {kind: "macro", macroId: string}} AutomationAction
 * @typedef {{id: string, name: string, trigger: Trigger, conditions?: Condition[], action: AutomationAction}} Automation
 */

// A macro step is one of:
//   {type:"action", instanceId, actionId, params}                  - call a function
//   {type:"condition", conditions:[...], then:[...], else:[...]}   - branch (recursive)
//   {type:"delay", ms}                                             - pause the sequence
// A macro can also carry its own `trigger`/`conditions` (same shapes an
// automation uses below) so it can fire itself on an event/time, not just
// run on demand - ported from QTI's own macros, which support this too.
/** @type {Macro[]} */
let macros = loadJsonArray(MACROS_PATH);
// An automation is "when this event fires (or at this time of day), do
// that" - trigger and action instance are independent, so an automation
// can bridge two entirely different drivers. `action` is either
// {kind:"action", instanceId, actionId, params} (call one function) or
// {kind:"macro", macroId} (run a whole macro step sequence). `conditions`
// (if present) gate the action: ALL must hold or the automation is
// skipped for that trigger firing. `trigger` is
// {type:"event", instanceId, eventId} or
// {type:"time", time:"HH:MM", mode:"fixed"|"sunrise"|"sunset", offsetMin, days:[0-6]}
// - ported from QTI's own automations (server.js's executeAutomationAction/
// checkTimeAutomations), adapted from QTI's sysvar/export vocabulary to
// Oak's own state/action vocabulary.
/** @type {Automation[]} */
let automations = loadJsonArray(AUTOMATIONS_PATH);
/** @type {{latitude?: number, longitude?: number}} only used for sunrise/sunset triggers */
let settings = fs.existsSync(SETTINGS_PATH) ? JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8")) : {};
function saveSettings() {
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
}

// Numeric comparison whenever both sides parse as numbers (so ">"/"<"
// work on level/percentage-style states); otherwise falls back to string
// equality (==/!= only - >/< on non-numeric values has no sensible
// ordering, so it's always false). Ported directly from QTI's own
// evalCondition, just reading Oak's state shape instead of a sysvar.
function evalCondition(cond) {
  const actual = readInstanceState(cond.instanceId, cond.stateId, cond.stateSuffix);
  const expected = cond.value;
  const an = Number(actual);
  const en = Number(expected);
  const bothNumeric = actual !== undefined && actual !== "" && expected !== "" && !isNaN(an) && !isNaN(en);
  switch (cond.op) {
    case "==": return bothNumeric ? an === en : String(actual) === String(expected);
    case "!=": return bothNumeric ? an !== en : String(actual) !== String(expected);
    case ">": return bothNumeric && an > en;
    case "<": return bothNumeric && an < en;
    case ">=": return bothNumeric && an >= en;
    case "<=": return bothNumeric && an <= en;
    default: return false;
  }
}
// AND semantics: an empty/missing condition list always passes.
function evalConditions(conditions) {
  if (!conditions || !conditions.length) return true;
  return conditions.every(evalCondition);
}

// Sequential, best-effort execution (ported from QTI's runMacroSteps): a
// failing step is logged and the macro moves on, rather than aborting the
// whole sequence over one bad step - QTI reached the same conclusion for
// the same reason (one misconfigured light shouldn't block the other nine
// steps in a "goodnight" macro). Recursive for "condition" steps (a step
// can branch into its own then/else step lists) - depth-capped the same
// way QTI's own version is, since a macro step list can technically
// reference itself as a branch target and loop forever otherwise.
async function runMacroSteps(steps, macroName, depth, logPrefix) {
  logPrefix = logPrefix || "macro";
  if (!steps || !steps.length) return;
  if (depth > 20) {
    console.error(`[${logPrefix} error] "${macroName}": step nesting too deep, aborting`);
    return;
  }
  for (const step of steps) {
    if (!step || !step.type) continue;
    if (step.type === "action") {
      if (!step.instanceId || !step.actionId) continue;
      const entry = instances.get(step.instanceId);
      if (!entry || !entry.running) {
        console.error(`[${logPrefix} "${macroName}"] skipped step: instance "${step.instanceId}" not running`);
        continue;
      }
      try {
        entry.driverInstance.action(step.actionId, step.params || {});
      } catch (err) {
        console.error(`[${logPrefix} error] "${macroName}":`, err.message);
      }
    } else if (step.type === "condition") {
      const branch = evalConditions(step.conditions) ? step.then : step.else;
      await runMacroSteps(branch, macroName, depth + 1, logPrefix);
    } else if (step.type === "delay") {
      const ms = Math.max(0, Math.min(3600000, Number(step.ms) || 0)); // 1hr cap - a typo'd extra zero shouldn't hang a macro run indefinitely
      await new Promise((resolve) => setTimeout(resolve, ms));
    }
  }
}
function runMacro(macro) {
  if (!evalConditions(macro.conditions)) {
    console.log(`[macro] "${macro.name}" skipped (condition not met)`);
    return;
  }
  runMacroSteps(macro.steps || [], macro.name, 0).catch((e) => console.error(`[macro error] "${macro.name}":`, e.message));
}
function runEventMacros(instanceId, eventId) {
  for (const macro of macros) {
    if (!macro.trigger || macro.trigger.type !== "event") continue;
    if (macro.trigger.instanceId !== instanceId || macro.trigger.eventId !== eventId) continue;
    runMacro(macro);
  }
}

// Automations: single-action version of a macro, gated by trigger+
// conditions - see the `automations` declaration above for the full
// shape. Action is either one direct call or a whole macro run, ported
// from QTI's executeAutomationAction.
function executeAutomationAction(auto) {
  if (!auto.action) return;
  if (!evalConditions(auto.conditions)) {
    console.log(`[automation] "${auto.name}" skipped (condition not met)`);
    return;
  }
  if (auto.action.kind === "macro") {
    const macro = macros.find((m) => m.id === auto.action.macroId);
    if (!macro) {
      console.error(`[automation error] "${auto.name}": no such macro`);
      return;
    }
    console.log(`[automation] "${auto.name}" fired (running macro "${macro.name}")`);
    runMacro(macro);
    return;
  }
  if (!auto.action.instanceId || !auto.action.actionId) return;
  const entry = instances.get(auto.action.instanceId);
  if (!entry || !entry.running) {
    console.error(`[automation error] "${auto.name}": instance "${auto.action.instanceId}" not running`);
    return;
  }
  try {
    entry.driverInstance.action(auto.action.actionId, auto.action.params || {});
    console.log(`[automation] "${auto.name}" fired`);
  } catch (e) {
    console.error(`[automation error] "${auto.name}":`, e.message);
  }
}
function runEventAutomations(instanceId, eventId) {
  for (const auto of automations) {
    if (!auto.trigger || auto.trigger.type !== "event") continue;
    if (auto.trigger.instanceId !== instanceId || auto.trigger.eventId !== eventId) continue;
    executeAutomationAction(auto);
  }
}

// Approximate sunrise/sunset (NOAA's widely-used simplified solar
// calculator, ported directly from QTI's own computeSunTimes - accurate to
// within a few minutes, more than sufficient for a "turn the porch light
// on around sunset" automation). No network call, no dependency - pure
// trig off latitude/longitude + day-of-year. Returns "HH:MM" in local
// time, or null if the sun doesn't rise/set that day at this latitude
// (polar day/night - cosH out of [-1,1] range).
function computeSunTimes(date, lat, lon) {
  const rad = Math.PI / 180;
  const dayOfYear = Math.floor((date.getTime() - new Date(date.getFullYear(), 0, 0).getTime()) / 86400000);
  const zenith = 90.833; // official sunrise/sunset zenith, includes atmospheric refraction

  function calc(isSunrise) {
    const lngHour = lon / 15;
    const t = dayOfYear + ((isSunrise ? 6 : 18) - lngHour) / 24;
    const M = 0.9856 * t - 3.289;
    let L = M + 1.916 * Math.sin(M * rad) + 0.02 * Math.sin(2 * M * rad) + 282.634;
    L = ((L % 360) + 360) % 360;
    let RA = Math.atan(0.91764 * Math.tan(L * rad)) / rad;
    RA = ((RA % 360) + 360) % 360;
    const Lquadrant = Math.floor(L / 90) * 90;
    const RAquadrant = Math.floor(RA / 90) * 90;
    RA = (RA + (Lquadrant - RAquadrant)) / 15;
    const sinDec = 0.39782 * Math.sin(L * rad);
    const cosDec = Math.cos(Math.asin(sinDec));
    const cosH = (Math.cos(zenith * rad) - sinDec * Math.sin(lat * rad)) / (cosDec * Math.cos(lat * rad));
    if (cosH > 1 || cosH < -1) return null;
    let H = isSunrise ? 360 - Math.acos(cosH) / rad : Math.acos(cosH) / rad;
    H /= 15;
    const T = H + RA - 0.06571 * t - 6.622;
    return (((T - lngHour) % 24) + 24) % 24; // UT decimal hours
  }

  // `new Date(utcMs)` already IS the correct instant - .getHours()/
  // .getMinutes() automatically render it in the system's local timezone,
  // no manual offset arithmetic needed.
  function utToLocalHHMM(ut) {
    if (ut === null) return null;
    const utcMs = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) + ut * 3600000;
    const local = new Date(utcMs);
    return String(local.getHours()).padStart(2, "0") + ":" + String(local.getMinutes()).padStart(2, "0");
  }
  return { sunrise: utToLocalHHMM(calc(true)), sunset: utToLocalHHMM(calc(false)) };
}
// Recomputed once per calendar day (not once per checkTimeAutomations
// tick, which runs every 20s) - sunrise/sunset don't meaningfully move
// within a day, so there's no reason to redo the trig on every tick.
let sunTimesCache = null; // { dateKey, sunrise, sunset }
function getSunTimesToday() {
  const now = new Date();
  const dateKey = now.toISOString().slice(0, 10);
  if (sunTimesCache && sunTimesCache.dateKey === dateKey) return sunTimesCache;
  const lat = Number(settings.latitude);
  const lon = Number(settings.longitude);
  sunTimesCache = isFinite(lat) && isFinite(lon) ? { dateKey, ...computeSunTimes(now, lat, lon) } : { dateKey, sunrise: null, sunset: null };
  return sunTimesCache;
}
// A trigger with no `mode` (or mode:"fixed") uses its literal `time`
// field. mode "sunrise"/"sunset" resolves to today's solar time (null if
// latitude/longitude aren't set) plus an optional +/- minute offset
// ("30 min after sunset", etc).
function resolveTriggerTime(trigger) {
  if (!trigger.mode || trigger.mode === "fixed") return trigger.time;
  const sun = getSunTimesToday();
  const base = trigger.mode === "sunrise" ? sun.sunrise : sun.sunset;
  if (!base) return null;
  const offset = Number(trigger.offsetMin) || 0;
  if (!offset) return base;
  const parts = base.split(":");
  const total = (((Number(parts[0]) * 60 + Number(parts[1]) + offset) % 1440) + 1440) % 1440;
  return String(Math.floor(total / 60)).padStart(2, "0") + ":" + String(total % 60).padStart(2, "0");
}
// `days` (0=Sunday..6=Saturday) is optional - a MISSING `days` field means
// "every day". An explicitly empty array is NOT treated as "every day" -
// the UI always sends the checked days, so `[]` means every box got
// unchecked and the trigger should never fire, not silently fire daily.
function triggerMatchesToday(trigger, now) {
  return !Array.isArray(trigger.days) || trigger.days.includes(now.getDay());
}
// Time-of-day trigger ("at 18:00 every day, turn on the porch light") -
// checked periodically rather than one setTimeout per automation/macro, so
// editing one never has to reschedule anything; a minute-granularity
// de-dupe guard (lastFiredMinute) stops it firing more than once per
// matching minute even though this runs more often than once a minute.
const lastFiredMinute = new Map(); // automation.id -> "YYYY-MM-DDTHH:MM" it last fired at
const lastFiredMinuteMacro = new Map(); // macro.id -> "YYYY-MM-DDTHH:MM" it last fired at
// (`now` is a parameter so a test can ask "what fires at 18:00?".)
function checkTimeAutomations(now = new Date()) {
  const nowHHMM = String(now.getHours()).padStart(2, "0") + ":" + String(now.getMinutes()).padStart(2, "0");
  const nowKey = now.toISOString().slice(0, 10) + "T" + nowHHMM;
  for (const auto of automations) {
    if (!auto.trigger || auto.trigger.type !== "time") continue;
    if (!triggerMatchesToday(auto.trigger, now)) continue;
    if (resolveTriggerTime(auto.trigger) !== nowHHMM) continue;
    if (lastFiredMinute.get(auto.id) === nowKey) continue;
    lastFiredMinute.set(auto.id, nowKey);
    executeAutomationAction(auto);
  }
  for (const macro of macros) {
    if (!macro.trigger || macro.trigger.type !== "time") continue;
    if (!triggerMatchesToday(macro.trigger, now)) continue;
    if (resolveTriggerTime(macro.trigger) !== nowHHMM) continue;
    if (lastFiredMinuteMacro.get(macro.id) === nowKey) continue;
    lastFiredMinuteMacro.set(macro.id, nowKey);
    runMacro(macro);
  }
}
const timeAutomationTimer = setInterval(checkTimeAutomations, 20000);
if (timeAutomationTimer.unref) timeAutomationTimer.unref();

// A driver event can trigger automations and macros (see instances.js).
driverEvents.on("event", (instanceId, eventId) => {
  runEventAutomations(instanceId, eventId);
  runEventMacros(instanceId, eventId);
});

/** /api/macros, /api/automations, /api/settings */
async function routes(req, res, parts) {
  if (parts[1] === "macros" && parts.length === 2 && req.method === "GET") {
    return sendJson(res, 200, macros);
  }
  if (parts[1] === "macros" && parts.length === 2 && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      if (!body.name || !Array.isArray(body.steps) || !body.steps.length) {
        return sendJson(res, 400, { error: "name and at least one step are required" });
      }
      // trigger/conditions are optional (a macro that only ever runs on
      // demand, e.g. from the Dashboard's On/Off function picker, has
      // neither) - passed through as-is, same permissive validation
      // runMacroSteps already applies at execution time (an invalid step
      // is skipped, not rejected up front).
      const macro = {
        id: body.id || `macro-${Date.now()}`,
        name: body.name,
        steps: body.steps,
        trigger: body.trigger || undefined,
        conditions: Array.isArray(body.conditions) ? body.conditions : undefined,
      };
      const existingIdx = macros.findIndex((m) => m.id === macro.id);
      if (existingIdx === -1) macros.push(macro);
      else macros[existingIdx] = macro;
      saveJsonArray(MACROS_PATH, macros);
      broadcast({ type: "macrosChanged" });
      return sendJson(res, 200, { ok: true, id: macro.id });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }
  if (parts[1] === "macros" && parts.length === 3 && req.method === "DELETE") {
    macros = macros.filter((m) => m.id !== parts[2]);
    saveJsonArray(MACROS_PATH, macros);
    broadcast({ type: "macrosChanged" });
    return sendJson(res, 200, { ok: true });
  }
  if (parts[1] === "macros" && parts.length === 4 && parts[3] === "run" && req.method === "POST") {
    const macro = macros.find((m) => m.id === parts[2]);
    if (!macro) return sendJson(res, 404, { error: "No such macro" });
    runMacro(macro); // fire-and-forget, like QTI's own runMacro() - the caller gets an immediate ack, not a "wait for every step" response
    return sendJson(res, 200, { ok: true });
  }

  if (parts[1] === "automations" && parts.length === 2 && req.method === "GET") {
    return sendJson(res, 200, automations);
  }
  if (parts[1] === "automations" && parts.length === 2 && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      if (!body.name || !body.trigger || !body.action) {
        return sendJson(res, 400, { error: "name, trigger, and action are required" });
      }
      const auto = {
        id: body.id || `auto-${Date.now()}`,
        name: body.name,
        trigger: body.trigger,
        conditions: Array.isArray(body.conditions) ? body.conditions : undefined,
        action: body.action,
      };
      const existingIdx = automations.findIndex((a) => a.id === auto.id);
      if (existingIdx === -1) automations.push(auto);
      else automations[existingIdx] = auto;
      saveJsonArray(AUTOMATIONS_PATH, automations);
      broadcast({ type: "automationsChanged" });
      return sendJson(res, 200, { ok: true, id: auto.id });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }
  if (parts[1] === "automations" && parts.length === 3 && req.method === "DELETE") {
    automations = automations.filter((a) => a.id !== parts[2]);
    saveJsonArray(AUTOMATIONS_PATH, automations);
    broadcast({ type: "automationsChanged" });
    return sendJson(res, 200, { ok: true });
  }
  if (parts[1] === "automations" && parts.length === 4 && parts[3] === "run" && req.method === "POST") {
    const auto = automations.find((a) => a.id === parts[2]);
    if (!auto) return sendJson(res, 404, { error: "No such automation" });
    executeAutomationAction(auto); // manual test-fire, bypassing the trigger (conditions still apply)
    return sendJson(res, 200, { ok: true });
  }

  if (parts[1] === "settings" && parts.length === 2 && req.method === "GET") {
    return sendJson(res, 200, settings);
  }
  if (parts[1] === "settings" && parts.length === 2 && req.method === "PUT") {
    try {
      const body = await readJsonBody(req);
      settings = {
        latitude: body.latitude !== undefined && body.latitude !== "" ? Number(body.latitude) : undefined,
        longitude: body.longitude !== undefined && body.longitude !== "" ? Number(body.longitude) : undefined,
      };
      saveSettings();
      sunTimesCache = null; // latitude/longitude changed - today's cached sun times are now stale
      return sendJson(res, 200, { ok: true });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  res.writeHead(404);
  res.end("Not found");
}

module.exports = { routes, runMacro, executeAutomationAction, checkTimeAutomations, computeSunTimes };
