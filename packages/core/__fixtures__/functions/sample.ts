function declaration(a: number, b: number): number {
	return a + b;
}

const arrow = (x: string): string => {
	return x.toUpperCase();
};

const fnExpr = (items: string[]): number => items.length;

async function asyncDecl(): Promise<void> {
	await Promise.resolve();
}

const asyncArrow = async (): Promise<string> => {
	return "done";
};
