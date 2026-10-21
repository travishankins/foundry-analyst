import json
import re
from typing import Annotated, Literal, Union

from pydantic import BaseModel, Field, TypeAdapter

Scalar = Union[str, float, int, bool, None]


class KpiBlock(BaseModel):
    type: Literal["kpi"]
    label: str
    value: str
    delta: str | None = None
    trend: Literal["up", "down", "flat"] | None = None


class Series(BaseModel):
    key: str
    label: str | None = None


class ChartBlock(BaseModel):
    type: Literal["chart"]
    title: str
    chart_type: Literal["line", "bar", "area", "pie"]
    x_key: str
    series: list[Series] = Field(min_length=1)
    data: list[dict[str, Scalar]] = Field(max_length=500)


class TableBlock(BaseModel):
    type: Literal["table"]
    title: str | None = None
    columns: list[str] = Field(min_length=1)
    rows: list[list[Scalar]] = Field(max_length=500)


class MarkdownBlock(BaseModel):
    type: Literal["markdown"]
    content: str


class GridBlock(BaseModel):
    type: Literal["grid"]
    columns: int = Field(ge=1, le=4)
    blocks: list["Block"]


Block = Annotated[
    Union[KpiBlock, ChartBlock, TableBlock, MarkdownBlock, GridBlock],
    Field(discriminator="type"),
]
GridBlock.model_rebuild()


class Artifact(BaseModel):
    artifact_id: str = Field(pattern=r"^[a-z0-9][a-z0-9-]{0,63}$")
    title: str
    kind: Literal["dashboard", "report"]
    blocks: list[Block] = Field(min_length=1)


artifact_adapter = TypeAdapter(Artifact)

_FENCE = re.compile(r"```(?:json)?\s*(\{.*\})\s*```", re.DOTALL)


def artifact_json_schema() -> dict:
    return Artifact.model_json_schema()


def parse_artifact(text: str) -> Artifact:
    """Parse agent output that may wrap the JSON in a code fence or prose."""
    match = _FENCE.search(text)
    if match:
        candidate = match.group(1)
    else:
        start, end = text.find("{"), text.rfind("}")
        if start == -1 or end <= start:
            raise ValueError("No JSON object found in report-builder output")
        candidate = text[start : end + 1]
    return artifact_adapter.validate_python(json.loads(candidate))
