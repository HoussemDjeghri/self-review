/**
 * wire.mjs — coupling that has no import.
 *
 * The symbol path (impact.mjs's `changedSymbols` → grep → `broken`) finds a
 * consumer that *names* what changed. It cannot find the most common real
 * breakage there is: a backend renames `router.get("/api/users/:id")` and the
 * frontend's `fetch` of `"/api/users/" + id` dies. Nothing was imported,
 * nothing was exported, and a call graph is no help either — the two sides are
 * disconnected components and the edge exists only at runtime, over HTTP.
 *
 * What couples them is a *string*. So this module extracts the wire contracts a
 * diff removed or renamed, and hands impact.mjs search terms that will actually
 * appear at a consumer. Four rules make that work, each of which the naive
 * version gets wrong:
 *
 * 1. Trigger on **removed and not re-added**, not on "changed". A reformatted
 *    route line otherwise searches the tree for every literal on it.
 * 2. Search an **anchor**, not the literal. `/api/users/:id` never appears in a
 *    consumer; `/api/users/` appears in all of `"/api/users/" + id`,
 *    `` `/api/users/${id}` ``, `f"/api/users/{id}"` and `"/api/users/%s" % id`.
 * 3. Report "still names the old value" and stop. Deciding whether that is a
 *    break is the reviewer's job, not a script's.
 * 4. The tier marker fires on **consumers found**, not on a literal changing —
 *    otherwise every route edit escalates and the marker means nothing.
 *
 * Deliberately not here: a per-framework route parser. The break is symmetric
 * (a frontend moving to /api/v2 while the backend still serves /api is the same
 * bug, and a parser only knows the declaring side), the key it would produce is
 * the string we already have, and its coverage is a long tail where every miss
 * is silent. The one thing a parser would genuinely add is file-system routers,
 * where the route IS the path and no literal exists anywhere — `routeForPath`
 * covers that case directly.
 */
import path from "node:path";
import { DOC_EXTENSIONS } from "./paths.mjs";

/** Params in every dialect: Express, Rails, Flask, printf, f-string, JS template, glob. */
const PARAM = /^(:[\w-]+|\{[^}]*\}|<[^>]*>|\$\{[^}]*\}|%[sdiv]|\[[^\]]*\]|\*)$/;

/** Path segments that carry no identity, so they never satisfy the "one real segment" rule. */
const STOP_SEGMENTS = new Set(["api", "v1", "v2", "v3", "www", "com", "org", "net", "http", "https", "index", "public", "static", "assets"]);

/** Absolute paths that are filesystem, not wire. */
const FILESYSTEM = /^\/(usr|etc|var|tmp|opt|home|Users|dev|proc|bin|sbin|lib|mnt|srv)(\/|$)/;

const HTTP_VERBS = ["get", "post", "put", "patch", "delete", "head", "options", "all"];

/**
 * The verb declared on the same line, if any — folded into the key so that
 * `router.get(PATH)` becoming `router.post(PATH)` is visible at all. The
 * literal is unchanged there, so without this the whole edit is invisible.
 */
export function verbOn(line) {
  const patterns = [
    new RegExp(`\\.(${HTTP_VERBS.join("|")})\\s*\\(`, "i"),                     // router.get(
    new RegExp(`@(?:app|router|bp|blueprint)\\.(${HTTP_VERBS.join("|")})\\b`, "i"), // @app.get(
    new RegExp(`@(${HTTP_VERBS.join("|")})\\s*\\(`, "i"),                       // @Get(  — Nest
    new RegExp(`\\b(${HTTP_VERBS.join("|")})\\s+['"\`]`, "i"),                  // get "/users" — Rails/Sinatra
    new RegExp(`\\bmethod\\s*[:=]\\s*['"\`](${HTTP_VERBS.join("|")})['"\`]`, "i"),
  ];
  for (const pattern of patterns) {
    const hit = line.match(pattern);
    if (hit) return hit[1].toUpperCase();
  }
  return null;
}

/** Does this line declare the contract, rather than consume it? Reported for the reviewer; never gates admission. */
export function declaresOn(line, file) {
  if (/\b(router|app|bp|blueprint)\s*\.\s*(get|post|put|patch|delete|use|route)\s*\(/i.test(line)) return true;
  if (/@(Get|Post|Put|Patch|Delete|Controller|RequestMapping|app\.route)\b/.test(line)) return true;
  if (/\b(addEventListener|on|subscribe|consume|handler)\s*\(/.test(line)) return false;
  return /(^|\/)(routes?|api|controllers?|handlers?|endpoints?|urls)\b/i.test(path.dirname(file));
}

const segmentsOf = (value) => value.replace(/^\/+/, "").replace(/\/+$/, "").split("/");

/**
 * Which kind of wire contract this literal is, or null. The filters exist to
 * keep `"/"`, `"id"` and `"foo.bar"` — which occur thousands of times — out of
 * a tree-wide search, without a per-project stop list anyone has to maintain.
 */
/** `https://host/api/users/` and `/api/users/` are the same contract. */
export const withoutOrigin = (value) => value.match(/^[a-z][\w+.-]*:\/\/[^/]+(\/.*)$/i)?.[1] ?? value;

/**
 * Does this literal look like a credential rather than a contract? A commit
 * that ROTATES a leaked secret removes it and adds nothing in its place, which
 * is exactly the removed-and-not-re-added shape — and the value would then be
 * copied verbatim into impact.md, impact.json and the tier's marker evidence,
 * all of which outlive the diff and some of which get committed. The diff
 * already holds the secret; there is no reason to spread it into four more
 * files and a subagent brief. Nothing of value is lost: a path segment of 20+
 * characters mixing letters and digits is not a contract anyone writes twice.
 * Tested per segment, on the longest UNBROKEN alphanumeric run in it — a secret
 * is one continuous run, while a slug is short words joined by hyphens. Reading
 * the whole segment instead swallowed ordinary routes whole and silently:
 * `/products/mens-running-shoes-2024-limited-edition` never became a token at
 * all, which is the "indistinguishable from nothing changed" failure rule 1
 * exists to prevent, reached from the other direction. A UUID is named as the
 * standard it is rather than guessed at, and an all-letter run of 32+ counts
 * too — that was a live bypass while the rule demanded a digit.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const looksLikeSecret = (value) =>
  value.split(/[/.]/).some((part) => {
    if (UUID.test(part)) return true;                      // RFC 4122: a standard, not a guessed shape
    const run = (part.match(/[A-Za-z0-9]+/g) ?? []).reduce((longest, m) => Math.max(longest, m.length), 0);
    return run >= 20 && (/[0-9]/.test(part) || run >= 32);
  });

export function classify(value, { minSegments = 2, minLiteralChars = 3 } = {}) {
  if (typeof value !== "string" || !value || value.length > 200) return null;
  if (looksLikeSecret(value)) return null;
  const candidate = withoutOrigin(value);

  if (candidate.startsWith("/")) {
    if (/^\.{1,2}\//.test(value) || value.startsWith("~/") || FILESYSTEM.test(candidate)) return null;
    const segments = segmentsOf(candidate);
    if (segments.length < minSegments) return null;
    // A trailing file extension makes it a path, not a route; impact.mjs's
    // fileSymbols already searches file names.
    if (/\.[a-z0-9]{1,5}$/i.test(segments[segments.length - 1])) return null;
    const literal = segments.filter((segment) => !PARAM.test(segment));
    // One gate, on the property that matters: does any segment carry identity?
    // It used to be two, and the second — a floor on the JOINED length of every
    // literal segment — rejected `/users/:id`, `/cart/:id`, `/team/:id` and
    // every other unprefixed REST endpoint, which never became a token at all:
    // no row, no count, indistinguishable from "nothing changed".
    if (!literal.some((segment) => segment.length >= minLiteralChars && !STOP_SEGMENTS.has(segment.toLowerCase()))) return null;
    return "route";
  }
  if (/^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$/.test(value) && value.length >= 8) return "screaming";
  if (/^[a-z][\w-]*(\.[\w-]+)+$/.test(value) && value.length >= 10 && value.split(".").every((part) => part.length >= 3)) return "dotted";
  if (/^--[a-z0-9][a-z0-9-]*$/.test(value)) return "kebab";
  if (/^[a-z0-9]+(-[a-z0-9]+)+$/.test(value) && value.length >= 10) return "kebab";
  if (/^[A-Z][A-Za-z0-9]*(-[A-Z][A-Za-z0-9]*)+$/.test(value) && value.length >= 5) return "header";
  return null;
}

/** The map key: two spellings of one contract must collapse, or the join finds nothing. */
export function normalise(value, kind) {
  if (kind !== "route") return value;
  const withoutQuery = withoutOrigin(value).split(/[?#]/)[0];
  const collapsed = withoutQuery.replace(/\/{2,}/g, "/").replace(/\/+$/, "");
  return `/${segmentsOf(collapsed).map((segment) => (PARAM.test(segment) ? "*" : segment)).join("/")}`;
}

/**
 * What to actually search for: the longest run of consecutive literal segments,
 * with its slashes, so it survives concatenation and interpolation at the call
 * site. The second entry drops the first segment, for the base-URL-in-a-constant
 * case (`` `${API}/users/${id}` ``) — used only when the first finds nothing,
 * which is what keeps its looseness from costing anything.
 */
export function anchorsFor(value, kind) {
  if (kind !== "route") return { strong: [value], weak: null };
  const segments = segmentsOf(normalise(value, kind));
  const runs = [];
  let current = [];
  for (const segment of segments) {
    if (segment === "*") { if (current.length) runs.push(current); current = []; continue; }
    current.push(segment);
  }
  if (current.length) runs.push(current);
  if (runs.length === 0) return { strong: [], weak: null };
  const longest = runs.reduce((best, run) => (run.length > best.length ? run : best), runs[0]);
  const strong = [`/${longest.join("/")}/`];
  // The longest run is not always the identifying one. `/api/v1/:tenant/projects/:id`
  // has `[api, v1]` as its longest and `[projects]` as its last, and a consumer
  // written `` `${API_BASE}/projects/${id}` `` contains only the second. Both are
  // searched, both are strong: each is a full literal run, so the segment
  // signature still has to agree before a hit becomes a reference.
  const last = runs[runs.length - 1];
  if (last !== longest) strong.push(`/${last.join("/")}/`);
  // The weak anchor is the longest run minus its leading segment, for a base
  // URL held in a constant. It is kept OUT of the strong list rather than
  // appended to it: a strong pass that tried it would match `/orders/` for
  // `/api/orders/:id` and report a base-URL consumer as a certain one.
  const weak = longest.length > 1 ? `/${longest.slice(1).join("/")}/` : null;
  return { strong: [...new Set(strong)], weak: strong.includes(weak) ? null : weak };
}

/** Every quoted literal on one line. Backticks included: a template literal is where the interpolated forms live. */
export function literalsOn(line) {
  const found = [];
  for (const match of line.matchAll(/(['"`])((?:\\.|(?!\1)[^\\])*)\1/g)) found.push(match[2]);
  return found;
}

/**
 * The identifier-shaped words on a line that carry no quotes. A non-route
 * contract is named unquoted at most of its call sites — `process.env.DATABASE_URL`,
 * `--dry-run` on a command line, `X-Request-Id` in a header table — so matching
 * those on quoted literals alone would find almost none of them.
 */
export function bareTokensOn(line) {
  const words = line.match(/--?[A-Za-z][\w-]*|[A-Za-z][\w-]*(?:[.-][A-Za-z0-9][\w-]*)*/g) ?? [];
  // The dotted whole and its parts both: `process.env.DATABASE_URL` names the
  // env var `DATABASE_URL`, while `user.created` is itself the contract.
  return [...new Set(words.flatMap((word) => (word.includes(".") ? [word, ...word.split(".")] : [word])))];
}

/**
 * May this word be admitted as a contract without quotes around it? An env var
 * and a header name are unmistakable; a `--flag` is too, but only with its
 * dashes — bare kebab is CSS and prose. See tokensIn.
 */
const bareKind = (word, kind) => kind === "screaming" || kind === "header" || (kind === "kebab" && word.startsWith("--"));

/**
 * The wire tokens a line declares. `ext` gates the unquoted forms: an OpenAPI
 * `paths:` key and a `.env` name are contracts that carry no quotes.
 */
export function tokensIn(line, ext, options) {
  const values = literalsOn(line);
  if (ext === ".yml" || ext === ".yaml" || ext === ".json") {
    const key = line.match(YAML_ROUTE_KEY);
    if (key) values.push(key[1]);
  }
  if (ext === ".env" || ext === "") {
    const key = line.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]+)\s*=/);
    if (key) values.push(key[1]);
  }
  // Some contracts are named unquoted at the declaring site too, most of all
  // `process.env.DATABASE_URL`. Only the classes that are unmistakable without
  // quotes are taken from here: an env var, a `--flag`, a header name. Not
  // `dotted` — every method call in JS and Python is `a.b`, so `router.get`
  // and `process.env.X` would themselves be read as queue topics — and not
  // bare kebab, which is CSS and prose. A topic is written `emit("user.created")`
  // in practice, and the quoted path above already has it.
  for (const word of bareTokensOn(line)) {
    const kind = classify(word, options);
    if (kind && bareKind(word, kind) && !values.includes(word)) values.push(word);
  }
  const tokens = new Map();
  for (const value of values) {
    const kind = classify(value, options);
    if (!kind) continue;
    const key = normalise(value, kind);
    if (!tokens.has(key)) tokens.set(key, { value, kind, key });
  }
  return [...tokens.values()];
}

/** The leaf file names that ARE their directory's route rather than a segment of it. */
const ROUTE_LEAF = /^(route|index|page|layout|\+server|\+page|handler)\.[jt]sx?$/;

/**
 * A file-system router's route is its path, so a rename arrives as a status
 * line and no literal exists anywhere to find. Next app/pages, SvelteKit,
 * Nuxt server routes, Remix. Returns null for a file that is not one.
 */
export function routeForPath(file) {
  const match = file.match(/(?:^|\/)(app|pages|routes|server\/api)\/(.+)$/);
  if (!match) return null;
  const [, dir, rest] = match;
  const parts = rest.split("/");
  const last = parts[parts.length - 1];
  // Which directory matched decides what counts as a route file, and the
  // alternation is captured so this can be asked. It used to test `match[1]`,
  // which held everything AFTER the directory and so could never start with
  // one — the condition was dead, leaving "ends in .ts/.tsx" as the only gate,
  // which nearly every file in a JS project passes. Deleting an ordinary
  // co-located component (`app/dashboard/Settings.tsx`) then fabricated a
  // removed contract whose ungated anchors were grepped tree-wide, and any
  // incidental hit could fire the escalating wireBreak marker.
  const filenameRouted = dir === "pages" || dir === "server/api";
  if (!filenameRouted && !ROUTE_LEAF.test(last)) return null;
  if (filenameRouted && !/\.[jt]sx?$/.test(last)) return null;
  const segments = parts
    .slice(0, -1)
    .concat(ROUTE_LEAF.test(last) ? [] : [last.replace(/\.[jt]sx?$/, "")])
    .filter((segment) => !/^\(.*\)$/.test(segment))          // (group) — organisational, not part of the URL
    .map((segment) => (/^(\[\[?\.{3}[\w-]+\]?\]|\[[\w-]+\])$/.test(segment) ? "*" : segment));
  if (segments.length === 0) return null;
  const route = `/${segments.join("/")}`;
  // A derived route is a contract like any other, so it passes the same noise
  // gates a written one does: nothing here should admit `/id`, which classify
  // rejects outright.
  return classify(route, { minSegments: 1 }) === "route" ? route : null;
}

const GONE = new Set(["removed", "renamed"]);

/**
 * The wire contracts this diff removed or renamed, per hunk.
 *
 * Removed-and-not-re-added is the whole trigger. "Changed" would fire on a
 * moved or reformatted line — the same literal on a `-` and a `+` — and send
 * the tree-wide search after contracts that did not change at all.
 */
/**
 * Prose describes a contract; it does not declare one — and "which extensions
 * are prose" is one fact, so it is read from the list that already answers it
 * everywhere else. Hand-copied here, it was missing `.mdx` within the hour: an
 * `.mdx` runbook would have reproduced the exact false positive this scan was
 * just fixed to stop.
 */
const PROSE = DOC_EXTENSIONS;

export function changedWireTokens(parsedDiff, options) {
  const tokens = new Map();
  // Every contract this change still writes down, anywhere in it. Rename
  // pairing is per hunk on purpose — across hunks two unrelated edits pair by
  // coincidence — but "is this contract gone?" is a question about the whole
  // change, and asking it per hunk answered "yes" for a token the same commit
  // adds three files away. That is rule 1 inverted: the trigger is
  // removed-and-not-re-added, and re-added somewhere else is still re-added.
  const stillWritten = new Set();
  for (const { file, hunks } of parsedDiff) {
    if (PROSE.has(path.extname(file))) continue;
    for (const hunk of hunks) {
      for (const { sign, text } of hunk.lines) {
        if (sign !== "+") continue;
        // Keyed on the literal AS WRITTEN, with the verb — never on the
        // normalised anchor. `normalise` exists to collapse `:id` and
        // `:orderId` to the same `*`, which is right for matching a consumer
        // and catastrophic here: an unrelated `/api/orders/:orderId` added in
        // another file shares the anchor of a removed `/api/orders/:id` and
        // silently swallowed the removal — a false negative, and rule 1 has
        // the whole feature pointed the other way. The verb comes too, because
        // `router.get(x)` → `router.post(x)` re-writes the path unchanged.
        for (const token of tokensIn(text, path.extname(file), options)) stillWritten.add(`${verbOn(text) ?? ""} ${token.value}`);
      }
    }
  }
  const record = (entry) => {
    const previous = tokens.get(entry.key);
    if (!previous) { tokens.set(entry.key, { ...entry, files: [entry.file] }); return; }
    if (previous.state !== entry.state) previous.state = GONE.has(previous.state) && GONE.has(entry.state) ? "removed" : "changed";
    previous.to ??= entry.to;
    // Every file that declares the contract, not only the first one seen: one
    // diff can rename a route in the router AND in the spec beside it, and the
    // self-match exclusion has to cover both or the spec's own untouched
    // sibling routes come back as stale consumers of it.
    if (!previous.files.includes(entry.file)) previous.files.push(entry.file);
  };

  for (const { file, hunks } of parsedDiff) {
    const ext = path.extname(file);
    // A RUNBOOK that stops quoting `$RELEASE_ROOT/current` has not removed the
    // variable — it has edited a sentence about it. Treating prose as a
    // declaring side reported exactly that as a broken contract, on a corpus
    // case whose whole job is to contain no defect, and escalated it to tier L.
    // The same rule the risk markers already apply: docs describe, code runs.
    if (PROSE.has(ext)) continue;
    for (const hunk of hunks) {
      const added = new Map(), removed = new Map();
      for (const { sign, text } of hunk.lines) {
        if (sign !== "+" && sign !== "-") continue;
        const target = sign === "+" ? added : removed;
        for (const token of tokensIn(text, ext, options)) {
          if (target.has(token.key)) continue;
          target.set(token.key, { ...token, verb: verbOn(text), declared: declaresOn(text, file), line: text });
        }
      }
      for (const [key, token] of removed) {
        if (added.has(key)) {
          // Same path, different verb: the literal never moved, so only the
          // verb comparison can see this at all.
          const now = added.get(key);
          if (token.verb && now.verb && token.verb !== now.verb) {
            record({ ...token, file, state: "renamed", to: `${now.verb} ${key}` });
          }
          continue;
        }
        // A removed literal beside an added one of the same class sharing a
        // leading segment is a rename; never paired across hunks, where two
        // unrelated edits would pair by coincidence.
        const { target, tied } = bestRenameTarget(token, key, [...added.values()]);
        record({ ...token, file, state: target ? "renamed" : "removed", to: target?.key ?? null, ...(tied.length ? { ambiguous: tied } : {}) });
      }
    }
  }
  // A contract the change re-writes elsewhere was never removed. Tested on the
  // ORIGINAL key, so a genuine rename — whose old key is gone by definition —
  // survives this filter and is still reported.
  return [...tokens.values()].filter((token) => !stillWritten.has(`${token.verb ?? ""} ${token.value}`));
}

/**
 * Which added contract is this removed one's rename? "Shares a leading segment"
 * alone is true of nearly every route in a real API — a hunk removing
 * `/api/orders/:id` and `/api/carts/:id` while adding both `/api/v2/` forms
 * paired *both* removals with whichever addition came first, and the second
 * route's real target was never recorded. So candidates are scored by how many
 * segments they actually share and the best one wins; a leading segment in
 * common is the floor, not the answer.
 */
function bestRenameTarget(token, key, candidates) {
  const sameKind = candidates.filter((candidate) => candidate.kind === token.kind);
  // A non-route contract has no segments to score — `DATABASE_URL` and
  // `DB_URL` share nothing — so it pairs only on the unambiguous case: one
  // removed, exactly one added of its class in the same hunk. Without this the
  // rename was always reported as a plain removal and the report never asked
  // who serves the new name.
  if (token.kind !== "route") return sameKind.length === 1 ? { target: sameKind[0], tied: [] } : { target: null, tied: [] };
  let best = null, bestScore = 0, tied = [];
  for (const candidate of sameKind) {
    if (!sharesLeadingSegment(candidate.key, key)) continue;
    const score = sharedSegments(candidate.key, key);
    if (score > bestScore) { best = candidate; bestScore = score; tied = [candidate]; }
    else if (score === bestScore && score > 0) tied.push(candidate);
  }
  // A tie means the only signal there is has been exhausted, not that one
  // candidate is right. `/api/orders/:id` removed while both `/api/v2/orders/:id`
  // and `/api/v3/orders/:id` are added scores 1 for each, and taking the first
  // asserted a destination that is wrong half the time — the false confidence
  // rule 4 forbids. Report it as removed, and name what it might have gone to.
  if (tied.length > 1) return { target: null, tied: tied.map((candidate) => candidate.key) };
  return { target: best, tied: [] };
}

/**
 * How many *identifying* segments the two contracts have in common. Stop
 * segments are excluded and the count is what decides a rename, so
 * `/api/orders/:id` and `/api/v2/carts/:id` in one hunk score 0 and are two
 * separate changes — sharing `/api` is not evidence of anything, and pairing on
 * it reported an abandoned endpoint as migrated to an unrelated new one.
 */
function sharedSegments(a, b) {
  const pool = new Set(segmentsOf(b).filter((segment) => !STOP_SEGMENTS.has(segment.toLowerCase())));
  return segmentsOf(a).filter((segment) => segment !== "*" && pool.has(segment)).length;
}

function sharesLeadingSegment(a, b) {
  const [first] = segmentsOf(a);
  const [other] = segmentsOf(b);
  return Boolean(first) && first === other;
}

/**
 * Is this hit line really a consumer of that contract? The anchor is a prefix,
 * so `/api/users-admin/` and a bare `/api/users` would both match it as text.
 * Comparing segment signatures rejects those without parsing anything: literal
 * segments must be equal at the same positions, a param matches any one
 * segment, and a fragment that ends in an interpolation is open-ended.
 */
/**
 * Does the fragment consume the contract, compared from where the anchor sits
 * in it? The last-run anchor of the key for `/api/v1/:tenant/projects/:id` is
 * `/projects/`, and a
 * consumer writing `` `${API_BASE}/projects/${id}` `` has three segments where
 * the key has five — aligned from segment 0 it could never match, so that
 * anchor was generated, searched for, and then unable to confirm anything. Both
 * sides are cut to the anchor: the key from where the anchor's segments begin,
 * the fragment from where the anchor's text begins.
 */
export function anchoredMatch(key, anchor, fragment) {
  const keySegments = segmentsOf(key);
  const anchorSegments = segmentsOf(anchor);
  const cut = fragment.indexOf(anchor);
  if (cut < 0) return false;
  for (let start = 0; start + anchorSegments.length <= keySegments.length; start += 1) {
    if (!anchorSegments.every((segment, i) => keySegments[start + i] === segment)) continue;
    if (signatureMatches(`/${keySegments.slice(start).join("/")}`, fragment.slice(cut))) return true;
  }
  return false;
}

export function signatureMatches(key, fragment) {
  const wanted = segmentsOf(key);
  const openEnded = /(\$\{[^}]*\}|%[sdiv]|\+\s*\w|\{[^}]*\}|<[^>]*>)\s*$/.test(fragment) || fragment.endsWith("/");
  // The same strip `classify` applies to a declaration: a consumer that hard-codes
  // `https://api.example.com/api/users/` names the same contract as one that
  // writes `/api/users/`, and it is the cross-service caller — the one with no
  // import, no shared module and no way to be found except this.
  const got = segmentsOf(withoutOrigin(fragment).split(/[?#]/)[0]);
  if (got.length > wanted.length) return false;
  if (!openEnded && got.length !== wanted.length) return false;
  return got.every((segment, index) => {
    if (segment === "" ) return wanted[index] === "";
    if (wanted[index] === "*" || PARAM.test(segment) || /\$\{|%[sdiv]|\{[^}]*\}/.test(segment)) return true;
    return segment === wanted[index];
  });
}

/** An OpenAPI/gateway `paths:` key: a route named with no quotes around it. */
const YAML_ROUTE_KEY = /^\s*['"]?(\/[\w{}:./-]+)['"]?\s*:/;

/**
 * The fragments on a hit line that could be the consumer's spelling of a route.
 * `ext` admits the unquoted mapping key, because a spec file names the same
 * contract on the consuming side that `tokensIn` reads on the declaring one —
 * without it a companion OpenAPI file still naming the old route read as safe.
 */
export function fragmentsOn(line, ext) {
  const found = literalsOn(line).filter((value) => value.includes("/"));
  if (ext === ".yml" || ext === ".yaml" || ext === ".json") {
    const key = line.match(YAML_ROUTE_KEY);
    if (key && !found.includes(key[1])) found.push(key[1]);
  }
  return found;
}


/**
 * Does the fragment begin with a base URL held elsewhere — an interpolation, or
 * a concatenation of something that is not itself a path? That is the only
 * shape the weak anchor is for: `` `${API_BASE}/users/${id}` `` is a consumer
 * of `/api/users/*`, while a bare `"/users/"` in some unrelated module is not.
 */
const startsInterpolated = (fragment) => /^\$\{|^%[sdiv]|^\{/.test(fragment.trim());

/**
 * Match the hits of one tree-wide search against the wire tokens that produced
 * its anchors. Two passes, and the second only where the first found nothing.
 * The strong pass tries every full literal run of the route — the longest and
 * the last, since `/api/v1/:tenant/projects/:id` is identified by `projects`
 * and not by `v1` — and each hit must still satisfy the segment signature. The
 * weak pass drops the leading segment for the base-URL-in-a-constant case
 * (`` `${API}/users/${id}` ``); running it only on tokens with zero strong hits
 * is what keeps its looseness from costing anything.
 */
export function matchWireHits(hits, tokens, { maxRefs = 40 } = {}) {
  const byToken = new Map(tokens.map((token) => [token.key, { strong: [], weak: [], to: 0 }]));
  // One line is one consumer, however many times the sweep returned it. It can
  // arrive more than once: a file that is itself changed is searched by both
  // passes, and one line can match several of a token's anchors. Counted twice,
  // it inflates `refs`, `counts.wire_broken` and the tier's evidence alike.
  const counted = new Set();
  // A route is spelled by concatenation and interpolation, so its consumers are
  // matched by prefix plus segment signature. Every other class — an env var, a
  // topic, a CLI flag, a header — is spelled whole or not at all, and filtering
  // for a `/` the way the route path does would drop every one of its consumers.
  const routeFragments = new Map(), wholeLiterals = new Map();
  const fragmentsFor = (hit, kind) => {
    const cache = kind === "route" ? routeFragments : wholeLiterals;
    if (!cache.has(hit)) cache.set(hit, kind === "route" ? fragmentsOn(hit.text, path.extname(hit.file)) : literalsOn(hit.text).concat(bareTokensOn(hit.text)));
    return cache.get(hit);
  };
  for (const hit of hits) {
    for (const token of tokens) {
      const bucket = byToken.get(token.key);
      // The declaring file's own lines are the diff the finder already reads —
      // and a sibling route in that same file matching this one's anchor is the
      // commonest false positive there is. `token.file` comes from the diff, so
      // it is by construction a changed file: there is nothing to except.
      if ((token.files ?? [token.file]).includes(hit.file)) continue;
      const once = `${hit.file}:${hit.line}:${token.key}`;
      if (counted.has(once)) continue;
      const fragments = fragmentsFor(hit, token.kind);
      if (fragments.length === 0) continue;
      counted.add(once);
      const reference = { file: hit.file, line: hit.line, token: token.key, fragment: fragments[0] };
      if (token.kind !== "route") {
        // Whole-value equality: `DATABASE_URL` is a consumer of `DATABASE_URL`
        // and of nothing else. No prefix, so no signature check to make.
        if (fragments.includes(token.value)) bucket.strong.push({ ...reference, fragment: token.value, match: "strong" });
        if (token.to && fragments.includes(String(token.to))) bucket.to += 1;
        continue;
      }
      const matched = (anchor) => fragments.find((fragment) => anchoredMatch(token.key, anchor, fragment));
      const hitFragment = token.strong.map(matched).find(Boolean);
      if (hitFragment) {
        bucket.strong.push({ ...reference, fragment: hitFragment, match: "strong" });
      } else if (token.weak) {
        const loose = fragments.find((fragment) => fragment.includes(token.weak) && startsInterpolated(fragment));
        if (loose) bucket.weak.push({ ...reference, fragment: loose, match: "weak" });
      }
      if (token.to && fragments.some((fragment) => signatureMatches(String(token.to).replace(/^[A-Z]+ /, ""), fragment))) bucket.to += 1;
    }
  }

  const references = [];
  const rows = tokens.map((token) => {
    const bucket = byToken.get(token.key);
    // Both buckets, not one or the other. The weak pass runs per hit, so a
    // base-URL consumer was found and then discarded at the token level the
    // moment any other file used the relative form — leaving `weak_refs` as a
    // count with no file, no line and no row anywhere, in exactly the
    // `${API_BASE}/orders/${id}` case angle C is told to go resolve.
    const found = [...bucket.strong, ...bucket.weak];
    // Too many rows to RENDER is not too many rows to COUNT. This used to push
    // nothing at all when it tripped, which zeroed `counts.wire_broken` and
    // silenced the wireBreak marker for the rename with the most consumers in
    // the diff — the highest blast radius there is, and the one case the marker
    // exists for. Capped, the list stays a floor and the marker still fires.
    const noisy = found.length > maxRefs;
    references.push(...found.slice(0, maxRefs));
    return {
      class: token.kind, verb: token.verb ?? null, value: token.value, key: token.key,
      state: token.state, to: token.to ?? null, ambiguous: token.ambiguous ?? null, file: token.file, declared: Boolean(token.declared),
      anchors: token.anchors, refs: bucket.strong.length, weak_refs: bucket.weak.length,
      to_refs: bucket.to, noisy,
    };
  });
  return { tokens: rows, references };
}

/** The tokens worth searching for, with their anchors — the shape matchWireHits expects. */
export function wireSearchTokens(parsedDiff, files, options) {
  const withAnchors = (token, value, kind) => {
    const { strong, weak } = anchorsFor(value, kind);
    // `anchors` is the flat list the tree-wide search is given; `strong`/`weak`
    // is how matchWireHits tells a certain consumer from a possible one.
    return { ...token, strong, weak, anchors: [...strong, ...(weak ? [weak] : [])] };
  };
  const tokens = changedWireTokens(parsedDiff, options).map((token) => withAnchors(token, token.value, token.kind));
  // A file-system router carries its route in its path and nothing else, so a
  // rename or a delete is the only signal there is.
  for (const { path: file, status, from } of files) {
    if (status !== "D" && status !== "R") continue;
    // On a rename it is the OLD path that named the contract now gone; the new
    // one is what consumers should be moving TO.
    const route = routeForPath(from ?? file);
    if (!route || tokens.some((token) => token.key === route)) continue;
    tokens.push(withAnchors({
      value: route, kind: "route", key: route, verb: null, declared: true, file,
      state: status === "D" ? "removed" : "renamed", to: status === "R" ? routeForPath(file) : null,
    }, route, "route"));
  }
  return tokens.filter((token) => token.anchors.length > 0);
}
