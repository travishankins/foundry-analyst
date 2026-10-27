import { Component } from 'react';
import ChartBlock from './blocks/ChartBlock';
import DataTable from './blocks/DataTable';
import KpiCard from './blocks/KpiCard';
import Markdown from './Markdown';

// Model-generated blocks can be malformed; contain the failure to that block instead of blanking the app
class BlockBoundary extends Component {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error) {
    console.error('Artifact block failed to render', error);
  }

  render() {
    if (this.state.failed) return <div className="unknown-block">This block could not be rendered.</div>;
    return this.props.children;
  }
}

function Block({ block }) {
  return (
    <BlockBoundary>
      <BlockContent block={block} />
    </BlockBoundary>
  );
}

function BlockContent({ block }) {
  switch (block?.type) {
    case 'kpi':
      return <KpiCard block={block} />;
    case 'chart':
      return <ChartBlock block={block} />;
    case 'table':
      return <DataTable block={block} />;
    case 'markdown':
      return <Markdown>{block.content}</Markdown>;
    case 'grid':
      return (
        <div className="grid-block" style={{ '--cols': Math.min(Math.max(block.columns || 1, 1), 4) }}>
          {(block.blocks ?? []).map((child, i) => (
            <Block key={i} block={child} />
          ))}
        </div>
      );
    default:
      return <div className="unknown-block">Unsupported block: {String(block?.type)}</div>;
  }
}

export default function ArtifactRenderer({ artifact }) {
  return (
    <article className={`artifact-doc kind-${artifact.kind}`}>
      <h1>{artifact.title}</h1>
      {(artifact.blocks ?? []).map((block, i) => (
        <Block key={i} block={block} />
      ))}
    </article>
  );
}
