let content = new Map();

self.addEventListener("install", () => {
  console.log(`[mock-content-service-worker] install: skip waiting`);
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  console.log(`[mock-content-service-worker] activate: start claiming clients`);
  event.waitUntil(clients.claim());
  console.log(`[mock-content-service-worker] activate: ended claiming clients`);
});

self.addEventListener("message", event => {
  const dict = event.data || {};

  content = new Map(
    Object.entries(dict).filter(([path, value]) => path && value !== undefined)
  );

  console.log(`[mock-content-service-worker] message: replaced content store with ${content.size} resource(s): ${[...content.keys()].join(", ")}`, { event });
});

// TODO revise types
const CONTENT_TYPE_MAP = {
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".ts": "application/typescript",
  ".json": "application/json",
  ".html": "text/html",
  ".css": "text/css",
  ".txt": "text/plain",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".wasm": "application/wasm",
};

function contentTypeForPathname(pathname) {
  const ext = pathname.slice(pathname.lastIndexOf("."));
  return CONTENT_TYPE_MAP[ext] ?? "application/octet-stream";
}

self.addEventListener("fetch", event => {
  const { pathname } = new URL(event.request.url);
  const value = content.get(pathname);

  if (value !== undefined) {
    console.log(`[mock-content-service-worker] fetch: serving ${pathname} from content store`, { value });
    event.respondWith(
      new Response(value, {
        headers: {
          "Content-Type": contentTypeForPathname(pathname)
        }
      })
    );
  }
});
