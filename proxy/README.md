# FeedNest RSS proxy (optional)

FeedNest reads feeds straight from your browser. That works whenever the feed
host sends `Access-Control-Allow-Origin`. Many hosts do not, and no amount of
client-side code can change that — the browser blocks the response before
JavaScript ever sees it.

This small Cloudflare Worker fixes that specific problem for your own use. It
is **not** an open proxy and it is **not** required: FeedNest is fully usable
without it, for feeds that allow CORS.

## What it does

```
GET https://<worker>.workers.dev/?url=https%3A%2F%2Fexample.com%2Ffeed.xml
```

It fetches the target once, streams it back with permissive CORS headers, and
returns `x-feednest-final-url` so the client knows where redirects landed.

It does not parse, cache, store, or log article content. There is no database
binding in `wrangler.toml` on purpose.

## Security model

| Threat | Mitigation |
| --- | --- |
| SSRF to loopback / LAN / metadata | `src/guard.ts` rejects `localhost`, `*.local`, `*.internal`, `metadata.google.internal`, RFC1918, CGNAT, link-local (`169.254.0.0/16`), multicast, `[::1]`, `fc00::/7`, `fe80::/10` and IPv4-mapped private IPv6 |
| DNS tricks / decimal IPs | numeric and hex host forms are rejected; the Cloudflare runtime cannot reach a customer's private network in the first place |
| Redirect to an internal target | redirects are followed **manually**, one hop at a time, and every `Location` is re-validated |
| Open relay abuse | only `GET`/`HEAD`; only `http(s)`; no credentials in the URL; ports limited to 80/443/8080/8443 |
| Huge responses | declared and streamed bodies are capped (2 MB default, configurable) |
| Slow upstreams | 10 s abort budget for the whole chain |
| Non-feed traffic | content types restricted to RSS/Atom/RDF/XML/HTML |
| Request floods | best-effort per-IP limiter (120/min), plus Cloudflare's own edge protections |
| Data retention | no caching, no logging of bodies, `cache-control: no-store` |

The per-IP limiter lives in isolate memory, so it is coarse. If you need a
hard guarantee, put Cloudflare's Rate Limiting rules in front of the worker.

## Deploy

```bash
cd proxy
npm install
npx wrangler login          # or: export CLOUDFLARE_API_TOKEN=...
npx wrangler deploy
```

Then in FeedNest: **Settings → Fetching & CORS → Proxy URL**, paste the
`https://…workers.dev` URL and press **Test proxy**.

### Local development

```bash
cd proxy
npm install
npx wrangler dev            # http://127.0.0.1:8787
```

Point FeedNest at `http://127.0.0.1:8787` while developing.

## Cost

Workers Free is enough for personal reading. Check
<https://developers.cloudflare.com/workers/platform/limits/> for the current
request and CPU limits before depending on it.

## Tests

The guard and the request handler are covered by the main test suite:

```bash
npm test -- tests/proxy.test.ts
```
