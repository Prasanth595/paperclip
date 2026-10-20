const MAX_SANITIZE_DEPTH = 12;
const REPLACEMENT_CHARACTER = "\uFFFD";

export function sanitizeRunStringForPostgres(value: string): string {
  let changed = false;
  let output = "";
  for (let index = 0; index < value.length; ) {
    const code = value.charCodeAt(index);
    if (code === 0) {
      changed = true;
      index += 1;
      continue;
    }
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        output += value.slice(index, index + 2);
        index += 2;
      } else {
        output += REPLACEMENT_CHARACTER;
        changed = true;
        index += 1;
      }
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      output += REPLACEMENT_CHARACTER;
      changed = true;
      index += 1;
      continue;
    }
    output += value[index];
    index += 1;
  }
  return changed ? output : value;
}

export function sanitizeRunScopeForPostgres<T>(value: T, depth = 0): T {
  if (value === null || value === undefined || depth > MAX_SANITIZE_DEPTH) return value;
  if (typeof value === "string") return sanitizeRunStringForPostgres(value) as T;
  if (value instanceof Date || value instanceof Uint8Array) return value;
  if (Array.isArray(value)) {
    let changed = false;
    const output = value.map((item) => {
      const fixed = sanitizeRunScopeForPostgres(item, depth + 1);
      if (fixed !== item) changed = true;
      return fixed;
    });
    return (changed ? output : value) as T;
  }
  if (typeof value === "object") {
    let changed = false;
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>)) {
      const current = (value as Record<string, unknown>)[key];
      const fixed = sanitizeRunScopeForPostgres(current, depth + 1);
      if (fixed !== current) changed = true;
      output[key] = fixed;
    }
    return (changed ? output : value) as T;
  }
  return value;
}

export function sanitizeRunPatchForPostgres<T>(patch: T): T {
  return sanitizeRunScopeForPostgres(patch);
}
