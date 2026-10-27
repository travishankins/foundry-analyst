import os
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv

ENV_PATH = Path(__file__).resolve().parent.parent / ".env"
load_dotenv(ENV_PATH)


def _flag(name: str) -> bool:
    return os.getenv(name, "").strip().lower() in {"1", "true", "yes"}


@dataclass(frozen=True)
class Settings:
    project_endpoint: str = os.getenv("PROJECT_ENDPOINT", "")
    model_deployment: str = os.getenv("MODEL_DEPLOYMENT_NAME", "gpt-4.1")
    # The orchestrator owns the Learn MCP tool, which the classic Agents API does not run on the gpt-5 family
    orchestrator_model_deployment: str = os.getenv("ORCHESTRATOR_MODEL_DEPLOYMENT_NAME", "gpt-4.1")
    fabric_connection_id: str = os.getenv("FABRIC_CONNECTION_ID", "")
    mcp_server_url: str = os.getenv("MCP_SERVER_URL", "https://learn.microsoft.com/api/mcp")
    mcp_server_label: str = os.getenv("MCP_SERVER_LABEL", "microsoft_learn")
    orchestrator_agent_id: str = os.getenv("ORCHESTRATOR_AGENT_ID", "")
    report_builder_agent_id: str = os.getenv("REPORT_BUILDER_AGENT_ID", "")
    mock_agents: bool = _flag("MOCK_AGENTS")
    # "mock" simulates delivery; "graph" calls Microsoft Graph / a Teams webhook. Defaults to mock when agents are mocked.
    share_mode: str = os.getenv("SHARE_MODE", "").strip().lower()
    teams_webhook_url: str = os.getenv("TEAMS_WEBHOOK_URL", "")
    graph_sender: str = os.getenv("SHARE_EMAIL_SENDER", "")
    sharepoint_drive_id: str = os.getenv("SHAREPOINT_DRIVE_ID", "")
    sharepoint_folder: str = os.getenv("SHAREPOINT_FOLDER", "Foundry Analyst")
    onedrive_user: str = os.getenv("ONEDRIVE_USER", "")
    share_allowed_email_domains: tuple[str, ...] = tuple(
        d.strip().lower() for d in os.getenv("SHARE_ALLOWED_EMAIL_DOMAINS", "").split(",") if d.strip()
    )
    # "mock" = demo personas picked in the UI (no real security); "entra" = validate Microsoft Entra ID bearer tokens.
    # Defaults to mock when agents are mocked, otherwise entra.
    auth_mode: str = os.getenv("AUTH_MODE", "").strip().lower()
    entra_tenant_id: str = os.getenv("ENTRA_TENANT_ID", "")
    entra_client_id: str = os.getenv("ENTRA_CLIENT_ID", "")
    data_dir: str = os.getenv("DATA_DIR", "")
    share_requires_approval: bool = _flag("SHARE_REQUIRES_APPROVAL")
    approval_ttl_minutes: int = int(os.getenv("APPROVAL_TTL_MINUTES", "60"))
    allow_self_approval: bool = _flag("ALLOW_SELF_APPROVAL")
    event_webhook_secret: str = os.getenv("EVENT_WEBHOOK_SECRET", "")
    work_order_webhook_url: str = os.getenv("WORK_ORDER_WEBHOOK_URL", "")
    allowed_origins: list[str] = field(
        default_factory=lambda: [
            o.strip() for o in os.getenv("ALLOWED_ORIGINS", "http://localhost:3000").split(",") if o.strip()
        ]
    )

    @property
    def effective_share_mode(self) -> str:
        return self.share_mode or ("mock" if self.mock_agents else "graph")

    @property
    def effective_auth_mode(self) -> str:
        return self.auth_mode or ("mock" if self.mock_agents else "entra")


settings = Settings()
