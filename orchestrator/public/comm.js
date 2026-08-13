"use strict";

// 1:1 WebRTC video/voice calling + text chat between live.html sessions of
// the same household, connected to this same Oak orchestrator, plus Web
// Push to wake a backgrounded/locked device - ported directly from QTI's
// own public/comm.js, which itself already solved the real problems here
// (mobile autoplay/gesture policies, AudioContext suspension, SDP/ICE
// relay over an existing WS channel instead of a second transport). v1
// scope, same as QTI's: 1:1 calls + text chat, no group calls.
//
// Presence/signaling state lives entirely on the server in memory (see
// server.js's commUsers Map) - a WS reconnect means re-registering.

const FALLBACK_ICE = [{ urls: "stun:stun.l.google.com:19302" }, { urls: "stun:stun1.l.google.com:19302" }];

// Distinct from the ephemeral per-WS-session clientId the server assigns
// on every commRegister - this one is generated once and kept in
// localStorage so a push subscription (and the server's offline-device
// registry) can still find "this device" after its WS connection is gone.
function getDeviceId() {
  let id = localStorage.getItem("oak_comm_device_id");
  if (!id) {
    id = Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem("oak_comm_device_id", id);
  }
  return id;
}

const pushSupported = typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

function urlBase64ToBuffer(base64) {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(b64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr.buffer;
}

export function createCommPanel({ WS, langZh }) {
  let selfId = null;
  const deviceId = getDeviceId();
  let displayName = localStorage.getItem("oak_comm_name") || "Guest-" + Math.random().toString(36).slice(2, 6);
  let pushSubscribed = false;
  let users = []; // {clientId, displayName} - excludes self
  const messages = []; // {from, fromName, to, text, timestamp} - in-memory only, cleared on reload
  let unreadCount = 0;
  let panelOpen = false;
  let activeChatTarget = null; // null = group/everyone, else a clientId

  let callState = "idle"; // idle | calling | incoming | connected
  let callPeer = null; // {clientId, displayName}
  let incomingVideo = false;
  let pc = null;
  let localStream = null;
  let pendingIce = [];
  let iceServers = null;
  let ringtoneCtx = null;
  let ringtoneInterval = null;
  let callTimeoutTimer = null;
  const CALL_TIMEOUT_MS = 45000;

  function clearCallTimeout() {
    if (callTimeoutTimer) {
      clearTimeout(callTimeoutTimer);
      callTimeoutTimer = null;
    }
  }

  function showTransientCallEnd(text) {
    callStateEl.textContent = text;
    callActionsEl.innerHTML = "";
    setTimeout(() => {
      if (callState !== "idle") endCall();
    }, 2200);
  }

  const commBtn = document.getElementById("commBtn");
  const unreadDot = document.getElementById("commUnreadDot");
  const panel = document.getElementById("commPanel");
  const panelClose = document.getElementById("commPanelClose");
  const nameInput = document.getElementById("commNameInput");
  const pushToggle = document.getElementById("commPushToggle");
  const usersEl = document.getElementById("commUsers");
  const chatTargetEl = document.getElementById("commChatTarget");
  const chatTargetLabelEl = document.getElementById("commChatTargetLabel");
  const chatTargetClearEl = document.getElementById("commChatTargetClear");
  const chatEl = document.getElementById("commChat");
  const chatInput = document.getElementById("commChatInput");
  const chatSend = document.getElementById("commChatSend");
  const overlay = document.getElementById("commCallOverlay");
  const callNameEl = document.getElementById("commCallName");
  const callStateEl = document.getElementById("commCallState");
  const remoteVideoEl = document.getElementById("commRemoteVideo");
  const localVideoEl = document.getElementById("commLocalVideo");
  const callActionsEl = document.getElementById("commCallActions");

  function playRingBurst(ctx) {
    const now = ctx.currentTime;
    const gain = ctx.createGain();
    gain.connect(ctx.destination);
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.1, now + 0.02);
    gain.gain.setValueAtTime(0.1, now + 1.9);
    gain.gain.linearRampToValueAtTime(0, now + 2);
    [440, 480].forEach((freq) => {
      const osc = ctx.createOscillator();
      osc.frequency.value = freq;
      osc.connect(gain);
      osc.start(now);
      osc.stop(now + 2);
    });
  }

  function playRingtone() {
    stopRingtone();
    try {
      if (!ringtoneCtx) ringtoneCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (ringtoneCtx.state === "suspended") ringtoneCtx.resume().catch(() => {});
      playRingBurst(ringtoneCtx);
      ringtoneInterval = setInterval(() => {
        if (!ringtoneCtx) return;
        if (ringtoneCtx.state === "suspended") ringtoneCtx.resume().catch(() => {});
        playRingBurst(ringtoneCtx);
      }, 6000);
    } catch (e) {
      /* autoplay/audio policy blocked - visual ring UI still shows */
    }
  }
  function stopRingtone() {
    if (ringtoneInterval) {
      clearInterval(ringtoneInterval);
      ringtoneInterval = null;
    }
  }
  function unlockRingtoneAudio() {
    if (ringtoneCtx) return;
    try {
      ringtoneCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (ringtoneCtx.state === "suspended") ringtoneCtx.resume().catch(() => {});
    } catch (e) {}
  }

  async function getIceServers() {
    if (iceServers) return iceServers;
    try {
      const res = await WS.request("commGetIceServers", {});
      iceServers = (res && res.iceServers) || FALLBACK_ICE;
    } catch (e) {
      iceServers = FALLBACK_ICE;
    }
    return iceServers;
  }

  async function register() {
    if (callState !== "idle") endCall();
    try {
      const res = await WS.request("commRegister", { displayName, deviceId });
      selfId = res.clientId;
    } catch (e) {
      /* WS.onStatus(true) retries this on the next reconnect */
    }
  }

  // ---------------------------------------------------------------------
  // Web Push - lets an incoming call/message wake this device even when the
  // live.html tab is backgrounded or the screen is locked. requestPermission/
  // subscribe only need to run once (the subscription is what server-side
  // push.js persists); this just mirrors the current OS-level subscription
  // state into pushToggle rather than re-subscribing on every visit.
  // ---------------------------------------------------------------------
  async function refreshPushToggleState() {
    pushToggle.classList.toggle("sky-hidden", !pushSupported);
    if (!pushSupported) return;
    try {
      const reg = await navigator.serviceWorker.ready;
      const existing = await reg.pushManager.getSubscription();
      pushSubscribed = !!existing;
    } catch (e) {
      pushSubscribed = false;
    }
    renderPushToggle();
  }
  function renderPushToggle() {
    const zh = langZh();
    pushToggle.textContent = pushSubscribed ? (zh ? "🔔 通知已开启" : "🔔 Notifications on") : zh ? "🔕 开启通知" : "🔕 Enable notifications";
    pushToggle.classList.toggle("active", pushSubscribed);
  }
  async function togglePush() {
    if (!pushSupported) return;
    try {
      await navigator.serviceWorker.register("sw.js");
      const reg = await navigator.serviceWorker.ready;
      const existing = await reg.pushManager.getSubscription();
      if (pushSubscribed && existing) {
        await WS.request("commPushUnsubscribe", { deviceId }).catch(() => {});
        await existing.unsubscribe();
        pushSubscribed = false;
      } else {
        const permission = await Notification.requestPermission();
        if (permission !== "granted") {
          renderPushToggle();
          return;
        }
        const keyRes = await WS.request("commGetVapidKey", {});
        const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToBuffer(keyRes.key) });
        const j = sub.toJSON();
        await WS.request("commPushSubscribe", { deviceId, endpoint: j.endpoint, keys: j.keys });
        pushSubscribed = true;
      }
    } catch (e) {
      console.error("comm push toggle failed:", e);
    }
    renderPushToggle();
  }

  async function ensurePc() {
    const ice = await getIceServers();
    const conn = new RTCPeerConnection({ iceServers: ice });
    conn.onicecandidate = (ev) => {
      if (ev.candidate && callPeer) {
        WS.request("commSignal", { to: callPeer.clientId, signalType: "ice-candidate", payload: ev.candidate }).catch(() => {});
      }
    };
    conn.ontrack = (ev) => {
      remoteVideoEl.srcObject = ev.streams[0];
      remoteVideoEl.play().catch(() => {});
    };
    conn.onconnectionstatechange = () => {
      if ((conn.connectionState === "disconnected" || conn.connectionState === "failed" || conn.connectionState === "closed") && callState === "connected") {
        endCall();
      }
    };
    return conn;
  }

  async function flushPendingIce() {
    if (!pc || !pc.remoteDescription) return;
    for (const cand of pendingIce) {
      try {
        await pc.addIceCandidate(cand);
      } catch (e) {
        /* stale candidate, harmless */
      }
    }
    pendingIce = [];
  }

  function primeVideoPlayback() {
    localVideoEl.play().catch(() => {});
    remoteVideoEl.play().catch(() => {});
  }

  async function startCall(peer, video) {
    if (callState !== "idle") return;
    primeVideoPlayback();
    callPeer = peer;
    callState = "calling";
    incomingVideo = video;
    render();
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: video ? { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } } : false });
    } catch (e) {
      alert("Could not access camera/microphone: " + (e && e.message ? e.message : e));
      callState = "idle";
      callPeer = null;
      render();
      return;
    }
    localVideoEl.srcObject = localStream;
    localVideoEl.play().catch(() => {});
    pc = await ensurePc();
    for (const track of localStream.getTracks()) pc.addTrack(track, localStream);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await WS.request("commSignal", { to: peer.clientId, signalType: "offer", payload: { sdp: offer, video } });
    clearCallTimeout();
    callTimeoutTimer = setTimeout(() => {
      if (callState !== "calling") return;
      WS.request("commSignal", { to: peer.clientId, signalType: "timeout", payload: {} }).catch(() => {});
      showTransientCallEnd(langZh() ? "无应答" : "No answer");
    }, CALL_TIMEOUT_MS);
  }

  async function acceptCall() {
    if (callState !== "incoming" || !callPeer || !pc) return;
    stopRingtone();
    primeVideoPlayback();
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: incomingVideo ? { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } } : false });
    } catch (e) {
      alert("Could not access camera/microphone: " + (e && e.message ? e.message : e));
      hangup();
      return;
    }
    localVideoEl.srcObject = localStream;
    localVideoEl.play().catch(() => {});
    for (const track of localStream.getTracks()) pc.addTrack(track, localStream);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await WS.request("commSignal", { to: callPeer.clientId, signalType: "answer", payload: { sdp: answer } });
    clearCallTimeout();
    callState = "connected";
    render();
  }

  function hangup() {
    if (callPeer) WS.request("commSignal", { to: callPeer.clientId, signalType: "hangup", payload: {} }).catch(() => {});
    endCall();
  }
  function declineCall() {
    if (callPeer) WS.request("commSignal", { to: callPeer.clientId, signalType: "decline", payload: {} }).catch(() => {});
    endCall();
  }
  function endCall() {
    clearCallTimeout();
    stopRingtone();
    if (pc) {
      try {
        pc.close();
      } catch (e) {}
      pc = null;
    }
    if (localStream) {
      localStream.getTracks().forEach((t) => t.stop());
      localStream = null;
    }
    localVideoEl.srcObject = null;
    remoteVideoEl.srcObject = null;
    callState = "idle";
    callPeer = null;
    incomingVideo = false;
    pendingIce = [];
    render();
  }

  async function handleSignal(msg) {
    const { from, signalType, payload } = msg;
    if (signalType === "offer") {
      if (callState !== "idle") {
        WS.request("commSignal", { to: from, signalType: "busy", payload: {} }).catch(() => {});
        return;
      }
      const peerUser = users.find((u) => u.clientId === from) || { clientId: from, displayName: "Someone" };
      callPeer = peerUser;
      callState = "incoming";
      incomingVideo = !!(payload && payload.video);
      pc = await ensurePc();
      await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
      await flushPendingIce();
      render();
      playRingtone();
      clearCallTimeout();
      callTimeoutTimer = setTimeout(() => {
        if (callState !== "incoming" || !callPeer || callPeer.clientId !== from) return;
        endCall();
      }, CALL_TIMEOUT_MS + 15000);
    } else if (signalType === "answer") {
      if (!pc || callState !== "calling") return;
      clearCallTimeout();
      await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
      await flushPendingIce();
      callState = "connected";
      render();
    } else if (signalType === "ice-candidate") {
      if (pc && pc.remoteDescription) {
        try {
          await pc.addIceCandidate(payload);
        } catch (e) {}
      } else {
        pendingIce.push(payload);
      }
    } else if (signalType === "hangup") {
      if (callPeer && callPeer.clientId === from) endCall();
    } else if (signalType === "busy" || signalType === "decline") {
      if (callPeer && callPeer.clientId === from) {
        clearCallTimeout();
        const zh = langZh();
        showTransientCallEnd(callPeer.displayName + " " + (signalType === "busy" ? (zh ? "忙线中" : "is busy") : zh ? "已拒绝" : "declined"));
      }
    } else if (signalType === "timeout") {
      if (callState === "incoming" && callPeer && callPeer.clientId === from) {
        showTransientCallEnd(langZh() ? "未接来电" : "Missed call");
      }
    }
  }

  function sendChat() {
    const text = chatInput.value;
    if (!text.trim()) return;
    WS.request("commChatMessage", { text, to: activeChatTarget || undefined }).catch(() => {});
    chatInput.value = "";
  }
  function setChatTarget(clientId) {
    activeChatTarget = clientId || null;
    renderChatTarget();
    renderChat();
  }
  function renderChatTarget() {
    if (!chatTargetEl) return;
    const zh = langZh();
    if (!activeChatTarget) {
      chatTargetLabelEl.textContent = zh ? "所有人" : "Everyone";
      chatTargetClearEl.classList.add("sky-hidden");
      chatInput.placeholder = zh ? "给所有人发消息…" : "Message everyone…";
      return;
    }
    const peer = users.find((u) => u.clientId === activeChatTarget);
    chatTargetLabelEl.textContent = peer ? peer.displayName : zh ? "那个人" : "that person";
    chatTargetClearEl.classList.remove("sky-hidden");
    chatInput.placeholder = (zh ? "给 " : "Message ") + (peer ? peer.displayName : zh ? "对方" : "them") + (zh ? " 发消息…" : "…");
  }
  function handleChatMessage(msg) {
    messages.push(msg);
    if (messages.length > 200) messages.shift();
    if (!panelOpen && msg.from !== selfId) unreadCount++;
    renderChat();
    renderUnread();
  }
  async function loadChatHistory() {
    try {
      const res = await WS.request("commGetChatHistory", {});
      messages.length = 0;
      for (const m of res.messages || []) messages.push(m);
      if (messages.length > 200) messages.splice(0, messages.length - 200);
      renderChat();
    } catch (e) {
      /* acceptable - it's just history */
    }
  }

  function renderUnread() {
    unreadDot.classList.toggle("show", unreadCount > 0);
  }
  function renderUsers() {
    if (activeChatTarget && !users.some((u) => u.clientId === activeChatTarget)) {
      activeChatTarget = null;
      renderChat();
    }
    usersEl.innerHTML = "";
    if (!users.length) {
      const empty = document.createElement("div");
      empty.className = "comm-empty";
      empty.textContent = langZh() ? "现在没有其他设备在线。" : "No other devices online right now.";
      usersEl.appendChild(empty);
      renderChatTarget();
      return;
    }
    users.forEach((u) => {
      const row = document.createElement("div");
      row.className = "comm-user-row" + (activeChatTarget === u.clientId ? " active-chat-target" : "");
      const name = document.createElement("span");
      name.className = "comm-user-name";
      name.textContent = u.displayName;
      const msgBtn = document.createElement("button");
      msgBtn.className = "comm-call-btn";
      msgBtn.textContent = "💬";
      msgBtn.title = (langZh() ? "私信 " : "Message ") + u.displayName;
      msgBtn.addEventListener("click", () => setChatTarget(activeChatTarget === u.clientId ? null : u.clientId));
      const voiceBtn = document.createElement("button");
      voiceBtn.className = "comm-call-btn";
      voiceBtn.textContent = "📞";
      voiceBtn.title = langZh() ? "语音通话" : "Voice call";
      voiceBtn.addEventListener("click", () => startCall(u, false));
      const videoBtn = document.createElement("button");
      videoBtn.className = "comm-call-btn";
      videoBtn.textContent = "🎥";
      videoBtn.title = langZh() ? "视频通话" : "Video call";
      videoBtn.addEventListener("click", () => startCall(u, true));
      row.append(name, msgBtn, voiceBtn, videoBtn);
      usersEl.appendChild(row);
    });
    renderChatTarget();
  }
  function renderChat() {
    chatEl.innerHTML = "";
    const visible = messages.filter((m) => {
      if (!activeChatTarget) return !m.to;
      return (m.from === selfId && m.to === activeChatTarget) || (m.from === activeChatTarget && m.to === selfId);
    });
    visible.forEach((m) => {
      if (m.system) {
        const sysRow = document.createElement("div");
        sysRow.className = "comm-msg-system";
        sysRow.textContent = m.text;
        chatEl.appendChild(sysRow);
        return;
      }
      const row = document.createElement("div");
      row.className = "comm-msg" + (m.from === selfId ? " self" : "");
      const meta = document.createElement("div");
      meta.className = "comm-msg-meta";
      meta.textContent = (m.from === selfId ? (langZh() ? "我" : "You") : m.fromName) + " · " + new Date(m.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      const text = document.createElement("div");
      text.className = "comm-msg-text";
      text.textContent = m.text;
      row.append(meta, text);
      chatEl.appendChild(row);
    });
    chatEl.scrollTop = chatEl.scrollHeight;
  }
  function renderCallOverlay() {
    overlay.classList.toggle("sky-hidden", callState === "idle");
    if (callState === "idle") return;
    const zh = langZh();
    callNameEl.textContent = callPeer ? callPeer.displayName : "";
    callStateEl.textContent =
      callState === "calling" ? (zh ? "呼叫中…" : "Calling…") : callState === "incoming" ? (zh ? "来电（" + (incomingVideo ? "视频" : "语音") + "）" : "Incoming " + (incomingVideo ? "video" : "voice") + " call") : zh ? "已接通" : "Connected";
    remoteVideoEl.classList.toggle("sky-hidden", callState !== "connected" || !incomingVideo);
    localVideoEl.classList.toggle("sky-hidden", callState === "incoming" || !incomingVideo);
    callActionsEl.innerHTML = "";
    function actionBtn(label, cls, fn) {
      const b = document.createElement("button");
      b.className = "comm-call-action " + cls;
      b.textContent = label;
      b.addEventListener("click", fn);
      callActionsEl.appendChild(b);
    }
    if (callState === "incoming") {
      actionBtn(zh ? "拒绝" : "Decline", "decline", declineCall);
      actionBtn(zh ? "接听" : "Accept", "accept", acceptCall);
    } else {
      actionBtn(zh ? "挂断" : "Hang Up", "decline", hangup);
    }
  }
  function render() {
    renderUsers();
    renderCallOverlay();
  }

  function setPanelOpen(open) {
    panelOpen = open;
    panel.classList.toggle("sky-hidden", !open);
    commBtn.classList.toggle("active", open);
    if (open) {
      unreadCount = 0;
      renderUnread();
    }
  }

  document.addEventListener("pointerdown", unlockRingtoneAudio, { once: true });
  document.addEventListener("click", unlockRingtoneAudio, { once: true });
  commBtn.addEventListener("click", () => setPanelOpen(!panelOpen));
  panelClose.addEventListener("click", () => setPanelOpen(false));
  chatSend.addEventListener("click", sendChat);
  chatInput.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") sendChat();
  });
  if (chatTargetClearEl) chatTargetClearEl.addEventListener("click", () => setChatTarget(null));
  nameInput.value = displayName;
  nameInput.addEventListener("change", () => {
    const v = nameInput.value.trim().slice(0, 40);
    if (!v) {
      nameInput.value = displayName;
      return;
    }
    displayName = v;
    localStorage.setItem("oak_comm_name", displayName);
    register();
  });
  pushToggle.addEventListener("click", togglePush);

  WS.onPush((msg) => {
    if (msg.type === "commUsers") {
      users = (msg.users || []).filter((u) => u.clientId !== selfId);
      renderUsers();
    } else if (msg.type === "commSignal") {
      handleSignal(msg).catch((e) => console.error("comm signal error:", e));
    } else if (msg.type === "commChatMessage") {
      handleChatMessage(msg);
    }
  });
  WS.onStatus((connected) => {
    if (connected) register();
  });

  return {
    init() {
      register();
      render();
      loadChatHistory();
      refreshPushToggleState();
    },
    refreshLangText() {
      renderChatTarget();
      renderChat();
      renderUsers();
      if (pushSupported) renderPushToggle();
    },
  };
}
