export class BastionUnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BastionUnreachableError';
  }
}

export class BastionBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BastionBlockedError';
  }
}
