import React, { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { PublicNavbar } from '../components/layout/PublicNavbar';
import { Footer } from '../components/layout/Footer';

export const LandingPage = () => {
  const navigate = useNavigate();
  const [repoUrl, setRepoUrl] = useState('https://github.com/shadcn-ui/ui');
  const [branch, setBranch] = useState('main');
  const [sandboxTaps, setSandboxTaps] = useState(0);

  const handleSubmit = (e) => {
    e.preventDefault();
    if (repoUrl.trim()) {
      navigate(`/workspace?repo=${encodeURIComponent(repoUrl)}&branch=${branch}`);
    }
  };

  const handleQuickSelect = (url) => {
    setRepoUrl(url);
  };

  return (
    <div className="min-h-screen bg-dark-surface text-dark-on-surface font-body antialiased flex flex-col selection:bg-accent/30 selection:text-white">
      <PublicNavbar />

      <main className="flex-1">
        {/* Hero Section */}
        <section className="relative pt-16 pb-20 border-b border-border-subtle grid-lines overflow-hidden">
          <div className="max-w-7xl mx-auto px-6">
            {/* Status Notification Pill */}
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-dark-surface-container border border-border-subtle text-xs font-mono text-slate-300 mb-6">
              <span className="w-2 h-2 rounded-full bg-emerald-400"></span>
              <span>WebContainers v2.0 Sandbox Enabled</span>
              <span className="text-slate-500">•</span>
              <Link to="/workspace" className="text-accent hover:underline cursor-pointer">
                Instant zero-install preview →
              </Link>
            </div>

            <div className="max-w-4xl">
              <h1 className="font-headline text-display-lg text-white font-bold tracking-tight mb-4 text-balance">
                GitHub Repositories.{' '}
                <span className="text-transparent bg-clip-text bg-gradient-to-r from-blue-400 to-accent">
                  Instantly.
                </span>{' '}
                Without Installation.
              </h1>
              <p className="text-body-lg text-slate-300 max-w-2xl text-pretty mb-8">
                Paste any public or private GitHub repository URL to inspect files, analyze runtime dependencies, and run full-stack projects in an isolated cloud preview in under 3 seconds.
              </p>

              {/* Interactive GitHub URL Hero Input Card */}
              <div className="bg-dark-surface-container border border-border-strong rounded-xl p-2.5 sm:p-3 shadow-2xl max-w-3xl">
                <form onSubmit={handleSubmit} className="flex flex-col sm:flex-row items-stretch gap-2.5">
                  <div className="relative flex-1 flex items-center">
                    <span className="material-symbols-outlined absolute left-3.5 text-slate-400 text-[20px]">
                      terminal
                    </span>
                    <input
                      type="text"
                      value={repoUrl}
                      onChange={(e) => setRepoUrl(e.target.value)}
                      placeholder="https://github.com/owner/repository"
                      className="w-full bg-[#070A10] border border-border-subtle focus:border-dark-primary focus:ring-1 focus:ring-dark-primary text-white font-mono text-sm pl-11 pr-24 py-3 rounded-lg placeholder:text-slate-600 transition-colors"
                    />
                    <div className="absolute right-3 hidden sm:flex items-center gap-1 text-[11px] font-mono text-slate-500 bg-dark-surface-container px-2 py-0.5 rounded border border-border-subtle">
                      <span>⌘</span>
                      <span>K</span>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <select
                      value={branch}
                      onChange={(e) => setBranch(e.target.value)}
                      className="bg-[#070A10] border border-border-subtle text-slate-300 font-mono text-xs px-3 py-3 rounded-lg focus:border-dark-primary focus:ring-0"
                    >
                      <option value="main">branch: main</option>
                      <option value="next">branch: next</option>
                      <option value="canary">branch: canary</option>
                    </select>

                    <button
                      type="submit"
                      className="flex-1 sm:flex-none inline-flex items-center justify-center gap-2 px-5 py-3 rounded-lg bg-dark-primary hover:bg-blue-500 text-white font-label text-label-lg transition-all duration-state-change shadow-md hover:shadow-blue-500/20 active:scale-[0.99] whitespace-nowrap"
                    >
                      <span className="material-symbols-outlined text-[18px]">play_arrow</span>
                      <span>Preview Repository</span>
                    </button>
                  </div>
                </form>

                {/* Popular Quick Demos */}
                <div className="flex flex-wrap items-center gap-2 mt-3 pt-3 border-t border-border-subtle text-xs text-slate-400">
                  <span className="font-mono text-slate-500">Quick test:</span>
                  <button
                    type="button"
                    onClick={() => handleQuickSelect('https://github.com/shadcn-ui/ui')}
                    className="hover:text-white px-2 py-0.5 rounded bg-dark-surface border border-border-subtle hover:border-slate-500 font-mono text-[11px] transition-colors"
                  >
                    shadcn-ui/ui
                  </button>
                  <button
                    type="button"
                    onClick={() => handleQuickSelect('https://github.com/facebook/react')}
                    className="hover:text-white px-2 py-0.5 rounded bg-dark-surface border border-border-subtle hover:border-slate-500 font-mono text-[11px] transition-colors"
                  >
                    facebook/react
                  </button>
                  <button
                    type="button"
                    onClick={() => handleQuickSelect('https://github.com/vitejs/vite')}
                    className="hover:text-white px-2 py-0.5 rounded bg-dark-surface border border-border-subtle hover:border-slate-500 font-mono text-[11px] transition-colors"
                  >
                    vitejs/vite
                  </button>
                  <button
                    type="button"
                    onClick={() => handleQuickSelect('https://github.com/tailwindlabs/tailwindcss')}
                    className="hover:text-white px-2 py-0.5 rounded bg-dark-surface border border-border-subtle hover:border-slate-500 font-mono text-[11px] transition-colors"
                  >
                    tailwindlabs/tailwindcss
                  </button>
                </div>
              </div>
            </div>

            {/* High-fidelity Mockup Preview Frame */}
            <div className="mt-12 rounded-xl border border-border-strong bg-dark-surface-container overflow-hidden shadow-2xl">
              {/* Window Titlebar */}
              <div className="bg-[#070A10] border-b border-border-subtle px-4 py-2.5 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="w-3 h-3 rounded-full bg-red-500/80 inline-block"></span>
                  <span className="w-3 h-3 rounded-full bg-amber-500/80 inline-block"></span>
                  <span className="w-3 h-3 rounded-full bg-emerald-500/80 inline-block"></span>
                  <span className="text-xs font-mono text-slate-400 ml-2">
                    gitview-preview: shadcn-ui/ui • sandbox-3000 (running)
                  </span>
                </div>
                <div className="flex items-center gap-3 text-xs font-mono">
                  <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded bg-emerald-950/60 border border-emerald-500/30 text-emerald-400">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
                    <span>port 3000 online</span>
                  </span>
                  <Link to="/workspace" className="text-blue-400 hover:text-blue-300 flex items-center gap-1">
                    <span>Enter Full Workspace</span>
                    <span className="material-symbols-outlined text-[14px]">arrow_forward</span>
                  </Link>
                </div>
              </div>

              {/* 3-Pane Mini Layout Showcase */}
              <div className="grid grid-cols-12 divide-x divide-border-subtle h-[380px] bg-[#090D16]">
                {/* Mini File Tree (3 cols) */}
                <div className="col-span-3 p-3 overflow-hidden font-mono text-xs text-slate-300 bg-[#0B0F1A]">
                  <div className="flex items-center justify-between pb-2 mb-2 border-b border-border-subtle text-[11px] text-slate-500">
                    <span>FILES (38)</span>
                    <span className="material-symbols-outlined text-[14px]">unfold_more</span>
                  </div>
                  <div className="space-y-1">
                    <div className="flex items-center gap-1.5 text-slate-400">
                      <span className="material-symbols-outlined text-[15px]">folder_open</span> apps/www
                    </div>
                    <div className="flex items-center gap-1.5 pl-4 text-slate-400">
                      <span className="material-symbols-outlined text-[15px]">folder_open</span> registry/new-york
                    </div>
                    <div className="flex items-center gap-1.5 pl-8 text-blue-400 bg-dark-surface-container py-1 px-1.5 rounded border border-border-subtle font-medium">
                      <span className="text-[11px] text-blue-400 font-bold">TS</span> button.tsx
                    </div>
                    <div className="flex items-center gap-1.5 pl-8 text-slate-400 py-0.5">
                      <span className="text-[11px] text-blue-400 font-bold">TS</span> dialog.tsx
                    </div>
                    <div className="flex items-center gap-1.5 pl-8 text-slate-400 py-0.5">
                      <span className="text-[11px] text-amber-400 font-bold">JS</span> tailwind.config.ts
                    </div>
                    <div className="flex items-center gap-1.5 pl-4 text-slate-400">
                      <span className="text-[11px] text-red-400 font-bold">{`{}`}</span> package.json
                    </div>
                    <div className="flex items-center gap-1.5 pl-4 text-slate-400">
                      <span className="material-symbols-outlined text-[14px]">description</span> README.md
                    </div>
                  </div>
                </div>

                {/* Mini Code Viewer (5 cols) */}
                <div className="col-span-5 flex flex-col bg-[#070A12]">
                  <div className="flex items-center bg-[#090D16] border-b border-border-subtle px-3 py-1.5 gap-2 text-xs font-mono">
                    <span className="px-2 py-0.5 bg-dark-surface-container text-white border-t border-t-blue-400">
                      button.tsx
                    </span>
                    <span className="text-slate-500">TypeScript • 54 lines</span>
                  </div>
                  <div className="p-4 font-mono text-xs leading-relaxed text-slate-300 overflow-hidden space-y-1">
                    <p><span className="text-slate-600 mr-3">1</span><span className="text-purple-400">import</span> * <span className="text-purple-400">as</span> React <span className="text-purple-400">from</span> <span className="text-emerald-400">"react"</span></p>
                    <p><span className="text-slate-600 mr-3">2</span><span className="text-purple-400">import</span> {`{ Slot }`} <span className="text-purple-400">from</span> <span className="text-emerald-400">"@radix-ui/react-slot"</span></p>
                    <p><span className="text-slate-600 mr-3">3</span><span className="text-purple-400">import</span> {`{ cva, type VariantProps }`} <span className="text-purple-400">from</span> <span className="text-emerald-400">"class-variance-authority"</span></p>
                    <p><span className="text-slate-600 mr-3">4</span></p>
                    <p><span className="text-slate-600 mr-3">5</span><span className="text-blue-400">const</span> buttonVariants = <span className="text-amber-300">cva</span>(</p>
                    <p><span className="text-slate-600 mr-3">6</span>  <span className="text-emerald-400">"inline-flex items-center justify-center rounded-md font-medium"</span>,</p>
                    <p><span className="text-slate-600 mr-3">7</span>  {`{ variants: { variant: { default: "bg-primary text-white" } } }`}</p>
                    <p><span className="text-slate-600 mr-3">8</span>)</p>
                  </div>
                </div>

                {/* Mini Live Preview (4 cols) */}
                <div className="col-span-4 bg-[#0A0E17] flex flex-col">
                  <div className="flex items-center justify-between bg-[#080C14] border-b border-border-subtle px-3 py-1.5 text-xs font-mono">
                    <span className="flex items-center gap-1.5 text-slate-300">
                      <span className="material-symbols-outlined text-[14px] text-accent">visibility</span>
                      <span>Live Preview (3000)</span>
                    </span>
                    <span className="text-[10px] text-emerald-400 font-semibold">200 OK</span>
                  </div>
                  <div className="flex-1 p-6 flex flex-col items-center justify-center text-center bg-[#070A10]">
                    <div className="p-4 rounded-lg bg-dark-surface-container border border-border-subtle w-full max-w-xs space-y-3">
                      <div className="w-10 h-10 rounded-full bg-blue-500/20 text-blue-400 flex items-center justify-center mx-auto">
                        <span className="material-symbols-outlined text-[20px]">widgets</span>
                      </div>
                      <h4 className="font-headline font-semibold text-white text-sm">
                        Interactive Sandbox Active
                      </h4>
                      <p className="text-xs text-slate-400">
                        Component renders inside client WebContainer without remote servers.
                      </p>
                      <button
                        onClick={() => setSandboxTaps((t) => t + 1)}
                        className="w-full py-1.5 px-3 bg-blue-600 hover:bg-blue-500 text-white rounded text-xs font-medium transition-colors"
                      >
                        Click to Trigger State ({sandboxTaps})
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Persona Matrix */}
        <section id="how-it-works" className="py-20 border-b border-border-subtle bg-[#080B12]">
          <div className="max-w-7xl mx-auto px-6">
            <div className="max-w-2xl mb-14">
              <span className="text-xs font-mono text-accent uppercase tracking-widest block mb-2">
                Architected for Speed
              </span>
              <h2 className="font-headline text-display-md text-white font-bold">
                Built for four distinct engineering workflows
              </h2>
              <p className="text-body-md text-slate-400 mt-2">
                Skip the `git clone`, `pnpm install`, and conflicting Node versions entirely.
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
              {/* Persona 1: Engineers */}
              <div className="p-6 rounded-xl bg-dark-surface-container border border-border-subtle flex flex-col justify-between">
                <div>
                  <div className="w-10 h-10 rounded-lg bg-blue-500/10 border border-blue-500/20 text-blue-400 flex items-center justify-center mb-4">
                    <span className="material-symbols-outlined text-[22px]">code_blocks</span>
                  </div>
                  <h3 className="font-headline text-headline-sm text-white mb-2">Software Engineers</h3>
                  <p className="text-body-sm text-slate-400 leading-relaxed">
                    Triage libraries, check API implementations, and run examples instantly before installing into your production bundle.
                  </p>
                </div>
                <div className="mt-6 pt-4 border-t border-border-subtle font-mono text-xs text-slate-500">
                  Avg triage: <span className="text-white font-medium">4.2s vs 4.5m</span>
                </div>
              </div>

              {/* Persona 2: CS Students */}
              <div className="p-6 rounded-xl bg-dark-surface-container border border-border-subtle flex flex-col justify-between">
                <div>
                  <div className="w-10 h-10 rounded-lg bg-violet-500/10 border border-violet-500/20 text-violet-400 flex items-center justify-center mb-4">
                    <span className="material-symbols-outlined text-[22px]">school</span>
                  </div>
                  <h3 className="font-headline text-headline-sm text-white mb-2">CS Students</h3>
                  <p className="text-body-sm text-slate-400 leading-relaxed">
                    Study architectural patterns, inspect data structures, and execute sample code without breaking your local laptop environment.
                  </p>
                </div>
                <div className="mt-6 pt-4 border-t border-border-subtle font-mono text-xs text-slate-500">
                  Zero environment drift
                </div>
              </div>

              {/* Persona 3: Recruiters */}
              <div className="p-6 rounded-xl bg-dark-surface-container border border-border-subtle flex flex-col justify-between">
                <div>
                  <div className="w-10 h-10 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 flex items-center justify-center mb-4">
                    <span className="material-symbols-outlined text-[22px]">badge</span>
                  </div>
                  <h3 className="font-headline text-headline-sm text-white mb-2">Technical Recruiters</h3>
                  <p className="text-body-sm text-slate-400 leading-relaxed">
                    Review candidate portfolio repositories and test assignment projects live in your browser without requesting screen shares.
                  </p>
                </div>
                <div className="mt-6 pt-4 border-t border-border-subtle font-mono text-xs text-slate-500">
                  Instant candidate demo
                </div>
              </div>

              {/* Persona 4: OSS Maintainers */}
              <div className="p-6 rounded-xl bg-dark-surface-container border border-border-subtle flex flex-col justify-between">
                <div>
                  <div className="w-10 h-10 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-400 flex items-center justify-center mb-4">
                    <span className="material-symbols-outlined text-[22px]">commit</span>
                  </div>
                  <h3 className="font-headline text-headline-sm text-white mb-2">OSS Maintainers</h3>
                  <p className="text-body-sm text-slate-400 leading-relaxed">
                    Review incoming Pull Requests with live executed reproduction sandboxes before merging to main.
                  </p>
                </div>
                <div className="mt-6 pt-4 border-t border-border-subtle font-mono text-xs text-slate-500">
                  Interactive PR reviews
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Deep Technical Features */}
        <section id="features" className="py-20 border-b border-border-subtle bg-dark-surface">
          <div className="max-w-7xl mx-auto px-6">
            <div className="flex flex-col md:flex-row md:items-end justify-between mb-14 gap-4">
              <div>
                <span className="text-xs font-mono text-blue-400 uppercase tracking-widest block mb-2">
                  Core Technology
                </span>
                <h2 className="font-headline text-display-md text-white font-bold">
                  Engineered for deep repository inspection
                </h2>
              </div>
              <Link
                to="/import"
                className="inline-flex items-center gap-2 text-sm font-label text-blue-400 hover:text-blue-300 font-medium"
              >
                <span>Import your first repository</span>
                <span className="material-symbols-outlined text-[16px]">arrow_forward</span>
              </Link>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
              {/* Feature 1 */}
              <div className="space-y-3">
                <div className="h-44 rounded-lg bg-[#070A10] border border-border-subtle p-4 font-mono text-xs text-slate-400 flex flex-col justify-between">
                  <div className="flex items-center justify-between text-slate-500 border-b border-border-subtle pb-2">
                    <span>dependency-graph</span>
                    <span className="text-emerald-400">18 resolved</span>
                  </div>
                  <div className="space-y-1 text-[11px]">
                    <div className="flex justify-between"><span>@radix-ui/react-dialog</span><span className="text-slate-500">v1.0.5</span></div>
                    <div className="flex justify-between"><span>clsx</span><span className="text-slate-500">v2.1.0</span></div>
                    <div className="flex justify-between"><span>tailwind-merge</span><span className="text-slate-500">v2.2.1</span></div>
                    <div className="flex justify-between"><span>lucide-react</span><span className="text-slate-500">v0.323.0</span></div>
                  </div>
                  <div className="text-[10px] text-slate-500">Security audit: 0 vulnerabilities found</div>
                </div>
                <h3 className="font-headline text-headline-sm text-white">Automated Dependency Analysis</h3>
                <p className="text-body-sm text-slate-400">
                  Instantly parse `package.json`, `Cargo.toml`, or `go.mod` to inspect direct vs transitive dependencies, license types, and security vulnerabilities.
                </p>
              </div>

              {/* Feature 2 */}
              <div className="space-y-3">
                <div className="h-44 rounded-lg bg-[#070A10] border border-border-subtle p-4 font-mono text-xs text-slate-400 flex flex-col justify-between">
                  <div className="flex items-center justify-between text-slate-500 border-b border-border-subtle pb-2">
                    <span>webcontainer-runtime</span>
                    <span className="text-accent">Node 20.11</span>
                  </div>
                  <div className="space-y-1 text-[11px] text-slate-300">
                    <p className="text-slate-500">$ pnpm run dev</p>
                    <p>vite v5.1.3 dev server running at:</p>
                    <p className="text-emerald-400">&gt; Local: http://localhost:5173/</p>
                    <p className="text-slate-500">&gt; ready in 214ms.</p>
                  </div>
                  <div className="text-[10px] text-emerald-400">Hot module replacement enabled</div>
                </div>
                <h3 className="font-headline text-headline-sm text-white">Browser-Native Isolated Sandbox</h3>
                <p className="text-body-sm text-slate-400">
                  Run Node.js directly within your browser thread using WebAssembly containers. Full terminal execution, fast package installs, and zero server wait times.
                </p>
              </div>

              {/* Feature 3 */}
              <div className="space-y-3">
                <div className="h-44 rounded-lg bg-[#070A10] border border-border-subtle p-4 font-mono text-xs text-slate-400 flex flex-col justify-between">
                  <div className="flex items-center justify-between text-slate-500 border-b border-border-subtle pb-2">
                    <span>git-virtual-fs</span>
                    <span className="text-blue-400">Indexed</span>
                  </div>
                  <div className="space-y-1.5 text-[11px]">
                    <div className="flex items-center justify-between">
                      <span className="text-slate-300">AST Syntax Parsing</span>
                      <span className="text-emerald-400 font-mono">100%</span>
                    </div>
                    <div className="w-full h-1.5 bg-slate-800 rounded-full overflow-hidden">
                      <div className="w-full h-full bg-blue-500"></div>
                    </div>
                    <div className="flex items-center justify-between text-slate-500 text-[10px]">
                      <span>Fuzzy symbol search</span>
                      <span>&lt;10ms query</span>
                    </div>
                  </div>
                  <div className="text-[10px] text-slate-500">Virtual DOM tree loaded with breadcrumbs</div>
                </div>
                <h3 className="font-headline text-headline-sm text-white">Instant Code Navigation</h3>
                <p className="text-body-sm text-slate-400">
                  Jump directly to function declarations, jump across import statements, and browse giant monorepos without waiting for local language servers to index.
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* CTA Section */}
        <section className="py-20 bg-[#0B0F1A] border-b border-border-subtle">
          <div className="max-w-4xl mx-auto px-6 text-center">
            <h2 className="font-headline text-display-md text-white font-bold mb-4">
              Start exploring repositories today
            </h2>
            <p className="text-body-lg text-slate-300 mb-8 max-w-xl mx-auto">
              No credit card required. Works with all public GitHub repositories and private repos with GitHub authorization.
            </p>
            <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
              <Link
                to="/import"
                className="w-full sm:w-auto px-6 py-3 rounded-lg bg-dark-primary hover:bg-blue-500 text-white font-label text-label-lg transition-colors shadow-md"
              >
                Import Any Repository
              </Link>
              <Link
                to="/workspace"
                className="w-full sm:w-auto px-6 py-3 rounded-lg bg-dark-surface-container hover:bg-dark-surface-container-high border border-border-subtle text-slate-200 font-label text-label-lg transition-colors"
              >
                Try Sample Sandbox
              </Link>
            </div>
          </div>
        </section>
      </main>

      <Footer />
    </div>
  );
};
