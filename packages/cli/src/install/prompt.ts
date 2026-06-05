import * as readline from "node:readline";

export async function confirm(question: string): Promise<boolean> {
	if (!process.stdin.isTTY) return false;
	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout,
	});
	return new Promise<boolean>((resolve) => {
		rl.question(`${question} [Y/n] `, (answer) => {
			rl.close();
			const t = answer.trim().toLowerCase();
			resolve(t === "" || t === "y");
		});
	});
}
