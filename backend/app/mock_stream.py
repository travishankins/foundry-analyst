"""Scripted stand-in for the orchestrator so the UI can run without Azure (MOCK_AGENTS=1)."""

import json
import time
from collections.abc import Iterator

from .artifact_schema import artifact_adapter

SALES = [
    {"month": "Jul", "north": 182000, "south": 141000, "west": 120500},
    {"month": "Aug", "north": 195500, "south": 150200, "west": 128900},
    {"month": "Sep", "north": 210300, "south": 149800, "west": 141700},
]
CATEGORIES = [["Bikes", 612400, 0.31], ["Components", 241900, 0.22], ["Clothing", 98700, 0.38], ["Accessories", 66400, 0.44]]


def _dashboard(chart_type: str, with_margin: bool) -> dict:
    kpis = [
        {"type": "kpi", "label": "Revenue (Q3)", "value": "$1.42M", "delta": "+8.6% QoQ", "trend": "up"},
        {"type": "kpi", "label": "Orders", "value": "3,918", "delta": "+4.1%", "trend": "up"},
        {"type": "kpi", "label": "Avg order value", "value": "$362", "delta": "+4.3%", "trend": "up"},
    ]
    if with_margin:
        kpis.append({"type": "kpi", "label": "Gross margin", "value": "29.4%", "delta": "-0.6 pts", "trend": "down"})
    return {
        "artifact_id": "q3-sales-dashboard",
        "title": "Q3 Sales Dashboard",
        "kind": "dashboard",
        "blocks": [
            {"type": "grid", "columns": len(kpis), "blocks": kpis},
            {"type": "grid", "columns": 2, "blocks": [
                {"type": "chart", "title": "Revenue by region", "chart_type": chart_type, "x_key": "month",
                 "series": [{"key": "north", "label": "North"}, {"key": "south", "label": "South"}, {"key": "west", "label": "West"}],
                 "data": SALES},
                {"type": "chart", "title": "Revenue share by category", "chart_type": "pie", "x_key": "category",
                 "series": [{"key": "revenue"}],
                 "data": [{"category": c, "revenue": r} for c, r, _ in CATEGORIES]},
            ]},
            {"type": "table", "title": "Category performance", "columns": ["Category", "Revenue", "Margin"],
             "rows": [[c, r, m] for c, r, m in CATEGORIES]},
        ],
    }


def _report() -> dict:
    return {
        "artifact_id": "q3-executive-report",
        "title": "Q3 Executive Sales Report",
        "kind": "report",
        "blocks": [
            {"type": "markdown", "content": "## Summary\nRevenue grew **8.6%** quarter over quarter, led by the North region. "
                                            "Bikes remain the largest category while Accessories carry the highest margin."},
            {"type": "chart", "title": "Monthly revenue by region", "chart_type": "area", "x_key": "month",
             "series": [{"key": "north", "label": "North"}, {"key": "south", "label": "South"}, {"key": "west", "label": "West"}],
             "data": SALES},
            {"type": "markdown", "content": "## Recommendations\n1. Expand Accessories bundles with bike sales.\n"
                                            "2. Use a [Fabric data agent](https://learn.microsoft.com/fabric/data-science/concept-data-agent) "
                                            "for self-serve regional drill-downs."},
        ],
    }


def _tool(call_id: str, kind: str, name: str, arguments: str, output: str) -> Iterator[dict]:
    yield {"type": "tool_call", "id": call_id, "kind": kind, "name": name, "status": "in_progress"}
    time.sleep(0.6)
    yield {"type": "tool_call", "id": call_id, "kind": kind, "name": name, "status": "completed",
           "arguments": arguments, "output": output}


def _text(text: str) -> Iterator[dict]:
    for word in text.split(" "):
        time.sleep(0.03)
        yield {"type": "text_delta", "text": word + " "}


def mock_run(content: str, artifact_context: dict | None) -> Iterator[dict]:
    lower = content.lower()
    yield {"type": "run_status", "status": "in_progress", "run_id": "run_mock"}

    table = "| month | north | south | west |\n|---|---|---|---|\n" + "\n".join(
        f"| {r['month']} | {r['north']} | {r['south']} | {r['west']} |" for r in SALES)
    wants_artifact = artifact_context or any(k in lower for k in ("dashboard", "report", "chart", "visual"))
    wants_docs = any(k in lower for k in ("doc", "learn", "how do i", "best practice", "link"))

    if not artifact_context:
        yield from _tool("call_fabric", "connected_agent", "fabric_data",
                         json.dumps({"query": "Revenue by month and region, last quarter"}), table)
    if wants_docs:
        yield from _tool("call_docs", "connected_agent", "docs_mcp",
                         json.dumps({"query": content[:200]}),
                         "See https://learn.microsoft.com/fabric/data-science/concept-data-agent")

    if wants_artifact:
        if artifact_context:
            spec = _dashboard("line" if "line" in lower else "bar", with_margin="margin" in lower or "kpi" in lower)
            spec["artifact_id"] = artifact_context.get("artifact_id", spec["artifact_id"])
        else:
            spec = _report() if "report" in lower else _dashboard("bar", with_margin=False)
        artifact = artifact_adapter.validate_python(spec)
        yield from _tool("call_report", "connected_agent", "report_builder",
                         json.dumps({"request": content[:200]}), json.dumps(spec))
        yield {"type": "artifact", "artifact": artifact.model_dump(mode="json", exclude_none=True)}
        yield from _text(f"I've {'updated' if artifact_context else 'created'} **{artifact.title}** "
                         "in the artifacts panel. North led Q3 revenue growth, and Bikes remain the largest category.")
    elif wants_docs:
        yield from _text("Per Microsoft Learn, you add a Fabric data agent to Foundry through a Microsoft Fabric "
                         "connection, then attach the Fabric tool to your agent.")
    else:
        yield from _text("North was the top region last quarter at **$587.8K**, followed by South ($441.0K) and West ($391.1K).")

    yield {"type": "run_status", "status": "completed", "run_id": "run_mock"}
