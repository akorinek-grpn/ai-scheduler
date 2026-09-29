import fs from "node:fs";
import { fileURLToPath } from "node:url";

// WCAG contrast of rendered text colour classes against the real surfaces: the
// tokens in globals.css and Tailwind's palette, converted OKLCH -> sRGB (the same
// conversion run-diagram.test.tsx checks against a known ratio).

type Oklch = [number, number, number];
export type Theme = "light" | "dark";

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const globalsCss = fs.readFileSync(`${ROOT}src/web/app/globals.css`, "utf8");
const paletteCss = fs.readFileSync(
  `${ROOT}node_modules/tailwindcss/theme.css`,
  "utf8",
);

function cssVar(css: string, name: string): Oklch {
  const match = new RegExp(
    `--${name}:\\s*oklch\\(\\s*([\\d.]+)(%?)\\s+([\\d.]+)\\s+([\\d.]+)\\s*\\)`,
  ).exec(css);
  if (!match) throw new Error(`--${name} not found`);
  return [
    Number(match[1]) / (match[2] ? 100 : 1),
    Number(match[3]),
    Number(match[4]),
  ];
}

function block(selector: string): string {
  const start = globalsCss.indexOf(`${selector} {`);
  return globalsCss.slice(start, globalsCss.indexOf("}", start));
}

const THEME_BLOCK: Record<Theme, string> = {
  light: block(":root"),
  dark: block(".dark"),
};

function luminance([L, C, H]: Oklch): number {
  const a = C * Math.cos((H * Math.PI) / 180);
  const b = C * Math.sin((H * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const linear = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map((channel) => Math.min(1, Math.max(0, channel)));
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function ratio(x: Oklch, y: Oklch): number {
  const [high, low] = [luminance(x), luminance(y)].sort((p, q) => q - p);
  return (high + 0.05) / (low + 0.05);
}

/** A theme token ("muted-foreground", "sidebar") or a palette colour ("blue-700"). */
export function color(name: string, theme: Theme): Oklch {
  return /^[a-z]+-\d{2,3}$/.test(name)
    ? cssVar(paletteCss, `color-${name}`)
    : cssVar(THEME_BLOCK[theme], name);
}

const TEXT_COLOR = /^text-((?:[a-z]+-\d{2,3})|foreground|muted-foreground)$/;
const DARK_TEXT_COLOR =
  /^dark:text-((?:[a-z]+-\d{2,3})|foreground|muted-foreground)$/;

export interface TextContrast {
  classes: string;
  light: number;
  dark: number;
}

/**
 * For every element with a text colour class, its lowest contrast across the given
 * surfaces in each theme (a missing dark: class means the light colour applies).
 */
export function textContrasts(
  html: string,
  surfaces: string[] = ["background", "card"],
): TextContrast[] {
  const results: TextContrast[] = [];
  for (const [, classAttr] of html.matchAll(/class="([^"]*)"/g)) {
    const classes = classAttr.split(/\s+/);
    const light = classes
      .map((name) => TEXT_COLOR.exec(name)?.[1])
      .find(Boolean);
    if (!light) continue;
    const dark =
      classes.map((name) => DARK_TEXT_COLOR.exec(name)?.[1]).find(Boolean) ??
      light;
    const lowest = (text: string, theme: Theme): number =>
      Math.min(
        ...surfaces.map((surface) =>
          ratio(color(text, theme), color(surface, theme)),
        ),
      );
    results.push({
      classes: classAttr,
      light: lowest(light, "light"),
      dark: lowest(dark, "dark"),
    });
  }
  return results;
}
