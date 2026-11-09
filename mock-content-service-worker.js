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
}

function contentTypeForPathname(pathname) {
  const ext = pathname.slice(pathname.lastIndexOf("."))
  return CONTENT_TYPE_MAP[ext] ?? "application/octet-stream"
}

let content = new Map()

self.addEventListener("install", () => {
  console.log(`[mock-content-service-worker] install: skip waiting`)
  self.skipWaiting()
})

self.addEventListener("activate", (event) => {
  console.log(`[mock-content-service-worker] activate: start claiming clients`)
  event.waitUntil(clients.claim())
  console.log(`[mock-content-service-worker] activate: ended claiming clients`)
})

self.addEventListener("message", event => {
  const dict = event.data || {}

  content = new Map(
    Object.entries(dict).filter(([path, value]) => path && value !== undefined)
  )

  console.log(`[mock-content-service-worker] message: replaced content store with ${content.size} resource(s): ${[...content.keys()].join(", ")}`, { event })

  event.ports[0]?.postMessage({ ack: true })

  console.log(`[mock-content-service-worker] message: ack sent`)
})

self.addEventListener("fetch", event => {
  event.respondWith((async () => {
    const client = await clients.get(event.clientId)
    if (client?.frameType !== "nested") {
      console.log(`[mock-content-service-worker] fetch: passing through ${event.request.url} (non-nested frame, frameType=${client?.frameType})`, { event, client })
      return fetch(event.request)
    }

    const { pathname } = new URL(event.request.url)
    const value = content.get(pathname)

    if (value === undefined) {
      console.log(`[mock-content-service-worker] fetch: passing through ${pathname} (not in content store)`, { event })
      return fetch(event.request)
    }

    console.log(`[mock-content-service-worker] fetch: serving ${pathname} from content store`, { event, value })
    return new Response(value, {
      headers: {
        "Content-Type": contentTypeForPathname(pathname)
      }
    })
  })())
})
