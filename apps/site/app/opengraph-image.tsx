import { generate as DefaultImage } from "fumadocs-ui/og";
import { ImageResponse } from "next/og";
import { appName } from "@/lib/shared";

export const revalidate = false;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OgImage() {
	return new ImageResponse(
		<DefaultImage
			title={appName}
			description="Local code graph for TypeScript, JavaScript and PHP, built for coding agents."
			site={appName}
		/>,
		size,
	);
}
