# Oak

A small, independently-designed driver platform: a JSON manifest format for
describing a device integration, a sandboxed Node.js runtime for running
driver code against it, and an orchestrator that hosts multiple driver
instances behind a REST API.

See [SPEC.md](./SPEC.md) for the manifest/runtime design and an explicit
note on independence from any third-party driver SDK.

## Layout

- `runtime/loader.js` — loads a manifest + `driver.js`, runs the driver in
  its own `vm.Context`, wires it to a TCP `Connection` or an `HttpClient`
  depending on the manifest's declared transport, and isolates every
  callback into driver code so one bad driver can't crash the host.
- `drivers/dsc-powerseries/` — example driver over a persistent TCP socket
  (DSC PowerSeries via Envisalink's TPI protocol).
- `drivers/http-relay/` — example driver over plain request/response HTTP
  (a generic local-network relay/switch), with polling instead of pushed
  events — proves the platform isn't secretly TCP-shaped underneath.
- `example/` — standalone fake device servers plus small end-to-end demo
  scripts, so each driver can be exercised without any real hardware.
- `orchestrator/` — the host that loads a set of instances from
  `config.json` (see `config.example.json`) and exposes them over a REST
  API (`GET /api/instances`, `GET /api/instances/:id/state`,
  `GET /api/instances/:id/events`, `POST /api/instances/:id/action/:actionId`)
  and a WebSocket at `/ws`. One file per job:

  | File | What it does |
  |---|---|
  | `server.js` | starts everything, checks the login, hands each `/api/<name>` request to its module, `/ws` |
  | `instances.js` | the configured instances (add, start, stop, edit, remove, save), `/api/instances`, `/api/health` |
  | `automations.js` | macros, automations, sunrise/sunset, time triggers, `/api/macros`, `/api/automations`, `/api/settings` |
  | `bindings.js` | Dashboard slots, 3D scenes, Layout pages, `/api/bindings` |
  | `drivers.js` | driver packages, `/api/drivers` |
  | `cameras.js` | cameras and ffmpeg, `/api/cameras`, `/camera-ws` |
  | `files.js` | the pages in `public/`, uploaded models and images |
  | `comm.js` | calls, chat and push between `live.html` sessions |
  | `auth.js` | login and sessions |
  | `broadcast.js`, `http-util.js` | `broadcast()` to every `/ws` client; JSON helpers |

  `npm test` runs the tests in `orchestrator/test/`. With `jsconfig.json`,
  VS Code type-checks the orchestrator and runtime from their JSDoc types.

## Install

The install script sets up Node.js (if it's missing), clones the repo,
installs dependencies, and registers Oak as a background service that
starts on boot/login and restarts on crash — systemd on Linux, launchd on
macOS, Task Scheduler on Windows.

**Linux — Debian, Ubuntu, or Raspberry Pi OS** (Raspberry Pi OS is
Debian-based with systemd, so this is the exact same installer and command —
nothing Pi-specific to do; on anything else without systemd it exits with
manual steps instead of failing partway through):

```sh
curl -fsSL https://raw.githubusercontent.com/qinghuaatbc/oak/main/scripts/install.sh | bash
```

**macOS** (registered as a launchd LaunchAgent instead of a systemd service;
uses Homebrew for Node.js if it's missing but won't install Homebrew itself;
never needs sudo):

```sh
curl -fsSL https://raw.githubusercontent.com/qinghuaatbc/oak/main/scripts/install-macos.sh | bash
```

**Windows** (registered as a per-user Scheduled Task with an AtLogOn
trigger; uses winget for Node.js if it's missing but won't install winget
itself; never needs Administrator):

```powershell
irm https://raw.githubusercontent.com/qinghuaatbc/oak/main/scripts/install-windows.ps1 | iex
```

**Or clone first, run locally** — same result on any OS, useful if you want
to read the script before running it:

```sh
git clone https://github.com/qinghuaatbc/oak.git ~/oak-app/oak
~/oak-app/oak/scripts/install.sh                # Linux, defaults to port 8702
~/oak-app/oak/scripts/install-macos.sh 8080     # macOS, or pick your own port
~/oak-app/oak/scripts/install-windows.ps1 -Port 8080   # Windows, PowerShell
```

Once installed, open the admin panel from any device on the same network:

```
http://<machine-ip>:8702/admin.html   # configure drivers, dashboard, layout
http://<machine-ip>:8702/live.html    # the day-to-day control surface
```

On a first install the script asks for a username and password — that's
the login for both pages. It's saved in `orchestrator/admin.json`, the
password only as a salted hash. Change it any time, no restart needed:

```sh
node ~/oak-app/oak/scripts/set-login.js
```

Re-run the same script any time to update — it's idempotent, pulling the
latest code, reinstalling dependencies, and restarting the service:

```sh
~/oak-app/oak/scripts/install.sh          # Linux
~/oak-app/oak/scripts/install-macos.sh    # macOS
~/oak-app/oak/scripts/install-windows.ps1 # Windows
```

## Try it (from source, without installing as a service)

```sh
node example/demo.js              # dsc-powerseries against a fake Envisalink
node example/demo-http-relay.js   # http-relay against a fake relay device

cp orchestrator/config.example.json orchestrator/config.json
node example/fake-envisalink-server.js &
node example/fake-relay-server.js &
node orchestrator/server.js
```

## Status

147 built-in drivers (`drivers/`), each a manifest + sandboxed `vm.Context`
instance, hosted behind one orchestrator (`orchestrator/server.js`) with a
WebSocket-backed live dashboard, an admin panel, a drag-and-drop Layout
builder, and 3D scene mesh-binding (including binding a device to a mesh
directly by dragging it onto the 3D view from the Layout editor). Under
active development, not a finished product — some driver command sets are a
plausible starting point rather than verified against every device's full
protocol; see each driver's own manifest for what's actually been tested
against real hardware.
