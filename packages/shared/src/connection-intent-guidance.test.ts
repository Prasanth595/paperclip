import { describe, expect, it } from "vitest";
import { CONNECTION_INTENT_AGENT_GUIDANCE, CONNECTION_REQUEST_TOOL_DESCRIPTION, CONNECTION_RUNTIME_TOOL_NAMES, CONNECTIONS_SEARCH_TOOL_DESCRIPTION } from "./connection-intent-guidance.js";
describe("connection result guidance", () => {
  it("delegates route decisions to trusted tool output instead of a provider decision tree", () => {
    expect(CONNECTION_INTENT_AGENT_GUIDANCE).toContain("follow the returned `instruction`");
    expect(CONNECTION_INTENT_AGENT_GUIDANCE).toContain("Respect recorded user choices");
    expect(CONNECTION_INTENT_AGENT_GUIDANCE).not.toMatch(/Composio|Arcade|Executor|Zapier/);
    expect(CONNECTION_INTENT_AGENT_GUIDANCE).not.toMatch(/https?:\/\/|bearer/);
  });
  it("retains waiting, credential, and arbitrary URL boundaries", () => {
    expect(CONNECTION_INTENT_AGENT_GUIDANCE).toContain("yield without retrying or polling");
    expect(CONNECTION_INTENT_AGENT_GUIDANCE).toContain("never invent access or ask for credentials in comments");
    expect(CONNECTION_INTENT_AGENT_GUIDANCE).toContain("arbitrary MCP URLs");
  });
  it("describes exact questions and saved selection proof", () => {
    expect(CONNECTIONS_SEARCH_TOOL_DESCRIPTION).toContain("exact providerQuestion");
    expect(CONNECTION_REQUEST_TOOL_DESCRIPTION).toContain("saved provider-selection interaction ID");
    expect(CONNECTION_RUNTIME_TOOL_NAMES).toEqual(["connections_search","connection_request"]);
  });

  it("separates assigned-catalog discovery from explicit connection setup without granting access", () => {
    expect(CONNECTION_INTENT_AGENT_GUIDANCE).toContain("When the user asks to connect a service, call `connections_search` before any service tool");
    expect(CONNECTION_INTENT_AGENT_GUIDANCE).toContain("For ordinary work, use installed tools or search the assigned tool catalog directly");
    expect(CONNECTION_INTENT_AGENT_GUIDANCE).toContain("Missing inline schemas do not mean missing access");
    expect(CONNECTION_INTENT_AGENT_GUIDANCE).toContain("Use connection tools if the needed capability or access is missing");
    expect(CONNECTION_INTENT_AGENT_GUIDANCE).toContain("Tool execution still checks current permissions and approvals");
    expect(CONNECTIONS_SEARCH_TOOL_DESCRIPTION).toContain("Use first for an explicit request to connect a service");
    expect(CONNECTIONS_SEARCH_TOOL_DESCRIPTION).toContain("do not preflight catalog-listed apps here");
    expect(CONNECTIONS_SEARCH_TOOL_DESCRIPTION).toContain("matches do not grant access");
    expect(CONNECTION_REQUEST_TOOL_DESCRIPTION).toContain("only the human can approve it");
  });
});
