export function App() {
  const { electron, chrome } = window.omp.versions;
  return (
    <main className="flex h-screen flex-col items-center justify-center gap-2 bg-surface font-sans text-text">
      <h1 className="text-2xl text-text-muted">omp-app</h1>
      <p data-testid="bridge-versions" className="text-sm text-text-muted">
        electron {electron} · chrome {chrome}
      </p>
    </main>
  );
}
