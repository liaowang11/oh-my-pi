{ stdenv }:
{
  aarch64-darwin = {
    addon = "pi_natives.darwin-arm64.node";
    nativeLibrary = "libpi_natives.dylib";
  };
  aarch64-linux = {
    addon = "pi_natives.linux-arm64.node";
    nativeLibrary = "libpi_natives.so";
  };
  x86_64-darwin = {
    addon = "pi_natives.darwin-x64-baseline.node";
    nativeLibrary = "libpi_natives.dylib";
    rustFlags = "-C target-cpu=x86-64-v2";
  };
  x86_64-linux = {
    addon = "pi_natives.linux-x64-baseline.node";
    nativeLibrary = "libpi_natives.so";
    rustFlags = "-C target-cpu=x86-64-v2";
  };
}
.${stdenv.hostPlatform.system} or (throw "Unsupported OMP platform: ${stdenv.hostPlatform.system}")
