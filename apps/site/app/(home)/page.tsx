import Link from "next/link";
import { ArrowRight, Terminal, Network, Zap } from "lucide-react";
import { HeroConstellation, Starfield } from "@/components/constellation";
import { PointerParallax } from "@/components/parallax";
import { ScrollReveal } from "@/components/reveal";
import { Term } from "@/components/term";
import { GitHubIcon } from "@/components/icons";
import { gitConfig } from "@/lib/shared";

const repoUrl = `https://github.com/${gitConfig.user}/${gitConfig.repo}`;

const hosts = ["Claude Code", "Cursor", "Codex", "opencode"];

const surfaces = [
	{
		title: "CLI",
		icon: Terminal,
		blurb:
			"search · context · callers · impact · trace — scriptable, one-shot, pipeable.",
	},
	{
		title: "MCP + skills",
		icon: Network,
		blurb:
			"Agents query the graph over MCP instead of running broad grep/read loops.",
	},
	{
		title: "Local & fast",
		icon: Zap,
		blurb:
			"A local SQLite graph, watcher-fresh. No API keys, nothing leaves your machine.",
	},
];

export default function HomePage() {
	return (
		<main className="astro-home">
			<Starfield />

			<section className="astro-hero">
				<div className="astro-hero-copy">
					<p className="astro-eyebrow">
						<span className="astro-eyebrow-dot" /> Local-first code graph for
						JS/TS
					</p>
					<h1>
						See your codebase as a{" "}
						<span className="astro-grad">constellation</span>.
					</h1>
					<p className="astro-subhead">
						Astrograph indexes symbols, calls, imports, inheritance, and
						references into a local graph — then serves it to a fast CLI and to
						agents over MCP. Exact answers, fewer tokens, no grep loops.
					</p>
					<div className="astro-actions">
						<Link href="/docs" className="astro-button astro-button-primary">
							Read the docs
							<ArrowRight className="size-4" />
						</Link>
						<Link
							href={repoUrl}
							className="astro-button astro-button-secondary"
						>
							<GitHubIcon className="size-4" />
							View on GitHub
						</Link>
					</div>
				</div>

				<div className="astro-hero-visual">
					<PointerParallax className="astro-constellation-wrap">
						<HeroConstellation />
					</PointerParallax>
					<Term name="astrograph — graph.db" className="astro-term-hero">
						<span className="tl">
							<span className="t-prompt">$</span>{" "}
							<span className="t-cmd">astrograph</span>{" "}
							<span className="t-arg">context</span>{" "}
							<span className="t-str">
								&quot;how does auth refresh work?&quot;
							</span>
						</span>
						{"\n\n"}
						<span className="t-dim">entry points</span>
						{"\n"} <span className="t-id">refreshSession</span>
						{"\n"} <span className="t-id">AuthProvider</span>
						{"\n\n"}
						<span className="t-dim">included code</span>
						{"\n"} <span className="t-path">src/auth/session.ts</span>
						{"\n"} <span className="t-path">src/auth/AuthProvider.tsx</span>
						{"\n\n"}
						<span className="t-key">coverage</span>{" "}
						<span className="t-ok">128/128 resolved</span>
						{"\n"}
						<span className="t-key">partial</span>{" "}
						<span className="t-ok">no</span>
					</Term>
				</div>
			</section>

			<section className="astro-compat astro-reveal">
				<p className="astro-kicker">Works with your agents</p>
				<ul className="astro-compat-row">
					{hosts.map((h) => (
						<li key={h}>{h}</li>
					))}
				</ul>
			</section>

			<section className="astro-surfaces astro-reveal">
				{surfaces.map(({ title, icon: Icon, blurb }) => (
					<div className="astro-surface" key={title}>
						<Icon className="size-5" />
						<div>
							<h3>{title}</h3>
							<p>{blurb}</p>
						</div>
					</div>
				))}
			</section>

			<section className="astro-why astro-reveal" aria-labelledby="why-heading">
				<div className="astro-why-head">
					<p className="astro-kicker">Why depth wins</p>
					<h2 id="why-heading">Depth over breadth, on purpose.</h2>
					<p className="astro-why-sub">
						One question, one command. The graph already did the exploration —
						these are real answers, not text matches.
					</p>
				</div>

				<div className="astro-term-grid">
					<figure className="astro-feature">
						<Term name="who calls this?" className="astro-term-mini">
							<span className="t-prompt">$</span>{" "}
							<span className="t-cmd">astrograph</span>{" "}
							<span className="t-arg">callers</span>{" "}
							<span className="t-id">useAccount</span>
							{"\n\n"} <span className="t-path">AccountMenu.tsx</span>
							<span className="t-dim">:14</span>
							{"\n"} <span className="t-path">useBilling.ts</span>
							<span className="t-dim">:22</span>
							{"\n"} <span className="t-path">dashboard/page.tsx</span>
							<span className="t-dim">:8</span>
							{"\n\n"}
							<span className="t-key">3 callers</span>{" "}
							<span className="t-ok">· resolved</span>
						</Term>
						<figcaption>
							Walk call flow in either direction — every edge resolved by the
							type-checker.
						</figcaption>
					</figure>

					<figure className="astro-feature">
						<Term name="what will this break?" className="astro-term-mini">
							<span className="t-prompt">$</span>{" "}
							<span className="t-cmd">astrograph</span>{" "}
							<span className="t-arg">impact</span>{" "}
							<span className="t-id">AuthProvider</span>
							{"\n\n"} <span className="t-path">App.tsx</span>
							{"\n"} <span className="t-path">routes/private.tsx</span>
							{"\n"} <span className="t-path">hooks/useSession.ts</span>
							{"\n\n"}
							<span className="t-key">12 symbols</span>{" "}
							<span className="t-ok">· depth 2</span>
						</Term>
						<figcaption>
							See a change&apos;s blast radius before you touch a single line.
						</figcaption>
					</figure>

					<figure className="astro-feature">
						<Term name="can I trust it?" className="astro-term-mini">
							<span className="t-prompt">$</span>{" "}
							<span className="t-cmd">astrograph</span>{" "}
							<span className="t-arg">status</span>
							{"\n\n"}
							<span className="t-dim">nodes</span>{" "}
							<span className="t-id">2314</span>
							{"  "}
							<span className="t-dim">edges</span>{" "}
							<span className="t-id">11080</span>
							{"\n\n"}
							<span className="t-key">coverage</span>{" "}
							<span className="t-ok">136/136 resolved</span>
							{"\n"}
							<span className="t-key">partial</span>{" "}
							<span className="t-ok">no</span>
						</Term>
						<figcaption>
							Honest coverage on every answer — never a silent, partial guess.
						</figcaption>
					</figure>
				</div>
			</section>

			<section className="astro-cta astro-reveal">
				<p className="astro-kicker">Get started</p>
				<h2>Index your repo in one command.</h2>
				<Term name="~/your-project" className="astro-term-cta">
					<span className="t-prompt">$</span>{" "}
					<span className="t-cmd">astrograph</span>{" "}
					<span className="t-arg">init</span>
					{"\n\n"}
					<span className="t-dim">indexing…</span>
					{"\n"}
					<span className="t-ok">✓</span>{" "}
					<span className="t-id">136 files</span>{" "}
					<span className="t-dim">·</span>{" "}
					<span className="t-id">2,314 symbols</span>
					{"\n"}
					<span className="t-path">.astrograph/graph.db</span>{" "}
					<span className="t-ok">ready</span>
				</Term>
				<div className="astro-actions astro-actions-center">
					<Link
						href="/docs/quick-start"
						className="astro-button astro-button-primary"
					>
						Read the docs
						<ArrowRight className="size-4" />
					</Link>
					<Link href={repoUrl} className="astro-button astro-button-secondary">
						<GitHubIcon className="size-4" />
						View on GitHub
					</Link>
				</div>
			</section>

			<footer className="astro-footer">
				<span className="astro-footer-brand">Astrograph</span>
				<span>Apache-2.0 · Built by Rodolfo Robles</span>
				<Link href={repoUrl} className="astro-footer-link">
					<GitHubIcon className="size-4" />
					GitHub
				</Link>
			</footer>

			<ScrollReveal />
		</main>
	);
}
