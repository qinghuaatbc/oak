# Oak Driver Platform — Spec v0.1

## Purpose and independence note

Oak is an independently designed driver platform: a JSON manifest format
plus a small Node.js runtime for loading and running device-integration
drivers ("Oak drivers"), and (separately, not part of this spec) an
orchestration server in the spirit of a multi-instance driver host.

This spec was written from scratch. It does not reuse any third-party SDK's
file formats, field names, or API surface. Where a driver talks to a real
device (e.g. DSC PowerSeries below), the command codes and checksum
algorithm come from that device vendor's own published protocol
documentation — protocol facts, not another party's code or manifest
schema. Anyone extending this platform should keep that boundary: read the
device vendor's own docs (or your own packet capture of your own hardware),
never a third party's driver implementation.

## Manifest format (`manifest.json`)

One JSON file per driver, next to a `driver.js`. Top-level fields:

- `id` (string) — unique driver identifier
- `displayName` (string)
- `version` (semver string)
- `connection` — describes how an instance is wired up. `kind: "choice"`
  offers the installer several transport options (e.g. network vs. serial),
  each with its own typed `fields` list (`type`: `string`/`number`/`password`).
- `settings` — instance-level configuration fields, same shape as
  `connection.options[].fields`, for things that aren't about the transport
  itself (e.g. a default access code).
- `actions` — things a user/automation can trigger. Each has an `id`,
  `label`, and typed `params`.
- `events` — things the driver can report happened. Each has an `id`,
  `label`, and a list of param names it carries.
- `states` — named values a driver exposes for querying/display. A state
  may be `perInstance` (e.g. per-zone, per-partition) — see the runtime's
  `setState(id, value, instanceKey)`.

This is a single JSON document per driver, not four separate XML files —
one fewer moving part, and no attribute-string dispatch conventions to
remember (no `export="Fn:Variant"` colon-splitting, no `tag=`/`sysvar=`
string-matching). Actions and events are addressed by their own `id`
field directly.

## Runtime API (`runtime/loader.js`)

A driver module (`driver.js`) exports `create(ctx)`, returning an object
with optional `onConnect`, `onDisconnect`, `onData` lifecycle hooks. `ctx`
is passed in explicitly (no implicit globals):

- `ctx.connection` — a `Connection` (`EventEmitter`) wrapping the active
  transport. `.send(text)`, `.close()`, events `"open"`/`"close"`/`"data"`/`"error"`.
- `ctx.clock` — `.every(ms, fn)` / `.after(ms, fn)`, both return `{cancel()}`.
  Every callback registered here is expected to just keep doing its job on
  each tick; there is no self-rearm footgun to remember, unlike a
  restart-yourself timer object.
- `ctx.config` — this instance's resolved connection + settings values.
- `ctx.log(...)`
- `ctx.setState(id, value, instanceKey?)` / `ctx.getState(id, instanceKey?)`
- `ctx.emitEvent(eventId, params)`
- `ctx.onAction(actionId, handler)` — register the function that runs when
  this action is invoked; `handler(params)` is called directly, no
  string-based export lookup.

A `DriverInstance` (also an `EventEmitter`) is what the host application
gets back from `loadDriver(driverDir, config)`. It re-emits `"event"` and
`"state"` for the host to consume, and exposes `.action(id, params)` to
invoke an action from outside.

## What's deliberately different from prior art in this space

- One JSON manifest, not several XML files with different attribute
  dispatch conventions.
- Driver code is a plain CommonJS module exporting a factory function that
  receives its dependencies explicitly (`ctx`) — no implicit global
  objects for I/O, no bespoke scripting-engine subset to target. Any
  current Node.js version runs it directly.
- Naming and call shape for connections/timers/state are original to this
  project (see above) — same general capabilities as any request/response
  driver framework needs, expressed with this project's own vocabulary.

## Verification checklist for new drivers

1. Confirm the device has a vendor-published protocol doc or a standard
   protocol (MQTT, Modbus, UPnP, ONVIF, the device's own published TPI/API
   docs, etc.) — or packet-capture your own owned hardware directly.
2. Write `manifest.json` describing its actions/events/states.
3. Write `driver.js` against that protocol doc only.
4. Run it against a local fake-server test harness (see `example/`) before
   ever touching real hardware.
5. Validate against real hardware — a fake-server test only proves the
   driver speaks the protocol correctly against itself, not that the real
   device agrees.
