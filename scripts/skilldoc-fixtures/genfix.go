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

	// The commit is an ARGUMENT, never a literal. Hardcoding it meant the next
	// regeneration at a newer revision would still stamp the old one, and
	// `sourceCommit` is the only provenance this file carries — a wrong one is
	// worse than none (@codex, PR #1249).
	doc["sourceCommit"], _ = json.Marshal(commit)

	out, _ := json.MarshalIndent(doc, "", "  ")
	os.Stdout.Write(out)
}
