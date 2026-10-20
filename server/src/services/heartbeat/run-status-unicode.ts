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

type SanitizeContainer = Record<string, unknown> | unknown[];
type SanitizeKey = string | number;

type SanitizeFrame = {
  source: unknown;
  parent: SanitizeFrame | null;
  parentKey: SanitizeKey | null;
  sourceKey: SanitizeKey | null;
  out: SanitizeContainer | null;
  keys: string[] | null;
  nextChild: number;
  changed: boolean;
  exiting: boolean;
};

function isSanitizeContainer(value: unknown): value is SanitizeContainer {
  return typeof value === "object"
    && value !== null
    && !(value instanceof Date)
    && !(value instanceof Uint8Array);
}

function assignSanitized(frame: SanitizeFrame, fixed: unknown, root: { value: unknown }) {
  if (!frame.parent) {
    root.value = fixed;
    return;
  }
  const parentOut = frame.parent.out as SanitizeContainer;
  const parentKey = frame.parentKey as SanitizeKey;
  if (Array.isArray(parentOut)) {
    parentOut[parentKey as number] = fixed;
  } else {
    Object.defineProperty(parentOut, parentKey as string, {
      value: fixed,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  const original = (frame.parent.source as Record<SanitizeKey, unknown>)[frame.sourceKey as SanitizeKey];
  if (fixed !== original || parentKey !== frame.sourceKey) frame.parent.changed = true;
}

export function sanitizeRunScopeForPostgres<T>(value: T): T {
  const root = { value: value as unknown };
  const path = new WeakSet<object>();
  const stack: SanitizeFrame[] = [{
    source: value,
    parent: null,
    parentKey: null,
    sourceKey: null,
    out: null,
    keys: null,
    nextChild: 0,
    changed: false,
    exiting: false,
  }];

  while (stack.length > 0) {
    const frame = stack.pop() as SanitizeFrame;
    const source = frame.source;

    if (frame.exiting) {
      path.delete(source as object);
      assignSanitized(frame, frame.changed ? frame.out : source, root);
      continue;
    }

    if (typeof source === "string") {
      assignSanitized(frame, sanitizeRunStringForPostgres(source), root);
      continue;
    }

    if (!isSanitizeContainer(source)) {
      assignSanitized(frame, source, root);
      continue;
    }

    if (frame.out === null) {
      if (path.has(source)) {
        assignSanitized(frame, source, root);
        continue;
      }
      path.add(source);
      if (!Array.isArray(source)) frame.keys = Object.keys(source);
      frame.out = Array.isArray(source) ? [] : {};
    }

    const length = Array.isArray(source) ? source.length : frame.keys!.length;
    if (frame.nextChild >= length) {
      frame.exiting = true;
      stack.push(frame);
      continue;
    }

    const childIndex = frame.nextChild;
    frame.nextChild += 1;
    stack.push(frame);

    const sourceKey: SanitizeKey = Array.isArray(source)
      ? childIndex
      : frame.keys![childIndex];
    const parentKey: SanitizeKey = Array.isArray(source)
      ? childIndex
      : sanitizeRunStringForPostgres(frame.keys![childIndex]);

    stack.push({
      source: (source as Record<SanitizeKey, unknown>)[sourceKey],
      parent: frame,
      parentKey,
      sourceKey,
      out: null,
      keys: null,
      nextChild: 0,
      changed: false,
      exiting: false,
    });
  }

  return root.value as T;
}

export function sanitizeRunPatchForPostgres<T>(patch: T): T {
  return sanitizeRunScopeForPostgres(patch);
}
