import { Provider } from "@/components/provider";
import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./global.css";

const sans = Inter({
	subsets: ["latin"],
	variable: "--font-sans",
	display: "swap",
});
const mono = JetBrains_Mono({
	subsets: ["latin"],
	variable: "--font-mono",
	display: "swap",
});

export const metadata: Metadata = {
	metadataBase: new URL("https://chofito.github.io/astrograph"),
	title: {
		default: "Astrograph",
		template: "%s | Astrograph",
	},
	description:
		"Local-first code graph for JS/TS, built for humans and AI agents.",
};

export default function Layout({ children }: LayoutProps<"/">) {
	return (
		<html
			lang="en"
			className={`dark ${sans.variable} ${mono.variable}`}
			suppressHydrationWarning
		>
			<body className="flex flex-col min-h-screen">
				<Provider>{children}</Provider>
			</body>
		</html>
	);
}
