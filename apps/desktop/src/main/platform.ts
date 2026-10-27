import {
  type BrowserWindowConstructorOptions,
  Menu,
  type MenuItemConstructorOptions,
} from "electron";

/** The only module allowed to hold macOS-specific code. */
export interface Platform {
  readonly name: NodeJS.Platform;
  /** Whether closing the last window should quit the app. */
  readonly quitWhenAllWindowsClosed: boolean;
  /**
   * Native window chrome. On macOS the title bar is hidden and the traffic lights sit inside the
   * app's own 44 px bar (12 px circles, 16 px from the left, centred on the bar). The renderer
   * reserves `--layout-traffic-lights` for them and marks its bars as drag regions.
   */
  readonly windowChrome: BrowserWindowConstructorOptions;
  /**
   * Installs the application menu. Electron's default menu binds ⌘R to "Reload", which the app
   * uses for "Restart omp"; this one keeps the standard roles and leaves out the reload commands.
   */
  installMenu(): void;
}

const darwin = process.platform === "darwin";

export const platform: Platform = {
  name: process.platform,
  quitWhenAllWindowsClosed: !darwin,
  windowChrome: darwin
    ? { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 16, y: 16 } }
    : {},
  installMenu() {
    const template: MenuItemConstructorOptions[] = [
      ...(darwin ? ([{ role: "appMenu" }] as const) : []),
      { role: "editMenu" },
      { label: "View", submenu: [{ role: "toggleDevTools" }, { role: "togglefullscreen" }] },
      { role: "windowMenu" },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  },
};
