import { argbFromHex, Hct, hexFromArgb, MaterialDynamicColors, SchemeTonalSpot } from '@material/material-color-utilities';

/** Brand-derived Material roles, generated locally with Google's color utilities.
 * This baseline is not Android wallpaper dynamic color or a native theme bridge.
 */
export function material3Palette(dark: boolean): Record<string, string> {
  const scheme = new SchemeTonalSpot(Hct.fromInt(argbFromHex('#3b66db')), dark, 0);
  const colors = new MaterialDynamicColors();
  return Object.fromEntries([...colors.allColors, colors.shadow(), colors.scrim(), colors.surfaceVariant(), colors.surfaceTint()].map(color => [
    `--md-sys-color-${color.name.replaceAll('_', '-')}`, hexFromArgb(color.getArgb(scheme)),
  ]));
}
