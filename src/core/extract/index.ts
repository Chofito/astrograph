import { type Lang, withTree } from "../parser";
import { extractPhp } from "./php";
import type { Extraction } from "./types";
import { extractTypeScript } from "./typescript";

export function extract(lang: Lang, source: string): Extraction {
	return withTree(lang, source, (tree) => (lang === "php" ? extractPhp(tree) : extractTypeScript(tree)));
}
