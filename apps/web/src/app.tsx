import { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import ForceGraph3D from 'react-force-graph-3d';

interface GraphNode {
  id: string;
  kind: string;
  name: string;
  [key: string]: unknown;
}

interface GraphEdge {
  source: string;
  target: string | null;
  kind: string;
  [key: string]: unknown;
}

interface StatusData {
  nodeCount: number;
  edgeCount: number;
  fileCount: number;
}

function App() {
  const [status, setStatus] = useState<StatusData | null>(null);
  const [graphData, setGraphData] = useState<{ nodes: GraphNode[]; links: GraphEdge[] } | null>(null);

  useEffect(() => {
    fetch('/api/status')
      .then((r) => r.json())
      .then((result) => {
        setStatus(result.data as StatusData);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetch('/api/graph')
      .then((r) => r.json())
      .then((result) => {
        const data = result.data as { nodes: GraphNode[]; edges: GraphEdge[] };
        setGraphData({
          nodes: data.nodes,
          links: data.edges.filter((e) => e.target !== null) as GraphEdge[],
        });
      })
      .catch(() => {});
  }, []);

  const graph = useMemo(() => {
    if (!graphData) return null;
    return (
      <ForceGraph3D
        graphData={graphData as unknown as Parameters<typeof ForceGraph3D>[0]['graphData']}
        nodeAutoColorBy="kind"
        nodeLabel="name"
        linkDirectionalArrowLength={3}
        linkDirectionalArrowRelPos={1}
        backgroundColor="#0b0d17"
      />
    );
  }, [graphData]);

  return (
    <div className="scene-container">
      <header className="absolute top-0 left-0 right-0 z-10 flex items-center justify-between px-6 py-3 bg-astro-panel/80 backdrop-blur border-b border-astro-border">
        <h1 className="text-lg font-semibold tracking-tight">Astrograph</h1>
        {status && (
          <div className="flex gap-4 text-sm text-gray-300">
            <span>{status.nodeCount} nodes</span>
            <span>{status.edgeCount} edges</span>
            <span>{status.fileCount} files</span>
          </div>
        )}
      </header>
      {graph}
    </div>
  );
}

const rootEl = document.getElementById('root');
if (rootEl) {
  createRoot(rootEl).render(<App />);
}
