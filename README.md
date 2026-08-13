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
- `orchestrator/` — an MVP host that loads a set of instances from
  `config.json` (see `config.example.json`) and exposes them over a REST
  API (`GET /api/instances`, `GET /api/instances/:id/state`,
  `GET /api/instances/:id/events`, `POST /api/instances/:id/action/:actionId`).

## Try it

```sh
node example/demo.js              # dsc-powerseries against a fake Envisalink
node example/demo-http-relay.js   # http-relay against a fake relay device

cp orchestrator/config.example.json orchestrator/config.json
node example/fake-envisalink-server.js &
node example/fake-relay-server.js &
node orchestrator/server.js
```

## Status

Early scaffold — one TCP-transport driver, one HTTP-transport driver, and a
polling-based (not yet WebSocket) orchestrator. Command codes in the DSC
driver beyond login/keepalive/zone/partition status are a plausible
starting point, not yet verified against the official TPI command
reference or real hardware.
