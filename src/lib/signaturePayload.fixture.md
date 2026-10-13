# S0 signing payload fixture

`signaturePayload.fixture.json` is the shared **plaintext** conformance artifact
for server#1629 / epic#1614. The contract is `cor:dmo:130:01` (signed payload)
and `cor:dmo:120:01` (approval fingerprint). Consume the same file in the spike,
CLI, portal and later server implementation; do not re-generate expected values
from the implementation under test.

## Exact bytes

For plaintext title, abstract and content, compute the existing
`hadron-approval-v1` fingerprint first. Then serialize this UTF-8 text, in the
specified order, **with LF after every line including the last**:

```text
hadron-signature-v1
node <stable node id>
approval-hash <64 lowercase hex>
```

The fixture carries the same bytes as `payloadUtf8` and standard base64
`canonical`. The WebAuthn challenge input is the **32 raw bytes** of SHA-256 over
those payload bytes. `challengeHex` and unpadded `challengeBase64url` are two
encodings of that same digest, not alternate inputs to hash. A browser decodes
base64url into a byte buffer for the WebAuthn challenge; hashing the hex text or
passing its UTF-8 bytes is a different challenge.

Each case contains `input.nodeId` and plaintext `input.fields`; `approvalHash`
is the content fingerprint regardless of whether anyone has approved the node.
Signing does not require or create an approval. Neither revSeq, loc, memory,
role, tags, properties nor data is in this payload. The later ceremony still
pins and gates its signing request's revision and single-use lifecycle; this
fixture does not implement that ceremony or its replay/freshness checks.

## Coverage and provenance

The twelve vectors were computed independently with Python `hashlib`, using the
specified approval field framing and signature lines. The test recomputes
approval with the existing TypeScript codec and recomputes the payload digest
with Node crypto, while pinning the spec example literally. Cases include the
spec's Retention example, all ten approval-v1 edge cases (null, empty, UTF-8,
CRLF/lone CR, unnormalized Unicode, field-boundary-like text, whitespace) and
the same content on a different stable node. The fixture contains only
synthetic public text and identifiers; no keys or user data.

## Encrypted memories have no payload hash

**v1 is the only approval fingerprint and the only signature payload.** There is
no keyed or encrypted-memory variant. Approval, minting and signing are refused
on a node in an encrypted memory, always (`cor:dmo:120:00`, Scope; Holger,
2026-10-13, team chat #9837), so no fingerprint or payload is ever computed for
encrypted-memory plaintext, and these vectors must not be used to compute one.
(The approval refusal is not built yet: hadron-server#1637.)
This retires the earlier keyed-v2 plan (the DM=D ruling) that this section used
to describe; `cor:dmo:120:00` and `cor:dmo:130:04` record the replacement. Any
future payload change gets its own prefix and fixture and never changes these v1
bytes.

This S0 artifact adds no runtime signing endpoint, schema, dependency or
credential registry. DL registration/activation policy and DN's parked secrets
service are not encoded in content-fingerprint bytes.
