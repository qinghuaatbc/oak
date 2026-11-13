// Where Oak is: "" at a host's root, "/oak-app" behind a proxy that serves it
// at https://example.com/oak-app/ - the folder of the page. Every request
// the pages make goes under it, so Oak works at either.
export const BASE = location.pathname.replace(/\/[^/]*$/, "");

/** A stored URL as this page reaches it: one from the server's root
 *  ("/models/home.glb", "/images/x.png") gets BASE in front; others stay. */
export function oakUrl(url) {
  return typeof url === "string" && url.startsWith("/") && !url.startsWith("//") ? BASE + url : url;
}
