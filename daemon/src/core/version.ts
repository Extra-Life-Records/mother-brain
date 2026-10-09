export interface RuntimeVersionInfo {
  buildVersion: string;
  commit: string;
  environment: string;
  pid: number;
  startedAt: string;
}

function shortCommit(sha: string | undefined): string {
  if (!sha) return 'unknown';
  return sha.slice(0, 7);
}

export function getRuntimeVersionInfo(startedAtIso: string): RuntimeVersionInfo {
  const buildVersion = process.env['MB_BUILD_VERSION']
    ?? process.env['npm_package_version']
    ?? 'dev';

  const commit = shortCommit(
    process.env['MB_GIT_SHA']
    ?? process.env['GITHUB_SHA']
    ?? process.env['SOURCE_VERSION'],
  );

  return {
    buildVersion,
    commit,
    environment: process.env['NODE_ENV'] ?? 'unknown',
    pid: process.pid,
    startedAt: startedAtIso,
  };
}

export function formatVersionLabel(startedAtIso: string): string {
  const info = getRuntimeVersionInfo(startedAtIso);
  return `v${info.buildVersion} (${info.commit})`;
}
