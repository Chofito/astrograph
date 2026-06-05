"use client";
import { useEffect } from "react";

/**
 * Progressive scroll-reveal for elements with `.astro-reveal`.
 * Adds `reveal-ready` to <html> only when JS runs, so content stays visible
 * without JS. Honors prefers-reduced-motion (reveals everything immediately).
 */
export function ScrollReveal() {
	useEffect(() => {
		const els = document.querySelectorAll<HTMLElement>(".astro-reveal");
		if (!els.length) return;

		if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
			els.forEach((e) => e.classList.add("is-in"));
			return;
		}

		document.documentElement.classList.add("reveal-ready");
		const io = new IntersectionObserver(
			(entries) => {
				for (const e of entries) {
					if (e.isIntersecting) {
						e.target.classList.add("is-in");
						io.unobserve(e.target);
					}
				}
			},
			{ rootMargin: "0px 0px -12% 0px", threshold: 0.12 },
		);
		els.forEach((e) => io.observe(e));
		return () => io.disconnect();
	}, []);

	return null;
}
