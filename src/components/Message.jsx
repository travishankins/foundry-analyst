import ArtifactCard from './ArtifactCard';
import Markdown from './Markdown';
import ToolCallBlock from './ToolCallBlock';

export default function Message({ message, openArtifact, onOpenArtifact }) {
  if (message.role === 'user') {
    return (
      <div className="message user">
        {message.editing && <div className="editing-tag">Editing: {message.editing}</div>}
        <div className="bubble">{message.content}</div>
      </div>
    );
  }

  const thinking = message.pending && !message.content && message.toolCalls.length === 0;

  return (
    <div className="message assistant">
      <div className="avatar" aria-hidden="true">✳</div>
      <div className="assistant-body">
        {message.toolCalls.map((call) => (
          <ToolCallBlock key={call.id} call={call} />
        ))}
        {thinking && <div className="thinking">Thinking<span className="dots" /></div>}
        {message.content && <Markdown>{message.content}</Markdown>}
        {message.pending && message.content && <span className="cursor" aria-hidden="true" />}
        {message.artifacts.map((ref) => (
          <ArtifactCard
            key={`${ref.artifactId}-${ref.version}`}
            refInfo={ref}
            active={openArtifact?.artifactId === ref.artifactId && openArtifact?.version === ref.version}
            onOpen={() => onOpenArtifact(ref.artifactId, ref.version)}
          />
        ))}
        {message.error && <div className="message-error" role="alert">{message.error}</div>}
      </div>
    </div>
  );
}
