const content = new Map();

self.addEventListener("message", event => {
  const dict = event.data || {};

  for (const [path, value] of Object.entries(dict)) {
    if (path && value !== undefined) {
      content.set(path, value);
    }
  }

  if (Object.keys(dict).length > 0) {
    console.log(`[mock-content-service-worker] message: registered ${Object.keys(dict).length} resource(s): ${Object.keys(dict).join(", ")}`, { event });
  }
});

self.addEventListener("fetch", event => {
  const { pathname } = new URL(event.request.url);
  const value = content.get(pathname);

  if (value !== undefined) {
    console.log(`[mock-content-service-worker] fetch: serving ${pathname} from content store`, { value });
    event.respondWith(
      new Response(value, {
        headers: {
          "Content-Type": "application/javascript"
        }
      })
    );
  }
});
