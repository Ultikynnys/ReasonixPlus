// Must clear the highest engines.node among the runtime dependencies, since they
// load before any command runs and fail at import rather than at first use.
export const MIN_NODE_VERSION = "22.19.0";

interface Version {
  major: number;
  minor: number;
  patch: number;
}

function parseVersion(version: string): Version | null {
  const parts = version.split(".");
  const major = Number.parseInt(parts[0] ?? "", 10);
  const minor = Number.parseInt(parts[1] ?? "", 10);
  const patch = Number.parseInt(parts[2] ?? "", 10);
  if (!Number.isInteger(major) || !Number.isInteger(minor) || !Number.isInteger(patch)) return null;
  return { major, minor, patch };
}

function atLeast(actual: Version, floor: Version): boolean {
  if (actual.major !== floor.major) return actual.major > floor.major;
  if (actual.minor !== floor.minor) return actual.minor > floor.minor;
  return actual.patch >= floor.patch;
}

export function isSupportedNodeVersion(
  version = process.versions.node,
  minVersion = MIN_NODE_VERSION,
): boolean {
  const actual = parseVersion(version);
  const floor = parseVersion(minVersion);
  return actual !== null && floor !== null && atLeast(actual, floor);
}

export function unsupportedNodeMessage(
  version = process.versions.node,
  minVersion = MIN_NODE_VERSION,
): string {
  return `Reasonix+ requires Node ${minVersion}+ (current: ${version}). Install Node ${minVersion} or newer and rerun Reasonix+.`;
}

export function enforceSupportedNodeVersion(
  version = process.versions.node,
  minVersion = MIN_NODE_VERSION,
): void {
  if (isSupportedNodeVersion(version, minVersion)) return;
  process.stderr.write(`${unsupportedNodeMessage(version, minVersion)}\n`);
  process.exit(1);
}
