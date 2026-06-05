export function greet(name: string): string {
	return `Hello, ${name}!`;
}

export class UserService {
	private name: string;

	constructor(name: string) {
		this.name = name;
	}

	getName(): string {
		return this.name;
	}

	static create(name: string): UserService {
		return new UserService(name);
	}
}

export enum Role {
	Admin = "admin",
	User = "user",
}

export type Config = {
	debug: boolean;
	port: number;
};

export namespace Utils {
	export function formatDate(d: Date): string {
		return d.toISOString();
	}
}

const MAX_RETRIES = 3;
let currentRetry = 0;
