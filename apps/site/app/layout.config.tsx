import { BookOpen } from "lucide-react";
import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import { appName, gitConfig } from "@/lib/shared";

function AstrographLogo() {
	return (
		<span className="astro-wordmark">
			<svg
				className="astro-wordmark-glyph"
				viewBox="0 0 32 32"
				role="img"
				aria-label="Astrograph constellation logo"
			>
				<path d="M7 22 14 9l5 7 6-4" />
				<circle cx="7" cy="22" r="2.4" />
				<circle cx="14" cy="9" r="2.2" />
				<circle cx="19" cy="16" r="2.1" />
				<circle cx="25" cy="12" r="2.3" />
			</svg>
			<span>{appName}</span>
		</span>
	);
}

export function baseOptions(): BaseLayoutProps {
	return {
		nav: {
			title: <AstrographLogo />,
			url: "/",
		},
		links: [
			{
				type: "main",
				text: "Docs",
				url: "/docs",
				active: "nested-url",
				icon: <BookOpen className="size-4" />,
			},
		],
		// GitHub is rendered once from `githubUrl` below (don't also add it to `links`).
		githubUrl: `https://github.com/${gitConfig.user}/${gitConfig.repo}`,
		// Space theme is dark-only — hide the light/dark switch in every layout.
		themeSwitch: { enabled: false },
	};
}
