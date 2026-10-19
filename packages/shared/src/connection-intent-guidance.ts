/**
 * Canonical instructions for the run-scoped connection tools.
 *
 * Keep this text provider-neutral and free of run identity, credentials, URLs,
 * or bearer tokens: it is reused in prompts, adapter descriptors, CLI help,
 * environment delivery, and MCP tool descriptions.
 */
export const CONNECTION_INTENT_AGENT_GUIDANCE = [
  "Connection tools:",
  "- When the user asks to connect a service, call `connections_search` before any service tool, even if already installed. Search by its name or capability and follow the returned `instruction`.",
  "- For ordinary work, use installed tools or search the assigned tool catalog directly. Missing inline schemas do not mean missing access: do not call `connections_search` just to confirm a catalog-listed app. Use connection tools if the needed capability or access is missing. Tool execution still checks current permissions and approvals.",
  "- Use the returned service identifiers and connection tools for setup. Respect recorded user choices; never invent access or ask for credentials in comments.",
  "- If installed tools are Off or the connection is not enabled for this agent, call `connection_request` with the saved connectionId and required toolNames. It creates a scoped human access card; never substitute a generic permission question or change permissions yourself.",
  "- When waiting for user action, finish independent work, then yield without retrying or polling. On continuation, follow the recorded outcome and use the installed connection.",
  "- Do not use connection tools for arbitrary MCP URLs or unrelated work.",
].join("\n");

export const CONNECTIONS_SEARCH_TOOL_DESCRIPTION = "Search connections for setup or missing capability/access across tool, channel/email, and AI purposes, using a service name or description (up to 4000 characters). Results tolerate extra words, split names, and small typos. Use first for an explicit request to connect a service. For ordinary work, use installed tools or search the assigned tool catalog directly; do not preflight catalog-listed apps here. Choose the relevant match and follow its instruction and exact providerQuestion, if any, for connection_request or setupPath. Also discovers verified external aggregator apps. Search is read-only; matches do not grant access. Do not use for arbitrary MCP URLs.";

export const CONNECTION_REQUEST_TOOL_DESCRIPTION = "Request the service identifier returned by connections_search. For an existing connection with missing agent access, pass connectionId and the exact required toolNames to create an embedded Grant access card; only the human can approve it. Follow the search instruction; aggregator routes require the saved provider-selection interaction ID. Only this tool creates the real setup card. If user action is needed, finish independent work, then yield without retrying or asking for credentials in comments.";

export const CONNECTION_RUNTIME_TOOL_NAMES = [
  "connections_search",
  "connection_request",
] as const;
