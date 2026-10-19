# Complete required context without an extra read round

The operational skill's `paperclip-read-documents.mjs` reads explicit issue/key
references through the current run's existing Issue Documents API authorization.
It validates the complete response, canonical issue/key, revision, body bytes and
SHA-256 before producing success. It never parses arbitrary instructions into
document authority or reads the database directly.

Default output remains the original manifest and private segment files. The
optional `--inline-max-bytes N` accepts 1,024–49,152 bytes and counts the entire
UTF-8 stdout, including headers and newlines. For a fitting result, the first line
is a manifest header and the remaining JSON contains `inlineComplete: true` and
complete `bodySegments`. Their ordered concatenation is the exact original body.
Each JSON-encoded segment is at most 4,096 bytes; every inline output line stays
within 6,000 bytes. No body is summarized or partially inlined.

Independent document reads can run as separate tool calls in the same input
phase. This avoids forcing several complete bodies under one stdout budget.
Known smaller runtime/instruction limits still apply. The helper does not raise
the client's output limit; use a lower budget or default output where required.

If complete output does not fit, `delivery: segments` returns the original full
segment manifest. If that header is too large, `delivery: manifest-file` returns
the private saved manifest path. If even this pointer cannot fit, the helper
fails and cleans up instead of returning partial success. Directories are private
and files are created exclusively with mode 0600. A client truncation notice or
missing/incomplete inline payload always requires the complete saved fallback.

Only bodies actually delivered completely count as read. A manifest, digest or
saved file does not. Conditional rule references and explicit freshness checks
remain required; later edits or lost context require a fresh read. This is a
presentation optimization, not a cross-run rule cache or an authorization cache.

The [CLI tests](../server/src/__tests__/paperclip-read-documents-helper.test.ts)
exercise real authenticated HTTP, Unicode/escaped-body reconstruction, exact
output boundaries, both complete fallbacks and failures without success output.
Live verification must additionally prove complete model-facing delivery and
final accounting; a successful shell exit alone is insufficient.
