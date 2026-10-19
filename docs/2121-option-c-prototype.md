# #2121 option C prototype — pending Holger choice

Branch starts at main ad7f1c28093faa48770ac9391f5edf1feae49380. No PR, merge or rollout authorization.

New chat bodies must satisfy BOTH existing 65,536 JavaScript-code-unit limit and a proposed 120,000 UTF-8-byte limit. Exact byte boundary passes; one byte beyond refuses, never truncates. GraphQL createTeamChatMessage and createChannelMessage, and their existing MCP delegates, use the shared validator. The common postToChannelRoot write path also validates platform-authored posts. The byte check occurs before append/encryption/sequence allocation; existing character validation retains its original precedence.

Wire shape unchanged. SDL mutation descriptions state the two limits. Byte refusal keeps TEAM_CHAT_BODY_TOO_LARGE and adds extensions.maxBytes=120000; its fixed message includes no body. Existing character refusal retains maxChars. No new input/output field, migration, proof format or ack behavior.

Consequences for the ruling: this changes what future writers may store. It does not shorten/delete existing oversize messages and does not independently enforce a full rendered-envelope byte ceiling. Existing backlog and transport metadata remain separate concerns. It cannot by itself unblock an already-stored oversize first message. No stub-counts-as-delivery decision is embedded here.

Red-first: cb8d90af; the over-byte and astral controls fail on unchanged main while exact boundary passes. Focused full team-chat suite 98/98 passes after implementation, including both-door zero-append controls. Typecheck, SDL/841 SQL templates and diff check pass. A mutant substituting JS character count for UTF-8 byte count kills the astral pin; restored focused3/3 pass. Final results are posted with the branch head on #2121. No final design approval, full-suite/QA or deployment claim.
