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
	"strings"

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
			"why": "the whole point of §4a: the id alone must move the digest"},
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

// reservedCases are the `lintReserved` inputs (#1315), authored here and
// upserted by name. Plain spellings only: Go folds with x/text/collate and the
// server with ICU, and the two differ on exotic code points that the name
// grammar already refuses (hadron-cli#712), so an exotic case would pin a
// table-version difference rather than the rule.
func reservedCases() []kase {
	node := func(exports map[string]any) map[string]any {
		return map[string]any{
			"urn": "hrn:node:acme.com:mem:tasks:x", "loc": "tasks:x", "memoryUrn": "hrn:mem:acme.com:mem",
			"isRunnable": true, "content": "# Do the thing\n\nSteps.",
			"properties": map[string]any{"exports": exports},
		}
	}
	decl := func(name string) map[string]any {
		return map[string]any{"name": name, "description": "Do the thing. Use when you must do the thing.", "enable": true}
	}
	return []kase{
		{"name": "synced is reserved for claudeSkill", "node": node(map[string]any{"claudeSkill": decl("synced")})},
		{"name": "the reservation folds case", "node": node(map[string]any{"claudeSkill": decl("Synced")}),
			"why": "both sides fold at primary strength (ICU / x/text/collate); the grammar also refuses the capital, so both rules fire"},
		{"name": "a padded synced is judged on the trimmed name", "node": node(map[string]any{"claudeSkill": decl(" synced ")}),
			"why": "the planner exports under the trimmed name, so the reservation is checked against what it writes (#1318)"},
		{"name": "synced is not reserved for codexSkill", "node": node(map[string]any{"codexSkill": decl("synced")}),
			"why": "the reservation is Claude's, not a global ban"},
		{"name": "both hosts declare synced, only Claude refuses", "node": node(map[string]any{
			"claudeSkill": decl("synced"), "codexSkill": decl("synced")})},
		{"name": "codex evaluates the name but does not reserve it", "node": node(map[string]any{"codexSkill": decl("Synced")}),
			"why": "a POSITIVE control that the Codex column is evaluated: the capital trips skill-name-invalid there, the reservation does not"},
		{"name": "a name containing synced is not reserved", "node": node(map[string]any{"claudeSkill": decl("synced-notes")}),
			"why": "the whole name is matched, never a substring"},
	}
}

// markupCases are the `lintMarkup` inputs (#1341), authored here and upserted
// by name. The first twenty are Holger's Cowork probe upload (2026-09-25),
// EXACTLY as uploaded: Cowork refused the twelve marked so and accepted the
// eight marked so. The rest pin what the probe did not measure: which span the
// message quotes, how it is quoted, and the nested `<<>` the rule refuses on
// purpose. Both hosts declare every node, so the codexSkill column is a real
// verdict rather than an undeclared-node result. Every description says "Use
// when", so each case pins the markup rule and not skill-description-no-trigger.
func markupCases() []kase {
	node := func(desc string) map[string]any {
		decl := map[string]any{"name": "probe", "description": desc, "enable": true}
		return map[string]any{
			"urn": "hrn:node:acme.com:mem:tasks:probe", "loc": "tasks:probe", "memoryUrn": "hrn:mem:acme.com:mem",
			"isRunnable": true, "content": "# Probe\n\nSteps.",
			"properties": map[string]any{"exports": map[string]any{"claudeSkill": decl, "codexSkill": decl}},
		}
	}
	probe := func(name, verdict, desc string) kase {
		return kase{"name": name + " (Cowork " + verdict + ")", "node": node(desc)}
	}
	return []kase{
		probe("p01-clean-control", "accepted", "Does a thing. Use when you need it."),
		probe("p02-placeholder", "refused", "Use when adding a node to <memory>."),
		probe("p03-capital-tag", "refused", "Use when working as <Name>."),
		probe("p04-hyphen-tag", "refused", "Use when given a <memory-urn>."),
		probe("p05-lone-lt", "accepted", "Use when a < b."),
		probe("p06-lone-gt", "accepted", "Use when b > a."),
		probe("p07-lt-and-gt-spaced", "refused", "Use when 1 < 2 and 3 > 2."),
		probe("p08-closing-tag", "refused", "Use when the block ends with </end>."),
		probe("p09-self-closing", "refused", "Use when a <br/> appears."),
		probe("p10-arrows", "accepted", "Use when mapping a -> b or x => y."),
		probe("p11-heart", "accepted", "Use when you <3 it."),
		probe("p12-shift", "refused", "Use when shifting x << 2 or y >> 1."),
		probe("p13-entities", "accepted", "Use when text shows &lt;memory&gt; escaped."),
		probe("p14-digit-tag", "refused", "Use when step <1> is next."),
		probe("p15-two-words", "refused", "Use when <two words> appear."),
		probe("p16-email", "refused", "Use when mailing <user@example.com>."),
		probe("p17-html-comment", "refused", "Use when a <!-- note --> appears."),
		probe("p18-empty-brackets", "accepted", "Use when <> appears."),
		probe("p19-url", "refused", "Use when linking <https://example.com>."),
		probe("p20-lt-letter", "accepted", "Use when a<b holds."),
		{"name": "nested opener is refused (unmeasured, conservative)", "node": node("Use when a <<> appears."),
			"why": "<[^>]+> and <[^<>]+> both fit the probe and differ only here; the broader one is encoded, so a plugin errs toward uploading"},
		{"name": "the message quotes the leftmost span", "node": node("Use when <a> then <b>.")},
		{"name": "the quoted span is escaped like %q", "node": node(`Use when <say "hi"> fires.`),
			"why": "the span is author-controlled; the server quotes it with goQuote"},
		{"name": "a printable non-ASCII span is quoted as is", "node": node("Use when a <café> opens.")},
		{"name": "a non-printable code point in the span is escaped", "node": node("Use when a <a\u200bb> opens."),
			"why": "U+200B is where Go %q (\\u200b) and a naive JSON.stringify diverge; the server must quote it the Go way"},
		{"name": "markup is reported beside too-long", "node": node("Use when <memory> " + strings.Repeat("x", 1024)),
			"why": "both are errors, so fixing one does not reveal the other on the next run"},
	}
}

// headerCases are provenance-header inputs: the #1323 `rev=` edge values
// (hadron-cli#724, merged as 9e7d2bd, is the first Go that reads one), plus the
// separator cases they turned up. Each case edits the provenance
// line of ONE Go-rendered file; genfix writes the edited file as `input` and
// Go's ParseFile verdict beside it. A malformed `rev=` voids the WHOLE header
// on both sides (#1339 / Eli, dev-team chat #1626), so a voided case reads
// back with an empty source rather than a revision-less header.
//
// The separator cases are there because RE2's \s is [\t\n\f\r ] while
// JavaScript's also takes \v and the Unicode spaces: an NBSP between two keys
// is a separator to one reader and part of a value to the other. The first
// generation of this section found the port on the JavaScript side of that
// line, for the legacy header as much as the current one.
func headerCases() []kase {
	edit := func(name, old, repl, why string) kase {
		c := kase{"name": name, "old": old, "new": repl}
		if why != "" {
			c["why"] = why
		}
		return c
	}
	const id = "id=node-1 "
	const legacyOld = "hadron-skill id=node-1 source=hrn:node:a.com:mem:tasks:x hash="
	return []kase{
		edit("absent: a pre-#1323 header", id, id, "revision 0 in Go, null in TypeScript: both mean none"),
		edit("rev=1, the minimum", id, id+"rev=1 ", ""),
		edit("rev=7", id, id+"rev=7 ", ""),
		edit("rev=2147483647, Node.revSeq's maximum", id, id+"rev=2147483647 ", ""),
		edit("rev=2147483648 voids the header", id, id+"rev=2147483648 ", "one past the signed 32-bit column"),
		edit("rev=99999999999 voids the header", id, id+"rev=99999999999 ", "eleven digits: Go refuses on length before parsing"),
		edit("rev=0 voids the header", id, id+"rev=0 ", ""),
		edit("rev=07 voids the header", id, id+"rev=07 ", "no leading zero: one spelling per revision"),
		edit("rev=-1 voids the header", id, id+"rev=-1 ", ""),
		edit("rev=+7 voids the header", id, id+"rev=+7 ", ""),
		edit("rev=1.5 voids the header", id, id+"rev=1.5 ", ""),
		edit("rev=7x voids the header", id, id+"rev=7x ", ""),
		edit("a non-ASCII digit voids the header", id, id+"rev=\u0667 ", "Arabic-Indic seven: \\d must stay ASCII on both sides"),
		edit("rev after hash: key order does not matter", " -->\n<!--", " rev=7 -->\n<!--", "anchored on the provenance line's end: the human line below it ends in ' -->' too"),
		edit("a repeated rev: the last one counts (valid last)", id, id+"rev=0 rev=7 ", ""),
		edit("a repeated rev: the last one counts (invalid last)", id, id+"rev=7 rev=0 ", ""),
		edit("REV=7 is an unknown key, not a revision", id, id+"REV=7 ", "keys are case-sensitive"),
		edit("an NBSP after the rev value", id, id+"rev=7\u00a0", "RE2 \\S takes the NBSP into the value; JS \\s takes it as a separator"),
		edit("a vertical tab after the rev value", id, id+"rev=7\v", "RE2 \\s excludes \\v; JS \\s includes it"),
		edit("an NBSP between two other keys", "source=", "\u00a0source=", "the same question without rev: it predates #1323"),
		edit("a legacy header (control)", legacyOld, "Generated from hrn:node:a.com:mem:tasks:x -->\n<!-- hash=",
			"the edit leaves a legacy line, then a comment neither reader treats as provenance"),
		edit("a legacy header with an NBSP separator", legacyOld, "Generated from\u00a0hrn:node:a.com:mem:tasks:x -->\n<!-- hash=", ""),
	}
}

// lintPerHost upserts authored cases into a section and fills each case's
// findingsByHost from Go's LintFor over EVERY row of skilldoc.Hosts — never
// skilldoc.Lint, the Claude-only wrapper, under which a codexSkill
// declaration is not evaluated at all (PR #1343 review).
// templateCases are the inputs of `lintTemplate` (hadron-server#2943 /
// hadron-cli#1166): an include tag `{{> part}}` is resolved on export, so the
// "ships as literal text" warning is for an ordinary placeholder only.
func templateCases() []kase {
	node := func(content string) map[string]any {
		decl := map[string]any{"name": "tpl", "description": "Does a thing. Use when you need it.", "enable": true}
		return map[string]any{
			"urn": "hrn:node:acme.com:mem:tasks:tpl", "loc": "tasks:tpl", "memoryUrn": "hrn:mem:acme.com:mem",
			"isRunnable": true, "content": content,
			"properties": map[string]any{"exports": map[string]any{"claudeSkill": decl, "codexSkill": decl}},
		}
	}
	return []kase{
		{"name": "an include tag alone gets no finding", "node": node("# T\n\n{{> base:parts:intro}}\n")},
		{"name": "two include tags get no finding", "node": node("{{> a:b}} then {{>c}}")},
		{"name": "a placeholder alone still warns", "node": node("Hello {{name}}")},
		{"name": "an include tag beside a placeholder still warns", "node": node("{{> a:b}} and {{name}}"),
			"why": "the placeholder still ships as literal text"},
		{"name": "a space before > is not an include tag, so it warns", "node": node("{{ > a:b}}"),
			"why": "the export resolver's opener is exactly {{>"},
		{"name": "an empty pair still warns", "node": node("x {{}} y")},
		{"name": "no braces, no finding", "node": node("plain body")},
		{"name": "braces inside an include target still warn", "node": node("{{>{{x}}"),
			"why": "the rule is a pattern search, not the include parser: the inner {{x}} is a placeholder match (out of scope: reimplementing the parser, #2943)"},
		{"name": "an include tag with inner padding gets no finding", "node": node("{{>  part  }}")},
	}
}

func lintPerHost(doc map[string]json.RawMessage, section string, cases []kase) []kase {
	var out []kase
	b, _ := json.Marshal(upsert(decodeOrEmpty(doc, section), cases...))
	if err := json.Unmarshal(b, &out); err != nil {
		panic(err)
	}
	for _, c := range out {
		n := c["node"].(map[string]any)
		props, _ := n["properties"].(map[string]any)
		node := skilldoc.Node{
			URN: n["urn"].(string), Loc: n["loc"].(string), MemoryURN: n["memoryUrn"].(string),
			IsRunnable: n["isRunnable"].(bool), Content: n["content"].(string), Properties: props,
		}
		byHost := map[string]any{}
		for _, h := range skilldoc.Hosts {
			findings := []any{}
			for _, f := range skilldoc.LintFor(node, h) {
				findings = append(findings, map[string]any{"rule": f.Rule, "severity": f.Severity, "message": f.Message})
			}
			byHost[h.Key] = findings
		}
		c["findingsByHost"] = byHost
		delete(c, "findings") // the pre-review single-host shape
	}
	return out
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

	// ── lintReserved ────────────────────────────────────────────────────────
	// #1315: a host-reserved skill name (Claude's `synced`). A section of its
	// own rather than cases upserted into `lint`, which stays at
	// `lintSourceCommit`: one stamp for cases generated at two revisions would
	// misstate one of them. Inputs are authored in reservedCases(); findings
	// come PER HOST from Go's LintFor over every row of skilldoc.Hosts — never
	// skilldoc.Lint, the Claude-only wrapper, under which a codexSkill
	// declaration is not evaluated at all (PR #1343 review). Needs
	// hadron-cli#712 or later for the rule to exist.
	lr := lintPerHost(doc, "lintReserved", reservedCases())
	doc["lintReserved"], _ = json.Marshal(lr)
	doc["lintReservedSourceCommit"], _ = json.Marshal(commit)

	// ── lintMarkup ──────────────────────────────────────────────────────────
	// #1341: Cowork's `<…>` description refusal, Claude only. Its own section
	// and stamp, like lintReserved. Needs hadron-cli#722 (PR #730, merged as
	// c9fa75a) or later for the rule to exist.
	doc["lintMarkup"], _ = json.Marshal(lintPerHost(doc, "lintMarkup", markupCases()))
	doc["lintMarkupSourceCommit"], _ = json.Marshal(commit)

	// ── lintTemplate ────────────────────────────────────────────────────────
	// hadron-server#2943 / hadron-cli#1166: include tags get no
	// skill-content-has-template finding. Its own section and stamp, like
	// lintMarkup; needs the hadron-cli#1166 change or later.
	doc["lintTemplate"], _ = json.Marshal(lintPerHost(doc, "lintTemplate", templateCases()))
	doc["lintTemplateSourceCommit"], _ = json.Marshal(commit)

	// ── parseHeader ─────────────────────────────────────────────────────────
	// #1323: Go's ParseFile over the headerCases edits. Its own section and
	// stamp, like lintMarkup; needs hadron-cli#724 (merged as 9e7d2bd) or
	// later, where File.Revision exists — an older commit does not compile.
	base, err := skilldoc.Render("node-1", "skill", "hrn:node:a.com:mem:tasks:x", "Use when testing.", "body")
	if err != nil {
		panic(fmt.Sprintf("parseHeader base render: %v", err))
	}
	pr := upsert(decodeOrEmpty(doc, "parseHeader"), headerCases()...)
	for _, c := range pr {
		old, repl := str(c, "old"), str(c, "new")
		if strings.Count(base, old) != 1 {
			panic(fmt.Sprintf("parseHeader %s: %q is not unique in the base file", str(c, "name"), old))
		}
		input := strings.Replace(base, old, repl, 1)
		f, err := skilldoc.ParseFile([]byte(input))
		if err != nil {
			panic(fmt.Sprintf("parseHeader %s: %v", str(c, "name"), err))
		}
		c["input"] = input
		c["id"], c["source"], c["hash"], c["revision"] = f.ID, f.Source, f.Hash, f.Revision
	}
	doc["parseHeader"], _ = json.Marshal(pr)
	doc["parseHeaderSourceCommit"], _ = json.Marshal(commit)

	// The commit is an ARGUMENT, never a literal. Hardcoding it meant the next
	// regeneration at a newer revision would still stamp the old one, and
	// `sourceCommit` is the only provenance this file carries — a wrong one is
	// worse than none (@codex, PR #1249).
	doc["sourceCommit"], _ = json.Marshal(commit)

	out, _ := json.MarshalIndent(doc, "", "  ")
	os.Stdout.Write(out)
}
