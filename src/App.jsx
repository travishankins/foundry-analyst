import { useCallback, useEffect, useState } from 'react';
import './App.css';
import ArtifactsPanel from './components/ArtifactsPanel';
import ChatView from './components/ChatView';
import GovernanceView from './components/GovernanceView';
import LibraryView from './components/LibraryView';
import OperationsView from './components/OperationsView';
import Sidebar from './components/Sidebar';
import { useAgentStream } from './hooks/useAgentStream';
import { useConversations } from './hooks/useConversations';
import { publishArtifact } from './lib/api';

function App({ session }) {
  const { conversations, active, create, select, startNew, update, rename, remove } = useConversations(session.user.id);
  const [view, setView] = useState(session.can('chat') ? 'chat' : 'library');
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
        onNew={() => {
          setView('chat');
          startNew();
        }}
        onSelect={select}
        onRename={rename}
        onDelete={remove}
        collapsed={sidebarCollapsed}
        onToggle={() => setSidebarCollapsed((c) => !c)}
        view={view}
        onView={setView}
        session={session}
      />
      {view === 'chat' && (
        <>
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
              canShare={session.can('share')}
              onPublish={session.can('publish') ? (artifact) => publishArtifact(artifact) : undefined}
            />
          )}
        </>
      )}
      {view === 'library' && <LibraryView session={session} />}
      {view === 'operations' && <OperationsView session={session} />}
      {view === 'governance' && <GovernanceView />}
    </div>
  );
}

export default App;
