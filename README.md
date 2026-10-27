# Foundry Analyst

A chat UI that turns a prompt into a dashboard or report, backed by a multi-agent setup on Azure AI Foundry:

- **Orchestrator** agent calls the Microsoft Learn MCP server itself (product and docs questions) and delegates to connected sub-agents:
  - **fabric-data-agent** answers business-data questions through a Microsoft Fabric data agent (optional).
  - **report-builder** returns a schema-validated JSON *artifact* (KPIs, charts, tables, markdown).
- The React UI streams tool calls and text, renders artifacts in a side panel (versioned, editable by follow-up prompt, exportable to PNG/PDF).
- The FastAPI backend translates Foundry run events into server-sent events (SSE) for the UI.

## Run locally (no Azure needed)

```powershell
npm install
cd backend
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt   # macOS/Linux: .venv/bin/pip
cd ..

npm run api:mock   # terminal 1: scripted agents on http://127.0.0.1:8000
npm start          # terminal 2: UI on http://localhost:3000
```

## Run against Foundry

1. Copy `backend/.env.example` to `backend/.env` and set `PROJECT_ENDPOINT` and `MODEL_DEPLOYMENT_NAME`. Set `FABRIC_CONNECTION_ID` for the Fabric sub-agent, or pass `--no-fabric` in step 3 to skip it. `ORCHESTRATOR_MODEL_DEPLOYMENT_NAME` (default `gpt-4.1`) is the orchestrator's model; see "Deploy to Azure" for why it differs.
2. Sign in with `az login` (the backend uses `DefaultAzureCredential`).
3. From `backend/`: `python -m agents.setup_agents [--no-fabric]` creates or updates the agents and writes their IDs to `.env`.
4. Restart the API with `npm run api` (it does not hot-reload `.env`).

## Sharing

The artifact panel's **Share** button sends the artifact (as a PDF) to Teams, email, SharePoint or OneDrive. With `MOCK_AGENTS=1` delivery is simulated and clearly labelled "Demo mode"; set `SHARE_MODE=graph` plus the channel settings in `backend/.env.example` for real delivery. Only configured channels are offered.

| Channel | What happens | Needs |
| --- | --- | --- |
| Teams | Adaptive card with the KPI summary | `TEAMS_WEBHOOK_URL` |
| Email | Summary body plus PDF attachment | `SHARE_EMAIL_SENDER`, Graph `Mail.Send` |
| SharePoint / OneDrive | Uploads the PDF and returns an organization view link | `SHAREPOINT_DRIVE_ID` / `ONEDRIVE_USER`, Graph file permissions |

Delivery runs as the backend's own identity (`DefaultAzureCredential`), not as the signed-in user. Every share is recorded in the audit log (and in memory at `GET /api/shares`). `SHARE_ALLOWED_EMAIL_DOMAINS` restricts email recipients. The Graph and Teams paths are covered by unit tests against a mocked HTTP transport, but have not been run against a real tenant.

## Sign-in and roles

Every API call needs a signed-in user, and what they can do depends on their role:

| Role | Can do |
| --- | --- |
| Viewer | Browse the shared library |
| Analyst | Chat, build artifacts, publish to the library, share, raise events, see Operations |
| Approver | See Operations, approve or reject requests, see Governance |
| Admin | Everything, and unpublish anyone's artifact |

Roles combine (a user can hold several). A signed-in user with no role gets 403 everywhere. Denied attempts are written to the audit log.

- **Demo mode** (`MOCK_AGENTS=1`, or `AUTH_MODE=mock`): you pick a persona (Alice Analyst, Ada Approver, Victor Viewer, Rae Admin) and the UI sends it as an `X-Demo-User` header. **This is not security.** Never expose a server running in this mode.
- **Microsoft Entra ID** (`AUTH_MODE=entra`, the default when agents are real): the SPA signs users in with MSAL and the API validates the bearer token's signature, issuer, audience, and expiry against your tenant's keys. To set it up:
  1. Register one app in Entra ID (single tenant). Add a **Single-page application** redirect URI of `http://localhost:3000` (and your production URL).
  2. Under *Expose an API*, set the Application ID URI to `api://<client-id>` and add a scope named `access_as_user`.
  3. Under *App roles*, create roles with the exact values `Viewer`, `Analyst`, `Approver`, `Admin` (allowed member types: Users).
  4. In *Enterprise applications* for this app, enable "Assignment required" and assign users or groups to roles.
  5. Set `ENTRA_TENANT_ID` and `ENTRA_CLIENT_ID` in `backend/.env`, and restart the API.

Conversations stay in the browser's local storage, kept separately per user. A user can only post to threads they created.

## Shared library

**Publish** (Analyst and up) puts an artifact in the library where every signed-in user, including Viewers, can open it. Publishing the same artifact again creates a new version. Only the publisher or an Admin can unpublish.

## Events, approvals and work orders

Agents can act on events, but a person approves anything that changes the outside world.

1. An anomaly event arrives, either from **Operations → Simulate anomaly** or from a monitor calling `POST /api/events/anomaly` with `{"metric": "...", "scope": "...", "change_pct": 38.5}` and the header `X-Webhook-Secret: <EVENT_WEBHOOK_SECRET>`. Point a Fabric Activator rule, Event Grid subscription, or Logic App at that endpoint.
2. The orchestrator investigates with the Fabric data agent and builds an analysis dashboard.
3. It proposes a **work order**, which waits under *Awaiting approval*. Nothing is created yet.
4. An Approver approves or rejects (with a comment). Only then is the work order sent to `WORK_ORDER_WEBHOOK_URL` (simulated in demo mode).

Set `SHARE_REQUIRES_APPROVAL=1` to put sharing behind the same gate. The requester can't approve their own request unless `ALLOW_SELF_APPROVAL=1`. Requests expire after `APPROVAL_TTL_MINUTES`. Event text is whitespace-collapsed and quoted before it reaches the agent, at most three analyses run at once, and webhook callers are checked with a constant-time secret comparison.

## Governance

The **Governance** page (Approver and Admin) shows 24-hour run counts, failures, average and p95 latency, tool usage, pending and decided approvals, open incidents, and blocked access attempts, plus a filterable audit log of agent runs (who, prompt, tools, duration, outcome), publishes, shares, events, approvals and denials. Set `DATA_DIR` to keep the library, approvals, incidents and audit log across restarts; the audit log keeps its most recent 2000 entries.

## Deploy to Azure

The architecture is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). `infra/demo-users.ps1` creates demo users for each role and `infra/reset-demo.ps1` clears the demo data on the site.

One command deploys everything into a single resource group (default `rg-foundry-analyst` in `centralus`), including the Foundry project and the agents. You need the Azure CLI signed in (`az login`), Node, and Python. For the Fabric sub-agent you also need a published Fabric data agent (the GUIDs in its URL: `.../groups/<workspace-id>/aiskills/<artifact-id>`); without one, pass `-SkipFabric`.

```powershell
./infra/deploy.ps1 -FabricWorkspaceId <guid> -FabricArtifactId <guid>
./infra/deploy.ps1 -SkipFabric                       # Foundry + orchestrator + report-builder, no Fabric
./infra/deploy.ps1 -SkipFabric -Assign 'ada@contoso.com:Approver','victor@contoso.com:Viewer'
./infra/deploy.ps1 -MockAgents 1                     # scripted demo agents, no Foundry or Fabric needed
```

It will:

1. Refuse to continue if the subscription is not `Enabled` (a disabled subscription is read-only).
2. Create or update the Entra app registration (`infra/entra.ps1`): SPA redirect URIs, the `access_as_user` scope, the four app roles, "assignment required", and assign you the Admin role. Use `-ClientId <app-id>` to reuse an existing registration instead, or `-ServiceManagementReference <guid>` if your tenant requires a Service Tree ID on new registrations.
3. Check you have quota for both models in the Foundry region.
4. Build the web app and package it with the backend (`infra/package.py`).
5. Deploy `infra/main.bicep`: a Linux App Service (B1, Always On, HTTPS only, TLS 1.2, FTPS off, health check at `/api/health`) that serves both the API and the web app, plus a Log Analytics workspace with the App Service logs and metrics. It also deploys `infra/foundry.bicep`: a Foundry resource (Entra-only, no keys), a project, the `gpt-5.4` and `gpt-4.1` deployments, a project connection to your Fabric data agent (unless `-SkipFabric`), and the *Foundry User* role (formerly *Azure AI User*) on the project for the web app's managed identity and for you.
6. Create or update the agents with `backend/agents/setup_agents.py`: `orchestrator` (with the Learn MCP tool) plus the sub-agents `report-builder` and, with Fabric, `fabric-data-agent`. It waits for the role assignment to propagate, then sets `ORCHESTRATOR_AGENT_ID` and `REPORT_BUILDER_AGENT_ID` on the web app.
7. Zip-deploy the package, wait for health, and check that sign-in is in Entra mode.

Notes:
- The site is `https://foundry-analyst-<hash>.azurewebsites.net`; the Foundry resource is `foundry-analyst-<hash>-ai`. Names are derived from the subscription and resource group, so re-running updates in place (agents are upserted by name).
- **Two models:** the sub-agents run on `-ModelName` (default `gpt-5.4`), but the orchestrator runs on `-OrchestratorModelName` (default `gpt-4.1`). Tested against this API version: an agent with the Microsoft Learn MCP tool fails with `server_error` on `gpt-5.4`, and a sub-agent cannot run an MCP tool at all because the approval step cannot be surfaced from a sub-agent run. Other options: `-FoundryLocation`, `-ModelVersion`, `-ModelCapacity`, `-OrchestratorModelVersion`, `-OrchestratorModelCapacity` (thousands of tokens per minute).
- With no Fabric data source, the orchestrator tells users to paste data for dashboards and never invents figures. Docs questions and dashboards built from pasted data work.
- With real agents, sharing follows `SHARE_MODE` (graph) instead of the simulated delivery, so no share channels appear until you configure them in the App Service settings (see `backend/.env.example`).
- **Fabric data agent tool retirement:** Microsoft is retiring the Fabric data agent tool in Foundry Agent Service on 2026-11-06 in favour of Fabric IQ. This template uses the current tool; plan a migration. The tool also runs queries as the calling identity, so confirm the web app's managed identity has access to the Fabric data agent and its data. The Fabric path is not tested end to end.
- The library, approvals, incidents and audit log are stored under `/home/data`, which persists on App Service. Run a single instance (the default).
- The event webhook secret is generated once and printed once; it is kept as an app setting.
- To remove everything: `az group delete -n rg-foundry-analyst`. The Entra app is separate (`az ad app delete --id <client-id>`).

## Tests

```powershell
npm test -- --run                      # frontend (Vitest)
cd backend; .venv\Scripts\python -m pytest   # backend
```

## Layout

| Path | Purpose |
| --- | --- |
| `src/` | React UI (chat, artifacts panel, chart/table/KPI blocks) |
| `backend/app/main.py` | FastAPI app and SSE endpoint |
| `backend/app/agent_stream.py` | Foundry stream to UI event translation; cancels abandoned runs |
| `backend/app/artifact_schema.py` | Pydantic schema for artifacts (also given to the report-builder agent) |
| `backend/app/sharing.py` | Share-to-Teams/email/SharePoint/OneDrive providers, validation and share log |
| `backend/app/auth.py` | Roles, permissions, Entra token validation, demo personas |
| `backend/app/approvals.py`, `incidents.py`, `library.py`, `audit.py`, `stores.py` | Approvals, event-driven incidents, shared library, audit log and their persistence |
| `backend/app/mock_stream.py` | Scripted agents for `MOCK_AGENTS=1` |
| `backend/agents/setup_agents.py` | Provisions the Foundry agents (run by `deploy.ps1`, or by hand for local dev) |
| `scripts/api.mjs` | Cross-platform API launcher used by `npm run api` / `api:mock` |
| `infra/` | Bicep templates (`main.bicep`, `foundry.bicep`), Entra app setup, packaging and the one-command `deploy.ps1` |
