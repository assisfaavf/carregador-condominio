function App() {
  return (
    <main className="min-h-screen bg-background-light p-8 text-slate-900 dark:bg-background-dark dark:text-white">
      <div className="mx-auto max-w-2xl rounded-xl border border-white/10 bg-background-dark p-8 text-white shadow-lg">
        <h1 className="text-primary font-display text-4xl">
          Teste Tailwind Stitch
        </h1>
        <p className="mt-4">
          Fundo com <code>bg-background-dark</code> e texto com{' '}
          <code>text-white</code> no modo escuro.
        </p>
      </div>
      <p className="mx-auto mt-6 max-w-2xl text-sm opacity-80">
        Exemplo solicitado: <code>text-primary font-display</code>.
      </p>
    </main>
  )
}

export default App
