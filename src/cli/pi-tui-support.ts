/**
 * Summary: Runtime guards and dynamic-loading helpers for the optional pi-tui
 * CLI so the main runtime can stay on the current Node 20 baseline.
 */

const PI_TUI_MIN_NODE_MAJOR = 22;
const PI_TUI_MIN_NODE_MINOR = 19;
const PI_TUI_MIN_NODE_PATCH = 0;

export interface ParsedNodeVersion {
  major: number;
  minor: number;
  patch: number;
}

export function parseNodeVersion(version: string): ParsedNodeVersion {
  const normalizedVersion = version.startsWith('v') ? version.slice(1) : version;
  const [majorPart = '0', minorPart = '0', patchPart = '0'] = normalizedVersion.split('.');

  return {
    major: Number.parseInt(majorPart, 10) || 0,
    minor: Number.parseInt(minorPart, 10) || 0,
    patch: Number.parseInt(patchPart, 10) || 0,
  };
}

export function supportsPiTuiNode(version: string): boolean {
  const parsed = parseNodeVersion(version);
  if (parsed.major !== PI_TUI_MIN_NODE_MAJOR) {
    return parsed.major > PI_TUI_MIN_NODE_MAJOR;
  }

  if (parsed.minor !== PI_TUI_MIN_NODE_MINOR) {
    return parsed.minor > PI_TUI_MIN_NODE_MINOR;
  }

  return parsed.patch >= PI_TUI_MIN_NODE_PATCH;
}

export function buildPiTuiRuntimeError(version: string): string {
  return [
    `pi-tui CLI requires Node >= ${PI_TUI_MIN_NODE_MAJOR}.${PI_TUI_MIN_NODE_MINOR}.${PI_TUI_MIN_NODE_PATCH}. Current runtime is ${version}.`,
    'Keep using demo:cli on Node 20, or upgrade Node and install @earendil-works/pi-tui to enable the TUI UI.',
  ].join(' ');
}

export async function loadPiTuiModule() {
  if (!supportsPiTuiNode(process.versions.node)) {
    throw new Error(buildPiTuiRuntimeError(process.versions.node));
  }

  try {
    return await import('@earendil-works/pi-tui');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error([
      'The optional @earendil-works/pi-tui package is not available.',
      'Install it after upgrading to Node 22.19+ with: npm install @earendil-works/pi-tui',
      `Original error: ${message}`,
    ].join(' '));
  }
}