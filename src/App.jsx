import { useCallback, useEffect, useState } from 'react';
import './App.css';
import ArtifactsPanel from './components/ArtifactsPanel';
import ChatView from './components/ChatView';
import Sidebar from './components/Sidebar';
import { useAgentStream } from './hooks/useAgentStream';
import { useConversations } from './hooks/useConversations';

function App() {
  const { conversations, active, create, select, startNew, update, rename, remove } = useConversations();
  const [openArtifact, setOpenArtifact] = useState(null);
  const [editDismissed, setEditDismissed] = useState(false);
  const [panelWidth, setPanelWidth] = useState(() => Math.round(window.innerWidth * 0.45));
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  const onArtifact = useCallback((artifactId) => {
    setOpenArtifact({ artifactId, version: null });
    setEditDismissed(false);
  }, []);

  const { send, stop, streamingId } = useAgentStream({ create, update, onArtifact });

  const activeId = active?.id;
  useEffect(() => setOpenArtifact(null), [activeId]);

  const versions = (openArtifact && active?.artifacts[openArtifact.artifactId]) || [];
  const version = openArtifact?.version ?? versions.length;
  const current = versions[version - 1];
  const editing = current && !editDismissed ? current : null;

  const handleSend = (text) => send(active, text, editing ?? undefined);

  return (
    <div className="app">
      <Sidebar
        conversations={conversations}
        activeId={activeId}
        onNew={startNew}
        onSelect={select}
        onRename={rename}
        onDelete={remove}
        collapsed={sidebarCollapsed}
        onToggle={() => setSidebarCollapsed((c) => !c)}
      />
      <ChatView
        conversation={active}
        streaming={streamingId !== null}
        onSend={handleSend}
        onStop={stop}
        openArtifact={current ? { artifactId: current.artifact_id, version } : null}
        onOpenArtifact={(artifactId, v) => {
          setOpenArtifact({ artifactId, version: v });
          setEditDismissed(false);
        }}
        editing={editing?.title}
        onCancelEdit={() => setEditDismissed(true)}
      />
      {current && (
        <ArtifactsPanel
          versions={versions}
          version={version}
          onSelectVersion={(v) => setOpenArtifact((o) => ({ ...o, version: v }))}
          onClose={() => setOpenArtifact(null)}
          width={panelWidth}
          onResize={setPanelWidth}
        />
      )}
    </div>
  );
}

export default App;
