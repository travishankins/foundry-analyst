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
    fabric_connection_id: str = os.getenv("FABRIC_CONNECTION_ID", "")
    mcp_server_url: str = os.getenv("MCP_SERVER_URL", "https://learn.microsoft.com/api/mcp")
    mcp_server_label: str = os.getenv("MCP_SERVER_LABEL", "microsoft_learn")
    orchestrator_agent_id: str = os.getenv("ORCHESTRATOR_AGENT_ID", "")
    report_builder_agent_id: str = os.getenv("REPORT_BUILDER_AGENT_ID", "")
    mock_agents: bool = _flag("MOCK_AGENTS")
    allowed_origins: list[str] = field(
        default_factory=lambda: [
            o.strip() for o in os.getenv("ALLOWED_ORIGINS", "http://localhost:3000").split(",") if o.strip()
        ]
    )


settings = Settings()
