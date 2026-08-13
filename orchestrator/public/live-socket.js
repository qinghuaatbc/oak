// Shared WS client for admin.js/live.js - browser-native WebSocket, no
// library needed. Reconnects with a fixed 2s backoff on drop.
export function connectLiveSocket(onMessage) {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  function connect() {
    const ws = new WebSocket(`${proto}//${location.host}/ws`);
    ws.onmessage = (ev) => {
      try {
        onMessage(JSON.parse(ev.data));
      } catch (err) {
        console.error("bad WS message", err);
      }
    };
    ws.onclose = () => setTimeout(connect, 2000);
    ws.onerror = () => ws.close();
  }
  connect();
}
