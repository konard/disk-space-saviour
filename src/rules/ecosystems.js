/**
 * Reclaimable locations for the 20 most common language ecosystems.
 *
 * `caches` are global, per-user locations. Paths start with `~` (each home
 * directory) or `{VAR}` (an environment variable such as LOCALAPPDATA on
 * Windows) and may contain `*` segments. Default tier is `safe`: download and
 * compilation caches that the tool re-creates on demand.
 *
 * `projects` are directories inside project trees, recognised by name plus a
 * marker file next to them (`markers`), inside them (`selfMarkers`), or next
 * to their parent (`parentMarkers`, with `parentName`). Kind `cache` is always
 * `safe`; `build` and `dependencies` are `moderate` after the project has been
 * inactive for the configured number of days and `aggressive` otherwise.
 *
 * `busy` lists process names that, when running (inside the project for
 * project directories), mean the tool may be using the directory right now.
 * `native` is the tool's own clean command, used when the tool is installed
 * and the cache belongs to the current user.
 */

const JS_BUSY = ['node', 'npm', 'npx', 'pnpm', 'yarn', 'bun', 'deno'];
const PY_BUSY = ['python', 'python3', 'pip', 'uv', 'poetry', 'pytest'];
const RUST_BUSY = ['cargo', 'rustc', 'rustdoc', 'rust-analyzer'];
const JVM_BUSY = ['java', 'gradle', 'gradlew', 'mvn', 'sbt', 'kotlin'];
const DOTNET_BUSY = ['dotnet', 'msbuild'];

export const ECOSYSTEMS = [
  {
    id: 'javascript',
    name: 'JavaScript / TypeScript',
    caches: [
      {
        id: 'npm-cache',
        description: 'npm download cache',
        paths: ['~/.npm/_cacache', '{LOCALAPPDATA}/npm-cache/_cacache'],
        native: { tool: 'npm', argv: ['npm', 'cache', 'clean', '--force'] },
        busy: ['npm'],
      },
      {
        id: 'npx-cache',
        description: 'npx package cache',
        paths: ['~/.npm/_npx', '{LOCALAPPDATA}/npm-cache/_npx'],
        busy: ['npm', 'npx'],
      },
      {
        id: 'yarn-cache',
        description: 'Yarn download cache',
        paths: [
          '~/.cache/yarn',
          '~/Library/Caches/Yarn',
          '~/.yarn/berry/cache',
          '{LOCALAPPDATA}/Yarn/Cache',
        ],
        busy: ['yarn'],
      },
      {
        id: 'pnpm-store',
        description: 'pnpm content-addressable store',
        paths: [
          '~/.local/share/pnpm/store',
          '~/Library/pnpm/store',
          '~/.pnpm-store',
          '{LOCALAPPDATA}/pnpm/store',
        ],
        native: { tool: 'pnpm', argv: ['pnpm', 'store', 'prune'] },
        busy: ['pnpm'],
      },
      {
        id: 'bun-cache',
        description: 'Bun install cache',
        paths: ['~/.bun/install/cache'],
        native: { tool: 'bun', argv: ['bun', 'pm', 'cache', 'rm'] },
        busy: ['bun'],
      },
      {
        id: 'deno-cache',
        description: 'Deno module cache',
        paths: [
          '~/.cache/deno',
          '~/Library/Caches/deno',
          '{LOCALAPPDATA}/deno',
        ],
        busy: ['deno'],
      },
      {
        id: 'node-gyp-cache',
        description: 'node-gyp headers cache',
        paths: ['~/.cache/node-gyp', '~/Library/Caches/node-gyp'],
        busy: ['node-gyp', 'npm'],
      },
    ],
    projects: [
      {
        id: 'node-modules',
        kind: 'dependencies',
        description: 'installed npm dependencies',
        names: ['node_modules'],
        markers: ['package.json'],
        lockfiles: [
          'package-lock.json',
          'npm-shrinkwrap.json',
          'pnpm-lock.yaml',
          'yarn.lock',
          'bun.lock',
          'bun.lockb',
        ],
        busy: JS_BUSY,
      },
      {
        id: 'js-framework-build',
        kind: 'build',
        description: 'framework build output',
        names: ['.next', '.nuxt', '.svelte-kit', '.output'],
        markers: ['package.json'],
        busy: JS_BUSY,
      },
      {
        id: 'js-tool-cache',
        kind: 'cache',
        description: 'bundler and task-runner cache',
        names: ['.turbo', '.parcel-cache', '.angular', '.vite'],
        markers: ['package.json'],
        busy: JS_BUSY,
      },
    ],
  },
  {
    id: 'python',
    name: 'Python',
    caches: [
      {
        id: 'pip-cache',
        description: 'pip wheel and HTTP cache',
        paths: [
          '~/.cache/pip',
          '~/Library/Caches/pip',
          '{LOCALAPPDATA}/pip/Cache',
        ],
        busy: ['pip', 'pip3'],
      },
      {
        id: 'uv-cache',
        description: 'uv cache',
        paths: ['~/.cache/uv', '{LOCALAPPDATA}/uv/cache'],
        native: { tool: 'uv', argv: ['uv', 'cache', 'clean'] },
        busy: ['uv'],
      },
      {
        id: 'poetry-cache',
        description: 'Poetry package cache',
        paths: [
          '~/.cache/pypoetry/cache',
          '~/.cache/pypoetry/artifacts',
          '~/Library/Caches/pypoetry/cache',
          '~/Library/Caches/pypoetry/artifacts',
        ],
        busy: ['poetry'],
      },
      {
        id: 'poetry-virtualenvs',
        description: 'Poetry-managed virtual environments',
        tier: 'moderate',
        paths: [
          '~/.cache/pypoetry/virtualenvs',
          '~/Library/Caches/pypoetry/virtualenvs',
        ],
        busy: ['poetry', 'python', 'python3'],
      },
      {
        id: 'python-tool-caches',
        description: 'pipenv, pdm, hatch and pre-commit caches',
        paths: [
          '~/.cache/pipenv',
          '~/.cache/pdm',
          '~/.cache/hatch',
          '~/.cache/pre-commit',
        ],
        busy: ['pipenv', 'pdm', 'hatch', 'pre-commit'],
      },
      {
        id: 'conda-pkgs',
        description: 'conda package cache',
        paths: [
          '~/.conda/pkgs',
          '~/miniconda3/pkgs',
          '~/anaconda3/pkgs',
          '~/miniforge3/pkgs',
        ],
        native: {
          tool: 'conda',
          argv: ['conda', 'clean', '--all', '--yes'],
          required: true,
        },
        busy: ['conda', 'mamba'],
      },
    ],
    projects: [
      {
        id: 'python-venv',
        kind: 'dependencies',
        description: 'virtual environment',
        names: ['.venv', 'venv', '.env', 'env'],
        selfMarkers: ['pyvenv.cfg'],
        lockfiles: ['poetry.lock', 'uv.lock', 'Pipfile.lock', 'pdm.lock'],
        busy: PY_BUSY,
      },
      {
        id: 'python-bytecode',
        kind: 'cache',
        description: 'bytecode and tool caches',
        names: ['__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache'],
        busy: PY_BUSY,
      },
      {
        id: 'python-test-envs',
        kind: 'dependencies',
        description: 'tox/nox environments',
        names: ['.tox', '.nox'],
        markers: ['tox.ini', 'noxfile.py', 'pyproject.toml', 'setup.cfg'],
        busy: [...PY_BUSY, 'tox', 'nox'],
      },
    ],
  },
  {
    id: 'rust',
    name: 'Rust',
    caches: [
      {
        id: 'cargo-registry',
        description: 'cargo registry downloads and sources',
        paths: ['~/.cargo/registry/cache', '~/.cargo/registry/src'],
        busy: RUST_BUSY,
      },
      {
        id: 'cargo-git',
        description: 'cargo git checkouts',
        paths: ['~/.cargo/git/checkouts', '~/.cargo/git/db'],
        busy: RUST_BUSY,
      },
      {
        id: 'sccache',
        description: 'sccache compilation cache',
        paths: [
          '~/.cache/sccache',
          '~/Library/Caches/Mozilla.sccache',
          '{LOCALAPPDATA}/Mozilla/sccache',
        ],
        busy: ['sccache', ...RUST_BUSY],
      },
    ],
    projects: [
      {
        id: 'cargo-target',
        kind: 'build',
        description: 'cargo build output',
        names: ['target'],
        markers: ['Cargo.toml'],
        selfMarkers: ['CACHEDIR.TAG', 'debug', 'release', '.rustc_info.json'],
        busy: RUST_BUSY,
      },
    ],
  },
  {
    id: 'jvm',
    name: 'Java / Kotlin',
    caches: [
      {
        id: 'gradle-caches',
        description: 'Gradle dependency and build caches',
        paths: [
          '~/.gradle/caches',
          '~/.gradle/wrapper/dists',
          '~/.gradle/daemon',
        ],
        busy: JVM_BUSY,
      },
      {
        id: 'kotlin-native',
        description: 'Kotlin/Native toolchains and caches',
        tier: 'moderate',
        paths: ['~/.konan'],
        busy: JVM_BUSY,
      },
      {
        id: 'android-build-cache',
        description: 'Android build cache',
        paths: ['~/.android/cache', '~/.android/build-cache'],
        busy: JVM_BUSY,
      },
    ],
    projects: [
      {
        id: 'gradle-build',
        kind: 'build',
        description: 'Gradle build output',
        names: ['build'],
        markers: [
          'build.gradle',
          'build.gradle.kts',
          'settings.gradle',
          'settings.gradle.kts',
        ],
        busy: JVM_BUSY,
      },
      {
        id: 'gradle-project-cache',
        kind: 'cache',
        description: 'Gradle and Kotlin project caches',
        names: ['.gradle', '.kotlin'],
        markers: [
          'build.gradle',
          'build.gradle.kts',
          'settings.gradle',
          'settings.gradle.kts',
        ],
        busy: JVM_BUSY,
      },
      {
        id: 'maven-target',
        kind: 'build',
        description: 'Maven build output',
        names: ['target'],
        markers: ['pom.xml'],
        busy: JVM_BUSY,
      },
    ],
  },
  {
    id: 'go',
    name: 'Go',
    caches: [
      {
        id: 'go-build-cache',
        description: 'Go build cache',
        paths: [
          '~/.cache/go-build',
          '~/Library/Caches/go-build',
          '{LOCALAPPDATA}/go-build',
        ],
        native: { tool: 'go', argv: ['go', 'clean', '-cache'] },
        busy: ['go', 'gopls'],
      },
      {
        id: 'go-mod-cache',
        description: 'Go module cache',
        paths: ['~/go/pkg/mod'],
        native: { tool: 'go', argv: ['go', 'clean', '-modcache'] },
        busy: ['go', 'gopls'],
      },
      {
        id: 'golangci-lint-cache',
        description: 'golangci-lint cache',
        paths: ['~/.cache/golangci-lint', '~/Library/Caches/golangci-lint'],
        busy: ['golangci-lint'],
      },
    ],
    projects: [],
  },
  {
    id: 'c-cpp',
    name: 'C / C++',
    caches: [
      {
        id: 'ccache',
        description: 'ccache compilation cache',
        paths: ['~/.cache/ccache', '~/.ccache', '~/Library/Caches/ccache'],
        native: { tool: 'ccache', argv: ['ccache', '--clear'] },
        busy: ['ccache', 'make', 'ninja', 'cmake'],
      },
      {
        id: 'vcpkg-archives',
        description: 'vcpkg binary cache',
        paths: ['~/.cache/vcpkg/archives', '{LOCALAPPDATA}/vcpkg/archives'],
        busy: ['vcpkg'],
      },
    ],
    projects: [
      {
        id: 'cmake-build',
        kind: 'build',
        description: 'CMake build tree',
        names: ['cmake-build-*', 'build', 'out'],
        markers: ['CMakeLists.txt'],
        selfMarkers: ['CMakeCache.txt', 'build.ninja', 'Makefile'],
        busy: ['make', 'ninja', 'cmake', 'cc1', 'cc1plus', 'clang', 'ld'],
      },
      {
        id: 'cpp-index-cache',
        kind: 'cache',
        description: 'language server index cache',
        names: ['.ccls-cache', '.clangd'],
        busy: ['ccls', 'clangd'],
      },
    ],
  },
  {
    id: 'dotnet',
    name: '.NET',
    caches: [
      {
        id: 'nuget-packages',
        description: 'NuGet global packages folder',
        paths: ['~/.nuget/packages'],
        native: {
          tool: 'dotnet',
          argv: ['dotnet', 'nuget', 'locals', 'global-packages', '--clear'],
        },
        busy: DOTNET_BUSY,
      },
      {
        id: 'nuget-http-cache',
        description: 'NuGet HTTP cache',
        paths: [
          '~/.local/share/NuGet/v3-cache',
          '~/.local/share/NuGet/http-cache',
          '{LOCALAPPDATA}/NuGet/v3-cache',
        ],
        busy: DOTNET_BUSY,
      },
    ],
    projects: [
      {
        id: 'dotnet-obj',
        kind: 'build',
        description: 'MSBuild intermediate output',
        names: ['obj'],
        markers: ['*.csproj', '*.fsproj', '*.vbproj'],
        selfMarkers: ['project.assets.json', 'Debug', 'Release'],
        busy: DOTNET_BUSY,
      },
      {
        id: 'dotnet-bin',
        kind: 'build',
        description: 'MSBuild output',
        names: ['bin'],
        markers: ['*.csproj', '*.fsproj', '*.vbproj'],
        selfMarkers: ['Debug', 'Release'],
        busy: DOTNET_BUSY,
      },
    ],
  },
  {
    id: 'php',
    name: 'PHP',
    caches: [
      {
        id: 'composer-cache',
        description: 'Composer download cache',
        paths: [
          '~/.cache/composer',
          '~/.composer/cache',
          '~/Library/Caches/composer',
          '{LOCALAPPDATA}/Composer',
        ],
        native: { tool: 'composer', argv: ['composer', 'clear-cache'] },
        busy: ['composer', 'php'],
      },
    ],
    projects: [
      {
        id: 'composer-vendor',
        kind: 'dependencies',
        description: 'Composer dependencies',
        names: ['vendor'],
        markers: ['composer.json'],
        lockfiles: ['composer.lock'],
        selfMarkers: ['autoload.php'],
        busy: ['composer', 'php', 'php-fpm'],
      },
    ],
  },
  {
    id: 'ruby',
    name: 'Ruby',
    caches: [
      {
        id: 'gem-cache',
        description: 'RubyGems spec and download cache',
        paths: ['~/.gem/specs', '~/.local/share/gem/specs', '~/.bundle/cache'],
        busy: ['gem', 'bundle', 'ruby'],
      },
      {
        id: 'rubocop-cache',
        description: 'RuboCop cache',
        paths: ['~/.cache/rubocop_cache'],
        busy: ['rubocop'],
      },
    ],
    projects: [
      {
        id: 'bundler-vendor',
        kind: 'dependencies',
        description: 'Bundler-installed gems',
        names: ['bundle'],
        parentName: 'vendor',
        parentMarkers: ['Gemfile'],
        lockfiles: ['Gemfile.lock'],
        busy: ['ruby', 'bundle', 'rails', 'puma'],
      },
      {
        id: 'rails-tmp-cache',
        kind: 'cache',
        description: 'Rails tmp cache',
        names: ['cache'],
        parentName: 'tmp',
        parentMarkers: ['Gemfile'],
        busy: ['ruby', 'rails', 'puma'],
      },
    ],
  },
  {
    id: 'swift',
    name: 'Swift / Apple',
    caches: [
      {
        id: 'xcode-derived-data',
        description: 'Xcode DerivedData',
        paths: ['~/Library/Developer/Xcode/DerivedData'],
        busy: ['Xcode', 'xcodebuild', 'swift-frontend'],
      },
      {
        id: 'swiftpm-cache',
        description: 'SwiftPM repository cache',
        paths: [
          '~/Library/Caches/org.swift.swiftpm',
          '~/.cache/org.swift.swiftpm',
        ],
        busy: ['swift', 'swift-build', 'swift-frontend'],
      },
      {
        id: 'cocoapods-cache',
        description: 'CocoaPods download cache',
        paths: ['~/Library/Caches/CocoaPods'],
        busy: ['pod'],
      },
      {
        id: 'core-simulator-caches',
        description: 'iOS simulator caches',
        paths: ['~/Library/Developer/CoreSimulator/Caches'],
        busy: ['Simulator', 'simctl'],
      },
      {
        id: 'ios-device-support',
        description: 'iOS DeviceSupport symbols (re-copied on device connect)',
        tier: 'moderate',
        paths: ['~/Library/Developer/Xcode/iOS DeviceSupport'],
        busy: ['Xcode'],
      },
    ],
    projects: [
      {
        id: 'swiftpm-build',
        kind: 'build',
        description: 'SwiftPM build output',
        names: ['.build'],
        markers: ['Package.swift'],
        busy: ['swift', 'swift-build', 'swift-frontend'],
      },
      {
        id: 'cocoapods-pods',
        kind: 'dependencies',
        description: 'CocoaPods dependencies',
        names: ['Pods'],
        markers: ['Podfile'],
        busy: ['pod', 'xcodebuild'],
      },
    ],
  },
  {
    id: 'dart',
    name: 'Dart / Flutter',
    caches: [
      {
        id: 'pub-cache',
        description: 'pub package cache',
        paths: [
          '~/.pub-cache/hosted',
          '~/.pub-cache/git',
          '{LOCALAPPDATA}/Pub/Cache',
        ],
        busy: ['dart', 'flutter'],
      },
    ],
    projects: [
      {
        id: 'dart-tool',
        kind: 'build',
        description: 'Dart tool and build output',
        names: ['.dart_tool', 'build'],
        markers: ['pubspec.yaml'],
        busy: ['dart', 'flutter'],
      },
    ],
  },
  {
    id: 'haskell',
    name: 'Haskell',
    caches: [
      {
        id: 'cabal-packages',
        description: 'cabal package downloads',
        paths: ['~/.cabal/packages', '~/.cache/cabal/packages'],
        busy: ['cabal', 'ghc'],
      },
      {
        id: 'cabal-store',
        description: 'cabal store (built libraries)',
        tier: 'moderate',
        paths: ['~/.cabal/store', '~/.local/state/cabal/store'],
        busy: ['cabal', 'ghc'],
      },
      {
        id: 'stack-cache',
        description: 'Stack pantry and snapshot builds',
        tier: 'moderate',
        paths: ['~/.stack/pantry', '~/.stack/snapshots'],
        busy: ['stack', 'ghc'],
      },
      {
        id: 'ghcup-cache',
        description: 'ghcup download cache',
        paths: ['~/.ghcup/cache', '~/.ghcup/tmp', '~/.ghcup/logs'],
        busy: ['ghcup'],
      },
    ],
    projects: [
      {
        id: 'haskell-build',
        kind: 'build',
        description: 'cabal/stack build output',
        names: ['dist-newstyle', '.stack-work'],
        markers: ['*.cabal', 'cabal.project', 'stack.yaml', 'package.yaml'],
        busy: ['cabal', 'stack', 'ghc'],
      },
    ],
  },
  {
    id: 'scala',
    name: 'Scala',
    caches: [
      {
        id: 'coursier-cache',
        description: 'Coursier download cache',
        paths: [
          '~/.cache/coursier',
          '~/Library/Caches/Coursier',
          '{LOCALAPPDATA}/Coursier/cache',
        ],
        busy: ['java', 'sbt', 'cs', 'scala-cli', 'mill'],
      },
      {
        id: 'ivy-sbt-cache',
        description: 'Ivy download cache and sbt boot',
        paths: ['~/.ivy2/cache', '~/.sbt/boot'],
        busy: ['java', 'sbt'],
      },
    ],
    projects: [
      {
        id: 'sbt-target',
        kind: 'build',
        description: 'sbt build output',
        names: ['target'],
        markers: ['build.sbt', 'build.properties', 'plugins.sbt', 'build.sc'],
        busy: ['java', 'sbt', 'mill', 'bloop'],
      },
      {
        id: 'scala-ide-cache',
        kind: 'cache',
        description: 'Metals/Bloop project cache',
        names: ['.bloop', '.metals', '.scala-build'],
        busy: ['java', 'bloop', 'metals', 'scala-cli'],
      },
    ],
  },
  {
    id: 'elixir',
    name: 'Elixir / Erlang',
    caches: [
      {
        id: 'hex-cache',
        description: 'Hex package cache',
        paths: ['~/.hex/packages', '~/.cache/rebar3', '~/Library/Caches/hex'],
        busy: ['beam.smp', 'mix', 'rebar3'],
      },
    ],
    projects: [
      {
        id: 'mix-build',
        kind: 'build',
        description: 'Mix build output and dependencies',
        names: ['_build', 'deps'],
        markers: ['mix.exs', 'rebar.config'],
        busy: ['beam.smp', 'mix', 'rebar3'],
      },
    ],
  },
  {
    id: 'ocaml',
    name: 'OCaml',
    caches: [
      {
        id: 'opam-download-cache',
        description: 'opam download cache',
        paths: ['~/.opam/download-cache'],
        native: { tool: 'opam', argv: ['opam', 'clean', '--download-cache'] },
        busy: ['opam', 'dune', 'ocaml'],
      },
    ],
    projects: [
      {
        id: 'dune-build',
        kind: 'build',
        description: 'dune build output',
        names: ['_build'],
        markers: ['dune-project', 'dune'],
        busy: ['dune', 'ocaml', 'ocamlfind'],
      },
      {
        id: 'opam-local-switch',
        kind: 'dependencies',
        description: 'project-local opam switch',
        names: ['_opam'],
        markers: ['*.opam', 'dune-project'],
        busy: ['opam', 'dune', 'ocaml'],
      },
    ],
  },
  {
    id: 'lean',
    name: 'Lean',
    caches: [
      {
        id: 'mathlib-cache',
        description: 'Mathlib olean cache',
        paths: ['~/.cache/mathlib', '~/Library/Caches/mathlib'],
        busy: ['lake', 'lean'],
      },
    ],
    projects: [
      {
        id: 'lake-build',
        kind: 'build',
        description: 'Lake packages and build output',
        names: ['.lake', 'lake-packages'],
        markers: ['lakefile.lean', 'lakefile.toml', 'lean-toolchain'],
        busy: ['lake', 'lean'],
      },
    ],
  },
  {
    id: 'julia',
    name: 'Julia',
    caches: [
      {
        id: 'julia-compiled',
        description: 'Julia precompilation cache',
        paths: ['~/.julia/compiled'],
        busy: ['julia'],
      },
      {
        id: 'julia-packages',
        description: 'Julia packages and artifacts',
        tier: 'moderate',
        paths: ['~/.julia/packages'],
        busy: ['julia'],
      },
    ],
    projects: [],
  },
  {
    id: 'r',
    name: 'R',
    caches: [],
    projects: [
      {
        id: 'renv-library',
        kind: 'dependencies',
        description: 'renv project library',
        names: ['library'],
        parentName: 'renv',
        parentMarkers: ['renv.lock'],
        busy: ['R', 'Rscript', 'rsession'],
      },
    ],
  },
  {
    id: 'zig',
    name: 'Zig',
    caches: [
      {
        id: 'zig-global-cache',
        description: 'Zig global cache',
        paths: ['~/.cache/zig', '~/Library/Caches/zig', '{LOCALAPPDATA}/zig'],
        busy: ['zig', 'zls'],
      },
    ],
    projects: [
      {
        id: 'zig-cache',
        kind: 'cache',
        description: 'Zig local cache',
        names: ['.zig-cache', 'zig-cache'],
        markers: ['build.zig'],
        busy: ['zig', 'zls'],
      },
      {
        id: 'zig-out',
        kind: 'build',
        description: 'Zig install prefix',
        names: ['zig-out'],
        markers: ['build.zig'],
        busy: ['zig'],
      },
    ],
  },
  {
    id: 'scripting',
    name: 'Perl / Lua / Nim / Crystal',
    caches: [
      {
        id: 'cpan-build',
        description: 'cpanm and CPAN build directories',
        paths: ['~/.cpanm/work', '~/.cpan/build', '~/.cpan/sources'],
        busy: ['cpanm', 'cpan', 'perl'],
      },
      {
        id: 'luarocks-cache',
        description: 'LuaRocks cache',
        paths: ['~/.cache/luarocks'],
        busy: ['luarocks'],
      },
      {
        id: 'nim-cache',
        description: 'Nim compilation cache',
        paths: ['~/.cache/nim', '~/nimcache'],
        busy: ['nim', 'nimble'],
      },
      {
        id: 'crystal-cache',
        description: 'Crystal compilation cache',
        paths: ['~/.cache/crystal', '~/Library/Caches/crystal'],
        busy: ['crystal', 'shards'],
      },
    ],
    projects: [
      {
        id: 'lua-modules',
        kind: 'dependencies',
        description: 'LuaRocks project tree',
        names: ['lua_modules'],
        markers: ['*.rockspec', '.luarocks'],
        busy: ['lua', 'luajit', 'luarocks'],
      },
      {
        id: 'nimble-deps',
        kind: 'dependencies',
        description: 'Nimble local dependencies',
        names: ['nimbledeps', 'nimcache'],
        markers: ['*.nimble', 'config.nims'],
        busy: ['nim', 'nimble'],
      },
      {
        id: 'crystal-lib',
        kind: 'dependencies',
        description: 'Crystal shards',
        names: ['lib'],
        markers: ['shard.lock'],
        busy: ['crystal', 'shards'],
      },
      {
        id: 'perl-local-lib',
        kind: 'dependencies',
        description: 'Carton local library',
        names: ['local'],
        markers: ['cpanfile.snapshot'],
        busy: ['perl', 'carton'],
      },
    ],
  },
];

/**
 * Project rules flattened with their ecosystem id.
 */
export const PROJECT_RULES = ECOSYSTEMS.flatMap((ecosystem) =>
  ecosystem.projects.map((rule) => ({ ...rule, ecosystem: ecosystem.id }))
);

/**
 * Global cache rules flattened with their ecosystem id.
 */
export const CACHE_RULES = ECOSYSTEMS.flatMap((ecosystem) =>
  ecosystem.caches.map((rule) => ({ ...rule, ecosystem: ecosystem.id }))
);
