const defaults = [
  'registry.npmjs.org',
  'registry.yarnpkg.com',
  'registry.npmmirror.com',
  'npmmirror.com',
  'cdn.npmmirror.com',
  'nodejs.org',
  'github.com',
  'codeload.github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'raw.githubusercontent.com',
  'pypi.org',
  'files.pythonhosted.org',
  'repo.maven.apache.org',
  'proxy.golang.org',
  'sum.golang.org',
  'storage.googleapis.com',
  'index.crates.io',
  'static.crates.io',
];
export function dependencyHosts() {
  return new Set(
    (process.env.BUILDER_DEPENDENCY_HOSTS ?? defaults.join(','))
      .toLowerCase()
      .split(',')
      .map((host) => host.trim())
      .filter(Boolean),
  );
}
