function describe(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

export function validateJsonSchema(value, schema, path = "$") {
  const errors = [];

  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path}: expected one of ${schema.enum.join(", ")}`);
    return errors;
  }

  if (schema.type) {
    const matches =
      (schema.type === "array" && Array.isArray(value)) ||
      (schema.type === "object" &&
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value)) ||
      (schema.type === "integer" && Number.isInteger(value)) ||
      (schema.type === "number" &&
        typeof value === "number" &&
        Number.isFinite(value)) ||
      (schema.type === "string" && typeof value === "string") ||
      (schema.type === "boolean" && typeof value === "boolean") ||
      (schema.type === "null" && value === null);

    if (!matches) {
      errors.push(`${path}: expected ${schema.type}, got ${describe(value)}`);
      return errors;
    }
  }

  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${path}: shorter than minLength ${schema.minLength}`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push(`${path}: longer than maxLength ${schema.maxLength}`);
    }
  }

  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push(`${path}: smaller than minimum ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push(`${path}: larger than maximum ${schema.maximum}`);
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${path}: fewer than minItems ${schema.minItems}`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push(`${path}: more than maxItems ${schema.maxItems}`);
    }
    if (schema.items) {
      value.forEach((item, index) => {
        errors.push(...validateJsonSchema(item, schema.items, `${path}[${index}]`));
      });
    }
  }

  if (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  ) {
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) {
        errors.push(`${path}.${key}: required property is missing`);
      }
    }

    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (Object.hasOwn(value, key)) {
        errors.push(...validateJsonSchema(value[key], child, `${path}.${key}`));
      }
    }

    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys(schema.properties ?? {}));
      for (const key of Object.keys(value)) {
        if (!allowed.has(key)) {
          errors.push(`${path}.${key}: additional property is not allowed`);
        }
      }
    }
  }

  return errors;
}

export function assertJsonSchema(value, schema, label = "value") {
  const errors = validateJsonSchema(value, schema);
  if (errors.length > 0) {
    throw new Error(`${label} failed schema validation:\n- ${errors.join("\n- ")}`);
  }
  return value;
}
