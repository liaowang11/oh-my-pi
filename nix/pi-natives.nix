{
  alsa-lib,
  cmake,
  darwin,
  lib,
  libpulseaudio,
  ninja,
  pipewire,
  pkg-config,
  autoPatchelfHook,
  rustPlatform,
  rustToolchain,
  stdenv,
  withWaylandScreencast ? false,
}:
let
  platform = import ./platform.nix { inherit stdenv; };
  # Literal relative paths (not `self.outPath`/`source`, which flakes expose
  # only as an already-materialized whole-repo string) are each their own
  # lazily-fetched, independently content-hashed Nix path. Building the `src`
  # from only the Rust workspace's paths keeps this derivation's hash disjoint
  # from packages/: a TS-only change never touches these paths, so it
  # substitutes from a binary cache instead of rebuilding Cargo from scratch.
  rustSrc = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../Cargo.toml
      ../Cargo.lock
      ../rust-toolchain.toml
      ../.cargo
      ../crates
    ];
  };
in
stdenv.mkDerivation {
  pname = "omp-pi-natives";
  version = (lib.importTOML ../Cargo.toml).workspace.package.version;
  src = rustSrc;

  cargoDeps = rustPlatform.importCargoLock { lockFile = ../Cargo.lock; };

  nativeBuildInputs = [
    cmake
    ninja
    pkg-config
    rustPlatform.bindgenHook
    rustPlatform.cargoSetupHook
    rustToolchain
  ]
  ++ lib.optionals stdenv.hostPlatform.isLinux [ autoPatchelfHook ]
  ++ lib.optionals stdenv.hostPlatform.isDarwin [ darwin.autoSignDarwinBinariesHook ];

  # libgcc_s is resolved from the compiler's lib output during autoPatchelf.
  buildInputs =
    lib.optionals stdenv.hostPlatform.isLinux [ stdenv.cc.cc.lib ]
    ++ lib.optionals withWaylandScreencast [ pipewire ];

  strictDeps = true;
  dontConfigure = true;

  env = {
    CMAKE_POLICY_VERSION_MINIMUM = "3.5";
    PCRE2_SYS_STATIC = "1";
    SOURCE_DATE_EPOCH = "1";
  }
  // lib.optionalAttrs (platform ? rustFlags) { RUSTFLAGS = platform.rustFlags; };

  buildPhase = ''
    runHook preBuild
    cargo build --release -p pi-natives ${lib.optionalString withWaylandScreencast "--features wayland-pipewire"}
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    install -Dm755 "target/release/${platform.nativeLibrary}" "$out/lib/${platform.addon}"

    ${lib.optionalString stdenv.hostPlatform.isLinux ''
      autoPatchelf -- "$out/lib/${platform.addon}"
      # pi-voice dlopens libpulse-simple.so.0 / libpulse.so.0 / libasound.so.2
      # by bare name; glibc resolves those through the calling object's
      # RUNPATH, so append the client libraries here. Nothing links them, so
      # autoPatchelf cannot discover them on its own.
      patchelf --add-rpath "${
        lib.makeLibraryPath [
          libpulseaudio
          alsa-lib
        ]
      }" \
        "$out/lib/${platform.addon}"
    ''}
    ${lib.optionalString stdenv.hostPlatform.isDarwin ''
      # arm64 Darwin requires even locally-built Mach-O addons to carry an
      # ad-hoc signature.
      signIfRequired "$out/lib/${platform.addon}"
    ''}

    runHook postInstall
  '';

  meta.platforms = [
    "aarch64-darwin"
    "aarch64-linux"
    "x86_64-darwin"
    "x86_64-linux"
  ];
}
