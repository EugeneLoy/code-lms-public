const content = new Map();

self.addEventListener("message", event => {
  const { path, value } = event.data || {};

  if (path && value !== undefined) {
    content.set(path, value);
  }
});

self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);


  if (url.pathname === "/main.js") {
    const value = content.get("/main.js");

    if (value !== undefined) {

      const code = value + "\n\nconsole.log('Program exited.');\n\n"
    
      event.respondWith(
        new Response(code, {
          headers: {
            "Content-Type": "application/javascript"
          }
        })
      );
    }
  }
});
