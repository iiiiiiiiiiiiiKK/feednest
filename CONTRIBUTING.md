# Contributing to FeedNest

Thanks for taking a look. FeedNest is deliberately small: a static React app,
IndexedDB for storage, and one optional Cloudflare Worker. Keep it that way.

## Ground rules

1. **Local-first is non-negotiable.** No accounts, no telemetry, no server-side
   storage of subscriptions or reading history.
2. **Be honest in the UI.** A CORS failure is a CORS failure; a summary is a
   summary. Do not paper over a failed request with a success toast.
3. **No new runtime dependency without a reason.** Prefer the platform.
4. **Tests come with behaviour.** Pure logic goes in `src/lib` or
   `src/state/selectors.ts` and gets a Vitest test; user flows get a Playwright
   test.

## Development

```bash
npm ci
npm run dev
```

Before opening a pull request:

```bash
npm run lint
npm run typecheck
npm test
npm run test:e2e     # builds first; needs Playwright browsers
```

## Style

- TypeScript strict mode, no `any`.
- Components stay under ~250 lines; extract hooks or subcomponents instead.
- Tailwind utility classes with the design tokens in `src/index.css`
  (`bg-bg`, `text-ink-muted`, `border-line`, `bg-accent`…). Do not hard-code
  colours that break the dark theme.
- Comments explain *why*, not *what* the next line does.

## Adding a feed parsing case

Add the sample to `tests/fixtures/`, extend `tests/parse.test.ts`, then adjust
`src/lib/parse.ts`. If the sample reveals a real-world quirk, mention the host in
a comment so the next person knows why the code is defensive there.

## Security

- Anything that fetches user-provided URLs must go through
  `src/lib/url.ts#assertSafeRemoteUrl` or `proxy/src/guard.ts#checkTargetUrl`.
- Feed HTML is sanitised in `src/lib/parse.ts`. Never render raw feed HTML.
- Report vulnerabilities privately via GitHub security advisories rather than a
  public issue.

## Commit messages

Short imperative subject, then a body explaining the trade-off when there is one:

```
fix(dedupe): keep undated items out of the Today view

Fetch-time fallbacks were sorted as if they were publication dates, which made
undated entries claim to be the newest item in the library.
```
