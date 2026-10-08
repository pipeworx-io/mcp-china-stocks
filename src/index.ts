interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    // Fleet #2382. Everything that isn't a timeout/abort here is a genuine
    // NETWORK-LEVEL failure — DNS resolution, connection refused, TLS handshake,
    // Cloudflare's own "Network connection lost." — meaning `fetch()` itself
    // threw and no HTTP response of any kind was ever received. Until this fix
    // that raw exception was rethrown VERBATIM: a bare `TypeError: fetch failed`
    // (or the Workers-runtime equivalent) names no upstream, carries no class
    // token, and reads exactly like a defect in OUR code — because it says
    // nothing about the call at all. It landed in `error`, the tier that means
    // "Pipeworx has a defect", for every one of the (at the time of writing)
    // ~470 packs that call this helper directly with no wrapper of their own.
    //
    // `dexscreener` hit this independently (fleet #1579) and fixed it with a
    // bespoke per-pack try/catch around `fetchWithTimeout`. That fix is correct
    // but only covers one pack; every other caller of this shared helper still
    // leaked the raw exception. Moving the same fix HERE — the one place that
    // already carries the timeout case — covers every pack that uses
    // `fetchWithTimeout` without a wrapper, for free, and without widening
    // `classifyToolError`'s regex list: the fix is giving the message a proper
    // `upstream_down:` token at the point the two facts (no response was ever
    // received, and which host we were trying to reach) are actually in hand,
    // not teaching the classifier to guess from prose after the fact.
    //
    // Safe on the same grounds as the timeout branch above: no argument a
    // caller passes can make `fetch()` itself throw a connection-level error,
    // so this is always an availability failure, never a caller mistake. Same
    // `markInternalOrigin` treatment — an origin we run that never answered is
    // still ours, not a third party's outage.
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      markInternalOrigin(
        `upstream_down: could not reach ${name} at all (${raw.slice(0, 160)}). ` +
          `No request reached ${name}, so this says NOTHING about whether the arguments you passed ` +
          'are valid — do not re-check them on the strength of this error. Retry shortly.',
        url,
      ),
    );
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
/**
 * China A-shares MCP. Keyless.
 *
 * Live data for the Chinese A-share market (Shanghai / Shenzhen / STAR / ChiNext):
 *  - Daily LIMIT-UP board (涨停板) — how many stocks hit the +10%/+20% daily limit,
 *    and the ranked pool with consecutive-board count (连板), seal fund (封板资金),
 *    industry, turnover. Source: Eastmoney push2ex (JSON, keyless).
 *  - Real-time A-share QUOTES by symbol. Source: Sina hq.sinajs.cn (keyless; names
 *    are GBK-encoded, decoded via TextDecoder).
 *  - LIMIT-DOWN board (跌停板) — the counterpart to limit-up. Source: Eastmoney
 *    push2ex getTopicDTPool (keyless). Added 2026-10-08 (fleet #2831); earlier
 *    project memory recorded this endpoint as gated (rc:206) — re-verified
 *    live and working, so that note no longer applies.
 *  - MARGIN FINANCING / securities-lending balance (融资融券余额), market-wide
 *    by exchange + per-SZSE-stock. Source: SSE query.sse.com.cn/marketdata/
 *    tradedata/queryMargin.do + SZSE www.szse.cn ShowReport CATALOGID=1837_xxpl
 *    (both keyless). Added 2026-10-08 (fleet #2831) — the #1 demand-read gap
 *    (42 distinct callers, 14d) at the time this was built.
 *
 * Note: both upstreams are China-hosted; verified reachable, but see egress notes.
 */


// Bound every fetch() in this pack to a fixed timeout — an upstream that
// degrades without erroring would otherwise hold the Worker in `await fetch()`
// until its own execution budget kills the request (minutes, not seconds).
// Mirrors the epoFetch / usaspending retryFetch pattern (fleet #685).
async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  return fetchWithTimeout(url, init ?? {}, 'China A-shares');
}

const ZT_POOL = 'https://push2ex.eastmoney.com/getTopicZTPool';
// Limit-DOWN pool (跌停板), same host/auth-token shape as ZT_POOL above.
// NOTE: project memory from 2026-09-07 recorded this as "rc:206 data:null —
// endpoint gated/changed". Re-verified live from a throwaway CF Worker under
// the pipeworx prod account on 2026-10-08 (fleet #2831): rc:0, 9 real
// limit-down stocks returned for 2026-10-08. Whatever gated it before is no
// longer gating it — do not treat this comment as a reason to avoid it again
// without re-checking.
const DT_POOL = 'https://push2ex.eastmoney.com/getTopicDTPool';
const SINA = 'https://hq.sinajs.cn';
// SSE's own daily margin-trading summary (融资融券交易汇总), market-wide —
// NOT the generic commonQuery.do (that fails open: an unknown sqlId returns
// HTTP 200 with data:null, which looks exactly like "no data today" unless
// you already know the real path). Returns the most recent N published days,
// newest first, no date param needed/supported. Fields are already in CNY
// (元) — the one exchange of the two that needs no unit conversion. Verified
// live 2026-10-08 (fleet #2831) via a throwaway CF Worker: 200, real rows for
// 2026-09-30 (the last trading day before the 10-01..10-08 National Day
// closure).
const SSE_MARGIN = 'https://query.sse.com.cn/marketdata/tradedata/queryMargin.do';
// SZSE's margin-trading report via the same ShowReport mechanism as
// ashares_sector_flows' sibling pack (china-exchange-data) — CATALOGID
// 1837_xxpl, tab1 = market-wide total, tab2 = per-stock detail (filter with
// txtZqdm, NOT the uppercase TXTZQDM the hidden-field metadata might suggest).
// txtDate is YYYY-MM-DD (not YYYYMMDD) and REQUIRED — omit it and SZSE dumps
// its entire history since 2010 instead of defaulting to latest. A date with
// no published data (today, a weekend, a holiday) comes back with an empty
// `data` array and a blank `metadata.subname` — a real 200, not an error, so
// the caller must walk back trading days itself. tab1's `jrrjye` (融券余额)
// is in 亿元 (×1e8); tab2's `jrrjye` is in **万元** (×1e4) — same field name,
// different unit, confirmed by live probe 2026-10-08 (fleet #2831): this is
// exactly the 100×-error trap a sibling project's china-market-data notes
// warned about. Verified live via throwaway CF Worker: 200, real rows for
// both tab1 (market total) and tab2 (000001 平安银行 detail).
const SZSE_MARGIN = 'https://www.szse.cn/api/report/ShowReport/data';
const SZSE_MARGIN_REFERER = 'https://www.szse.cn/market/trend/index.html';
// Tencent/gtimg daily K-line (日K线) — forward/backward-adjusted or raw daily
// OHLCV bars for a single code + date range. Keyless. Verified 2026-09-03
// (fleet task #1208): row = [date, open, close, high, low, volume_lots].
// No turnover-amount field in this row form (checked both qfq/hfq/unadjusted
// and a second-leg Sina hisdata endpoint — neither exposes daily amount), so
// ashares_daily_history reports amount_cny: "not_available" rather than
// deriving it.
const GTIMG_KLINE = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get';
// Sina's ranked market-node listing (为板块排行, keyless) — sorts the whole
// board by amount/changepercent/volume server-side. Verified reachable
// 2026-09-03 (fleet task #1205); no industry field in this payload.
const HQ_NODE_DATA = 'https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData';
// Eastmoney datacenter report API (业绩预告 / 盈利预测) — verified CF-egress-OK
// 2026-07-17; note this is a DIFFERENT host from push2.eastmoney (which is
// empty from any IP — see project memory) so don't lump them together.
const DATACENTER = 'https://datacenter-web.eastmoney.com/api/data/v1/get';
// Eastmoney per-stock capital-flow daily history (主力净流入/超大单/大单/中单/
// 小单净流入), keyless. Added 2026-10-08 (fleet #2840). Re-probed live: this
// is push2HIS (not push2), which is NOT the gated host — project memory's
// "push2.eastmoney.com empty from any IP" does not apply here, confirmed by a
// real 200 with real klines for 000768 (中航西飞) on first probe.
const FFLOW_DAYKLINE = 'https://push2his.eastmoney.com/api/qt/stock/fflow/daykline/get';
// Eastmoney 龙虎榜 (dragon-tiger list) daily detail — same datacenter-web host
// as DATACENTER above, different reportName. Verified live 2026-10-08 for
// 2026-09-24 (real rows, e.g. 平潭发展 000592 with buy/sell/net amounts).
const BILLBOARD_REPORT = 'RPT_DAILYBILLBOARD_DETAILSNEW';
// Market-wide institution-seat net-buy detail per stock for a date (one row
// per stock that had an institutional seat trade that day) — NOT filterable
// by SECURITY_CODE (that returns "返回数据为空", a real empty, not an error);
// join client-side by SECURITY_CODE against BILLBOARD_REPORT's rows instead.
// Report name recovered from data.eastmoney.com/stock/lhb.html's own embedded
// API calls (jgmmqk widget), not guessed. Verified live 2026-10-08.
const BILLBOARD_ORG_REPORT = 'RPT_ORGANIZATION_TRADE_DETAILSNEW';
// That day's most-active brokerage branches market-wide (not per-stock) — the
// closest keyless "top brokerages" signal for a 龙虎榜 date; also recovered
// from lhb.html (hyyyb widget). Verified live 2026-10-08.
const BILLBOARD_BRANCH_REPORT = 'RPT_OPERATEDEPT_ACTIVE';
// Bulk per-day, per-stock valuation snapshot (ALL ~5,500+ A-shares in one
// paged report) — the one genuinely historical bulk Eastmoney report found
// for a PAST date: price, change %, market cap, and industry/板块
// (BOARD_NAME), for any TRADE_DATE. It does NOT carry turnover amount or
// volume (checked every column — see README), so it backs ashares_
// turnover_ranking's `date` + `sort:'changepercent'` path and the industry
// enrichment, but NOT a historical sort:'amount'/'volume' ranking. Verified
// live 2026-10-08 for 2026-09-22 (real rows, including two real IPO-debut
// ~700% first-day movers, sanity-checked as plausible rather than garbage).
const VALUE_ANALYSIS_REPORT = 'RPT_VALUEANALYSIS_DET';
// ETF fund-share-count disclosure history (期末总份额/期末净资产), keyless.
// Added 2026-10-08 (fleet #2840). IMPORTANT, re-verified live for all 4
// requested ETFs (515050/561980/588170/588200): this is NOT a daily series —
// Chinese ETFs disclose 份额 at period boundaries (quarter-end) plus ad-hoc
// material-change dates (e.g. 515050 also has an off-cycle 2026-05-12 row),
// not every trading day. ashares_etf_shares reports exactly what's disclosed
// and says so rather than fabricating daily rows between disclosures.
const ETF_SHARES_ARCHIVE = 'https://fundf10.eastmoney.com/FundArchivesDatas.aspx';
// Sina's minute-bar kline endpoint (分钟K线, keyless) — scale is the bar
// interval in minutes (1/5/15/30/60); datalen caps out at ~1950 bars total
// REGARDLESS of interval (verified live 2026-10-06: datalen=1950 works,
// datalen=2000 returns the literal string "null"), so the retention window
// shrinks as the interval shrinks: ~8 trading days at 1-minute, ~40 at
// 5-minute, ~110 at 15-minute, ~1yr at 30-minute, ~2yr at 60-minute, and it
// slides forward as new days trade and old ones drop off the back. Volume is
// already in SHARES per bar (not the 100-share 手 lots gtimg's daily bars
// use) and amount is CNY — cross-checked by summing a full day's 5-minute
// bars against ashares_daily_history's daily volume for the same code+day
// (515050 and 600519, 2026-09-01): both matched within ~0.1%, the residual
// being end-of-day call-auction handling this endpoint attributes to the
// last bar slightly differently than the daily close print.
const SINA_KLINE = 'https://quotes.sina.cn/cn/api/jsonp_v2.php/var%20_=/CN_MarketDataService.getKLineData';

// ── helpers ──────────────────────────────────────────────────────────
function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}
/** Eastmoney encodes limit-up-pool prices as an integer × 1000 (e.g. 24650 → 24.65). */
function price(v: unknown): number | null {
  const n = num(v);
  return n == null ? null : Math.round((n / 1000) * 1e4) / 1e4;
}
/** HHMMSS integer (e.g. 92500) → "09:25:00". */
function hms(v: unknown): string | null {
  const n = num(v);
  if (n == null) return null;
  const s = String(Math.trunc(n)).padStart(6, '0');
  return `${s.slice(0, 2)}:${s.slice(2, 4)}:${s.slice(4, 6)}`;
}
function latestTradingDate(): string {
  // A-shares trade Mon–Fri; step back over the weekend for a sensible default.
  const d = new Date();
  const day = d.getUTCDay();
  if (day === 0) d.setUTCDate(d.getUTCDate() - 2);
  else if (day === 6) d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}
/** Normalize YYYYMMDD or YYYY-MM-DD to YYYY-MM-DD (what gtimg's kline endpoint expects). */
function isoDate(v: unknown, fallback: string): string {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s) return fallback;
  const digits = s.replace(/-/g, '');
  if (!/^\d{8}$/.test(digits)) return fallback;
  return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
}
/** Map a bare 6-digit code to a Sina symbol (sh/sz/bj prefix). */
function sinaSym(code: string): string {
  const c = code.trim().toLowerCase();
  if (/^(sh|sz|bj)\d{6}$/.test(c)) return c;
  const n = c.replace(/\D/g, '');
  if (/^(6|9)/.test(n)) return `sh${n}`; // Shanghai main + B
  if (/^(0|3)/.test(n)) return `sz${n}`; // Shenzhen main + ChiNext
  if (/^(4|8)/.test(n)) return `bj${n}`; // Beijing exchange
  return `sh${n}`;
}
/** SZSE's ShowReport formats large numbers with thousands separators (e.g. "12,358.98"). */
function cnNum(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const n = Number(v.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}
/** YYYYMMDD -> YYYY-MM-DD. */
function ymdToIso(v: unknown): string | null {
  const s = String(v ?? '');
  return /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : null;
}
function isoToday(): string {
  return new Date().toISOString().slice(0, 10);
}
function isoMinusDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

// The five headline A-share indices, Sina symbol → English name.
const MARKET_INDICES: Array<{ sym: string; name: string; cn: string }> = [
  { sym: 'sh000001', name: 'Shanghai Composite', cn: '上证指数' },
  { sym: 'sz399001', name: 'Shenzhen Component', cn: '深证成指' },
  { sym: 'sz399006', name: 'ChiNext', cn: '创业板指' },
  { sym: 'sh000688', name: 'STAR 50', cn: '科创50' },
  { sym: 'sh000300', name: 'CSI 300', cn: '沪深300' },
];

// ── tools ────────────────────────────────────────────────────────────
const tools: McpToolExport['tools'] = [
  {
    name: 'ashares_limit_up',
    description:
      "The Chinese A-share market's LIMIT-UP board (涨停板) for a trading day — how many stocks hit their daily price limit (+10%, or +20% for STAR/ChiNext) and the ranked list of those stocks. Answers 'how many A-shares hit limit up today', 'top limit-up stocks', 'which stocks 涨停'. Each stock includes code, name, price, change %, turnover (成交额), float market cap, turnover rate (换手率), consecutive-board count (连板数 lbc), first/last seal time, seal fund (封板资金), and industry (行业). Source: Eastmoney (keyless).",
    summary: 'China A-share stocks that hit their daily limit-up price today, from Eastmoney.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        date: { type: 'string', description: 'Trading day as YYYYMMDD or YYYY-MM-DD (default: most recent trading day).' },
        limit: { type: 'number', description: 'How many stocks to return, 1–100 (default 30). The total count is always returned regardless.' },
      },
    },
  },
  {
    name: 'ashares_limit_down',
    description:
      "The Chinese A-share market's LIMIT-DOWN board (跌停板) for a trading day — how many stocks hit their daily DOWN price limit (-10%, or -20% for STAR/ChiNext) and the ranked list of those stocks. Answers 'how many A-shares hit limit down today', '跌停家数', 'which stocks 跌停', 'limit-down stock count for a China A-share trading day' — the counterpart to ashares_limit_up, together giving market-wide limit-up/limit-down breadth. Each stock includes code, name, price, change % (negative), turnover (成交额), float market cap, turnover rate (换手率), seal fund (封板资金), last seal time, industry (行业), and P/E. Source: Eastmoney (keyless).",
    summary: 'China A-share stocks that hit their daily limit-down price today, from Eastmoney.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        date: { type: 'string', description: 'Trading day as YYYYMMDD or YYYY-MM-DD (default: most recent trading day).' },
        limit: { type: 'number', description: 'How many stocks to return, 1–100 (default 30). The total count is always returned regardless.' },
      },
    },
  },
  {
    name: 'ashares_margin_financing',
    description:
      "China A-share margin financing and securities lending balance (融资融券余额/两融余额) — the market-wide leverage gauge: aggregate financing balance (融资余额, money borrowed to buy stock), securities-lending balance (融券余额, shares borrowed to short), and their combined total (融资融券余额), for the Shanghai (SSE) and Shenzhen (SZSE) exchanges separately and combined, with day-over-day change. Answers '融资余额', '两融余额', '融资融券余额', 'margin financing balance', 'China A-share margin debt', 'how much margin debt is in the A-share market', 'margin balance day over day change'. Pass a 6-digit SZSE code (0/3/159-prefixed) in `symbol` for that stock's own 融资余额/融券余额/融资融券余额 instead of the market aggregate — SSE (6xxxxx) per-stock detail is not available via any verified keyless route, so a SH code returns a clear not_available message rather than silently substituting. Margin data publishes T+1 (today's figures appear tomorrow morning); a request for a day with nothing published yet or a non-trading day (weekend/holiday) automatically falls back to the last trading day that published, and says so. Amounts in CNY (converted from each exchange's native 元/亿元/万元 units and labelled). Source: SSE query.sse.com.cn (keyless) + SZSE www.szse.cn ShowReport CATALOGID=1837_xxpl (keyless).",
    summary: "The China A-share market's aggregate margin financing and securities lending balance, from SSE + SZSE.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        symbol: { type: 'string', description: 'Optional 6-digit SZSE code (0/3/159-prefixed, e.g. "000001" 平安银行) for that stock\'s own margin balance instead of the market-wide aggregate. SSE codes (6xxxxx) are not supported here — no verified keyless per-stock route exists.' },
        date: { type: 'string', description: 'Trading day as YYYY-MM-DD or YYYYMMDD (default: most recent day with published data). Margin data is T+1, so "today" usually has nothing yet.' },
      },
    },
  },
  {
    name: 'ashares_market_snapshot',
    description:
      "Overall snapshot of the Chinese A-share market — the headline index levels (Shanghai Composite, Shenzhen Component, ChiNext, STAR 50, CSI 300) with change %, day range and turnover, plus market-wide breadth as a sentiment gauge: how many stocks hit limit-up (涨停) and limit-down (跌停) today. Answers 'how is the China A-share market doing', 'Shanghai Composite today', 'A-share market snapshot at close', 'how did Chinese stocks close', '涨跌停家数', 'limit-up limit-down counts today'. For the ranked pools use ashares_limit_up / ashares_limit_down; for market-wide margin financing leverage use ashares_margin_financing. Source: Sina + Eastmoney (keyless).",
    summary: 'A snapshot of current China A-share market indices and breadth, from Eastmoney.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'ashares_quote',
    description:
      'Real-time quote(s) for Chinese A-share stocks by 6-digit code (Shanghai 6xxxxx, Shenzhen 0xxxxx/3xxxxx, STAR 688xxx, ChiNext 30xxxx, Beijing 8xxxxx/4xxxxx). Returns name, current price, change and change %, open, previous close, day high/low, volume, turnover, and the quote timestamp. Accepts one code or a comma-separated list. Example: ashares_quote({ symbols: "600519,000858" }) for Kweichow Moutai and Wuliangye. Source: Sina (keyless).',
    summary: 'The current quote for a China A-share stock, from Eastmoney.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        symbols: { type: 'string', description: 'One 6-digit code or a comma-separated list, e.g. "600519" or "600519,000001,300750". sh/sz/bj prefixes are accepted but optional.' },
      },
      required: ['symbols'],
    },
  },
  {
    name: 'ashares_turnover_ranking',
    description:
      "Market-wide ranking of Chinese A-share stocks by turnover / 成交额排名, 成交额前30名, 成交量排名, or 涨跌幅排名 — the whole board (not specific codes), sorted server-side and returned as a ranked list. Answers 'A股成交额前30名', 'top 30 A-shares by turnover today', 'A股成交量排名', 'A-share market-wide ranking by amount/volume/change %', 'which A-shares traded the most today'. Each row has code, name, price, change %, volume (shares), turnover in CNY (成交额), turnover rate %, and industry (行业/板块, when resolvable). Omit `date` (or pass today) for the LIVE board (Sina, real-time). Pass a PAST trading day in `date` for that day's ranking instead of today's — this uses a different, Eastmoney-sourced historical path and only supports `sort:'changepercent'` (涨跌幅排名): no keyless bulk source for a PAST day's turnover amount or volume ranking was found (Sina's live board is the only amount/volume source), so `date` + `sort:'amount'|'volume'` throws a clear error naming that gap rather than silently substituting today's board. A non-trading `date` (weekend/holiday) walks back to the prior trading day automatically.",
    summary: 'China A-share stocks ranked by trading turnover today, or by change % on a past trading day, from Sina/Eastmoney.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        limit: { type: 'number', description: 'How many stocks to return, 1–100 (default 30).' },
        sort: { type: 'string', enum: ['amount', 'changepercent', 'volume'], description: "Rank by turnover amount (成交额, default), change % (涨跌幅), or share volume (成交量). For a PAST `date`, only 'changepercent' is available — 'amount'/'volume' throw a clear error for historical dates (no keyless historical source for those two)." },
        order: { type: 'string', enum: ['desc', 'asc'], description: 'desc (default, highest first) or asc.' },
        board: {
          type: 'string',
          enum: ['hs_a', 'sh_a', 'sz_a', 'cyb'],
          description: "Which board to rank: hs_a = all Shanghai+Shenzhen A-shares (default, 沪深A股), sh_a = Shanghai only (沪市A股), sz_a = Shenzhen only (深市A股), cyb = ChiNext (创业板).",
        },
        date: { type: 'string', description: "A PAST trading day, YYYY-MM-DD or YYYYMMDD, for that day's ranking instead of today's live board. Only `sort:'changepercent'` is supported with a past date. Omit for the live board." },
      },
    },
  },
  {
    name: 'ashares_capital_flow',
    description:
      "Per-stock daily main-capital net inflow history (主力净流入 / 超大单+大单净流入, often called '超大单净流入' in retail trackers) for a Chinese A-share stock or ETF — one row per trading day with net inflow broken down by order size: 超大单 (super-large/institutional), 大单 (large), 中单 (medium), 小单 (small), plus 主力净流入 (main = 超大单+大单combined) in both CNY amount and as a % of that day's turnover. Answers '主力净流入历史', '超大单净流入', '000768最近20个交易日的主力资金流向', 'main capital net inflow history for a China A-share stock', 'which days did big money flow into/out of a stock'. A positive net inflow means net buying pressure from that order-size bucket that day, negative means net selling. Source: Eastmoney push2his fflow/daykline (keyless).",
    summary: "A China A-share stock's daily main-capital (主力) net inflow history, from Eastmoney.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        code: { type: 'string', description: '6-digit A-share or ETF code, e.g. "000768" (中航西飞) or "515050". sh/sz/bj prefixes accepted but optional.' },
        days: { type: 'number', description: 'How many of the most recent trading days to return, 1–200 (default 20).' },
      },
      required: ['code'],
    },
  },
  {
    name: 'ashares_billboard',
    description:
      "The Chinese A-share market's daily 龙虎榜 (dragon-tiger list / billboard) for a trading day — stocks flagged for unusual price/turnover deviation, with the top seats' buy/sell/net amounts, plus (when present that day) institution-seat (机构专用) net-buy detail and that day's most-active brokerage branches (营业部) market-wide as a 'top brokerages' signal. Answers '龙虎榜', 'dragon tiger list for a date', 'which stocks were on the billboard on 2026-09-24', '机构净买入', 'institution seat net buys', 'top active brokerage seats'. Each listed stock has the reason it was flagged (EXPLANATION, e.g. daily move ≥7%), close price, change %, and billboard buy/sell/net amounts in CNY; stocks that also had institutional-seat activity that day carry institution_net_buy_cny/institution_buy_seats/institution_sell_seats. A non-trading `date` (weekend/holiday) walks back to the prior trading day automatically. Source: Eastmoney datacenter-web (keyless).",
    summary: "The China A-share market's daily dragon-tiger list (龙虎榜) with seat net-buy amounts, from Eastmoney.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        date: { type: 'string', description: 'Trading day as YYYY-MM-DD or YYYYMMDD (default: most recent trading day).' },
        limit: { type: 'number', description: 'How many billboard-listed stocks to return, 1–100 (default 50).' },
      },
    },
  },
  {
    name: 'ashares_etf_shares',
    description:
      "Disclosed fund-share-count (基金份额) and net-asset history for a Chinese-listed ETF — period-end total shares outstanding (期末总份额), the period's subscriptions/redemptions (期间申购/赎回), and period-end net assets (期末净资产), in shares and CNY. Answers '基金份额变动', 'ETF shares outstanding history', '515050规模变动', 'how many shares outstanding does this ETF have over time'. IMPORTANT: this is NOT a daily series — Chinese ETFs publicly disclose 份额 only at quarter-end plus occasional ad-hoc material-change dates (confirmed live for 515050/561980/588170/588200), not every trading day; a `from`/`to` window with no disclosure inside it returns found:false naming the nearest disclosed dates rather than fabricating daily rows. For a daily PRICE series use ashares_daily_history; this tool is share-count/AUM only. Source: Eastmoney fund F10 archive (keyless).",
    summary: "A Chinese ETF's disclosed share-count and net-asset history (period-end, not daily), from Eastmoney.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        code: { type: 'string', description: '6-digit ETF code, e.g. "515050", "561980", "588170", "588200", or "512000".' },
        from: { type: 'string', description: 'Earliest disclosure date to include, YYYY-MM-DD or YYYYMMDD (inclusive). Default: no lower bound (full history, newest first, capped).' },
        to: { type: 'string', description: 'Latest disclosure date to include, YYYY-MM-DD or YYYYMMDD (inclusive). Default: today (no upper bound in practice).' },
      },
      required: ['code'],
    },
  },
  {
    name: 'ashares_earnings_forecast',
    description:
      "Company-issued earnings guidance (业绩预告) for a Chinese A-share stock — the company's own forecast announcements with predicted profit range (lower/upper bounds in CNY), year-over-year change %, forecast type (略增/预增/扭亏 etc.), and the company's stated reason. Answers '业绩预测', '业绩预告', 'earnings forecast/guidance for a China A-share company like 华工科技 000988'. Most recent reports first. Source: Eastmoney datacenter (keyless).",
    summary: 'Analyst earnings forecasts for a China A-share company, from Eastmoney.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        symbol: { type: 'string', description: '6-digit A-share code, e.g. "000988" (华工科技) or "600519" (贵州茅台).' },
        limit: { type: 'number', description: 'How many forecast announcements to return, 1–20 (default 4, newest first).' },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'ashares_analyst_consensus',
    description:
      'Analyst consensus estimates (盈利预测) for a Chinese A-share stock — per forecast year: consensus EPS, P/E at current price, net profit attributable to parent (归母净利润), and total operating revenue, in CNY. Answers "analyst estimates / 盈利预测 / forecast EPS for a China A-share like 000988". Source: Eastmoney datacenter (keyless).',
    summary: 'The analyst consensus rating and price target for a China A-share stock, from Eastmoney.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        symbol: { type: 'string', description: '6-digit A-share code, e.g. "000988" or "300750" (宁德时代).' },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'ashares_daily_history',
    description:
      "Daily OHLCV history (历史日线) for one or more Chinese A-share stocks over a date range — open, high, low, close, volume, and day-over-day change % per trading day. Answers '300418在2026-08-31到2026-09-03的收盘价和涨跌幅', 'daily closes for 600519 last week', 'history for 000858 and 300750 this month', '涨跌幅历史', '历史成交量'. Up to 20 comma-separated 6-digit codes. change_pct is computed from consecutive closes within the returned range (the first row has no prior close in range, so it is null); turnover amount (成交额) is not exposed by this daily-bar source, so amount_cny is reported as \"not_available\" rather than estimated — use ashares_quote or ashares_turnover_ranking for same-day turnover amount. Source: Tencent/gtimg fqkline (keyless).",
    summary: 'A China A-share stock\'s daily price history, from Eastmoney.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        codes: { type: 'string', description: 'One 6-digit code or a comma-separated list, up to 20, e.g. "300418" or "300418,300364,002131". sh/sz/bj prefixes accepted but optional.' },
        start: { type: 'string', description: 'Start date, YYYY-MM-DD or YYYYMMDD (inclusive).' },
        end: { type: 'string', description: 'End date, YYYY-MM-DD or YYYYMMDD (inclusive). Default: today.' },
        adjust: { type: 'string', enum: ['qfq', 'hfq', 'none'], description: 'Price adjustment for splits/dividends: qfq = forward-adjusted (default, prices comparable to today), hfq = backward-adjusted, none = raw unadjusted prices.' },
      },
      required: ['codes', 'start'],
    },
  },
  {
    name: 'ashares_intraday_bars',
    description:
      "Intraday minute bars (分钟线/分时/分钟K线) for Chinese A-share stocks/ETFs on a given trading日/交易日, with cumulative volume and turnover (累计成交量/累计成交额) computed up to a requested time of day (截至<time>, e.g. 截至11:05) — answers '515050在2026-09-01这个交易日截至11:05的累计成交量和累计成交额', '600519某个交易日截至某时刻的累计成交量和成交额', 'cumulative volume for 600519 up to 11:05 on a past trading day', 'intraday minute bars for an A-share on a specific date'. ashares_quote is realtime-only (today, right now) and ashares_daily_history is end-of-day-only (no intraday granularity) — this tool is for a PAST trading日's intraday trajectory. Returns the interval bars for that day plus cumulative_volume_shares/cumulative_turnover_cny summed from the day's open through `up_to` (or the whole day if `up_to` is omitted). `symbols` takes a bare 6-digit code (e.g. \"515050\") or the sh/sz/bj-prefixed form, same as ashares_quote. Bounded lookback: the upstream caps total bars at ~1950 regardless of interval, so retention shrinks as the interval shrinks — roughly 8 trading days at 1-minute, 40 at 5-minute (the default), 110 at 15-minute, a year at 30-minute, two years at 60-minute — and it slides forward daily. A `date` older than a result's `earliest_bar_date_available` is out of range for that interval; try a coarser interval, or use ashares_daily_history for daily (not intraday) history further back. Source: Sina (keyless).",
    summary: "A China A-share stock's intraday minute bars and cumulative volume/turnover up to a given time on a past trading day, from Sina.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        symbols: { type: 'string', description: 'One 6-digit code or a comma-separated list, up to 5, e.g. "515050" or "600519,000001". sh/sz/bj prefixes accepted but optional. ETF codes work the same as stock codes.' },
        date: { type: 'string', description: 'The trading day the bars are for, YYYY-MM-DD or YYYYMMDD, e.g. "2026-09-01".' },
        up_to: { type: 'string', description: 'Time of day (24-hour, Beijing time) to cumulate volume/turnover through, e.g. "11:05". Omit for the whole trading day (or "as of now" if `date` is today and the market is open).' },
        interval: { type: 'string', enum: ['1', '5', '15', '30', '60'], description: 'Bar interval in minutes. Default "5". Smaller intervals keep a shorter lookback window — see the tool description.' },
      },
      required: ['symbols', 'date'],
    },
  },
  {
    name: 'ashares_technical_indicators',
    description:
      "Technical indicators for Chinese A-share stocks and ETFs (均线/布林/MACD/KDJ) — MA (moving averages, any windows, default MA5/MA10/MA20/MA60), BOLL (Bollinger Bands, default 20-period ×2 std dev), MACD (DIF/DEA/柱, default 12/26/9), and KDJ (K/D/J, default 9/3/3), computed from this pack's own daily OHLCV history (same source and codes as ashares_daily_history — ETF codes like 515050/588170/561980 work the same as stock codes). Answers '515050通信ETF华夏最近20个交易日MA5/MA10/MA20/BOLL/MACD/KDJ', '603986兆易创新周线MACD是否死叉', 'MA20 and BOLL for an A-share ETF', '布林带', '均线', '金叉死叉'. Internally fetches extra lookback history before `start` so the indicators are warmed up (MA60/MACD need ~60+ trading days of prior data) — only the requested [start, end] range is returned. MACD histogram uses the common Chinese charting convention 柱=2×(DIF−DEA); KDJ smoothing is the standard 3/3 recursive form seeded at 50. Up to 5 comma-separated codes per call (indicator math is heavier than a plain OHLCV pull). Source: Tencent/gtimg fqkline (keyless), same as ashares_daily_history.",
    summary: 'Moving averages, Bollinger Bands, MACD and KDJ for a China A-share stock or ETF, computed from daily OHLCV history.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        codes: { type: 'string', description: 'One 6-digit code or a comma-separated list, up to 5, e.g. "515050" or "600519,300750". sh/sz/bj prefixes accepted but optional. ETF codes work the same as stock codes.' },
        start: { type: 'string', description: 'Start date for the RETURNED indicator range, YYYY-MM-DD or YYYYMMDD (inclusive). Extra history before this date is fetched automatically to warm up the indicators.' },
        end: { type: 'string', description: 'End date, YYYY-MM-DD or YYYYMMDD (inclusive). Default: today.' },
        adjust: { type: 'string', enum: ['qfq', 'hfq', 'none'], description: 'Price adjustment for splits/dividends: qfq = forward-adjusted (default), hfq = backward-adjusted, none = raw.' },
        indicators: {
          type: 'array',
          items: { type: 'string', enum: ['ma', 'boll', 'macd', 'kdj'] },
          description: 'Which indicator families to compute. Default: all four.',
        },
        ma_windows: { type: 'array', items: { type: 'number' }, description: 'MA window lengths in trading days. Default [5, 10, 20, 60].' },
        boll_period: { type: 'number', description: 'BOLL period, default 20.' },
        boll_mult: { type: 'number', description: 'BOLL standard-deviation multiplier, default 2.' },
        macd_fast: { type: 'number', description: 'MACD fast EMA period, default 12.' },
        macd_slow: { type: 'number', description: 'MACD slow EMA period, default 26.' },
        macd_signal: { type: 'number', description: 'MACD signal (DEA) EMA period, default 9.' },
        kdj_n: { type: 'number', description: 'KDJ RSV lookback period, default 9.' },
        kdj_m1: { type: 'number', description: 'KDJ K smoothing factor, default 3.' },
        kdj_m2: { type: 'number', description: 'KDJ D smoothing factor, default 3.' },
      },
      required: ['codes', 'start'],
    },
  },
];

// ── handlers ─────────────────────────────────────────────────────────
async function limitUp(args: Record<string, unknown>) {
  const date = (typeof args.date === 'string' && args.date.trim() ? args.date.replace(/-/g, '') : latestTradingDate()).slice(0, 8);
  const want = Math.min(Math.max(Number(args.limit ?? 30), 1), 100);
  const params = new URLSearchParams({
    ut: '7eea3edcaed734bea9cbfc24409ed989',
    dpt: 'wz.ztzt',
    Pageindex: '0',
    pagesize: String(Math.max(want, 100)),
    sort: 'fbt:asc',
    date,
  });
  const res = await pwFetch(`${ZT_POOL}?${params}`, { headers: { 'User-Agent': 'Mozilla/5.0 (pipeworx.io)', Referer: 'https://quote.eastmoney.com/' } });
  if (!res.ok) throw await httpError(res, 'Eastmoney');
  const body = (await res.json()) as { rc?: number; data?: { tc?: number; qdate?: number; pool?: Array<Record<string, unknown>> } | null };
  if (!body.data || !Array.isArray(body.data.pool)) {
    return { date, found: false, message: `No limit-up data for ${date} (not a trading day, or data not yet published).` };
  }
  const pool = body.data.pool.slice(0, want).map((s) => ({
    code: s.c ?? null,
    name: s.n ?? null,
    price: price(s.p),
    change_pct: num(s.zdp) != null ? Math.round((num(s.zdp) as number) * 100) / 100 : null,
    turnover_yuan: num(s.amount),
    float_mktcap_yuan: num(s.ltsz),
    turnover_rate_pct: num(s.hs) != null ? Math.round((num(s.hs) as number) * 100) / 100 : null,
    consecutive_boards: num(s.lbc),
    first_seal_time: hms(s.fbt),
    last_seal_time: hms(s.lbt),
    seal_fund_yuan: num(s.fund),
    times_unsealed: num(s.zbc),
    industry: s.hybk ?? null,
  }));
  return {
    date: String(body.data.qdate ?? date),
    limit_up_count: body.data.tc ?? pool.length,
    returned: pool.length,
    note: 'Daily price limit is +10% for main-board A-shares, +20% for STAR (688xxx) and ChiNext (30xxxx). consecutive_boards>1 = a multi-day 连板 streak.',
    stocks: pool,
  };
}

async function limitDown(args: Record<string, unknown>) {
  const date = (typeof args.date === 'string' && args.date.trim() ? args.date.replace(/-/g, '') : latestTradingDate()).slice(0, 8);
  const want = Math.min(Math.max(Number(args.limit ?? 30), 1), 100);
  const params = new URLSearchParams({
    ut: '7eea3edcaed734bea9cbfc24409ed989',
    dpt: 'wz.ztzt',
    Pageindex: '0',
    pagesize: String(Math.max(want, 100)),
    sort: 'fund:asc',
    date,
  });
  const res = await pwFetch(`${DT_POOL}?${params}`, { headers: { 'User-Agent': 'Mozilla/5.0 (pipeworx.io)', Referer: 'https://quote.eastmoney.com/' } });
  if (!res.ok) throw await httpError(res, 'Eastmoney');
  const body = (await res.json()) as { rc?: number; data?: { tc?: number; qdate?: number; pool?: Array<Record<string, unknown>> } | null };
  if (!body.data || !Array.isArray(body.data.pool)) {
    return { date, found: false, message: `No limit-down data for ${date} (not a trading day, or data not yet published).` };
  }
  const pool = body.data.pool.slice(0, want).map((s) => ({
    code: s.c ?? null,
    name: s.n ?? null,
    price: price(s.p),
    change_pct: num(s.zdp) != null ? Math.round((num(s.zdp) as number) * 100) / 100 : null,
    turnover_yuan: num(s.amount),
    float_mktcap_yuan: num(s.ltsz),
    turnover_rate_pct: num(s.hs) != null ? Math.round((num(s.hs) as number) * 100) / 100 : null,
    pe_ratio: num(s.pe),
    seal_fund_yuan: num(s.fund),
    last_seal_time: hms(s.lbt),
    industry: s.hybk ?? null,
  }));
  return {
    date: String(body.data.qdate ?? date),
    limit_down_count: body.data.tc ?? pool.length,
    returned: pool.length,
    note: 'Daily price limit is -10% for main-board A-shares, -20% for STAR (688xxx) and ChiNext (30xxxx). Counterpart to ashares_limit_up.',
    stocks: pool,
  };
}

async function marketSnapshot() {
  // Indices parse with the same Sina field layout as stock quotes.
  const list = MARKET_INDICES.map((i) => i.sym).join(',');
  const indices: Array<Record<string, unknown>> = [];
  let asOf: string | null = null;
  try {
    const res = await pwFetch(`${SINA}/list=${list}`, { headers: { Referer: 'https://finance.sina.com.cn/', 'User-Agent': 'Mozilla/5.0 (pipeworx.io)' } });
    if (res.ok) {
      const text = new TextDecoder('gbk').decode(await res.arrayBuffer());
      const bySym = new Map<string, string[]>();
      for (const line of text.split('\n')) {
        const m = line.match(/hq_str_([a-z]{2}\d{6})="([^"]*)"/);
        if (m && m[2]) bySym.set(m[1], m[2].split(','));
      }
      for (const idx of MARKET_INDICES) {
        const f = bySym.get(idx.sym);
        if (!f || f.length < 10) { indices.push({ index: idx.name, cn_name: idx.cn, found: false }); continue; }
        const cur = Number(f[3]); const prev = Number(f[2]);
        if (!asOf && f[30] && f[31]) asOf = `${f[30]} ${f[31]}`;
        indices.push({
          index: idx.name,
          cn_name: idx.cn,
          level: Number.isFinite(cur) ? Math.round(cur * 100) / 100 : null,
          change: Number.isFinite(cur) && Number.isFinite(prev) ? Math.round((cur - prev) * 100) / 100 : null,
          change_pct: Number.isFinite(cur) && Number.isFinite(prev) && prev !== 0 ? Math.round(((cur - prev) / prev) * 1e4) / 100 : null,
          open: num(f[1]), high: num(f[4]), low: num(f[5]),
          turnover_yuan: num(f[9]),
        });
      }
    }
  } catch { /* indices best-effort */ }

  // Limit-up / limit-down counts (涨跌停家数) — headline breadth/sentiment
  // gauges for A-shares. Two independent best-effort calls so one failing
  // doesn't blank out the other.
  let limitUpCount: number | null = null;
  let limitDownCount: number | null = null;
  const date = latestTradingDate();
  try {
    const params = new URLSearchParams({ ut: '7eea3edcaed734bea9cbfc24409ed989', dpt: 'wz.ztzt', Pageindex: '0', pagesize: '1', sort: 'fbt:asc', date });
    const res = await pwFetch(`${ZT_POOL}?${params}`, { headers: { 'User-Agent': 'Mozilla/5.0 (pipeworx.io)', Referer: 'https://quote.eastmoney.com/' } });
    if (res.ok) {
      const body = (await res.json()) as { data?: { tc?: number } | null };
      limitUpCount = body.data?.tc ?? null;
    }
  } catch { /* breadth best-effort */ }
  try {
    const params = new URLSearchParams({ ut: '7eea3edcaed734bea9cbfc24409ed989', dpt: 'wz.ztzt', Pageindex: '0', pagesize: '1', sort: 'fund:asc', date });
    const res = await pwFetch(`${DT_POOL}?${params}`, { headers: { 'User-Agent': 'Mozilla/5.0 (pipeworx.io)', Referer: 'https://quote.eastmoney.com/' } });
    if (res.ok) {
      const body = (await res.json()) as { data?: { tc?: number } | null };
      limitDownCount = body.data?.tc ?? null;
    }
  } catch { /* breadth best-effort */ }

  return {
    market: 'China A-shares (Shanghai / Shenzhen / STAR / ChiNext)',
    as_of: asOf ?? date,
    indices,
    limit_up_count: limitUpCount,
    limit_down_count: limitDownCount,
    note: 'Index turnover is in CNY. limit_up_count/limit_down_count = number of A-shares that closed at their daily +10%/-10% price limit (+20%/-20% for STAR/ChiNext) — market-sentiment gauges. Use ashares_limit_up / ashares_limit_down for the ranked pools, and ashares_margin_financing for market-wide leverage (融资融券余额). Source: Sina (indices) + Eastmoney (limit counts), keyless.',
  };
}

// ── generic Eastmoney datacenter-web helper (RPT_* reports) ───────────
// Shared by billboard/institution-seat/active-branch/value-analysis lookups
// below -- all four live on the same host+shape as the existing earnings/
// consensus DATACENTER calls, just with different reportName/filter/sort.
async function dcQuery(params: Record<string, string>): Promise<Array<Record<string, unknown>>> {
  const qs = new URLSearchParams({ columns: 'ALL', source: 'WEB', client: 'WEB', ...params });
  const res = await pwFetch(`${DATACENTER}?${qs}`, { headers: { 'User-Agent': 'Mozilla/5.0 (pipeworx.io)', Referer: 'https://data.eastmoney.com/' } });
  if (!res.ok) throw await httpError(res, 'Eastmoney datacenter');
  const body = (await res.json()) as { success?: boolean; code?: number; message?: string; result?: { data?: Array<Record<string, unknown>> } | null };
  if (body.success === false) {
    // code 9201 ("返回数据为空") is a real, legitimate empty result (e.g. a
    // stock with no institutional-seat trade that day) -- NOT a transport or
    // parse failure. Every other non-success code is treated as loud: throw,
    // don't silently return [] and have it read as "no data" either.
    if (body.code === 9201) return [];
    throw new Error(`Eastmoney datacenter report error${body.code ? ` (${body.code})` : ''}: ${body.message ?? 'unknown error'} -- reportName=${params.reportName ?? '?'}`);
  }
  return body.result?.data ?? [];
}

/** Best-effort industry (行业/板块) lookup for a batch of codes, via the
 * bulk VALUE_ANALYSIS_REPORT (sorted newest-TRADE_DATE-first so the first
 * occurrence per code is its latest). Never throws -- an enrichment lookup
 * failing should not break the ranking call it enriches. */
async function industriesByCode(codes: string[]): Promise<Map<string, string>> {
  const clean = codes.filter(Boolean);
  if (clean.length === 0) return new Map();
  const list = clean.map((c) => `"${c}"`).join(',');
  try {
    const rows = await dcQuery({
      reportName: VALUE_ANALYSIS_REPORT,
      columns: 'SECURITY_CODE,BOARD_NAME,TRADE_DATE',
      filter: `(SECURITY_CODE in (${list}))`,
      sortColumns: 'TRADE_DATE',
      sortTypes: '-1',
      pageSize: String(Math.min(Math.max(clean.length * 3, 30), 300)),
      pageNumber: '1',
    });
    const map = new Map<string, string>();
    for (const r of rows) {
      const c = String(r.SECURITY_CODE ?? '');
      const b = typeof r.BOARD_NAME === 'string' ? r.BOARD_NAME : null;
      if (c && b && !map.has(c)) map.set(c, b);
    }
    return map;
  } catch {
    return new Map();
  }
}

/** Walk back from `dateIso` until VALUE_ANALYSIS_REPORT has rows for that
 * date (covers weekends/holidays), ranked by change % -- the only field
 * this bulk report shares with ashares_turnover_ranking's live sort options. */
async function historicalChangeRanking(dateIso: string, ascFlag: '0' | '1', maxTries = 8): Promise<{ date: string; rows: Array<Record<string, unknown>> }> {
  let cursor = dateIso;
  for (let i = 0; i < maxTries; i++) {
    const rows = await dcQuery({
      reportName: VALUE_ANALYSIS_REPORT,
      filter: `(TRADE_DATE='${cursor}')`,
      sortColumns: 'CHANGE_RATE',
      sortTypes: ascFlag === '1' ? '1' : '-1',
      pageSize: '300',
      pageNumber: '1',
    });
    if (rows.length > 0) return { date: cursor, rows };
    cursor = isoMinusDays(cursor, 1);
  }
  return { date: dateIso, rows: [] };
}

function boardMatches(code: string, board: 'hs_a' | 'sh_a' | 'sz_a' | 'cyb'): boolean {
  if (board === 'hs_a') return true;
  if (board === 'sh_a') return /^(6|9)/.test(code);
  if (board === 'cyb') return /^30/.test(code);
  if (board === 'sz_a') return /^(0|3)/.test(code); // includes ChiNext, same as Sina's own sz_a grouping
  return true;
}

async function turnoverRanking(args: Record<string, unknown>) {
  const want = Math.min(Math.max(Number(args.limit ?? 30), 1), 100);
  const sortArg = typeof args.sort === 'string' ? args.sort.trim().toLowerCase() : 'amount';
  const sort = (['amount', 'changepercent', 'volume'] as const).includes(sortArg as 'amount' | 'changepercent' | 'volume')
    ? (sortArg as 'amount' | 'changepercent' | 'volume')
    : 'amount';
  const orderArg = typeof args.order === 'string' ? args.order.trim().toLowerCase() : 'desc';
  const asc = orderArg === 'asc' ? '1' : '0';
  const boardArg = typeof args.board === 'string' ? args.board.trim().toLowerCase() : 'hs_a';
  const board = (['hs_a', 'sh_a', 'sz_a', 'cyb'] as const).includes(boardArg as 'hs_a' | 'sh_a' | 'sz_a' | 'cyb')
    ? (boardArg as 'hs_a' | 'sh_a' | 'sz_a' | 'cyb')
    : 'hs_a';

  const todayIso = isoToday();
  const dateArg = typeof args.date === 'string' && args.date.trim() ? isoDate(args.date, todayIso) : null;
  const isHistorical = !!dateArg && dateArg !== todayIso;

  if (isHistorical) {
    // Fixed fleet #2840: this used to silently answer a dated request with
    // TODAY's live board (failure_mode: silent). Now it either serves a real
    // historical ranking (changepercent) or throws a loud, specific error
    // naming the gap -- no silent substitution either way.
    if (sort !== 'changepercent') {
      throw new Error(
        `A past date (${dateArg}) was requested with sort:'${sort}', but no keyless historical bulk source for market-wide turnover amount or share volume BY DATE was found -- Sina's getHQNodeData (used for the live board) only serves today, and Eastmoney's one confirmed bulk per-day report (RPT_VALUEANALYSIS_DET) carries price/change%%/market-cap/industry but not turnover or volume. Only sort:'changepercent' is available for a past date. Omit \`date\` for today's live amount/volume ranking, or use sort:'changepercent' for ${dateArg}.`,
      );
    }
    const { date: resolvedDate, rows: valueRows } = await historicalChangeRanking(dateArg, asc as '0' | '1');
    if (valueRows.length === 0) {
      return { board, sort, order: asc === '1' ? 'asc' : 'desc', date: dateArg, returned: 0, rows: [], message: `No historical ranking data found for ${dateArg} or the 8 trading days before it (too far in the past/future for this upstream, or not a trading day).` };
    }
    const filtered = valueRows.filter((r) => boardMatches(String(r.SECURITY_CODE ?? ''), board)).slice(0, want);
    const rows = filtered.map((r) => ({
      code: r.SECURITY_CODE ?? null,
      name: r.SECURITY_NAME_ABBR ?? null,
      price: num(r.CLOSE_PRICE),
      change_pct: num(r.CHANGE_RATE) != null ? Math.round((num(r.CHANGE_RATE) as number) * 100) / 100 : null,
      volume_shares: 'not_available',
      amount_cny: 'not_available',
      turnover_rate_pct: 'not_available',
      total_market_cap_cny: num(r.TOTAL_MARKET_CAP),
      industry: r.BOARD_NAME ?? 'not_available',
      tick_time: null,
    }));
    return {
      board,
      sort,
      order: asc === '1' ? 'asc' : 'desc',
      date: resolvedDate,
      date_note: resolvedDate === dateArg ? null : `${dateArg} had no data (weekend/holiday); walked back to the nearest prior trading day, ${resolvedDate}.`,
      as_of: resolvedDate,
      returned: rows.length,
      note: "Historical path (past `date`): ranked by change % from Eastmoney's RPT_VALUEANALYSIS_DET bulk daily report, which carries price/change%/market-cap/industry but NOT turnover amount or volume -- those fields are 'not_available' here (see amount_cny/volume_shares/turnover_rate_pct). industry (BOARD_NAME) IS available on this path, unlike the live Sina path's per-call enrichment.",
      source: 'Eastmoney datacenter-web RPT_VALUEANALYSIS_DET (keyless)',
      rows,
    };
  }

  const params = new URLSearchParams({ page: '1', num: String(want), sort, asc, node: board });
  const res = await pwFetch(`${HQ_NODE_DATA}?${params}`, { headers: { 'User-Agent': 'Mozilla/5.0 (pipeworx.io)', Referer: 'https://finance.sina.com.cn/' } });
  if (!res.ok) throw await httpError(res, 'Sina');
  const text = new TextDecoder('utf-8').decode(await res.arrayBuffer());
  let raw: Array<Record<string, unknown>>;
  try {
    raw = JSON.parse(text);
  } catch {
    return { board, sort, order: asc === '1' ? 'asc' : 'desc', returned: 0, rows: [], message: 'Sina returned a non-JSON response (likely off-hours or a transient block).' };
  }
  // Industry enrichment (fleet #2840): the live Sina board carries no
  // industry field at all, so resolve it with one extra bulk Eastmoney call
  // keyed by the codes this call already returned -- best-effort, never
  // throws (see industriesByCode), so a lookup failure degrades to
  // 'not_available' exactly as before rather than failing the whole call.
  const codes = raw.map((s) => String(s.code ?? ''));
  const industryMap = await industriesByCode(codes);
  const rows = raw.map((s) => {
    const code = String(s.code ?? '');
    return {
      code: s.code ?? null,
      name: s.name ?? null,
      price: num(s.trade),
      change: num(s.pricechange),
      change_pct: num(s.changepercent) != null ? Math.round((num(s.changepercent) as number) * 100) / 100 : null,
      volume_shares: num(s.volume),
      amount_cny: num(s.amount),
      turnover_rate_pct: num(s.turnoverratio) != null ? Math.round((num(s.turnoverratio) as number) * 100) / 100 : null,
      industry: industryMap.get(code) ?? 'not_available',
      tick_time: s.ticktime ?? null,
    };
  });
  return {
    board,
    sort,
    order: asc === '1' ? 'asc' : 'desc',
    as_of: rows[0]?.tick_time ?? null,
    returned: rows.length,
    note: "industry (行业/板块) is resolved via a secondary Eastmoney lookup (RPT_VALUEANALYSIS_DET) by code and falls back to 'not_available' for any code it doesn't carry. amount_cny is turnover (成交额) in CNY. Pass `date` for a PAST trading day's ranking (sort:'changepercent' only -- see this tool's description for why amount/volume aren't available historically).",
    source: 'Sina Market_Center.getHQNodeData (keyless) + Eastmoney RPT_VALUEANALYSIS_DET (industry enrichment, keyless)',
    rows,
  };
}

// ── ashares_capital_flow ───────────────────────────────────────────────
/** 6-digit code -> Eastmoney secid ("1.<code>" SSE, "0.<code>" SZSE/BSE). */
function eastmoneySecId(code: string): string {
  return sinaSym(code).startsWith('sh') ? `1.${code}` : `0.${code}`;
}

async function capitalFlow(args: Record<string, unknown>) {
  const code = String(args.code ?? '').replace(/\D/g, '');
  if (!/^\d{6}$/.test(code)) throw new Error('code must be a 6-digit A-share or ETF code, e.g. "000768" or "515050".');
  const days = Math.min(Math.max(Number(args.days ?? 20), 1), 200);
  const params = new URLSearchParams({
    secid: eastmoneySecId(code),
    fields1: 'f1,f2,f3,f7',
    fields2: 'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f62,f63,f64,f65',
  });
  const res = await pwFetch(`${FFLOW_DAYKLINE}?${params}`, { headers: { 'User-Agent': 'Mozilla/5.0 (pipeworx.io)', Referer: 'https://data.eastmoney.com/' } });
  if (!res.ok) throw await httpError(res, 'Eastmoney');
  const body = (await res.json()) as { rc?: number; data?: { code?: string; market?: number; name?: string; klines?: string[] } | null };
  if (!body.data || !Array.isArray(body.data.klines) || body.data.klines.length === 0) {
    return { code, found: false, message: `No main-capital (主力) flow history for ${code} -- check the code; invalid/delisted codes come back with no klines rather than an error.` };
  }
  const allRows = body.data.klines.map((line) => {
    const f = line.split(',');
    return {
      date: f[0],
      main_net_inflow_cny: num(f[1]),
      small_net_inflow_cny: num(f[2]),
      medium_net_inflow_cny: num(f[3]),
      large_net_inflow_cny: num(f[4]),
      super_large_net_inflow_cny: num(f[5]),
      main_net_inflow_pct: num(f[6]),
      small_net_inflow_pct: num(f[7]),
      medium_net_inflow_pct: num(f[8]),
      large_net_inflow_pct: num(f[9]),
      super_large_net_inflow_pct: num(f[10]),
      close: num(f[11]),
      change_pct: num(f[12]),
    };
  });
  const rows = allRows.slice(-days);
  const latest = rows[rows.length - 1] ?? null;
  return {
    code,
    name: body.data.name ?? null,
    exchange: exchangeOf(sinaSym(code)),
    country: 'China',
    market: 'China A-share market',
    statement:
      `China A-share market: ${rows.length} trading-day main-capital (主力) net-inflow row(s) for ${code}${body.data.name ? ` (${body.data.name})` : ''}, ` +
      `${rows[0]?.date ?? 'n/a'} to ${latest?.date ?? 'n/a'}` +
      (latest ? `; most recent day's main net inflow ¥${latest.main_net_inflow_cny?.toLocaleString() ?? 'n/a'}.` : '.'),
    returned: rows.length,
    note: "main_net_inflow_cny (主力净流入) = super_large_net_inflow_cny + large_net_inflow_cny (verified arithmetically against live data: the two sum exactly to the reported main figure). Positive = net buying pressure from that order-size bucket that day, negative = net selling. *_pct is that bucket's net inflow as a % of the day's total turnover. Order-size buckets (超大单/大单/中单/小单) are Eastmoney's own order-value classification, not configurable.",
    source: 'Eastmoney push2his fflow/daykline (keyless)',
    rows,
  };
}

// ── ashares_billboard (龙虎榜) ──────────────────────────────────────────
async function fetchBillboardList(dateIso: string, want: number): Promise<Array<Record<string, unknown>>> {
  return dcQuery({
    reportName: BILLBOARD_REPORT,
    filter: `(TRADE_DATE='${dateIso}')`,
    sortColumns: 'BILLBOARD_NET_AMT',
    sortTypes: '-1',
    pageSize: String(Math.max(want, 50)),
    pageNumber: '1',
  });
}

async function billboard(args: Record<string, unknown>) {
  const want = Math.min(Math.max(Number(args.limit ?? 50), 1), 100);
  const todayIso = isoToday();
  const startIso = typeof args.date === 'string' && args.date.trim() ? isoDate(args.date, todayIso) : todayIso;

  let cursor = startIso;
  let rows: Array<Record<string, unknown>> = [];
  let resolvedDate = cursor;
  let tried = 0;
  for (; tried < 8; tried++) {
    rows = await fetchBillboardList(cursor, want);
    if (rows.length > 0) { resolvedDate = cursor; break; }
    cursor = isoMinusDays(cursor, 1);
  }
  if (rows.length === 0) {
    return { date: startIso, found: false, message: `No 龙虎榜 (dragon-tiger list) data found for ${startIso} or the ${tried} trading day(s) before it (weekend/holiday run, or a date too far in the future).` };
  }

  const picked = rows.slice(0, want);
  const codes = picked.map((r) => String(r.SECURITY_CODE ?? ''));
  const [orgRows, branchRows] = await Promise.all([
    dcQuery({
      reportName: BILLBOARD_ORG_REPORT,
      filter: `(TRADE_DATE>='${resolvedDate}')(TRADE_DATE<='${resolvedDate}')`,
      sortColumns: 'NET_BUY_AMT',
      sortTypes: '-1',
      pageSize: '300',
      pageNumber: '1',
    }).catch(() => [] as Array<Record<string, unknown>>),
    dcQuery({
      reportName: BILLBOARD_BRANCH_REPORT,
      filter: `(ONLIST_DATE>='${resolvedDate}')(ONLIST_DATE<='${resolvedDate}')`,
      sortColumns: 'TOTAL_NETAMT',
      sortTypes: '-1',
      pageSize: '5',
      pageNumber: '1',
    }).catch(() => [] as Array<Record<string, unknown>>),
  ]);

  const orgByCode = new Map<string, Record<string, unknown>>();
  for (const r of orgRows) {
    const c = String(r.SECURITY_CODE ?? '');
    if (c && !orgByCode.has(c)) orgByCode.set(c, r);
  }
  const relevantOrgCount = codes.filter((c) => orgByCode.has(c)).length;

  const stocks = picked.map((r) => {
    const code = String(r.SECURITY_CODE ?? '');
    const org = orgByCode.get(code);
    return {
      code,
      name: r.SECURITY_NAME_ABBR ?? null,
      close_price: num(r.CLOSE_PRICE),
      change_pct: num(r.CHANGE_RATE) != null ? Math.round((num(r.CHANGE_RATE) as number) * 100) / 100 : null,
      turnover_rate_pct: num(r.TURNOVERRATE) != null ? Math.round((num(r.TURNOVERRATE) as number) * 100) / 100 : null,
      billboard_buy_cny: num(r.BILLBOARD_BUY_AMT),
      billboard_sell_cny: num(r.BILLBOARD_SELL_AMT),
      billboard_net_cny: num(r.BILLBOARD_NET_AMT),
      reason: r.EXPLANATION ?? null,
      institution_net_buy_cny: org ? num(org.NET_BUY_AMT) : null,
      institution_buy_seats: org ? num(org.BUY_TIMES) : null,
      institution_sell_seats: org ? num(org.SELL_TIMES) : null,
    };
  });

  const topBrokerages = branchRows.slice(0, 5).map((r) => ({
    name: r.OPERATEDEPT_NAME ?? null,
    net_buy_cny: num(r.TOTAL_NETAMT),
    buy_amount_cny: num(r.TOTAL_BUYAMT),
    sell_amount_cny: num(r.TOTAL_SELLAMT),
    stocks_bought: typeof r.SECURITY_NAME_ABBR === 'string' ? r.SECURITY_NAME_ABBR.split(' ').filter(Boolean).slice(0, 5) : [],
  }));

  return {
    date: resolvedDate,
    date_note: resolvedDate === startIso ? null : `${startIso} had no 龙虎榜 data (weekend/holiday, or nothing flagged); walked back to the nearest prior trading day, ${resolvedDate}.`,
    data_as_of: resolvedDate,
    returned: stocks.length,
    institution_seat_activity_count: relevantOrgCount,
    note: "billboard_*_cny = the stock's total top-seat buy/sell/net amount on the 龙虎榜 that day (CNY). institution_* fields are populated only for the subset of these stocks that ALSO had a 机构专用 (institution-designated) seat trade that day -- most billboard stocks do not, and null here means none, not missing data. top_brokerages is that day's most-active brokerage BRANCHES market-wide (not specific to these listed stocks) -- the closest keyless proxy found for a 'top-5 brokerages' signal on a billboard date; stocks_bought lists a sample of what each branch traded that day.",
    top_brokerages: topBrokerages,
    source: 'Eastmoney datacenter-web RPT_DAILYBILLBOARD_DETAILSNEW + RPT_ORGANIZATION_TRADE_DETAILSNEW + RPT_OPERATEDEPT_ACTIVE (keyless)',
    stocks,
  };
}

// ── ashares_etf_shares ──────────────────────────────────────────────────
/** '' and null both mean "not disclosed this period" in Eastmoney's fund F10
 * JSON -- unlike `num()`, this must NOT coerce '' to 0 (Number('') === 0). */
function etfNum(v: unknown): number | null {
  if (v === '' || v == null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

async function fetchEtfShareHistory(code: string): Promise<Array<Record<string, unknown>>> {
  const params = new URLSearchParams({ type: 'gmbd', code, page: '1' });
  const res = await pwFetch(`${ETF_SHARES_ARCHIVE}?${params}`, { headers: { 'User-Agent': 'Mozilla/5.0 (pipeworx.io)', Referer: `https://fund.eastmoney.com/${code}.html` } });
  if (!res.ok) throw await httpError(res, 'Eastmoney fund F10');
  const text = await res.text();
  // The endpoint returns `var gmbd_apidata={ content:"<html table>", summary:"...", data:[{...}] };`
  // -- content/summary are an HTML table and a prose string (both quoted with
  // escaped internals); `data` is the one genuinely structured piece, so
  // extract and parse just that array rather than scraping the HTML table.
  const m = text.trim().match(/"data"\s*:\s*(\[\{[\s\S]*\}\])\s*\}\s*;?\s*$/);
  if (!m) return [];
  try {
    return JSON.parse(m[1]) as Array<Record<string, unknown>>;
  } catch {
    return [];
  }
}

async function etfShares(args: Record<string, unknown>) {
  const code = String(args.code ?? '').replace(/\D/g, '');
  if (!/^\d{6}$/.test(code)) throw new Error('code must be a 6-digit ETF code, e.g. "515050".');
  const today = isoToday();
  const fromIso = typeof args.from === 'string' && args.from.trim() ? isoDate(args.from, '1900-01-01') : null;
  const toIso = typeof args.to === 'string' && args.to.trim() ? isoDate(args.to, today) : null;

  const raw = await fetchEtfShareHistory(code);
  if (raw.length === 0) {
    return { code, found: false, message: `No fund-share disclosure history found for ${code} -- check the code (this tool is for Eastmoney-covered ETFs/LOFs with a fund F10 page), or the fund may be too new to have disclosed yet.` };
  }
  const all = raw
    .map((r) => ({
      date: String(r.FSRQ ?? ''),
      name: (r.SHORTNAME as string | undefined) ?? null,
      period_subscriptions_shares: etfNum(r.QJSG),
      period_redemptions_shares: etfNum(r.QJSH),
      period_end_total_shares: etfNum(r.QMZFE),
      period_end_net_assets_cny: etfNum(r.QMJZC) ?? etfNum(r.NETNAV),
      net_assets_change_pct: etfNum(r.CHANGE),
    }))
    .filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.date))
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)); // newest first

  const windowed = all.filter((r) => (!fromIso || r.date >= fromIso) && (!toIso || r.date <= toIso));

  if (windowed.length === 0) {
    const before = all.find((r) => !toIso || r.date <= toIso) ?? null;
    const after = [...all].reverse().find((r) => !fromIso || r.date >= fromIso) ?? null;
    return {
      code,
      found: false,
      requested_from: fromIso,
      requested_to: toIso,
      message:
        `No fund-share disclosure falls inside ${fromIso ?? '(no lower bound)'}..${toIso ?? '(no upper bound)'} for ${code}. ` +
        'Chinese ETFs disclose 基金份额 at quarter-end plus occasional ad-hoc dates, not daily -- try widening the range.' +
        (before ? ` Nearest disclosure at/before the window: ${before.date} (${before.period_end_total_shares?.toLocaleString() ?? 'n/a'} shares).` : '') +
        (after ? ` Nearest at/after: ${after.date} (${after.period_end_total_shares?.toLocaleString() ?? 'n/a'} shares).` : ''),
      all_disclosure_dates: all.slice(0, 12).map((r) => r.date),
    };
  }

  return {
    code,
    name: windowed[0]?.name ?? null,
    found: true,
    country: 'China',
    market: 'China A-share/ETF market',
    statement:
      `China-listed ETF ${code}${windowed[0]?.name ? ` (${windowed[0].name})` : ''}: ${windowed.length} disclosed fund-share record(s) ` +
      `between ${windowed[windowed.length - 1]?.date} and ${windowed[0]?.date}.`,
    returned: windowed.length,
    note:
      "period_end_total_shares (期末总份额) and period_subscriptions/redemptions_shares (期间申购/赎回) are in raw SHARE units (confirmed ×1e8 against the source's own 亿份-denominated HTML table). period_end_net_assets_cny (期末净资产) is raw CNY. This is a DISCLOSURE-DATE series (quarter-end plus occasional ad-hoc material-change dates, e.g. this ETF may have one off-cycle date) -- NOT a literal daily series; no Eastmoney or exchange source publishes a daily retail-accessible 份额 count. For daily PRICE history use ashares_daily_history.",
    source: 'Eastmoney fund F10 archive (FundArchivesDatas.aspx?type=gmbd, keyless)',
    rows: windowed,
  };
}

async function quote(args: Record<string, unknown>) {
  const raw = String(args.symbols ?? '').trim();
  if (!raw) throw new Error('symbols is required, e.g. "600519" or "600519,000001".');
  const codes = raw.split(/[,\s]+/).filter(Boolean).slice(0, 50);
  const syms = codes.map(sinaSym);
  const res = await pwFetch(`${SINA}/list=${syms.join(',')}`, { headers: { Referer: 'https://finance.sina.com.cn/', 'User-Agent': 'Mozilla/5.0 (pipeworx.io)' } });
  if (!res.ok) throw await httpError(res, 'Sina');
  // Sina returns GBK-encoded text (Chinese names). Decode from the raw bytes.
  const text = new TextDecoder('gbk').decode(await res.arrayBuffer());

  const quotes = [];
  for (const line of text.split('\n')) {
    const m = line.match(/hq_str_([a-z]{2}\d{6})="([^"]*)"/);
    if (!m) continue;
    const sym = m[1];
    const f = m[2].split(',');
    if (f.length < 32 || !f[0]) {
      quotes.push({ symbol: sym, code: sym.slice(2), found: false });
      continue;
    }
    const cur = Number(f[3]);
    const prev = Number(f[2]);
    quotes.push({
      symbol: sym,
      code: sym.slice(2),
      name: f[0],
      price: Number.isFinite(cur) ? cur : null,
      prev_close: Number.isFinite(prev) ? prev : null,
      change: Number.isFinite(cur) && Number.isFinite(prev) ? Math.round((cur - prev) * 1000) / 1000 : null,
      change_pct: Number.isFinite(cur) && Number.isFinite(prev) && prev !== 0 ? Math.round(((cur - prev) / prev) * 1e4) / 100 : null,
      open: num(f[1]),
      high: num(f[4]),
      low: num(f[5]),
      volume_shares: num(f[8]),
      turnover_yuan: num(f[9]),
      as_of: `${f[30]} ${f[31]}`,
    });
  }
  return { count: quotes.length, quotes };
}

function requireCode(args: Record<string, unknown>): string {
  const code = String(args.symbol ?? args.code ?? args.symbols ?? '').replace(/\D/g, '');
  if (!/^\d{6}$/.test(code)) {
    throw new Error('symbol must be a 6-digit A-share code, e.g. "000988" or "600519".');
  }
  return code;
}

async function datacenter(reportName: string, code: string, extra: Record<string, string>) {
  const params = new URLSearchParams({
    reportName,
    columns: 'ALL',
    filter: `(SECURITY_CODE="${code}")`,
    ...extra,
  });
  const res = await pwFetch(`${DATACENTER}?${params}`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (pipeworx.io)', Referer: 'https://data.eastmoney.com/' },
  });
  if (!res.ok) throw await httpError(res, 'Eastmoney datacenter');
  const body = (await res.json()) as {
    success?: boolean;
    result?: { data?: Array<Record<string, unknown>>; count?: number } | null;
  };
  // Unknown codes come back success:false / result:null, not an HTTP error.
  return body.result?.data ?? [];
}

// ── ashares_margin_financing ───────────────────────────────────────────
type SzseMarginRow = { jrrzmr: string; jrrzye: string; jrrjmc: string; jrrjyl: string; jrrjye: string; jrrzrjye: string };

async function fetchSzseMarginTotal(dateIso: string): Promise<{ found: boolean; date: string | null; row: SzseMarginRow | null }> {
  const params = new URLSearchParams({ SHOWTYPE: 'JSON', CATALOGID: '1837_xxpl', TABKEY: 'tab1', txtDate: dateIso });
  const res = await pwFetch(`${SZSE_MARGIN}?${params}`, { headers: { Referer: SZSE_MARGIN_REFERER, 'User-Agent': 'Mozilla/5.0 (pipeworx.io)' } });
  if (!res.ok) throw await httpError(res, 'SZSE');
  const body = (await res.json()) as Array<{ metadata?: { subname?: string }; data?: SzseMarginRow[] }>;
  const subname = body[0]?.metadata?.subname;
  const row = body[0]?.data?.[0] ?? null;
  return { found: !!subname && !!row, date: subname || null, row };
}

/** Walk back from `fromIso` (inclusive) until SZSE has a published margin total — covers weekends/holidays and the T+1 publication lag. */
async function szseMarginLatest(fromIso: string, maxTries = 12): Promise<{ found: boolean; date: string | null; row: SzseMarginRow | null; tried: number }> {
  let cursor = fromIso;
  for (let i = 0; i < maxTries; i++) {
    const r = await fetchSzseMarginTotal(cursor);
    if (r.found) return { ...r, tried: i + 1 };
    cursor = isoMinusDays(cursor, 1);
  }
  return { found: false, date: null, row: null, tried: maxTries };
}

async function fetchSzseMarginStock(dateIso: string, code: string): Promise<{ found: boolean; date: string | null; row: (SzseMarginRow & { zqdm?: string; zqjc?: string }) | null }> {
  const params = new URLSearchParams({ SHOWTYPE: 'JSON', CATALOGID: '1837_xxpl', TABKEY: 'tab2', txtDate: dateIso, txtZqdm: code });
  const res = await pwFetch(`${SZSE_MARGIN}?${params}`, { headers: { Referer: SZSE_MARGIN_REFERER, 'User-Agent': 'Mozilla/5.0 (pipeworx.io)' } });
  if (!res.ok) throw await httpError(res, 'SZSE');
  const body = (await res.json()) as Array<{ metadata?: { subname?: string }; data?: Array<SzseMarginRow & { zqdm?: string; zqjc?: string }> }>;
  const subname = body[0]?.metadata?.subname;
  const row = body[0]?.data?.[0] ?? null;
  return { found: !!subname && !!row, date: subname || null, row };
}

type SseMarginRow = { opDate?: string; rzye?: number; rzmre?: number; rzche?: number; rqye?: number; rqylje?: number; rqmcl?: number; rqyl?: number; rzrqjyzl?: number };

async function fetchSseMarginRows(pageSize: number): Promise<SseMarginRow[]> {
  const params = new URLSearchParams({
    isPagination: 'true',
    'pageHelp.pageSize': String(pageSize),
    'pageHelp.pageNo': '1',
    'pageHelp.beginPage': '1',
    'pageHelp.endPage': '1',
    'pageHelp.cacheSize': '1',
    _: `${Date.now()}`,
  });
  const res = await pwFetch(`${SSE_MARGIN}?${params}`, { headers: { Referer: 'https://www.sse.com.cn/', 'User-Agent': 'Mozilla/5.0 (pipeworx.io)' } });
  if (!res.ok) throw await httpError(res, 'SSE');
  const body = (await res.json()) as { pageHelp?: { data?: SseMarginRow[] } };
  return body.pageHelp?.data ?? [];
}

function isSzseCode(code: string): boolean {
  // SZSE main board (0xxxxx), ChiNext (30xxxx), SZSE-listed ETFs (159xxx).
  return /^(0|3)\d{5}$/.test(code) || /^159\d{3}$/.test(code);
}
function isSseCode(code: string): boolean {
  return /^(6|5|9)\d{5}$/.test(code);
}

async function marginFinancing(args: Record<string, unknown>) {
  const symbolRaw = typeof args.symbol === 'string' ? args.symbol.replace(/\D/g, '') : '';

  if (symbolRaw) {
    if (!/^\d{6}$/.test(symbolRaw)) throw new Error('symbol must be a 6-digit code, e.g. "000001".');
    if (isSseCode(symbolRaw)) {
      return {
        symbol: symbolRaw,
        exchange: 'Shanghai Stock Exchange (SSE)',
        found: false,
        message: `No verified keyless per-stock margin-financing (融资融券) route exists for SSE-listed codes (${symbolRaw} is 6xxxxx). Per-stock detail is confirmed available for SZSE codes only (0/3/159-prefixed) — use the market-wide aggregate (omit symbol) for SSE-side totals.`,
      };
    }
    if (!isSzseCode(symbolRaw)) {
      return { symbol: symbolRaw, found: false, message: `${symbolRaw} does not look like a recognized SSE or SZSE code.` };
    }
    const dateArg = typeof args.date === 'string' && args.date.trim() ? isoDate(args.date, isoToday()) : isoToday();
    let cursor = dateArg;
    let hit: { found: boolean; date: string | null; row: (SzseMarginRow & { zqdm?: string; zqjc?: string }) | null } | null = null;
    for (let i = 0; i < 12; i++) {
      const r = await fetchSzseMarginStock(cursor, symbolRaw);
      if (r.found) { hit = r; break; }
      cursor = isoMinusDays(cursor, 1);
    }
    if (!hit || !hit.row) {
      return { symbol: symbolRaw, exchange: 'Shenzhen Stock Exchange (SZSE)', found: false, message: `No margin-financing detail found for ${symbolRaw} in the last 12 calendar days (not on the margin-eligible list, invalid code, or not yet published).` };
    }
    const r = hit.row;
    return {
      symbol: symbolRaw,
      name: r.zqjc ?? null,
      exchange: 'Shenzhen Stock Exchange (SZSE)',
      date: hit.date,
      found: true,
      financing_buy_cny: (cnNum(r.jrrzmr) ?? 0) * 1e8,
      financing_balance_cny: (cnNum(r.jrrzye) ?? 0) * 1e8,
      lending_sellout_shares: (cnNum(r.jrrjmc) ?? 0) * 1e4,
      lending_balance_shares: (cnNum(r.jrrjyl) ?? 0) * 1e4,
      // NOTE: tab2's jrrjye (融券余额) is in 万元, NOT 亿元 like tab1 — confirmed
      // live 2026-10-08. Using the tab1 ×1e8 factor here would be a 10,000×
      // error, not a plausible-looking 100× one.
      lending_balance_cny: (cnNum(r.jrrjye) ?? 0) * 1e4,
      combined_balance_cny: (cnNum(r.jrrzrjye) ?? 0) * 1e8,
      source: 'SZSE ShowReport CATALOGID=1837_xxpl tab2 (融资融券交易明细), keyless',
    };
  }

  // Market-wide aggregate: SSE's own list is already sorted newest-first with
  // no date param, so just pull 3 rows for latest + day-over-day change. SZSE
  // needs an explicit date and fails CLOSED on an unpublished one (empty data,
  // not an error), so walk back from today.
  const sseRows = await fetchSseMarginRows(3);
  if (sseRows.length === 0) throw new Error('SSE margin endpoint returned no rows at all — treat as an upstream failure, not "no margin trading today".');
  const sse = sseRows[0];
  const ssePrior = sseRows[1] ?? null;
  const sseDateIso = ymdToIso(sse.opDate) ?? isoToday();

  const szseLatest = await szseMarginLatest(sseDateIso);
  const szsePrior = szseLatest.date ? await szseMarginLatest(isoMinusDays(szseLatest.date, 1)) : null;

  const sseFinancing = num(sse.rzye) ?? 0;
  const sseLending = num(sse.rqylje) ?? 0;
  const sseCombined = num(sse.rzrqjyzl) ?? (sseFinancing + sseLending);
  const ssePriorFinancing = ssePrior ? num(ssePrior.rzye) ?? null : null;
  const ssePriorCombined = ssePrior ? num(ssePrior.rzrqjyzl) ?? null : null;

  const szseRow = szseLatest.row;
  const szseFinancing = szseRow ? (cnNum(szseRow.jrrzye) ?? 0) * 1e8 : null;
  const szseLending = szseRow ? (cnNum(szseRow.jrrjye) ?? 0) * 1e8 : null; // tab1 IS 亿元 — different from tab2 above.
  const szseCombined = szseRow ? (cnNum(szseRow.jrrzrjye) ?? 0) * 1e8 : null;
  const szsePriorFinancing = szsePrior?.row ? (cnNum(szsePrior.row.jrrzye) ?? 0) * 1e8 : null;
  const szsePriorCombined = szsePrior?.row ? (cnNum(szsePrior.row.jrrzrjye) ?? 0) * 1e8 : null;

  const datesMatch = szseLatest.date === sseDateIso;

  const marketFinancing = szseFinancing != null ? sseFinancing + szseFinancing : null;
  const marketCombined = szseCombined != null ? sseCombined + szseCombined : null;
  const marketFinancingPrior = ssePriorFinancing != null && szsePriorFinancing != null ? ssePriorFinancing + szsePriorFinancing : null;
  const marketCombinedPrior = ssePriorCombined != null && szsePriorCombined != null ? ssePriorCombined + szsePriorCombined : null;

  return {
    country: 'China',
    market: 'China A-share market (SSE + SZSE)',
    as_of: sseDateIso,
    date_note: datesMatch
      ? null
      : `SSE's latest published margin date is ${sseDateIso} but SZSE's latest is ${szseLatest.date ?? 'not found in the last 12 days'} — the two figures below are NOT for the same trading day; treat market-wide totals as unavailable until they align.`,
    statement:
      `China A-share market margin financing (融资融券余额) as of ${sseDateIso}: SSE financing balance ¥${sseFinancing.toLocaleString()}, ` +
      (szseFinancing != null ? `SZSE financing balance ¥${szseFinancing.toLocaleString()} (as of ${szseLatest.date}), combined ¥${(marketFinancing ?? 0).toLocaleString()}.` : 'SZSE figure unavailable.'),
    exchanges: {
      sse: {
        date: sseDateIso,
        financing_balance_cny: sseFinancing,
        financing_buy_cny: num(sse.rzmre),
        financing_repay_cny: num(sse.rzche),
        lending_balance_cny: sseLending,
        lending_balance_shares: num(sse.rqyl),
        lending_sellout_shares: num(sse.rqmcl),
        combined_balance_cny: sseCombined,
        change_financing_cny_dod: ssePriorFinancing != null ? Math.round(sseFinancing - ssePriorFinancing) : null,
        change_combined_cny_dod: ssePriorCombined != null ? Math.round(sseCombined - ssePriorCombined) : null,
      },
      szse: szseRow
        ? {
            date: szseLatest.date,
            financing_balance_cny: szseFinancing,
            financing_buy_cny: (cnNum(szseRow.jrrzmr) ?? 0) * 1e8,
            lending_balance_cny: szseLending,
            lending_balance_100m_shares: cnNum(szseRow.jrrjyl),
            lending_sellout_100m_shares: cnNum(szseRow.jrrjmc),
            combined_balance_cny: szseCombined,
            change_financing_cny_dod: szsePriorFinancing != null && szseFinancing != null ? Math.round(szseFinancing - szsePriorFinancing) : null,
            change_combined_cny_dod: szsePriorCombined != null && szseCombined != null ? Math.round(szseCombined - szsePriorCombined) : null,
          }
        : { found: false, message: `No SZSE margin total published in the 12 calendar days up to ${sseDateIso}.` },
    },
    market_wide: {
      financing_balance_cny: marketFinancing,
      combined_margin_balance_cny: marketCombined,
      change_financing_cny_dod: marketFinancingPrior != null && marketFinancing != null ? Math.round(marketFinancing - marketFinancingPrior) : null,
      change_combined_cny_dod: marketCombinedPrior != null && marketCombined != null ? Math.round(marketCombined - marketCombinedPrior) : null,
      unavailable_reason: marketFinancing == null ? 'SZSE figure for this date could not be found.' : null,
    },
    note:
      'financing_balance_cny = 融资余额 (money borrowed to buy stock); lending_balance_cny = 融券余额 (value of shares borrowed to short); combined_balance_cny = 融资融券余额. Margin data publishes T+1, so a weekday morning request often resolves to yesterday\'s figures. SSE fields are native CNY (元); SZSE tab1 fields are native 亿元, converted here ×1e8 — do not reuse that factor for ashares_margin_financing({symbol}), whose SZSE per-stock source (tab2) reports 融券余额 in 万元 (×1e4) instead.',
    source: 'SSE query.sse.com.cn/marketdata/tradedata/queryMargin.do (keyless) + SZSE www.szse.cn ShowReport CATALOGID=1837_xxpl tab1 (keyless)',
  };
}

async function earningsForecast(args: Record<string, unknown>) {
  const code = requireCode(args);
  const want = Math.min(Math.max(Number(args.limit ?? 4), 1), 20);
  const rows = await datacenter('RPT_PUBLIC_OP_NEWPREDICT', code, {
    sortColumns: 'REPORT_DATE',
    sortTypes: '-1',
    pageSize: String(want),
    pageNumber: '1',
  });
  if (rows.length === 0) {
    return { symbol: code, found: false, message: `No company earnings guidance (业绩预告) on record for ${code} — check the code, or the company may not have issued guidance.` };
  }
  return {
    symbol: code,
    name: rows[0].SECURITY_NAME_ABBR ?? null,
    count: rows.length,
    note: 'Company-issued guidance (业绩预告), newest first. Amounts in CNY. predict_type is the company wording (预增=large increase, 略增=slight increase, 扭亏=turnaround, 预减=decrease).',
    forecasts: rows.map((r) => ({
      report_period: String(r.REPORT_DATE ?? '').slice(0, 10),
      announced: String(r.NOTICE_DATE ?? '').slice(0, 10),
      metric: r.PREDICT_FINANCE ?? null,
      predict_type: r.PREDICT_TYPE ?? null,
      forecast_state: r.FORECAST_STATE ?? null,
      amount_lower_cny: num(r.PREDICT_AMT_LOWER),
      amount_upper_cny: num(r.PREDICT_AMT_UPPER),
      yoy_change_lower_pct: num(r.ADD_AMP_LOWER),
      yoy_change_upper_pct: num(r.ADD_AMP_UPPER),
      prior_year_same_period_cny: num(r.PREYEAR_SAME_PERIOD),
      summary: r.PREDICT_CONTENT ?? null,
      company_reason: r.CHANGE_REASON_EXPLAIN ?? null,
      is_latest: r.IS_LATEST === 'T',
    })),
  };
}

async function analystConsensus(args: Record<string, unknown>) {
  const code = requireCode(args);
  const rows = await datacenter('RPT_RES_PROFITPREDICT', code, { pageSize: '10', pageNumber: '1' });
  if (rows.length === 0) {
    return { symbol: code, found: false, message: `No analyst consensus (盈利预测) on record for ${code} — small caps often have no analyst coverage.` };
  }
  return {
    symbol: code,
    name: rows[0].SECURITY_NAME_ABBR ?? null,
    note: 'Analyst consensus (盈利预测) per forecast year. Amounts in CNY; PE is at the current price.',
    estimates: rows
      .map((r) => ({
        year: num(r.PREDICT_YEAR),
        eps_cny: num(r.EPS),
        pe: num(r.PE) != null ? Math.round((num(r.PE) as number) * 100) / 100 : null,
        net_profit_cny: num(r.PARENT_NETPROFIT),
        revenue_cny: num(r.TOTAL_OPERATE_INCOME),
      }))
      .sort((a, b) => (a.year ?? 0) - (b.year ?? 0)),
  };
}

type Adjust = 'qfq' | 'hfq' | 'none';
const ADJUST_KEY: Record<Adjust, string> = { qfq: 'qfqday', hfq: 'hfqday', none: 'day' };

async function dailyHistoryOne(code: string, start: string, end: string, adjust: Adjust): Promise<Record<string, unknown>> {
  const sym = sinaSym(code);
  const suffix = adjust === 'none' ? '' : adjust;
  const param = `${sym},day,${start},${end},640,${suffix}`;
  let body: { code?: number; data?: Record<string, Record<string, unknown>> };
  try {
    const res = await pwFetch(`${GTIMG_KLINE}?param=${encodeURIComponent(param)}`, { headers: { 'User-Agent': 'Mozilla/5.0 (pipeworx.io)', Referer: 'https://gu.qq.com/' } });
    if (!res.ok) throw await httpError(res, 'gtimg');
    body = (await res.json()) as typeof body;
  } catch (err) {
    return { code, symbol: sym, found: false, message: `Fetch failed for ${sym}: ${err instanceof Error ? err.message : String(err)}` };
  }
  const entry = body.data?.[sym];
  if (!entry) {
    return { code, symbol: sym, found: false, message: `No response data for ${sym} — check the code.` };
  }
  const rowsRaw = (entry[ADJUST_KEY[adjust]] as unknown[] | undefined) ?? (entry.day as unknown[] | undefined) ?? [];
  if (!Array.isArray(rowsRaw) || rowsRaw.length === 0) {
    return { code, symbol: sym, found: false, message: `No trading data for ${sym} between ${start} and ${end} (invalid/delisted code, or no trading days in range).` };
  }
  const rows = rowsRaw.map((r, i) => {
    const row = r as string[];
    const open = num(row[1]);
    const close = num(row[2]);
    const high = num(row[3]);
    const low = num(row[4]);
    const volumeLots = num(row[5]);
    const prevRow = i > 0 ? (rowsRaw[i - 1] as string[]) : null;
    const prevClose = prevRow ? num(prevRow[2]) : null;
    const change_pct = prevClose != null && prevClose !== 0 && close != null ? Math.round(((close - prevClose) / prevClose) * 1e4) / 100 : null;
    return {
      date: row[0],
      open,
      high,
      low,
      close,
      change_pct,
      volume: volumeLots != null ? Math.round(volumeLots * 100) : null,
      amount_cny: 'not_available',
    };
  });
  return { code, symbol: sym, found: true, exchange: exchangeOf(sym), security_type: securityTypeOf(code), adjust, returned: rows.length, rows };
}

// Venue and instrument class from the code alone — both are fixed by the
// exchanges' numbering, so this is a lookup, not a guess: SSE ETFs sit in
// 51/56/58xxxx, SZSE ETFs in 159xxx; 60/68xxxx are SSE stocks, 00/30xxxx SZSE.
// Anything outside those ranges is left null rather than labelled wrongly.
function exchangeOf(sym: string): string {
  if (sym.startsWith('sh')) return 'Shanghai Stock Exchange (SSE)';
  if (sym.startsWith('sz')) return 'Shenzhen Stock Exchange (SZSE)';
  if (sym.startsWith('bj')) return 'Beijing Stock Exchange (BSE)';
  return 'China A-share market';
}
function securityTypeOf(code: string): 'ETF' | 'stock' | null {
  const c = code.replace(/\D/g, '');
  if (/^(51|56|58)\d{4}$/.test(c) || /^159\d{3}$/.test(c)) return 'ETF';
  if (/^(60|68|00|30)\d{4}$/.test(c)) return 'stock';
  return null;
}

async function dailyHistory(args: Record<string, unknown>) {
  const raw = String(args.codes ?? '').trim();
  if (!raw) throw new Error('codes is required, e.g. "300418" or "300418,300364,002131".');
  const codes = raw.split(/[,\s]+/).filter(Boolean).slice(0, 20);
  const today = new Date().toISOString().slice(0, 10);
  const start = isoDate(args.start, today);
  const end = isoDate(args.end, today);
  const adjustArg = typeof args.adjust === 'string' ? args.adjust.trim().toLowerCase() : 'qfq';
  const adjust: Adjust = (['qfq', 'hfq', 'none'] as const).includes(adjustArg as Adjust) ? (adjustArg as Adjust) : 'qfq';
  const results = await Promise.all(codes.map((c) => dailyHistoryOne(c, start, end, adjust)));
  // Name the market and venue in words (fleet #2238): a payload of codes and
  // bars scored `unverifiable` on 34/35 answers — the gateway's entity check
  // could see a market symbol but nothing saying "this is the Chinese
  // A-share market". `country` is a key it reads; `statement` is prose.
  const found = results.filter((r) => r.found === true);
  const described = found
    .map((r) => `${r.code} (${r.security_type ?? 'security'} on the ${r.exchange})`)
    .join(', ');
  const adjustLabel = adjust === 'none' ? 'unadjusted' : adjust === 'hfq' ? 'back-adjusted (hfq)' : 'forward-adjusted (qfq)';
  const totalRows = found.reduce((n, r) => n + (typeof r.returned === 'number' ? r.returned : 0), 0);
  const statement =
    `China A-share market (Chinese A-shares): daily OHLCV bars for ${described || codes.join(', ')}, ${adjustLabel}, ${start} to ${end}; ` +
    `${totalRows} trading-day row(s) across ${found.length} of ${codes.length} code(s).`;
  return {
    country: 'China',
    market: 'China A-share market (Shanghai, Shenzhen and Beijing exchanges)',
    statement,
    start,
    end,
    adjust,
    note: 'change_pct is computed here from consecutive closes within the returned range (first row per code is null — no prior close in range). volume is shares (converted from the source\'s 100-share lots). amount_cny (成交额) is not available from this daily-bar source — use ashares_quote or ashares_turnover_ranking for same-day turnover amount.',
    source: 'Tencent/gtimg fqkline (keyless)',
    results,
    // Measured (fleet #2324): ashares_daily_history is a top-15 single-tool
    // entry point in 30d — 19 distinct external callers pull a price history
    // and never ask for today's live number, even though the note above
    // already tells them same-day turnover isn't in this response. Pre-fill
    // from the codes THIS call actually resolved (`found`), not the raw
    // request, so a partly-invalid `codes` list doesn't hand back a symbol
    // ashares_quote would reject.
    //
    // 14d re-measure (fleet #2325, 2026-10-07, same methodology as above —
    // re-deriving the #2324 baseline at the same tool gave 29, not the 19
    // quoted here; use this comment's own re-derived 29 as the apples-to-
    // apples baseline, not the original 19): single-tool-only callers 29 ->
    // 19 (total callers 194 -> 306, UP 58% — traffic grew while the
    // single-tool share shrank), share 14.9% -> 6.2%, DOWN 8.7pt. The
    // combination of more callers AND a lower single-tool share is the
    // cleanest positive read of the 6 shipped hints. Full comparison in the
    // fleet #2325 close.
    ...(found.length > 0
      ? {
          next: {
            tool: 'ashares_quote',
            args: { symbols: found.map((r) => r.code).join(',') },
            why: 'Live quote for the same stock(s) — current price, change % and today\'s turnover, which this history call does not carry.',
          },
        }
      : {}),
  };
}

// ── intraday minute bars ─────────────────────────────────────────────
type SinaKlineRow = { day: string; open: string; high: string; low: string; close: string; volume: string; amount: string };

/** HH:MM or HH:MM:SS -> "HH:MM:SS", or null if not parseable. */
function normalizeTime(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const m = v.trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh > 23 || mm > 59) return null;
  return `${String(hh).padStart(2, '0')}:${m[2]}:${m[3] ?? '00'}`;
}

async function fetchSinaKline(sym: string, intervalMin: string): Promise<SinaKlineRow[] | null> {
  const url = `${SINA_KLINE}?symbol=${sym}&scale=${intervalMin}&ma=no&datalen=1950`;
  const res = await pwFetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (pipeworx.io)', Referer: 'https://finance.sina.com.cn/' } });
  if (!res.ok) throw await httpError(res, 'Sina');
  const text = await res.text();
  const m = text.match(/var _=\((\[.*\]|null)\);/s);
  if (!m) return null;
  const parsed = JSON.parse(m[1]);
  return Array.isArray(parsed) ? (parsed as SinaKlineRow[]) : null;
}

async function intradayBarsOne(code: string, date: string, upTo: string | null, intervalMin: string): Promise<Record<string, unknown>> {
  const sym = sinaSym(code);
  let all: SinaKlineRow[] | null;
  try {
    all = await fetchSinaKline(sym, intervalMin);
  } catch (err) {
    return { code, symbol: sym, found: false, message: `Fetch failed for ${sym}: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!all || all.length === 0) {
    return { code, symbol: sym, found: false, message: `No intraday bar data for ${sym} — check the code.` };
  }
  const earliestBarDate = all[0].day.slice(0, 10);
  const latestBarDate = all[all.length - 1].day.slice(0, 10);
  const dayBars = all.filter((r) => r.day.startsWith(date));
  if (dayBars.length === 0) {
    const beforeWindow = date < earliestBarDate;
    return {
      code,
      symbol: sym,
      found: false,
      earliest_bar_date_available: earliestBarDate,
      latest_bar_date_available: latestBarDate,
      message: beforeWindow
        ? `No ${intervalMin}-minute bars for ${sym} on ${date} -- that date is before this symbol's current intraday retention window, which starts at ${earliestBarDate} for a ${intervalMin}-minute interval. Try a coarser interval (fewer, longer bars reach further back) or ashares_daily_history for daily (not intraday) history further back.`
        : `No ${intervalMin}-minute bars for ${sym} on ${date} (not a trading day / market holiday, or the date is after the latest available bar at ${latestBarDate}).`,
    };
  }
  const bars = dayBars.map((r) => ({
    time: r.day.slice(11, 16),
    open: num(r.open),
    high: num(r.high),
    low: num(r.low),
    close: num(r.close),
    volume_shares: num(r.volume) != null ? Math.round(num(r.volume) as number) : null,
    turnover_cny: num(r.amount) != null ? Math.round(num(r.amount) as number) : null,
  }));
  const cutoff = upTo ? dayBars.filter((r) => r.day <= `${date} ${upTo}`) : dayBars;
  const sum = (rows: SinaKlineRow[], key: 'volume' | 'amount') => rows.reduce((s, r) => s + (num(r[key]) ?? 0), 0);
  const lastCutoffBar = cutoff[cutoff.length - 1] ?? null;
  return {
    code,
    symbol: sym,
    found: true,
    exchange: exchangeOf(sym),
    security_type: securityTypeOf(code),
    date,
    interval_minutes: Number(intervalMin),
    as_of_time: lastCutoffBar ? lastCutoffBar.day.slice(11, 16) : null,
    bars_through_as_of: cutoff.length,
    cumulative_volume_shares: Math.round(sum(cutoff, 'volume')),
    cumulative_turnover_cny: Math.round(sum(cutoff, 'amount')),
    full_day_volume_shares: Math.round(sum(dayBars, 'volume')),
    full_day_turnover_cny: Math.round(sum(dayBars, 'amount')),
    returned_bars: bars.length,
    bars,
    earliest_bar_date_available: earliestBarDate,
    latest_bar_date_available: latestBarDate,
  };
}

async function intradayBars(args: Record<string, unknown>) {
  const raw = String(args.symbols ?? '').trim();
  if (!raw) throw new Error('symbols is required, e.g. "515050" or "600519,000001".');
  const codes = raw.split(/[,\s]+/).filter(Boolean).slice(0, 5);
  if (typeof args.date !== 'string' || !args.date.trim()) {
    throw new Error('date is required, e.g. "2026-09-01" or "20260901" -- the trading day the bars are for.');
  }
  const today = new Date().toISOString().slice(0, 10);
  const date = isoDate(args.date, today);
  const intervalArg = args.interval != null ? String(args.interval).trim() : '5';
  const interval = (['1', '5', '15', '30', '60'] as const).includes(intervalArg as '1' | '5' | '15' | '30' | '60') ? intervalArg : '5';
  let upTo: string | null = null;
  if (args.up_to != null) {
    upTo = normalizeTime(args.up_to);
    if (!upTo) throw new Error('up_to must be "HH:MM" (24-hour, Beijing time), e.g. "11:05".');
  }

  const results = await Promise.all(codes.map((c) => intradayBarsOne(c, date, upTo, interval)));
  const found = results.filter((r) => r.found === true) as Array<{ code: string; exchange: string; security_type: string | null; cumulative_volume_shares: number; cumulative_turnover_cny: number; as_of_time: string | null }>;
  const described = found.map((r) => `${r.code} (${r.security_type ?? 'security'} on the ${r.exchange})`).join(', ');
  const upToLabel = upTo ? upTo.slice(0, 5) : 'end of day';
  const statement =
    `China A-share market (Chinese A-shares): ${interval}-minute intraday bars for ${described || codes.join(', ')} on ${date}, cumulative volume and turnover through ${upToLabel}. ` +
    found.map((r) => `${r.code}: ${r.cumulative_volume_shares.toLocaleString()} shares / ¥${r.cumulative_turnover_cny.toLocaleString()} as of ${r.as_of_time ?? 'n/a'}.`).join(' ');
  return {
    country: 'China',
    market: 'China A-share market (Shanghai, Shenzhen and Beijing exchanges)',
    statement,
    date,
    up_to: upTo ? upTo.slice(0, 5) : null,
    interval_minutes: Number(interval),
    note:
      'cumulative_volume_shares/cumulative_turnover_cny are summed by this pack from the interval bars between the start of the trading day and `up_to` inclusive (or the whole day if up_to is omitted). Lookback is bounded by the upstream (Sina), which returns at most ~1950 of the most-recent bars regardless of interval -- so the retention window is a sliding ~8 trading days at 1-minute, ~40 at 5-minute (default), ~110 at 15-minute, ~1 year at 30-minute, ~2 years at 60-minute, shrinking and sliding forward daily. A date older than earliest_bar_date_available in a result is out of range at that interval. Cross-checked against ashares_daily_history\'s daily volume for the same code+day: full-day sums here matched within ~0.1%.',
    source: 'Sina quotes.sina.cn CN_MarketDataService.getKLineData (keyless)',
    results,
  };
}

// ── technical indicators ────────────────────────────────────────────
// All computed client-side from ashares_daily_history's own OHLCV bars — no
// new upstream call, no new vendor, no new key.

function sma(values: (number | null)[], period: number, i: number): number | null {
  if (i < period - 1) return null;
  let sum = 0;
  for (let k = i - period + 1; k <= i; k++) {
    const v = values[k];
    if (v == null) return null;
    sum += v;
  }
  return sum / period;
}

function computeMA(closes: (number | null)[], window: number): (number | null)[] {
  return closes.map((_, i) => {
    const v = sma(closes, window, i);
    return v == null ? null : Math.round(v * 1e4) / 1e4;
  });
}

function computeBOLL(closes: (number | null)[], period: number, mult: number) {
  const middle: (number | null)[] = [];
  const upper: (number | null)[] = [];
  const lower: (number | null)[] = [];
  for (let i = 0; i < closes.length; i++) {
    const mid = sma(closes, period, i);
    if (mid == null) {
      middle.push(null);
      upper.push(null);
      lower.push(null);
      continue;
    }
    let sumSq = 0;
    for (let k = i - period + 1; k <= i; k++) sumSq += ((closes[k] as number) - mid) ** 2;
    const std = Math.sqrt(sumSq / period);
    middle.push(Math.round(mid * 1e4) / 1e4);
    upper.push(Math.round((mid + mult * std) * 1e4) / 1e4);
    lower.push(Math.round((mid - mult * std) * 1e4) / 1e4);
  }
  return { middle, upper, lower };
}

/** Standard EMA, seeded with the first non-null value. With enough lookback
 * (this pack always fetches 120+ extra calendar days before `start`) the seed
 * choice washes out within a few periods — the error decays as (1-k)^n. */
function computeEMA(values: (number | null)[], period: number): (number | null)[] {
  const k = 2 / (period + 1);
  const out: (number | null)[] = new Array(values.length).fill(null);
  let prev: number | null = null;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v == null) continue;
    prev = prev == null ? v : v * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

function computeMACD(closes: (number | null)[], fast: number, slow: number, signal: number) {
  const emaFast = computeEMA(closes, fast);
  const emaSlow = computeEMA(closes, slow);
  const dif = closes.map((_, i) => (emaFast[i] != null && emaSlow[i] != null ? (emaFast[i] as number) - (emaSlow[i] as number) : null));
  const dea = computeEMA(dif, signal);
  const hist = dif.map((d, i) => (d != null && dea[i] != null ? 2 * (d - (dea[i] as number)) : null));
  const round = (v: number | null) => (v == null ? null : Math.round(v * 1e4) / 1e4);
  return { dif: dif.map(round), dea: dea.map(round), histogram: hist.map(round) };
}

function computeKDJ(highs: (number | null)[], lows: (number | null)[], closes: (number | null)[], n: number, m1: number, m2: number) {
  const K: (number | null)[] = new Array(closes.length).fill(null);
  const D: (number | null)[] = new Array(closes.length).fill(null);
  const J: (number | null)[] = new Array(closes.length).fill(null);
  let prevK = 50;
  let prevD = 50;
  for (let i = 0; i < closes.length; i++) {
    if (i < n - 1) continue;
    let hh = -Infinity;
    let ll = Infinity;
    let ok = true;
    for (let k = i - n + 1; k <= i; k++) {
      const h = highs[k];
      const l = lows[k];
      if (h == null || l == null) { ok = false; break; }
      if (h > hh) hh = h;
      if (l < ll) ll = l;
    }
    const c = closes[i];
    if (!ok || c == null || hh === ll) continue;
    const rsv = ((c - ll) / (hh - ll)) * 100;
    const k = ((m1 - 1) * prevK + rsv) / m1;
    const d = ((m2 - 1) * prevD + k) / m2;
    const j = 3 * k - 2 * d;
    K[i] = Math.round(k * 1e4) / 1e4;
    D[i] = Math.round(d * 1e4) / 1e4;
    J[i] = Math.round(j * 1e4) / 1e4;
    prevK = k;
    prevD = d;
  }
  return { k: K, d: D, j: J };
}

async function technicalIndicators(args: Record<string, unknown>) {
  const raw = String(args.codes ?? '').trim();
  if (!raw) throw new Error('codes is required, e.g. "515050" or "600519,300750".');
  const codes = raw.split(/[,\s]+/).filter(Boolean).slice(0, 5);
  const today = new Date().toISOString().slice(0, 10);
  const wantStart = isoDate(args.start, today);
  const end = isoDate(args.end, today);
  const adjustArg = typeof args.adjust === 'string' ? args.adjust.trim().toLowerCase() : 'qfq';
  const adjust: Adjust = (['qfq', 'hfq', 'none'] as const).includes(adjustArg as Adjust) ? (adjustArg as Adjust) : 'qfq';

  const families = Array.isArray(args.indicators) && args.indicators.length > 0 ? (args.indicators as string[]) : ['ma', 'boll', 'macd', 'kdj'];
  const maWindows = Array.isArray(args.ma_windows) && args.ma_windows.length > 0 ? (args.ma_windows as number[]).map(Number).filter(Number.isFinite) : [5, 10, 20, 60];
  const bollPeriod = Number(args.boll_period ?? 20);
  const bollMult = Number(args.boll_mult ?? 2);
  const macdFast = Number(args.macd_fast ?? 12);
  const macdSlow = Number(args.macd_slow ?? 26);
  const macdSignal = Number(args.macd_signal ?? 9);
  const kdjN = Number(args.kdj_n ?? 9);
  const kdjM1 = Number(args.kdj_m1 ?? 3);
  const kdjM2 = Number(args.kdj_m2 ?? 3);

  // Fetch extra lookback so MA60/MACD/KDJ are warmed up by `wantStart` — 220
  // calendar days ≈ 150 trading days, comfortably past the longest default
  // window (MA60) plus MACD's slow EMA + signal (~35 periods).
  const padded = new Date(`${wantStart}T00:00:00Z`);
  padded.setUTCDate(padded.getUTCDate() - 220);
  const fetchStart = padded.toISOString().slice(0, 10);

  const raws = await Promise.all(codes.map((c) => dailyHistoryOne(c, fetchStart, end, adjust)));

  const results = raws.map((r) => {
    if (!r.found) return r;
    const rows = (r.rows as Array<{ date: string; open: number | null; high: number | null; low: number | null; close: number | null }>) ?? [];
    const closes = rows.map((row) => row.close);
    const highs = rows.map((row) => row.high);
    const lows = rows.map((row) => row.low);

    const maSeries: Record<string, (number | null)[]> = {};
    if (families.includes('ma')) for (const w of maWindows) maSeries[`ma${w}`] = computeMA(closes, w);
    const boll = families.includes('boll') ? computeBOLL(closes, bollPeriod, bollMult) : null;
    const macd = families.includes('macd') ? computeMACD(closes, macdFast, macdSlow, macdSignal) : null;
    const kdj = families.includes('kdj') ? computeKDJ(highs, lows, closes, kdjN, kdjM1, kdjM2) : null;

    const startIdx = rows.findIndex((row) => row.date >= wantStart);
    const from = startIdx === -1 ? rows.length : startIdx;

    const indicatorRows = rows.slice(from).map((row, k) => {
      const i = from + k;
      const out: Record<string, unknown> = { date: row.date, close: row.close };
      for (const [key, series] of Object.entries(maSeries)) out[key] = series[i];
      if (boll) { out.boll_upper = boll.upper[i]; out.boll_middle = boll.middle[i]; out.boll_lower = boll.lower[i]; }
      if (macd) { out.macd_dif = macd.dif[i]; out.macd_dea = macd.dea[i]; out.macd_histogram = macd.histogram[i]; }
      if (kdj) { out.kdj_k = kdj.k[i]; out.kdj_d = kdj.d[i]; out.kdj_j = kdj.j[i]; }
      return out;
    });

    return {
      code: r.code,
      symbol: r.symbol,
      found: true,
      exchange: r.exchange,
      security_type: r.security_type,
      adjust,
      returned: indicatorRows.length,
      lookback_bars_used: rows.length,
      rows: indicatorRows,
    };
  });

  const found = results.filter((r) => (r as { found?: boolean }).found === true);
  const described = found.map((r) => `${(r as { code: string }).code}`).join(', ');
  return {
    country: 'China',
    market: 'China A-share market (Shanghai, Shenzhen and Beijing exchanges)',
    statement: `China A-share/ETF technical indicators for ${described || codes.join(', ')}, ${wantStart} to ${end}: ${families.join('/')} computed from ${adjust} daily OHLCV. Source: Tencent/gtimg fqkline (keyless), same as ashares_daily_history.`,
    start: wantStart,
    end,
    adjust,
    indicators: families,
    note: 'MA/BOLL/MACD/KDJ are computed by this pack from ashares_daily_history-equivalent OHLCV bars, not fetched pre-computed from any indicator vendor. MACD histogram uses the CN charting convention 柱=2×(DIF−DEA). KDJ K/D are recursive (seeded at 50), so values shortly after the fetched lookback window can differ slightly from a source with a longer warm-up; lookback_bars_used shows how many bars fed each result.',
    results,
  };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'ashares_market_snapshot':
      return marketSnapshot();
    case 'ashares_limit_up':
      return limitUp(args);
    case 'ashares_limit_down':
      return limitDown(args);
    case 'ashares_margin_financing':
      return marginFinancing(args);
    case 'ashares_quote':
      return quote(args);
    case 'ashares_turnover_ranking':
      return turnoverRanking(args);
    case 'ashares_capital_flow':
      return capitalFlow(args);
    case 'ashares_billboard':
      return billboard(args);
    case 'ashares_etf_shares':
      return etfShares(args);
    case 'ashares_earnings_forecast':
      return earningsForecast(args);
    case 'ashares_analyst_consensus':
      return analystConsensus(args);
    case 'ashares_daily_history':
      return dailyHistory(args);
    case 'ashares_intraday_bars':
      return intradayBars(args);
    case 'ashares_technical_indicators':
      return technicalIndicators(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
