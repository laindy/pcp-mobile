/**
 * Rasterise les SVG sources (même rendu que la page login) vers les mipmaps Android,
 * les splash Android (toutes densités port/land), l'icône App Store iOS et le splash iOS.
 * Exécuter après modification de resources/*.svg
 */
import sharp from "sharp";
import { mkdir } from "fs/promises";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const mobileRoot = join(__dirname, "..");
const legacySvg = join(mobileRoot, "resources", "pcpttherapy-legacy-launcher.svg");
const splashSvg = join(mobileRoot, "resources", "pcpttherapy-splash.svg");
const androidRes = join(
  mobileRoot,
  "android",
  "app",
  "src",
  "main",
  "res",
);
const iosIcon = join(
  mobileRoot,
  "ios",
  "App",
  "App",
  "Assets.xcassets",
  "AppIcon.appiconset",
  "AppIcon-512@2x.png",
);
const iosSplashDir = join(
  mobileRoot,
  "ios",
  "App",
  "App",
  "Assets.xcassets",
  "Splash.imageset",
);

const densities = [
  { folder: "mipmap-mdpi", px: 48 },
  { folder: "mipmap-hdpi", px: 72 },
  { folder: "mipmap-xhdpi", px: 96 },
  { folder: "mipmap-xxhdpi", px: 144 },
  { folder: "mipmap-xxxhdpi", px: 192 },
];

/** Tailles splash Android (template Capacitor / Cordova). */
const androidSplashes = [
  { folder: "drawable", width: 480, height: 320 },
  { folder: "drawable-port-mdpi", width: 320, height: 480 },
  { folder: "drawable-port-hdpi", width: 480, height: 800 },
  { folder: "drawable-port-xhdpi", width: 720, height: 1280 },
  { folder: "drawable-port-xxhdpi", width: 960, height: 1600 },
  { folder: "drawable-port-xxxhdpi", width: 1280, height: 1920 },
  { folder: "drawable-land-mdpi", width: 480, height: 320 },
  { folder: "drawable-land-hdpi", width: 800, height: 480 },
  { folder: "drawable-land-xhdpi", width: 1280, height: 720 },
  { folder: "drawable-land-xxhdpi", width: 1600, height: 960 },
  { folder: "drawable-land-xxxhdpi", width: 1920, height: 1280 },
];

const svgBuf = await sharp(legacySvg, { density: 300 }).toBuffer();
const splashBuf = await sharp(splashSvg, { density: 300 }).toBuffer();

for (const { folder, px } of densities) {
  const dir = join(androidRes, folder);
  await mkdir(dir, { recursive: true });
  const png = await sharp(svgBuf).resize(px, px).png().toBuffer();
  await sharp(png).toFile(join(dir, "ic_launcher.png"));
  await sharp(png).toFile(join(dir, "ic_launcher_round.png"));
}

await mkdir(dirname(iosIcon), { recursive: true });
await sharp(svgBuf).resize(1024, 1024).png().toFile(iosIcon);

await mkdir(iosSplashDir, { recursive: true });
for (const filename of [
  "splash-2732x2732.png",
  "splash-2732x2732-1.png",
  "splash-2732x2732-2.png",
]) {
  await sharp(splashBuf).resize(2732, 2732).png().toFile(join(iosSplashDir, filename));
}

for (const { folder, width, height } of androidSplashes) {
  const dir = join(androidRes, folder);
  await mkdir(dir, { recursive: true });
  await sharp(splashBuf)
    .resize(width, height, { fit: "cover", position: "centre" })
    .png()
    .toFile(join(dir, "splash.png"));
}

console.log(
  "OK: mipmaps + Android splash (11 densités) + iOS AppIcon 1024px + iOS splash 2732px",
);
