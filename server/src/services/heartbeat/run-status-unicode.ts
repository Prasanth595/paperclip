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

export function sanitizeRunScopeForPostgres<T>(value: T, seen: WeakSet<object> = new WeakSet()): T {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return sanitizeRunStringForPostgres(value) as T;
  if (value instanceof Date || value instanceof Uint8Array) return value;
  if (Array.isArray(value)) {
    if (seen.has(value)) return value;
    seen.add(value);
    try {
      let changed = false;
      const output = value.map((item) => {
        const fixed = sanitizeRunScopeForPostgres(item, seen);
        if (fixed !== item) changed = true;
        return fixed;
      });
      return (changed ? output : value) as T;
    } finally {
      seen.delete(value);
    }
  }
  if (typeof value === "object") {
    const source = value as Record<string, unknown>;
    if (seen.has(source)) return value;
    seen.add(source);
    try {
      let changed = false;
      const output: Record<string, unknown> = {};
      for (const key of Object.keys(source)) {
        const fixedKey = sanitizeRunStringForPostgres(key);
        if (fixedKey !== key) changed = true;
        const fixedValue = sanitizeRunScopeForPostgres(source[key], seen);
        if (fixedValue !== source[key]) changed = true;
        output[fixedKey] = fixedValue;
      }
      return (changed ? output : value) as T;
    } finally {
      seen.delete(source);
    }
  }
  return value;
}

export function sanitizeRunPatchForPostgres<T>(patch: T): T {
  return sanitizeRunScopeForPostgres(patch);
}
