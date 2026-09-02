// Run: node --test plugin/scripts/lib/wire.test.mjs   (or ./test.sh for everything)
//
// The primitive's whole value is that it finds a consumer coupled by a string
// and does not drown the reviewer in `"/"` and `"id"`. So the tests come in
// pairs: the four spellings a real consumer uses must be found, and the noise
// literals that share a prefix must not be.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDiff } from "./diff.mjs";
import { anchorsFor, bareTokensOn, changedWireTokens, classify, declaresOn, matchWireHits, normalise, routeForPath, signatureMatches, tokensIn, verbOn, wireSearchTokens } from "./wire.mjs";

const hunk = (file, lines) => [
  `--- a/${file}`, `+++ b/${file}`, "@@ -1,4 +1,4 @@", ...lines,
].join("\n").split("\n");

test("classify admits real contracts and rejects the literals that would drown the search", () => {
  assert.equal(classify("/api/users/:id"), "route");
  assert.equal(classify("https://example.com/api/users/:id"), "route", "an absolute URL is the same contract");
  assert.equal(classify("/checkout/session/{id}"), "route");

  // Each of these occurs thousands of times in a normal repo.
  assert.equal(classify("/"), null);
  assert.equal(classify("/id"), null, "one segment is not a contract");
  assert.equal(classify("id"), null);
  assert.equal(classify("/index.html"), null, "a file extension makes it a path; fileSymbols already searches those");
  assert.equal(classify("./relative/thing"), null);
  assert.equal(classify("/usr/local/bin"), null, "filesystem, not wire");
  assert.equal(classify("/api/v1"), null, "no segment that carries identity");
  // The floor is a property of one segment, not a total across the path: a
  // joined-length gate rejected every unprefixed REST endpoint there is.
  assert.equal(classify("/users/:id"), "route");
  assert.equal(classify("/cart/:id"), "route");
  assert.equal(classify("/tag/:id"), "route");

  assert.equal(classify("DATABASE_URL"), "screaming");
  assert.equal(classify("URL"), null, "too short to be worth a tree-wide search");
  assert.equal(classify("user.created"), "dotted");
  assert.equal(classify("foo.bar"), null);
  assert.equal(classify("checkout-session-v2"), "kebab");
  assert.equal(classify("--dry-run"), "kebab", "a CLI flag is a contract at any length");
  assert.equal(classify("X-Request-Id"), "header");

  // A commit that rotates a leaked secret removes it and adds nothing back —
  // the exact shape this loop triggers on — and the value would be copied into
  // impact.md, impact.json and the marker evidence, which outlive the diff.
  assert.equal(classify("https://hooks.slack.com/services/T0000000/B0000000/XcQ2mK9vLp4RtZ8wNb3Yd7Fj"), null);
  assert.equal(classify("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk"), null);
  assert.equal(classify("/api/checkout/session"), "route", "an ordinary route is not mistaken for one");
  assert.equal(classify("/v1/2024-01-15/reports"), "route", "nor is a date or a version segment");
});

test("normalise collapses the dialects of one route into one key", () => {
  const key = "/api/users/*";
  for (const spelling of ["/api/users/:id", "/api/users/{id}", "/api/users/<int:id>", "/api/users/${id}", "/api/users/:id/", "/api/users//:id", "/api/users/:id?full=1"]) {
    assert.equal(normalise(spelling, "route"), key, spelling);
  }
});

test("the anchor is what a consumer actually contains, not the route", () => {
  // `/api/users/:id` appears in no consumer anywhere. This is the single
  // reason a verbatim grep of the literal finds nothing.
  assert.deepEqual(anchorsFor("/api/users/:id", "route"), { strong: ["/api/users/"], weak: "/users/" });
  // Two runs of one segment each. Both are searched and both are certain: a
  // consumer writing `/orders/${id}/items` contains the second and not the
  // first, and a route is not identified by its longest run — `projects` is
  // what names `/api/v1/:tenant/projects/:id`, not `v1`.
  assert.deepEqual(anchorsFor("/orders/:id/items", "route"), { strong: ["/orders/", "/items/"], weak: null });
  assert.deepEqual(anchorsFor("/api/v1/:tenantId/projects/:projectId", "route"), { strong: ["/api/v1/", "/projects/"], weak: "/v1/" });

  for (const consumer of ['"/api/users/" + id', "`/api/users/${id}`", 'f"/api/users/{id}"', '"/api/users/%s" % id', '"/api/users/{}".format(id)']) {
    assert.ok(consumer.includes("/api/users/"), consumer);
  }
});

test("signatureMatches keeps the neighbours out that a prefix search lets in", () => {
  const key = "/api/users/*";
  assert.ok(signatureMatches(key, "/api/users/${id}"));
  assert.ok(signatureMatches(key, "/api/users/"), "open-ended: the id is concatenated after");
  assert.ok(signatureMatches(key, "/api/users/{id}"));
  assert.ok(signatureMatches(key, "/api/users/%s"));

  assert.equal(signatureMatches(key, "/api/users-admin/${id}"), false, "a different resource that shares the prefix");
  assert.equal(signatureMatches(key, "/api/users/${id}/orders"), false, "more segments is a different endpoint");
  assert.equal(signatureMatches(key, "/api/other/${id}"), false);
});

test("verbOn reads the dialects, so a get-to-post edit is visible at all", () => {
  assert.equal(verbOn('router.get("/api/users/:id", handler)'), "GET");
  assert.equal(verbOn('@app.post("/api/users/{id}")'), "POST");
  assert.equal(verbOn("@Get(':id')"), "GET");
  assert.equal(verbOn('get "/users/:id", to: "users#show"'), "GET");
  assert.equal(verbOn('fetch("/api/users/" + id)'), null, "a consumer declares no verb");
});

test("a route that is only a file path is derived from the path", () => {
  // The one case the string join is structurally blind to: nothing in the file
  // spells the route, and a rename arrives as a status line.
  assert.equal(routeForPath("web/app/api/users/[id]/route.ts"), "/api/users/*");
  assert.equal(routeForPath("src/routes/checkout/+server.ts"), "/checkout");
  assert.equal(routeForPath("app/(marketing)/pricing/page.tsx"), "/pricing", "a (group) is organisational, not part of the URL");
  assert.equal(routeForPath("server/api/orders/[...slug].ts"), "/orders/*");
  assert.equal(routeForPath("src/components/Button.tsx"), null);
  assert.equal(routeForPath("pages/api/webhooks/stripe.ts"), "/api/webhooks/stripe", "pages/ routes by filename");

  // Under app/ and routes/ only a route leaf is a route. The guard that said so
  // tested the wrong half of the match and was dead, leaving "ends in .tsx" —
  // so deleting a co-located component fabricated a contract whose ungated
  // anchors were then grepped tree-wide.
  assert.equal(routeForPath("app/dashboard/Settings.tsx"), null, "a co-located component is not a route");
  assert.equal(routeForPath("pages/id.ts"), null, "and a derived route still faces classify's noise gates — one short segment is not a contract");
});

test("only removed-and-not-re-added fires: a reformatted line is not a change", () => {
  // "Every literal the diff touched" would send a tree-wide search after every
  // route on a line somebody re-indented.
  const moved = changedWireTokens(parseDiff(hunk("server/routes.ts", [
    '-  router.get("/api/users/:id", handler)',
    '+  router.get("/api/users/:id", handler);',
  ])));
  assert.deepEqual(moved, [], "the same contract on both sides is not a change");

  const renamed = changedWireTokens(parseDiff(hunk("server/routes.ts", [
    '-router.get("/api/users/:id", handler)',
    '+router.get("/api/v2/users/:id", handler)',
  ])));
  assert.equal(renamed.length, 1);
  assert.equal(renamed[0].key, "/api/users/*");
  assert.equal(renamed[0].state, "renamed");
  assert.equal(renamed[0].to, "/api/v2/users/*");
  assert.equal(renamed[0].verb, "GET");
  assert.equal(renamed[0].declared, true);

  const gone = changedWireTokens(parseDiff(hunk("server/routes.ts", [
    '-router.post("/api/orders/create", handler)',
  ])));
  assert.equal(gone[0].state, "removed");
  assert.equal(gone[0].to, null);
});

test("a verb change with an unchanged path is caught by the verb, since nothing else moved", () => {
  const flipped = changedWireTokens(parseDiff(hunk("server/routes.ts", [
    '-router.get("/api/users/:id", handler)',
    '+router.post("/api/users/:id", handler)',
  ])));
  assert.equal(flipped.length, 1, "the literal is identical on both sides: only the verb differs");
  assert.equal(flipped[0].state, "renamed");
  assert.equal(flipped[0].to, "POST /api/users/*");
});

test("tokensIn reads the unquoted contracts too, and skips prose", () => {
  assert.deepEqual(tokensIn('  "/api/users/{id}":', ".yaml").map((token) => token.key), ["/api/users/*"], "an OpenAPI paths: key");
  assert.deepEqual(tokensIn("DATABASE_URL=postgres://x", ".env").map((token) => token.value), ["DATABASE_URL"]);
  assert.deepEqual(tokensIn("the route is /api/users/:id now", ".ts"), [], "unquoted prose is not a literal");
});

test("declaresOn separates the server from its callers, for ordering only", () => {
  assert.equal(declaresOn('router.get("/api/users/:id")', "server/routes.ts"), true);
  assert.equal(declaresOn('@Controller("users")', "src/users.controller.ts"), true);
  assert.equal(declaresOn('fetch("/api/users/" + id)', "web/src/lib.ts"), false);
});

test("matchWireHits finds the four consumer spellings and rejects the neighbours", () => {
  const tokens = wireSearchTokens(parseDiff(hunk("server/routes.ts", [
    '-router.get("/api/users/:id", handler)',
    '+router.get("/api/v2/users/:id", handler)',
  ])), []);
  const hits = [
    { file: "web/api.ts", line: 4, text: 'return fetch("/api/users/" + id)' },
    { file: "web/hooks.ts", line: 9, text: "const r = await fetch(`/api/users/${id}`)" },
    { file: "svc/client.py", line: 2, text: 'requests.get(f"/api/users/{id}")' },
    { file: "svc/legacy.py", line: 7, text: 'requests.get("/api/users/%s" % id)' },
    // Neighbours a prefix search lets in and the signature check must reject.
    { file: "web/admin.ts", line: 3, text: 'fetch("/api/users-admin/" + id)' },
    { file: "web/orders.ts", line: 5, text: "fetch(`/api/users/${id}/orders`)" },
    // The new value: to_refs answers "who serves it?"
    { file: "web/next.ts", line: 1, text: 'fetch(`/api/v2/users/${id}`)' },
  ];
  const { tokens: rows, references } = matchWireHits(hits, tokens);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].key, "/api/users/*");
  assert.equal(rows[0].refs, 4, "concat, template, f-string and %s — all four spellings");
  assert.equal(rows[0].to_refs, 1);
  assert.deepEqual(references.map((reference) => reference.file).sort(),
    ["svc/client.py", "svc/legacy.py", "web/api.ts", "web/hooks.ts"]);
});

test("the weak anchor is used only when the strong one finds nothing, and only for a base-URL consumer", () => {
  const tokens = wireSearchTokens(parseDiff(hunk("server/routes.ts", [
    '-router.get("/api/orders/:id", handler)',
  ])), []);
  const { tokens: rows } = matchWireHits([
    { file: "web/api.ts", line: 4, text: "fetch(`${API_BASE}/orders/${id}`)" },
    { file: "web/other.ts", line: 8, text: 'log("/orders/ is the prefix")' },
  ], tokens);
  assert.equal(rows[0].refs, 0, "nothing contains /api/orders/");
  assert.equal(rows[0].weak_refs, 1, "the base-URL consumer, and not the bare mention");
});

test("a weak consumer keeps its row when a strong one also exists", () => {
  // It used to be all-or-nothing per token: one file using the relative form
  // discarded every base-URL consumer of the same route, leaving `weak_refs` a
  // count with no file and no line — the blind spot this feature exists to close.
  const tokens = wireSearchTokens(parseDiff(hunk("server/routes.ts", [
    '-router.get("/api/orders/:id", h)',
    '+router.get("/api/v2/orders/:id", h)',
  ])), []);
  const { tokens: rows, references } = matchWireHits([
    { file: "web/direct.ts", line: 1, text: 'fetch("/api/orders/" + id)' },
    { file: "web/constant.ts", line: 4, text: "fetch(`${API_BASE}/orders/${id}`)" },
  ], tokens);
  assert.equal(rows[0].refs, 1);
  assert.equal(rows[0].weak_refs, 1);
  assert.deepEqual(references.map((reference) => [reference.file, reference.match]).sort(),
    [["web/constant.ts", "weak"], ["web/direct.ts", "strong"]]);
});

test("a contract with more consumers than the cap still names some of them", () => {
  // Too many rows to render is not too many rows to count: pushing nothing
  // zeroed counts.wire_broken and silenced the wireBreak marker for the rename
  // with the MOST consumers in the diff.
  const tokens = wireSearchTokens(parseDiff(hunk("server/routes.ts", [
    '-router.get("/api/orders/:id", h)',
    '+router.get("/api/v2/orders/:id", h)',
  ])), []);
  const hits = Array.from({ length: 30 }, (_, i) => ({ file: `web/c${i}.ts`, line: 1, text: 'fetch("/api/orders/" + id)' }));
  const { tokens: rows, references } = matchWireHits(hits, tokens, { maxRefs: 10 });
  assert.equal(rows[0].noisy, true);
  assert.equal(rows[0].refs, 30, "the true count is still reported");
  assert.equal(references.length, 10, "and the list is a floor, never empty");
});


test("a hit inside the declaring file is never a consumer, however the sweep found it", () => {
  // A sibling route in the same file matches this one's anchor, and that file
  // is by construction a changed file — so a guard excepting changed files
  // never fired and reported the declaration as its own stale caller.
  const tokens = wireSearchTokens(parseDiff(hunk("server/routes.ts", [
    '-router.get("/api/users/:id", getUser)',
    '+router.get("/api/v2/users/:id", getUser)',
  ])), []);
  const { tokens: rows } = matchWireHits([
    { file: "server/routes.ts", line: 9, text: 'router.get("/api/users/", listUsers)' },
    { file: "web/api.ts", line: 2, text: 'fetch("/api/users/" + id)' },
  ], tokens);
  assert.equal(rows[0].refs, 1, "the consumer in another file, and not the sibling declaration");
});

test("a non-route contract matches whole, quoted or bare — the slash filter found none of them", () => {
  const tokens = wireSearchTokens(parseDiff(hunk("server/db.ts", ['-const url = process.env.DATABASE_URL;'])), []);
  assert.equal(tokens.length, 1);
  const { tokens: rows, references } = matchWireHits([
    { file: "svc/db.ts", line: 3, text: "const u = process.env.DATABASE_URL;" },
    { file: ".env.example", line: 1, text: "DATABASE_URL=postgres://x" },
    { file: "web/other.ts", line: 4, text: "const u = process.env.DATABASE_URLS;" },
  ], tokens);
  assert.equal(rows[0].refs, 2, "unquoted in code and unquoted in .env; DATABASE_URLS is a different name");
  assert.deepEqual(references.map((reference) => reference.file).sort(), [".env.example", "svc/db.ts"]);
});

test("bareTokensOn reads the unquoted spellings a non-route consumer uses", () => {
  assert.ok(bareTokensOn("process.env.DATABASE_URL").includes("DATABASE_URL"));
  assert.ok(bareTokensOn("cli run --dry-run").includes("--dry-run"));
  assert.ok(bareTokensOn("emit(user.created)").includes("user.created"));
});

test("two routes renamed in one hunk each get their own target, not the first one seen", () => {
  // "Shares a leading segment" is true of nearly every route in a real API.
  const rows = changedWireTokens(parseDiff(hunk("server/routes.ts", [
    '-router.get("/api/orders/:id", getOrder)',
    '-router.get("/api/carts/:id", getCart)',
    '+router.get("/api/v2/orders/:id", getOrder)',
    '+router.get("/api/v2/carts/:id", getCart)',
  ])));
  assert.equal(rows.find((row) => row.key === "/api/orders/*").to, "/api/v2/orders/*");
  assert.equal(rows.find((row) => row.key === "/api/carts/*").to, "/api/v2/carts/*");
});

test("a file-system router rename is searched by its OLD route, and names the new one", () => {
  // The status line folds `old -> new`; deriving the route from the new path
  // searched for consumers of the value the change just introduced.
  const tokens = wireSearchTokens([], [{ path: "app/api/v2/users/route.ts", from: "app/api/users/route.ts", status: "R" }]);
  assert.equal(tokens.length, 1);
  assert.equal(tokens[0].key, "/api/users", "the contract that was removed");
  assert.equal(tokens[0].to, "/api/v2/users", "and where it went");
});

test("one line is one consumer, however many times the sweep returned it", () => {
  // A consumer file that is ITSELF changed is searched by both passes, and one
  // line can match several of a token's anchors. Found by running the script on
  // a real tree, not by a unit test: refs, counts.wire_broken and the tier's
  // evidence were all inflated.
  const tokens = wireSearchTokens(parseDiff(hunk("server/routes.ts", [
    '-router.get("/api/users/:id", handler)',
    '+router.get("/api/v2/users/:id", handler)',
  ])), []);
  const line = { file: "web/api.ts", line: 2, text: 'fetch("/api/users/" + id)' };
  const { tokens: rows, references } = matchWireHits([line, { ...line }, { ...line }], tokens);
  assert.equal(rows[0].refs, 1);
  assert.equal(references.length, 1);
});

test("a spec file still naming the old route is a consumer, quotes or no quotes", () => {
  // The declaring side already read an unquoted `paths:` key; the consuming
  // side did not, so a companion OpenAPI file naming the old route read as safe.
  const tokens = wireSearchTokens(parseDiff(hunk("server/routes.ts", [
    '-router.get("/api/users/:id", handler)',
    '+router.get("/api/v2/users/:id", handler)',
  ])), []);
  const { tokens: rows } = matchWireHits([
    { file: "gateway/openapi.yaml", line: 12, text: "  /api/users/{id}:" },
    { file: "notes/plan.md", line: 3, text: "  /api/users/{id}:" },
  ], tokens);
  assert.equal(rows[0].refs, 1, "the spec, and not the same text in prose");
});

test("a contract renamed in two files at once excludes both from its own consumers", () => {
  const parsed = parseDiff([
    ...hunk("server/routes.ts", ['-router.get("/api/users/:id", h)', '+router.get("/api/v2/users/:id", h)']),
    ...hunk("gateway/openapi.yaml", ["-  /api/users/{id}:", "+  /api/v2/users/{id}:"]),
  ]);
  const tokens = wireSearchTokens(parsed, []);
  const token = tokens.find((row) => row.key === "/api/users/*");
  assert.deepEqual(token.files, ["server/routes.ts", "gateway/openapi.yaml"]);
  const { tokens: rows } = matchWireHits([
    { file: "gateway/openapi.yaml", line: 40, text: "  /api/users/count:" },
    { file: "web/api.ts", line: 1, text: 'fetch("/api/users/" + id)' },
  ], tokens);
  assert.equal(rows.find((row) => row.key === "/api/users/*").refs, 1, "the untouched sibling in the spec is not a consumer");
});

test("a renamed env var is a rename, not a bare removal", () => {
  const rows = changedWireTokens(parseDiff(hunk("server/db.ts", [
    "-const url = process.env.DATABASE_URL;",
    "+const url = process.env.DB_ENDPOINT;",
  ])));
  const token = rows.find((row) => row.value === "DATABASE_URL");
  assert.equal(token.state, "renamed");
  assert.equal(token.to, "DB_ENDPOINT", "so the report can ask who sets the new name");
});

test("a lowercase secret is refused too — a UUID is the canonical shape for one", () => {
  assert.equal(classify("/webhooks/3fa85f64-5717-4562-b3fc-2c963f66afa6"), null);
  assert.equal(classify("/reset-password/4f8b2c91a3d7e6f0b1c2d3e4f5a6b7c8d9e0f1a2"), null);
  // And the guard reads one segment at a time: a digit 20 characters away in
  // some other segment is not evidence about this one.
  assert.equal(classify("/api/v1/organization-settings"), "route");
});

test("two unrelated routes in one hunk are two changes, not a rename", () => {
  // Sharing `/api` is not evidence of anything. Scored on stop segments, an
  // abandoned endpoint was reported as migrated to an unrelated new one, and
  // the "who serves the new value" question then reasoned about the wrong target.
  const unrelated = changedWireTokens(parseDiff(hunk("server/routes.ts", [
    '-router.get("/api/orders/:id", h)',
    '+router.get("/api/v2/carts/:id", h)',
  ])));
  assert.equal(unrelated[0].state, "removed");
  assert.equal(unrelated[0].to, null);

  const real = changedWireTokens(parseDiff(hunk("server/routes.ts", [
    '-router.get("/api/orders/:id", h)',
    '+router.get("/api/v2/orders/:id", h)',
  ])));
  assert.equal(real[0].to, "/api/v2/orders/*", "sharing `orders` is");
});

test("a consumer that names only the tail of a nested route is found through the last-run anchor", () => {
  // The feature's own worked example, and it matched nothing: `/projects/` was
  // generated as an anchor and searched for, then compared against the WHOLE
  // five-segment key from segment 0, where the three-segment consumer could
  // never line up. Generated, searched, and structurally unable to confirm.
  const tokens = wireSearchTokens(parseDiff(hunk("server/routes.ts", [
    '-router.get("/api/v1/:tenantId/projects/:projectId", show)',
    '+router.get("/api/v1/:tenantId/workspaces/:projectId", show)',
  ])), [{ path: "server/routes.ts", status: "M" }], {});
  assert.deepEqual(tokens[0].strong, ["/api/v1/", "/projects/"], "the tail run is an anchor of its own");

  const found = matchWireHits([
    { file: "web/api.ts", line: 12, text: "return fetch(`${API_BASE}/projects/${id}`)" },
    { file: "web/full.ts", line: 3, text: 'fetch("/api/v1/" + tenant + "/projects/" + id)' },
    { file: "web/other.ts", line: 8, text: 'fetch(`${API_BASE}/projects/${id}/settings/${key}`)' },
  ], tokens, {});
  assert.equal(found.tokens[0].refs, 2, "the tail-only consumer and the full path both name this contract");
  assert.deepEqual(found.references.map((reference) => reference.file), ["web/api.ts", "web/full.ts"]);
});

test("an ordinary descriptive slug is a contract; a credential-shaped segment is not", () => {
  // The filter measured the whole segment, so any long slug carrying a year
  // read as a secret and the route never became a token at all — no row, no
  // count, no marker, indistinguishable from nothing changed. A secret is one
  // unbroken run; a slug is short words joined by hyphens.
  assert.equal(classify("/products/mens-running-shoes-2024-limited-edition"), "route");
  assert.equal(classify("/blog/how-to-configure-webpack-for-production-2024"), "route");
  assert.equal(classify("/reports/2024-01-15-quarterly-summary"), "route");

  assert.equal(classify("/webhooks/3fa85f64-5717-4562-b3fc-2c963f66afa6"), null, "a UUID, named as the standard it is");
  assert.equal(classify("/callback/xoxbXcQ2mK9vLp4RtZ8wNb3Yd7Fj"), null);
  assert.equal(classify("/t/4f8b2c91a3d7e6f0b1c2d3e4f5a6b7c8d9e0f1a2"), null, "40 hex chars");
  assert.equal(classify("/t/abcdefghijklmnopqrstuvwxyzabcdefgh"), null, "no digit, but 34 unbroken characters");
});

test("two candidates tied on the only available signal are reported as tied, not resolved", () => {
  // Same-hunk segment overlap is all there is. A tie means it is exhausted,
  // not that the first candidate is right.
  const tied = changedWireTokens(parseDiff(hunk("server/routes.ts", [
    '-router.get("/api/orders/:id", show)',
    '+router.get("/api/v2/orders/:id", show)',
    '+router.get("/api/v3/orders/:id", show)',
  ])));
  assert.equal(tied[0].state, "removed", "not renamed: which one it became is unknown");
  assert.equal(tied[0].to, null);
  assert.deepEqual(tied[0].ambiguous, ["/api/v2/orders/*", "/api/v3/orders/*"]);

  const clear = changedWireTokens(parseDiff(hunk("server/routes.ts", [
    '-router.get("/api/orders/:id", show)',
    '+router.get("/api/v2/orders/:id", show)',
    '+router.get("/api/carts/:id", show)',
  ])));
  assert.equal(clear[0].to, "/api/v2/orders/*", "one candidate outscores the other, so it is still resolved");
  assert.equal(clear[0].ambiguous, undefined);
});

test("a contract the same change re-writes somewhere else was never removed", () => {
  // Rule 1 is removed-and-not-re-added, and re-added in another file is still
  // re-added. The survival check used to run per hunk, so a commit that moved
  // a line reported the contract gone while three other files in it still
  // wrote the name — and on a corpus case built to contain no defect, that
  // false positive escalated the tier to L.
  const moved = changedWireTokens(parseDiff([
    ...hunk("lib/common.sh", ['-  local marker="$RELEASE_ROOT/current"']),
    ...hunk("bin/publish.sh", ['+  for dir in "$RELEASE_ROOT"/*/; do']),
  ]));
  assert.deepEqual(moved, [], "removed here, written there: the contract is still live");

  const gone = changedWireTokens(parseDiff([
    ...hunk("lib/common.sh", ['-  local marker="$RELEASE_ROOT/current"']),
    ...hunk("bin/publish.sh", ['+  for dir in "$ARTIFACT_DIR"/*/; do']),
  ]));
  assert.deepEqual(gone.map((token) => token.key), ["RELEASE_ROOT"], "nothing re-writes it, so it is gone");
});

test("prose describes a contract; it never declares one", () => {
  // The same rule the risk markers already apply: a doc quoting `rm -rf` is
  // describing it. A RUNBOOK that stops quoting `$RELEASE_ROOT/current` has
  // edited a sentence, not removed a variable.
  assert.deepEqual(changedWireTokens(parseDiff(hunk("docs/RUNBOOK.md", ['-cat "$RELEASE_ROOT/current"']))), [],
    "a removed line of documentation is not a removed contract");
  assert.deepEqual(changedWireTokens(parseDiff(hunk("docs/api.md", ['-GET /api/users/:id returns the user']))), []);

  // Every extension the rest of the codebase calls docs, not a second list
  // that drifts: the hand-copied one was missing `.mdx` within the hour.
  for (const ext of [".mdx", ".markdown", ".rst", ".adoc", ".txt"]) {
    assert.deepEqual(changedWireTokens(parseDiff(hunk(`docs/RUNBOOK${ext}`, ['-cat "$RELEASE_ROOT/current"']))), [], ext);
  }

  // The code beside it still is the declaring side.
  const real = changedWireTokens(parseDiff(hunk("lib/common.sh", ['-cat "$RELEASE_ROOT/current"'])));
  assert.deepEqual(real.map((token) => token.key), ["RELEASE_ROOT"]);
});

test("an unrelated route that merely shares the anchor does not count as re-writing the contract", () => {
  // The survival check is keyed on the literal as written, never on the
  // normalised anchor. `normalise` collapses `:id` and `:orderId` to the same
  // `*` — right for matching a consumer, catastrophic here: an unrelated route
  // added in another file swallowed a real removal, silently, which is rule 1
  // pointed backwards.
  const stillRemoved = changedWireTokens(parseDiff([
    ...hunk("routerA.js", ['-router.get("/api/orders/:id", handler)']),
    ...hunk("routerB.js", ['+router.get("/api/orders/:orderId", otherHandler)']),
  ]));
  assert.deepEqual(stillRemoved.map((token) => `${token.key} ${token.state}`), ["/api/orders/* removed"],
    "two different routes, one of which is gone");

  // The same literal, though, really is the same contract.
  assert.deepEqual(changedWireTokens(parseDiff([
    ...hunk("routerA.js", ['-router.get("/api/orders/:id", handler)']),
    ...hunk("routerB.js", ['+router.get("/api/orders/:id", handler)']),
  ])), [], "moved, not removed");
});
