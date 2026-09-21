// Regenerates the #1177/#1235 parity fixture sections affected by §4a's
// id-in-the-hash change, FROM the Go reference. Run inside a git-archive of
// hadron-cli at a named commit — never a working checkout (a colleague's tree
// moves while you measure).
package main

import (
	"encoding/json"
	"fmt"
	"os"

	"github.com/hadron-memory/hadron-cli/internal/skilldoc"
)

type hashCase struct {
	Name        string `json:"name"`
	ID          string `json:"id"`
	Source      string `json:"source"`
	SkillName   string `json:"skillName"`
	Description string `json:"description"`
	Content     string `json:"content"`
	Out         string `json:"out"`
}

func main() {
	raw, err := os.ReadFile(os.Args[1])
	if err != nil {
		panic(err)
	}
	var doc map[string]json.RawMessage
	if err := json.Unmarshal(raw, &doc); err != nil {
		panic(err)
	}

	// hash only. renderParseRoundTrip is handled separately below: its fields
	// are what Go READ BACK off its own rendered file, not the raw inputs, so
	// computing the digest directly skips the normalization the round trip is
	// there to exercise (a trailing newline survives the input and does not
	// survive NormalizeBody).
	for _, section := range []string{"hash"} {
		var cases []hashCase
		if err := json.Unmarshal(doc[section], &cases); err != nil {
			panic(fmt.Sprintf("%s: %v", section, err))
		}
		// Existing cases keep an EMPTY id — they pin the pre-§4a shape, whose
		// digests all change because "" is hashed, not skipped.
		for i := range cases {
			cases[i].Out = skilldoc.Hash(cases[i].ID, cases[i].Source, cases[i].SkillName,
				cases[i].Description, cases[i].Content)
		}
		// Plus the cases the old fixture could not express.
		extra := []hashCase{
			{Name: "with-id", ID: "01a0099f949d76a9baf3a16527485475",
				Source: "hrn:node:hadronmemory.com:hadron-cli:tasks:example",
				SkillName: "hadron-example", Description: "Use when example.",
				Content: "# Example\n\nBody text.\n"},
			{Name: "empty-id-is-hashed-not-skipped", ID: "",
				Source: "hrn:node:hadronmemory.com:hadron-cli:tasks:example",
				SkillName: "hadron-example", Description: "Use when example.",
				Content: "# Example\n\nBody text.\n"},
			{Name: "id-differs-same-everything-else", ID: "01a0000000000000000000000000000f",
				Source: "hrn:node:a.com:m:tasks:x", SkillName: "hadron-x",
				Description: "d", Content: "body"},
		}
		for i := range extra {
			extra[i].Out = skilldoc.Hash(extra[i].ID, extra[i].Source, extra[i].SkillName,
				extra[i].Description, extra[i].Content)
		}
		cases = append(cases, extra...)
		b, _ := json.Marshal(cases)
		doc[section] = b
	}

	// renderParseRoundTrip — render, then PARSE, and record what came back.
	var rt []hashCase
	if err := json.Unmarshal(doc["renderParseRoundTrip"], &rt); err != nil {
		panic(err)
	}
	rt = append(rt, hashCase{
		Name: "with-id", ID: "01a0099f949d76a9baf3a16527485475",
		Source: "hrn:node:hadronmemory.com:hadron-cli:tasks:example",
		SkillName: "hadron-example", Description: "Use when example.",
		Content: "# Example\n\nBody text.\n",
	}, hashCase{
		Name: "empty-id-is-hashed-not-skipped", ID: "",
		Source: "hrn:node:hadronmemory.com:hadron-cli:tasks:example",
		SkillName: "hadron-example", Description: "Use when example.",
		Content: "# Example\n\nBody text.\n",
	})
	for i := range rt {
		rendered, err := skilldoc.Render(rt[i].ID, rt[i].SkillName, rt[i].Source, rt[i].Description, rt[i].Content)
		if err != nil {
			panic(fmt.Sprintf("roundtrip render %s: %v", rt[i].Name, err))
		}
		f, err := skilldoc.ParseFile([]byte(rendered))
		if err != nil {
			panic(fmt.Sprintf("roundtrip parse %s: %v", rt[i].Name, err))
		}
		// What Go read back — including its normalization of the body.
		rt[i].ID, rt[i].Source, rt[i].SkillName = f.ID, f.Source, f.Name
		rt[i].Description, rt[i].Content, rt[i].Out = f.Description, f.Body, f.Hash
	}
	rtb, _ := json.Marshal(rt)
	doc["renderParseRoundTrip"] = rtb

	var rcases []hashCase
	if err := json.Unmarshal(doc["render"], &rcases); err != nil {
		panic(err)
	}
	// Kept name-aligned with renderParseRoundTrip: that section's test looks its
	// inputs up in THIS one by case name, so a case present in only one of the
	// two is an undefined lookup rather than a missing assertion.
	rcases = append(rcases, hashCase{
		Name: "with-id", ID: "01a0099f949d76a9baf3a16527485475",
		Source: "hrn:node:hadronmemory.com:hadron-cli:tasks:example",
		SkillName: "hadron-example", Description: "Use when example.",
		Content: "# Example\n\nBody text.\n",
	}, hashCase{
		Name: "empty-id-is-hashed-not-skipped", ID: "",
		Source: "hrn:node:hadronmemory.com:hadron-cli:tasks:example",
		SkillName: "hadron-example", Description: "Use when example.",
		Content: "# Example\n\nBody text.\n",
	})
	for i := range rcases {
		out, err := skilldoc.Render(rcases[i].ID, rcases[i].SkillName, rcases[i].Source,
			rcases[i].Description, rcases[i].Content)
		if err != nil {
			panic(fmt.Sprintf("render %s: %v", rcases[i].Name, err))
		}
		rcases[i].Out = out
	}
	b, _ := json.Marshal(rcases)
	doc["render"] = b

	doc["sourceCommit"], _ = json.Marshal("1d8ca46")
	out, _ := json.MarshalIndent(doc, "", "  ")
	os.Stdout.Write(out)
}
