// Locks down Electron's runtime switches in the packaged app so it can't be
// started as a plain Node process or opened with a debugger from the command line.
const path = require('path');
const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses');

exports.default = async function afterPack(ctx) {
  const name = ctx.packager.appInfo.productFilename;
  const exe = {
    win32: `${name}.exe`,
    darwin: `${name}.app`,
    linux: ctx.packager.executableName,
  }[ctx.electronPlatformName];
  await flipFuses(path.join(ctx.appOutDir, exe), {
    version: FuseVersion.V1,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
  });
};
