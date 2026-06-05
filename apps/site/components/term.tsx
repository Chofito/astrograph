import type { ReactNode } from "react";

/** Reusable terminal chrome (traffic-light bar + monospace body). */
export function Term({
	name,
	className,
	children,
}: {
	name: string;
	className?: string;
	children: ReactNode;
}) {
	return (
		<div className={`astro-term${className ? ` ${className}` : ""}`}>
			<div className="astro-term-bar">
				<span className="astro-term-dot astro-term-dot-r" />
				<span className="astro-term-dot astro-term-dot-y" />
				<span className="astro-term-dot astro-term-dot-g" />
				<span className="astro-term-name">{name}</span>
			</div>
			<pre className="astro-term-body">
				<code>{children}</code>
			</pre>
		</div>
	);
}
