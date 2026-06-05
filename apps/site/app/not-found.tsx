import Link from "next/link";
import { Starfield } from "@/components/constellation";

export default function NotFound() {
	return (
		<main className="astro-home astro-notfound">
			<Starfield />
			<div className="astro-notfound-inner">
				<p className="astro-eyebrow">
					<span className="astro-eyebrow-dot" /> 404
				</p>
				<h1>This star isn&apos;t on the map.</h1>
				<p className="astro-subhead">
					The page you&apos;re looking for drifted out of the constellation.
				</p>
				<div className="astro-actions">
					<Link href="/" className="astro-button astro-button-primary">
						Back home
					</Link>
					<Link href="/docs" className="astro-button astro-button-secondary">
						Read the docs
					</Link>
				</div>
			</div>
		</main>
	);
}
