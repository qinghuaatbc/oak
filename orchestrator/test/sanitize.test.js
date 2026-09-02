// Unit tests for server.js's pure validation functions (sanitizeWidget/
// sanitizePage/sanitizeMeshBinding/sanitizeGlbScene/sanitizeLayoutBackground).
// No server, no network - these are plain functions in, object out, exactly
// the kind of thing that should never need a mock. Run with:
//   node --test orchestrator/test/
// Uses node:test/node:assert - both built into Node (18+), no dependency
// added for this, matching the same reasoning as this session's own
// v8-mini-node/test.sh (dependency-free real assertions over mocking).
const test = require("node:test");
const assert = require("node:assert/strict");
const { sanitizeWidget, sanitizePage, sanitizeMeshBinding, sanitizeGlbScene, sanitizeLayoutBackground } = require("../server.js");

const CAT_IDS = ["light", "switch", "climate"];

test("sanitizeWidget: a valid slot widget round-trips", () => {
  const out = sanitizeWidget({ type: "slot", cat: "light", slotId: "abc123", x: 2, y: 3, w: 4, h: 2 }, CAT_IDS);
  assert.equal(out.type, "slot");
  assert.equal(out.cat, "light");
  assert.equal(out.slotId, "abc123");
  assert.equal(out.x, 2);
  assert.equal(out.y, 3);
});

test("sanitizeWidget: rejects a slot widget with an unknown category", () => {
  assert.equal(sanitizeWidget({ type: "slot", cat: "not-a-real-category", slotId: "abc123" }, CAT_IDS), null);
});

test("sanitizeWidget: rejects an unknown widget type entirely", () => {
  assert.equal(sanitizeWidget({ type: "not-a-real-type" }, CAT_IDS), null);
});

test("sanitizeWidget: clamps x/y/w/h into their valid ranges instead of trusting raw input", () => {
  const out = sanitizeWidget({ type: "label", text: "hi", x: 999, y: -50, w: -5, h: -5 }, CAT_IDS);
  assert.equal(out.x, 11); // clamped to the 12-column grid's last valid index
  assert.equal(out.y, 0); // clamped to >= 0
  assert.equal(out.w, 1); // clamped to >= 1 (a negative w clamps; 0 specifically hits `|| 2`'s falsy
  assert.equal(out.h, 1); // fallback instead, since 0 is falsy in JS - a separate, real quirk, not covered here)
});

test("sanitizeWidget: a label's text is truncated, not rejected, past the length cap", () => {
  const out = sanitizeWidget({ type: "label", text: "x".repeat(500) }, CAT_IDS);
  assert.equal(out.text.length, 200);
});

test("sanitizePage: accepts the original flat-image background shape", () => {
  const out = sanitizePage({ id: "p1", name: "Living Room", background: { url: "/uploads/bg.jpg" }, widgets: [] }, CAT_IDS);
  assert.deepEqual(out.background, { url: "/uploads/bg.jpg" });
});

test("sanitizePage: accepts the newer 3D-scene background shape", () => {
  const out = sanitizePage({ id: "p1", name: "Living Room", background: { type: "3d", glbId: "scene-1" }, widgets: [] }, CAT_IDS);
  assert.deepEqual(out.background, { type: "3d", glbId: "scene-1" });
});

test("sanitizePage: a malformed background becomes null, not thrown away silently as something else", () => {
  assert.equal(sanitizePage({ id: "p1", name: "x", background: { type: "3d" /* no glbId */ }, widgets: [] }, CAT_IDS).background, null);
  assert.equal(sanitizePage({ id: "p1", name: "x", background: { nonsense: true }, widgets: [] }, CAT_IDS).background, null);
  assert.equal(sanitizePage({ id: "p1", name: "x", background: null, widgets: [] }, CAT_IDS).background, null);
});

test("sanitizePage: filters out invalid widgets rather than rejecting the whole page", () => {
  const out = sanitizePage(
    { id: "p1", name: "x", widgets: [{ type: "label", text: "keep me" }, { type: "not-real" }, { type: "slot", cat: "no-such-cat", slotId: "x" }] },
    CAT_IDS
  );
  assert.equal(out.widgets.length, 1);
  assert.equal(out.widgets[0].text, "keep me");
});

test("sanitizeMeshBinding: valid {cat,id} pointer round-trips", () => {
  const out = sanitizeMeshBinding({ cat: "light", id: "slot-1", animType: "" }, CAT_IDS);
  assert.deepEqual(out, { cat: "light", id: "slot-1", animType: "" });
});

test("sanitizeMeshBinding: rejects a binding pointing at an unknown category", () => {
  assert.equal(sanitizeMeshBinding({ cat: "no-such-cat", id: "slot-1" }, CAT_IDS), undefined);
});

test("sanitizeGlbScene: sanitizes every mesh binding inside, dropping only the bad ones", () => {
  const out = sanitizeGlbScene(
    {
      id: "scene-1",
      name: "Living Room",
      url: "/uploads/room.glb",
      meshBindings: { GoodMesh: { cat: "light", id: "slot-1" }, BadMesh: { cat: "no-such-cat", id: "slot-2" } },
    },
    CAT_IDS
  );
  assert.deepEqual(Object.keys(out.meshBindings), ["GoodMesh"]);
});

test("sanitizeLayoutBackground: loosely validates a 3D background the same way pageLink's targetPageId is (type-checked, not existence-checked)", () => {
  // No real glbId list is threaded through here on purpose - matches the
  // existing precedent for pageLink's targetPageId (see server.js's own
  // comment on sanitizeLayoutBackground). Confirms that precedent still
  // holds, not that it's the only possible design.
  assert.deepEqual(sanitizeLayoutBackground({ type: "3d", glbId: "anything-at-all" }), { type: "3d", glbId: "anything-at-all" });
  assert.equal(sanitizeLayoutBackground({ type: "3d", glbId: "" }), null);
  assert.equal(sanitizeLayoutBackground({ type: "3d" }), null);
});
