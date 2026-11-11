"use strict";
// Driver packages in drivers/: listing their manifests, uploading a new one
// and deleting an uploaded one - the /api/drivers routes.
const fs = require("fs");
const path = require("path");
const { DRIVERS_DIR, instances } = require("./instances");
const { sendJson, readJsonBody } = require("./http-util");

// The 4 drivers shipped with Oak itself - kept undeletable through the
// upload UI (a driver folder living outside DRIVERS_DIR entirely would be
// a bigger change; blocking deletion of the ones this repo ships is the
// simple, correct guard for now).
const BUILTIN_DRIVERS = new Set([
  "dsc-powerseries", "http-relay", "mqtt-plug", "generic-dimmer", "zone-hub", "eisy", "homeassistant",
  "pushover", "philips-hue", "sonos", "telegram", "slack", "openweathermap",
  "webhook", "roku", "lifx", "govee", "lutron-caseta", "shelly",
  "honeywell-vista", "tuya-local", "zigbee2mqtt", "zwave-js", "esphome", "xiaomi-miio",
  "broadlink", "google-cast", "ecobee", "ikea-tradfri", "unifi-protect", "onvif", "ring",
  "smartthings", "yamaha", "nuki", "rachio", "myq", "irobot-roomba", "tesla", "denon-avr",
  "ntfy", "presence", "somfy-mylink",
  "nest", "spotify", "plex", "kodi", "nanoleaf", "wemo", "netatmo", "adguard-home",
  "twilio", "discord-webhook", "sensibo", "lg-webos",
  "hikvision", "reolink", "home-connect", "resideo", "ifttt", "hydrawise",
  "harmony-hub", "samsung-tizen", "opnsense", "squeezebox", "tesla-powerwall",
  "frigate", "powerview", "august", "xbox", "solaredge", "awair",
  "tplink-kasa", "meross", "wiz", "venstar", "radio-thermostat", "govee-lan",
  "simplisafe", "abode", "konnected", "heos", "bose-soundtouch", "vizio-smartcast",
  "ambient-weather", "weatherflow-tempest", "purpleair", "emporia-vue", "sense-energy",
  "enphase-envoy", "rainmachine", "netro", "pentair-intellicenter", "unifi-network",
  "eero", "speedtest", "matrix", "pushbullet", "neato", "fibaro",
  "switchbot", "global-cache", "bond", "elgato-key-light", "ewelink", "amcrest",
  "flume", "roborock", "moen-flo", "arlo", "aqara-cloud",
  "paradox", "hai-omnilink",
  "pjlink", "extron-matrix", "wyrestorm", "artnet", "onkyo-pioneer", "doorbird",
  "samsung-mdc", "furman-pwm", "qsys-core", "lutron-homeworks", "genie-aladdin", "russound-rnet",
  "avpro-edge", "anthem-avr", "biamp-tesira", "nec-display", "tesla-wall-connector",
  "intellifire", "middleatlantic-pdu",
  "crown-hiqnet", "lg-display", "sony-bravia", "rainbird",
  "tasmota", "kramer-matrix", "panasonic-display", "justaddpower",
  "opensprinkler", "daikin", "somfy-overkiz", "tado",
  "dahua", "akuvox", "ssh-cli",
]);

function listDriverManifests() {
  return fs
    .readdirSync(DRIVERS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => JSON.parse(fs.readFileSync(path.join(DRIVERS_DIR, d.name, "manifest.json"), "utf8")));
}

// A driver author who didn't bother declaring `category` still gets a
// useful default instead of silently landing in "generic" (where the
// Add-Instance category filter and Dashboard's Auto-generate button would
// never surface it under Light/Switch/Security). Guessed from the SAME
// role tags roleActionsForCategory already reads elsewhere, in order of
// specificity: arm/disarm is unambiguously security; any level-capable
// on/off is called "light" (the more common case among Oak's own built-in
// drivers) rather than "media", since nothing in a manifest distinguishes
// the two without a category the author would have just declared anyway;
// on/off with no level is a plain switch. This is only ever a starting
// guess - the author's own explicit `category` always wins, and nothing
// downstream is locked to it (a slot can bind to any instance regardless
// of its driver's declared category).
function inferCategory(manifest) {
  const roles = new Set(manifest.actions.map((a) => a.role).filter(Boolean));
  if (roles.has("arm") || roles.has("disarm")) return "security";
  if (roles.has("level")) return "light";
  if (roles.has("on") || roles.has("off")) return "switch";
  return "generic";
}

// Uploaded drivers are plain text (a manifest.json + a driver.js), not a
// packaged/encrypted bundle the way an .rtidriver is - Oak has no
// packaging step at all yet, so this is the honest v1: upload the two
// files as-is. Validated only for "is this parseable as a manifest with
// the fields the runtime actually needs" - not sandboxed any more
// tightly than the drivers Oak already ships with, since every driver
// (built-in or uploaded) already runs through the same vm.Context in
// runtime/loader.js and Oak's whole model already assumes an installer
// trusts what they're adding, the same trust boundary RTI's own driver
// install flow has.
function uploadDriver(driverId, manifestJson, driverJs) {
  const safeId = String(driverId || "")
    .trim()
    .replace(/[^a-zA-Z0-9-]/g, "");
  if (!safeId) return { error: "Driver id must be alphanumeric/hyphens" };
  let manifest;
  try {
    manifest = JSON.parse(manifestJson);
  } catch (e) {
    return { error: `manifest.json isn't valid JSON: ${e.message}` };
  }
  if (!manifest.id || !manifest.displayName || !Array.isArray(manifest.actions) || !Array.isArray(manifest.states)) {
    return { error: "manifest.json must have id, displayName, actions[], states[]" };
  }
  if (!driverJs || !driverJs.trim()) return { error: "driver.js is required" };
  const hasCategory = manifest.category && (!Array.isArray(manifest.category) || manifest.category.length);
  let savedManifestJson = manifestJson;
  let inferredCategory = null;
  if (!hasCategory) {
    inferredCategory = inferCategory(manifest);
    manifest.category = inferredCategory;
    savedManifestJson = JSON.stringify(manifest, null, 2);
  }
  const dir = path.join(DRIVERS_DIR, safeId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "manifest.json"), savedManifestJson);
  fs.writeFileSync(path.join(dir, "driver.js"), driverJs);
  return { ok: true, id: safeId, inferredCategory };
}

function deleteDriverPackage(driverId) {
  if (BUILTIN_DRIVERS.has(driverId)) return { error: "This driver ships with Oak and can't be removed here" };
  const dir = path.join(DRIVERS_DIR, driverId);
  if (!fs.existsSync(dir)) return { error: "No such driver" };
  const inUse = [...instances.values()].some((entry) => entry.spec.driver === driverId);
  if (inUse) return { error: "An instance is still using this driver - remove that instance first" };
  fs.rmSync(dir, { recursive: true, force: true });
  return { ok: true };
}

/** /api/drivers */
async function routes(req, res, parts) {
  if (parts[1] === "drivers" && parts.length === 2 && req.method === "GET") {
    return sendJson(res, 200, listDriverManifests());
  }

  if (parts[1] === "drivers" && parts.length === 2 && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      const result = uploadDriver(body.driverId, body.manifestJson, body.driverJs);
      if (result.error) return sendJson(res, 400, result);
      return sendJson(res, 200, result);
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  if (parts[1] === "drivers" && parts.length === 3 && req.method === "DELETE") {
    const result = deleteDriverPackage(parts[2]);
    if (result.error) return sendJson(res, 400, result);
    return sendJson(res, 200, result);
  }
  res.writeHead(404);
  res.end("Not found");
}

module.exports = { routes, listDriverManifests, uploadDriver, deleteDriverPackage };
