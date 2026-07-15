import Ajv2020, { type AnySchema, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";

export type OutputBodyValidator = (body: unknown) => string[];

export function compileOutputBodySchema(schema: unknown): OutputBodyValidator {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  let validate: ValidateFunction;
  try {
    validate = ajv.compile(schema as AnySchema);
  } catch (error) {
    throw new Error(`invalid package output schema: ${error instanceof Error ? error.message : String(error)}`);
  }
  return (body) => {
    if (validate(body)) return [];
    return (validate.errors ?? []).map(formatSchemaError);
  };
}

function formatSchemaError(error: ErrorObject): string {
  const path = error.instancePath || "/";
  return `${path}: ${error.message ?? "does not match the package output schema"}`;
}
