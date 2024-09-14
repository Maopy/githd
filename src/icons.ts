import * as path from 'path';

import { Uri } from 'vscode';

const iconsRootPath = path.join(path.dirname(__dirname), '..', 'media', 'icons');
export function getIconUri(iconName: string, theme: string): Uri {
  return Uri.file(path.join(iconsRootPath, theme, `${iconName}.svg`));
}
export const Icons: any = {
  light: {
    Modified: getIconUri('status-modified', 'light'),
    Added: getIconUri('status-added', 'light'),
    Deleted: getIconUri('status-deleted', 'light'),
    Renamed: getIconUri('status-renamed', 'light'),
    Copied: getIconUri('status-copied', 'light')
  },
  dark: {
    Modified: getIconUri('status-modified', 'dark'),
    Added: getIconUri('status-added', 'dark'),
    Deleted: getIconUri('status-deleted', 'dark'),
    Renamed: getIconUri('status-renamed', 'dark'),
    Copied: getIconUri('status-copied', 'dark')
  }
};
