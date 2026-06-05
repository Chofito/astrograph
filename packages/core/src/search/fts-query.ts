const FTS_SPECIAL_RE = /['"*:^()]/g;
const NON_IDENTIFIER_RE = /[^A-Za-z0-9_$]+/g;
const DOTTED_OR_SNAKE_COMPOUND_RE = /[A-Za-z0-9_$]+[._][A-Za-z0-9_$.]+/g;

const FTS_BOOLEAN_OPERATORS = new Set(["and", "or", "not", "near"]);
const STOPWORDS = new Set([
	"how",
	"does",
	"do",
	"did",
	"the",
	"a",
	"an",
	"of",
	"is",
	"are",
	"to",
	"in",
	"on",
	"for",
	"from",
	"with",
	"without",
	"by",
	"at",
	"as",
	"this",
	"that",
	"these",
	"those",
	"it",
	"its",
	"be",
	"been",
	"being",
	"work",
	"works",
	"what",
	"where",
	"when",
	"why",
	"which",
	"who",
	"show",
	"find",
	"get",
	"set",
	"service",
]);

export function toFtsMatchQuery(raw: string): string {
	const rawTokens = [...tokenize(raw), ...compoundIdentifierCandidates(raw)];
	if (rawTokens.length === 0) return "";

	const contentTokens = rawTokens.filter((token) => {
		const lower = token.toLowerCase();
		return (
			token.length > 1 &&
			!FTS_BOOLEAN_OPERATORS.has(lower) &&
			!STOPWORDS.has(lower)
		);
	});
	const tokens =
		contentTokens.length > 0
			? contentTokens
			: rawTokens.filter((token) => token.length > 0);
	const expandedTokens = tokens.flatMap(expandIdentifierToken);

	return uniqueSorted(expandedTokens)
		.map((token) => `"${token}"*`)
		.join(" OR ");
}

export function toExactNameBoostToken(raw: string): string {
	const tokens = tokenize(raw);
	return tokens.length === 1 ? tokens[0]!.toLowerCase() : "";
}

function tokenize(raw: string): string[] {
	return raw
		.replaceAll("::", " ")
		.replaceAll(".", " ")
		.replace(FTS_SPECIAL_RE, " ")
		.split(NON_IDENTIFIER_RE)
		.map((token) => token.trim())
		.filter((token) => token !== "");
}

function compoundIdentifierCandidates(raw: string): string[] {
	return raw.match(DOTTED_OR_SNAKE_COMPOUND_RE) ?? [];
}

function expandIdentifierToken(token: string): string[] {
	const lower = token.includes(".")
		? token.replaceAll(".", "").toLowerCase()
		: token.toLowerCase();
	const parts = splitIdentifier(token)
		.map((part) => part.toLowerCase())
		.filter(
			(part) =>
				part.length >= 3 &&
				!STOPWORDS.has(part) &&
				!FTS_BOOLEAN_OPERATORS.has(part),
		);
	return [lower, ...parts];
}

function splitIdentifier(token: string): string[] {
	const separated = token
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
		.replaceAll(".", " ")
		.replaceAll("_", " ");
	return separated.split(/\s+/).filter((part) => part !== "");
}

function uniqueSorted(tokens: string[]): string[] {
	const seen = new Set<string>();
	for (const token of tokens) {
		const key = token.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
	}
	return [...seen].sort(compareStrings);
}

function compareStrings(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}
