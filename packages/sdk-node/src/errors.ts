export class BastionError extends Error {
  public readonly statusCode: number;
  public readonly body: { message: string };

  constructor(statusCode: number, body: { message: string }) {
    super(body.message);
    this.name = 'BastionError';
    this.statusCode = statusCode;
    this.body = body;
  }
}

export class BastionValidationError extends BastionError {
  constructor(body: { message: string }) {
    super(400, body);
    this.name = 'BastionValidationError';
  }
}

export class BastionUnauthorizedError extends BastionError {
  constructor(body: { message: string }) {
    super(401, body);
    this.name = 'BastionUnauthorizedError';
  }
}

export class BastionForbiddenError extends BastionError {
  constructor(body: { message: string }) {
    super(403, body);
    this.name = 'BastionForbiddenError';
  }
}

export class BastionNotFoundError extends BastionError {
  constructor(body: { message: string }) {
    super(404, body);
    this.name = 'BastionNotFoundError';
  }
}

export class BastionConflictError extends BastionError {
  constructor(body: { message: string }) {
    super(409, body);
    this.name = 'BastionConflictError';
  }
}

export class BastionBadGatewayError extends BastionError {
  constructor(body: { message: string }) {
    super(502, body);
    this.name = 'BastionBadGatewayError';
  }
}

export function throwForStatus(statusCode: number, body: { message: string }): never {
  switch (statusCode) {
    case 400:
      throw new BastionValidationError(body);
    case 401:
      throw new BastionUnauthorizedError(body);
    case 403:
      throw new BastionForbiddenError(body);
    case 404:
      throw new BastionNotFoundError(body);
    case 409:
      throw new BastionConflictError(body);
    case 502:
      throw new BastionBadGatewayError(body);
    default:
      throw new BastionError(statusCode, body);
  }
}
