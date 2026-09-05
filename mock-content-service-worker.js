let content = new Map();

self.addEventListener("message", event => {
  const dict = event.data || {};

  content = new Map(
    Object.entries(dict).filter(([path, value]) => path && value !== undefined)
  );

  console.log(`[mock-content-service-worker] message: replaced content store with ${content.size} resource(s): ${[...content.keys()].join(", ")}`, { event });
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
