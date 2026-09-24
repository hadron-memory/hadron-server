// Regenerates the #1177/#1235 parity fixture sections affected by §4a's
// id-in-the-hash change, FROM the Go reference. Run inside a git-archive of
// hadron-cli at a named commit — never a working checkout (a colleague's tree
// moves while you measure).
//
// Usage: genfix <fixtures.json> <hadron-cli-commit>
//
// ## Cases are maps, not structs, and that is load-bearing
//
// The first version decoded each case into a closed Go struct and marshaled it
// back. Anything the struct did not declare was SILENTLY DROPPED — which cost
// seven `why` explanations (the file's total went 32 → 25): five on hash cases
// and two on render, each the one-line reason that case exists ("Go trims NEL,
// JS does not — the hash diverges if ported naively"). No test reads `why`, so
// nothing failed (@codex, PR #1249). Reported as 29 at first, which was a
// diff-line count rather than a measurement.
//
// Using map[string]any means a field this program has never heard of survives
// regeneration. Only the keys it actually computes are written.
package main

import (
	"encoding/json"
	"fmt"
	"os"

	"github.com/hadron-memory/hadron-cli/internal/skilldoc"
)

type kase = map[string]any

func str(c kase, k string) string {
	if v, ok := c[k].(string); ok {
		return v
	}
	return ""
}

// upsert replaces a case with the same "name", or appends when absent. A blind
// append makes the generator NON-IDEMPOTENT: the README tells the next person
// to regenerate FROM the current fixture, so a second run would duplicate every
// added case and a third would triple it (measured: 13 → 16 → 19). The tests
// keep passing — duplicate names simply run twice — so the file grows silently.
func upsert(cases []kase, add ...kase) []kase {
	for _, a := range add {
		replaced := false
		for i := range cases {
			if str(cases[i], "name") == str(a, "name") {
				// Merge rather than overwrite, so an added case that later
				// gains a `why` by hand keeps it across the next run.
				for k, v := range a {
					cases[i][k] = v
				}
				replaced = true
				break
			}
		}
		if !replaced {
			cases = append(cases, a)
		}
	}
	return cases
}

// decodeOrEmpty is decode for a section this generator introduces: absent the
// first time it runs, so there is nothing to upsert into yet.
func decodeOrEmpty(doc map[string]json.RawMessage, section string) []kase {
	if _, ok := doc[section]; !ok {
		return []kase{}
	}
	return decode(doc, section)
}

func decode(doc map[string]json.RawMessage, section string) []kase {
	var cases []kase
	if err := json.Unmarshal(doc[section], &cases); err != nil {
		panic(fmt.Sprintf("%s: %v", section, err))
	}
	return cases
}

/** The id-bearing cases the pre-§4a fixture could not express. */
func extras() []kase {
	const src = "hrn:node:hadronmemory.com:hadron-cli:tasks:example"
	return []kase{
		{"name": "with-id", "id": "01a0099f949d76a9baf3a16527485475", "source": src,
			"skillName": "hadron-example", "description": "Use when example.",
			"content": "# Example\n\nBody text.\n",
			"why":     "the published cross-repo vector — hadron-cli#650"},
		{"name": "empty-id-is-hashed-not-skipped", "id": "", "source": src,
			"skillName": "hadron-example", "description": "Use when example.",
			"content": "# Example\n\nBody text.\n",
			"why":     "an absent id contributes the empty string, not nothing — one shape, no branch"},
		{"name": "id-differs-same-everything-else", "id": "01a0000000000000000000000000000f",
			"source": "hrn:node:a.com:m:tasks:x", "skillName": "hadron-x",
			"description": "d", "content": "body",
			"why":         "the whole point of §4a: the id alone must move the digest"},
	}
}

// collisionCases are the `lintCollisions` inputs, AUTHORED here and upserted
// by name so the section can be regenerated rather than hand-edited (#1289).
// Before #1289 the section was produced once, ad hoc, at 1a8036b, and nothing
// could regenerate it — the README's "regenerate rather than hand-edit" had no
// program behind it for this section, the same gap #1235 closed for `hash`.
//
// Every pre-#1289 case now carries `enable: true`. Their inputs had NO
// `enable`, and since D-2026-09-23-C only an ENABLED declaration claims a name
// (cor:agt:030:06) — so, left alone, the three collision cases would have
// silently stopped colliding on BOTH sides and still passed, which is a parity
// gate asserting nothing. The three disabled cases are the rule itself.
func collisionCases() []kase {
	node := func(urn, loc string, decl map[string]any) map[string]any {
		return map[string]any{
			"urn": urn, "loc": loc, "memoryUrn": "hrn:mem:acme.com:mem", "isRunnable": true,
			"content":    "# Do the thing\n\nSteps.",
			"properties": map[string]any{"exports": map[string]any{"claudeSkill": decl}},
		}
	}
	decl := func(name any, enable any) map[string]any {
		d := map[string]any{"description": "d. Use when x."}
		if name != nil {
			d["name"] = name
		}
		if enable != nil {
			d["enable"] = enable
		}
		return d
	}
	const a, b, c = "hrn:node:a.com:m:one", "hrn:node:b.com:m:two", "hrn:node:c.com:m:three"
	two := func(name string, ea, eb any) []any {
		return []any{node(a, "tasks:x", decl(name, ea)), node(b, "tasks:x", decl(name, eb))}
	}
	return []kase{
		{"name": "two nodes one name", "nodes": two("same-name", true, true)},
		{"name": "three nodes one name", "nodes": []any{
			node(a, "tasks:x", decl("dup", true)), node(b, "tasks:x", decl("dup", true)),
			node(c, "tasks:x", decl("dup", true))}},
		{"name": "distinct names", "nodes": []any{
			node(a, "tasks:x", decl("alpha", true)), node(b, "tasks:x", decl("beta", true))}},
		{"name": "a padded name does not collide with the trimmed one", "nodes": []any{
			node(a, "tasks:x", decl(" x-y ", true)), node(b, "tasks:x", decl("x-y", true))}},
		{"name": "two identically padded names DO collide", "nodes": two(" x-y ", true, true)},
		{"name": "nameless nodes never collide", "nodes": []any{
			node(a, "", decl(nil, true)), node(b, "", decl(nil, true))}},
		{"name": "a disabled declaration does not collide with an enabled one", "nodes": two("same-name", false, true),
			"why": "cor:agt:030:06 — switching an old foo off and enabling a new foo is a hand-over, not a collision (#1289)"},
		{"name": "an absent enable does not collide with an enabled one", "nodes": two("same-name", nil, true),
			"why": "enable defaults to off, so an absent enable claims no name either"},
		{"name": "two disabled declarations do not collide", "nodes": two("same-name", false, false),
			"why": "neither is exported, so neither claims the name"},
	}
}

// collisionFindings runs Go's LintCollisions over a case's nodes and writes
// the findings in the fixture's lower-camel shape. `memory` is omitted, as it
// always was in this section: every input shares one memory.
func collisionFindings(c kase) []any {
	var nodes []skilldoc.Node
	for _, raw := range c["nodes"].([]any) {
		n := raw.(map[string]any)
		props, _ := n["properties"].(map[string]any)
		nodes = append(nodes, skilldoc.Node{
			URN: n["urn"].(string), Loc: n["loc"].(string), MemoryURN: n["memoryUrn"].(string),
			IsRunnable: n["isRunnable"].(bool), Content: n["content"].(string), Properties: props,
		})
	}
	out := []any{}
	for _, f := range skilldoc.LintCollisions(nodes) {
		out = append(out, map[string]any{
			"urn": f.URN, "rule": f.Rule, "severity": f.Severity, "message": f.Message,
		})
	}
	return out
}

func main() {
	if len(os.Args) < 3 {
		fmt.Fprintln(os.Stderr, "usage: genfix <fixtures.json> <hadron-cli-commit>")
		os.Exit(2)
	}
	path, commit := os.Args[1], os.Args[2]

	raw, err := os.ReadFile(path)
	if err != nil {
		panic(err)
	}
	var doc map[string]json.RawMessage
	if err := json.Unmarshal(raw, &doc); err != nil {
		panic(err)
	}

	// ── hash ────────────────────────────────────────────────────────────────
	hashCases := upsert(decode(doc, "hash"), extras()...)
	for _, c := range hashCases {
		c["out"] = skilldoc.Hash(str(c, "id"), str(c, "source"), str(c, "skillName"),
			str(c, "description"), str(c, "content"))
	}
	doc["hash"], _ = json.Marshal(hashCases)

	// ── renderParseRoundTrip ────────────────────────────────────────────────
	// Records what Go READ BACK off its own rendered file, not the raw inputs:
	// `content` is post-NormalizeBody, so computing the digest directly skips
	// the normalization this section exists to exercise (a trailing newline
	// survives the input and does not survive the round trip).
	rt := upsert(decode(doc, "renderParseRoundTrip"), extras()[0], extras()[1])
	for _, c := range rt {
		rendered, err := skilldoc.Render(str(c, "id"), str(c, "skillName"), str(c, "source"),
			str(c, "description"), str(c, "content"))
		if err != nil {
			panic(fmt.Sprintf("roundtrip render %s: %v", str(c, "name"), err))
		}
		f, err := skilldoc.ParseFile([]byte(rendered))
		if err != nil {
			panic(fmt.Sprintf("roundtrip parse %s: %v", str(c, "name"), err))
		}
		c["id"], c["source"], c["skillName"] = f.ID, f.Source, f.Name
		c["description"], c["content"], c["out"] = f.Description, f.Body, f.Hash
	}
	doc["renderParseRoundTrip"], _ = json.Marshal(rt)

	// ── render ──────────────────────────────────────────────────────────────
	// Kept NAME-ALIGNED with renderParseRoundTrip: that section's test looks its
	// inputs up in THIS one by case name, so a case present in only one of the
	// two is an undefined lookup rather than a missing assertion.
	rc := upsert(decode(doc, "render"), extras()[0], extras()[1])
	for _, c := range rc {
		out, err := skilldoc.Render(str(c, "id"), str(c, "skillName"), str(c, "source"),
			str(c, "description"), str(c, "content"))
		if err != nil {
			panic(fmt.Sprintf("render %s: %v", str(c, "name"), err))
		}
		c["out"] = out
	}
	doc["render"], _ = json.Marshal(rc)

	// ── lintCollisions ──────────────────────────────────────────────────────
	// Stamped separately (`lintCollisionsSourceCommit`): `lint` is NOT
	// regenerated here and stays at `lintSourceCommit`, and one commit field
	// for two sections generated at different revisions would misstate one.
	//
	// Round-tripped through JSON first so the upserted Go literals and the
	// decoded fixture cases share one representation ([]any / float64), which
	// is what collisionFindings asserts on.
	var lc []kase
	cb, _ := json.Marshal(upsert(decode(doc, "lintCollisions"), collisionCases()...))
	if err := json.Unmarshal(cb, &lc); err != nil {
		panic(err)
	}
	for _, c := range lc {
		c["findings"] = collisionFindings(c)
	}
	doc["lintCollisions"], _ = json.Marshal(lc)
	doc["lintCollisionsSourceCommit"], _ = json.Marshal(commit)

	// ── declared ────────────────────────────────────────────────────────────
	// Inputs kept as they are; the reader's verdict recomputed from Go (#1292).
	// Before this the section had no generator. Its `two malformed hosts sort`
	// and UTF-8 ordering cases pinned unknown keys as MALFORMED, which
	// cor:agt:030:06 now rules out (an unknown key is a warning and never
	// blocks). Regenerated at a commit whose Go agrees, they come back with an
	// empty `malformed`. Stamped separately, like lintCollisions.
	dc := decode(doc, "declared")
	for _, c := range dc {
		props, _ := c["properties"].(map[string]any)
		d, found := skilldoc.Declared(props)
		out := map[string]any{"found": found, "nameSet": false, "enable": false, "enableSet": false}
		if found {
			out["key"], out["host"] = d.Key, d.Host
			out["nameSet"], out["enable"], out["enableSet"] = d.NameSet, d.Enable, d.EnableSet
			// Empty strings omitted, matching the section's existing shape.
			if d.Description != "" {
				out["description"] = d.Description
			}
			if d.Name != "" {
				out["name"] = d.Name
			}
		}
		c["declared"] = out
		malformed := skilldoc.Malformed(props)
		if malformed == nil {
			malformed = []string{}
		}
		c["malformed"] = malformed
		// The unknown keys, in UTF-8 byte order — the ORDER the pre-#1292
		// malformed-path vectors pinned now lives here. Needs a hadron-cli
		// commit that has UnknownHostKeys (#679 or later); older commits do
		// not compile this generator, which is the right failure.
		unknown := skilldoc.UnknownHostKeys(props)
		if unknown == nil {
			unknown = []string{}
		}
		c["unknown"] = unknown
	}
	doc["declared"], _ = json.Marshal(dc)
	doc["declaredSourceCommit"], _ = json.Marshal(commit)

	// ── lintUnknownHostKeys ─────────────────────────────────────────────────
	// #1292 (@copilot, PR #1296): the warning's MESSAGE is part of the port,
	// and it quotes an author-controlled key with %q. Keys are chosen for the
	// characters Go's %q and JSON.stringify escape differently: quote,
	// backslash, control characters, DEL, a non-printing NBSP and soft hyphen,
	// private use, and an astral code point. Inputs are authored here and
	// upserted by name; findings come from Go.
	uk := upsert(decodeOrEmpty(doc, "lintUnknownHostKeys"),
		kase{"name": "the codex shape", "keys": []any{"codex"}},
		kase{"name": "keys Go and JSON quote differently", "keys": []any{
			"with\"quote", "back\\slash", "new\nline", "tab\there", "bell\a", "del\x7f",
			"nbsp\u00a0", "soft\u00adhyphen", "caf\u00e9", "\ue000", "\U00010000", "emoji\U0001F600", "sp ace",
			// Unicode space separators other than U+0020, and U+2028: %q
			// ESCAPES them (measured, @copilot on PR #1296 read it the other way).
			"en\u2000quad", "ideo\u3000space", "ogham\u1680mark", "line\u2028sep"}},
	)
	for _, c := range uk {
		exports := map[string]any{"claudeSkill": map[string]any{"name": "x", "description": "d. Use when x."}}
		for _, k := range c["keys"].([]any) {
			exports[k.(string)] = true
		}
		n := skilldoc.Node{URN: "hrn:node:a.com:m:tasks:x", Loc: "tasks:x", MemoryURN: "hrn:mem:a.com:m",
			IsRunnable: true, Content: "# b", Properties: map[string]any{"exports": exports}}
		findings := []any{}
		for _, f := range skilldoc.LintUnknownHostKeys(n) {
			findings = append(findings, map[string]any{"rule": f.Rule, "severity": f.Severity, "message": f.Message})
		}
		c["findings"] = findings
	}
	doc["lintUnknownHostKeys"], _ = json.Marshal(uk)
	doc["lintUnknownHostKeysSourceCommit"], _ = json.Marshal(commit)

	// The commit is an ARGUMENT, never a literal. Hardcoding it meant the next
	// regeneration at a newer revision would still stamp the old one, and
	// `sourceCommit` is the only provenance this file carries — a wrong one is
	// worse than none (@codex, PR #1249).
	doc["sourceCommit"], _ = json.Marshal(commit)

	out, _ := json.MarshalIndent(doc, "", "  ")
	os.Stdout.Write(out)
}
