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
const SINA = 'https://hq.sinajs.cn';
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
    name: 'ashares_market_snapshot',
    description:
      "Overall snapshot of the Chinese A-share market — the headline index levels (Shanghai Composite, Shenzhen Component, ChiNext, STAR 50, CSI 300) with change %, day range and turnover, plus how many stocks hit limit-up (涨停) today as a sentiment gauge. Answers 'how is the China A-share market doing', 'Shanghai Composite today', 'A-share market snapshot at close', 'how did Chinese stocks close'. Source: Sina + Eastmoney (keyless).",
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
      "Market-wide ranking of Chinese A-share stocks by turnover / 成交额排名, 成交额前30名, 成交量排名, or 涨跌幅排名 — the whole board (not specific codes), sorted server-side and returned as a ranked list. Answers 'A股成交额前30名', 'top 30 A-shares by turnover today', 'A股成交量排名', 'A-share market-wide ranking by amount/volume/change %', 'which A-shares traded the most today'. Each row has code, name, price, change %, volume (shares), turnover in CNY (成交额), turnover rate %, and quote time. Source: Sina Market_Center.getHQNodeData (keyless).",
    summary: 'China A-share stocks ranked by trading turnover today, from Eastmoney.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        limit: { type: 'number', description: 'How many stocks to return, 1–100 (default 30).' },
        sort: { type: 'string', enum: ['amount', 'changepercent', 'volume'], description: 'Rank by turnover amount (成交额, default), change % (涨跌幅), or share volume (成交量).' },
        order: { type: 'string', enum: ['desc', 'asc'], description: 'desc (default, highest first) or asc.' },
        board: {
          type: 'string',
          enum: ['hs_a', 'sh_a', 'sz_a', 'cyb'],
          description: "Which board to rank: hs_a = all Shanghai+Shenzhen A-shares (default, 沪深A股), sh_a = Shanghai only (沪市A股), sz_a = Shenzhen only (深市A股), cyb = ChiNext (创业板).",
        },
      },
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

  // Limit-up count (涨停家数) — a headline breadth/sentiment gauge for A-shares.
  let limitUpCount: number | null = null;
  const date = latestTradingDate();
  try {
    const params = new URLSearchParams({ ut: '7eea3edcaed734bea9cbfc24409ed989', dpt: 'wz.ztzt', Pageindex: '0', pagesize: '1', sort: 'fbt:asc', date });
    const res = await pwFetch(`${ZT_POOL}?${params}`, { headers: { 'User-Agent': 'Mozilla/5.0 (pipeworx.io)', Referer: 'https://quote.eastmoney.com/' } });
    if (res.ok) {
      const body = (await res.json()) as { data?: { tc?: number } | null };
      limitUpCount = body.data?.tc ?? null;
    }
  } catch { /* breadth best-effort */ }

  return {
    market: 'China A-shares (Shanghai / Shenzhen / STAR / ChiNext)',
    as_of: asOf ?? date,
    indices,
    limit_up_count: limitUpCount,
    note: 'Index turnover is in CNY. limit_up_count = number of A-shares that closed at their daily price limit (+10%, or +20% for STAR/ChiNext) — a market-sentiment gauge. Use ashares_limit_up for the ranked limit-up pool. Source: Sina (indices) + Eastmoney (limit-up), keyless.',
  };
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
  const rows = raw.map((s) => ({
    code: s.code ?? null,
    name: s.name ?? null,
    price: num(s.trade),
    change: num(s.pricechange),
    change_pct: num(s.changepercent) != null ? Math.round((num(s.changepercent) as number) * 100) / 100 : null,
    volume_shares: num(s.volume),
    amount_cny: num(s.amount),
    turnover_rate_pct: num(s.turnoverratio) != null ? Math.round((num(s.turnoverratio) as number) * 100) / 100 : null,
    industry: 'not_available',
    tick_time: s.ticktime ?? null,
  }));
  return {
    board,
    sort,
    order: asc === '1' ? 'asc' : 'desc',
    as_of: rows[0]?.tick_time ?? null,
    returned: rows.length,
    note: 'industry (行业) is not available from this Sina endpoint; use a per-code lookup elsewhere if needed. amount_cny is turnover (成交额) in CNY.',
    source: 'Sina Market_Center.getHQNodeData (keyless)',
    rows,
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
    case 'ashares_quote':
      return quote(args);
    case 'ashares_turnover_ranking':
      return turnoverRanking(args);
    case 'ashares_earnings_forecast':
      return earningsForecast(args);
    case 'ashares_analyst_consensus':
      return analystConsensus(args);
    case 'ashares_daily_history':
      return dailyHistory(args);
    case 'ashares_technical_indicators':
      return technicalIndicators(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
