"""Create or update the demo agents in Foundry. Run from backend/: python -m agents.setup_agents [--json] [--no-fabric]

--json prints the agent IDs as one JSON line instead of writing them to .env (used by infra/deploy.ps1).
--no-fabric skips the Fabric sub-agent and needs no FABRIC_CONNECTION_ID."""

import json
import sys

from azure.ai.agents import AgentsClient
from azure.ai.agents.models import (
    ConnectedAgentTool,
    FabricTool,
    McpTool,
    ResponseFormatJsonSchema,
    ResponseFormatJsonSchemaType,
)
from azure.identity import DefaultAzureCredential
from dotenv import set_key

from app.artifact_schema import artifact_json_schema
from app.settings import ENV_PATH, settings

FABRIC_AGENT = "fabric-data-agent"
REPORT_AGENT = "report-builder"
ORCHESTRATOR = "orchestrator"
# Earlier versions created this sub-agent. The Learn MCP tool needs an approval step that a sub-agent run cannot
# surface (and "never require approval" is not stored on the agent), so the orchestrator now owns the MCP tool.
OBSOLETE_AGENTS = ("docs-mcp-agent",)

FABRIC_INSTRUCTIONS = """You answer business data questions using the Microsoft Fabric data agent tool.
Always call the Fabric tool; never invent numbers.
Return aggregated results only (at most 200 rows) as a markdown table, followed by one sentence
describing the query scope (filters, time range). If the tool fails, say so plainly."""

REPORT_INSTRUCTIONS = f"""You turn data into a dashboard or report artifact.
Output ONLY a JSON object matching the provided schema, no prose.
Rules:
- Use only the data you were given; never invent values.
- artifact_id: lowercase kebab-case slug. If you were given an existing artifact to edit,
  keep its artifact_id and return the full updated artifact.
- kind "dashboard": lead with a grid of kpi blocks, then charts, then a table.
- kind "report": markdown narrative sections interleaved with charts/tables.
- chart data rows are objects keyed by x_key and each series key; numbers must be numeric.
- Keep at most 500 rows per chart/table.
Schema:
{json.dumps(artifact_json_schema())}"""

ORCHESTRATOR_INSTRUCTIONS = """You are the orchestrator for an analytics assistant. Delegate; do not answer data questions yourself.
- Business/sales/inventory data questions -> fabric_data.
- Microsoft product, Foundry or Fabric documentation questions -> call the Microsoft Learn MCP tools
  yourself and always include the source URLs.
- When the user asks for a dashboard, chart, visualization or report: first get the data from fabric_data,
  then call report_builder passing the user's request AND the full data table you received.
- When the message includes a "Current artifact" JSON block, pass that JSON verbatim to report_builder
  together with the requested change.
- After report_builder returns, do NOT repeat the JSON. Reply with a short summary of what the
  artifact shows; the UI displays the artifact itself.
- Combine results when a question spans data and documentation."""

# Used when no Fabric data agent is connected (deploy.ps1 -SkipFabric)
ORCHESTRATOR_INSTRUCTIONS_NO_FABRIC = """You are the orchestrator for an analytics assistant. Delegate; do not answer questions yourself.
No business data source is connected, so never invent figures.
- Microsoft product, Foundry or Fabric documentation questions -> call the Microsoft Learn MCP tools
  yourself and always include the source URLs.
- When the user asks for a dashboard, chart, visualization or report: if their message contains the data,
  call report_builder passing the request AND that data. Otherwise tell them no data source is connected
  and ask them to paste the data.
- When the message includes a "Current artifact" JSON block, pass that JSON verbatim to report_builder
  together with the requested change.
- After report_builder returns, do NOT repeat the JSON. Reply with a short summary of what the
  artifact shows; the UI displays the artifact itself."""


def upsert(client: AgentsClient, existing: dict, name: str, **kwargs):
    if name in existing:
        agent = client.update_agent(existing[name].id, name=name, **kwargs)
        print(f"updated {name}: {agent.id}")
    else:
        agent = client.create_agent(name=name, **kwargs)
        print(f"created {name}: {agent.id}")
    return agent


def main(emit_json: bool = False, with_fabric: bool = True) -> None:
    required = {"PROJECT_ENDPOINT": settings.project_endpoint}
    if with_fabric:
        required["FABRIC_CONNECTION_ID"] = settings.fabric_connection_id
    missing = [k for k, v in required.items() if not v]
    if missing:
        sys.exit(f"Missing settings in {ENV_PATH}: {', '.join(missing)}")

    model = settings.model_deployment
    with AgentsClient(endpoint=settings.project_endpoint, credential=DefaultAzureCredential()) as client:
        existing = {a.name: a for a in client.list_agents()}

        fabric_agent = None
        if with_fabric:
            fabric = FabricTool(connection_id=settings.fabric_connection_id)
            fabric_agent = upsert(
                client, existing, FABRIC_AGENT,
                model=model, instructions=FABRIC_INSTRUCTIONS, tools=fabric.definitions,
            )

        mcp = McpTool(server_label=settings.mcp_server_label, server_url=settings.mcp_server_url)
        # The app auto-approves calls to this read-only server while streaming the orchestrator run (see agent_stream.py)
        mcp.set_approval_mode("never")

        report_agent = upsert(
            client, existing, REPORT_AGENT,
            model=model,
            instructions=REPORT_INSTRUCTIONS,
            temperature=0.2,
            response_format=ResponseFormatJsonSchemaType(
                json_schema=ResponseFormatJsonSchema(
                    name="artifact",
                    description="Dashboard or report artifact",
                    schema=artifact_json_schema(),
                )
            ),
        )

        connected = []
        if fabric_agent:
            connected.append(ConnectedAgentTool(
                id=fabric_agent.id, name="fabric_data",
                description="Answers business data questions from the Fabric Lakehouse (sales, products, customers, inventory)."))
        connected.append(ConnectedAgentTool(
            id=report_agent.id, name="report_builder",
            description="Builds or edits a dashboard/report artifact (JSON) from provided data and a request."))
        orchestrator = upsert(
            client, existing, ORCHESTRATOR,
            model=settings.orchestrator_model_deployment,
            instructions=ORCHESTRATOR_INSTRUCTIONS if with_fabric else ORCHESTRATOR_INSTRUCTIONS_NO_FABRIC,
            tools=[*mcp.definitions, *(d for t in connected for d in t.definitions)],
            tool_resources=mcp.resources,
        )

        for name in OBSOLETE_AGENTS:
            if name in existing:
                client.delete_agent(existing[name].id)
                print(f"deleted obsolete {name}: {existing[name].id}")

    ids = {
        "FABRIC_AGENT_ID": fabric_agent.id if fabric_agent else "",
        "REPORT_BUILDER_AGENT_ID": report_agent.id,
        "ORCHESTRATOR_AGENT_ID": orchestrator.id,
    }
    if emit_json:
        # deploy.ps1 sets the IDs on the web app itself, so leave the local .env alone
        print(json.dumps(ids))
        return

    ENV_PATH.touch(exist_ok=True)
    for key, value in ids.items():
        set_key(str(ENV_PATH), key, value)
    print(f"Agent IDs written to {ENV_PATH}")


if __name__ == "__main__":
    main(emit_json="--json" in sys.argv[1:], with_fabric="--no-fabric" not in sys.argv[1:])
