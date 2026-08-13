'use strict';

const { app, BrowserWindow, shell, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');

const APP_URL = 'https://eesoftware.app/';

// Keep a global reference so the window isn't garbage-collected.
let mainWindow = null;

// ── Auto-updater ─────────────────────────────────────────────────────────────

function setupAutoUpdater() {
  // Log update events to the console (visible via Electron's --inspect or
  // by attaching a logger).  Errors are swallowed silently so a failed
  // update check never interrupts the member's session.
  autoUpdater.logger = null; // disable the built-in logger noise

  // When an update has been downloaded, prompt the member to restart.
  autoUpdater.on('update-downloaded', (info) => {
    if (!mainWindow) return;

    dialog
      .showMessageBox(mainWindow, {
        type: 'info',
        title: 'Update Ready',
        message: `Earnings Edge Software ${info.version} is ready to install.`,
        detail:
          'The update will be applied the next time the app restarts. ' +
          'Restart now to get the latest version.',
        buttons: ['Restart Now', 'Later'],
        defaultId: 0,
        cancelId: 1,
      })
      .then(({ response }) => {
        if (response === 0) autoUpdater.quitAndInstall();
      })
      .catch(() => {});
  });

  // Swallow errors silently — a failed update check (e.g. no internet,
  // release not published yet) must never crash or interrupt the session.
  autoUpdater.on('error', (err) => {
    console.error('[auto-updater] error:', err.message ?? err);
  });
}

// ── Window ───────────────────────────────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    title: 'Earnings Edge Software',
    icon: path.join(__dirname, '..', 'build', getIconFilename()),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      // Allow Clerk + Circle auth cookies to persist across launches.
      // Electron stores its session in the app's userData directory.
      session: require('electron').session.defaultSession,
    },
  });

  mainWindow.loadURL(APP_URL);

  // Prevent the web page's <title> tag from overriding the window title.
  mainWindow.on('page-title-updated', (event) => {
    event.preventDefault();
  });

  // Open external links in the system browser, not in the app window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith('https://eesoftware.app')) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function getIconFilename() {
  switch (process.platform) {
    case 'win32':  return 'icon.ico';
    case 'darwin': return 'icon.icns';
    default:       return 'icon.png';
  }
}

// ── App lifecycle ─────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  setupAutoUpdater();
  createWindow();

  // Check for updates 4 seconds after the window opens so Clerk sign-in
  // has time to render before any update dialog could appear.
  setTimeout(() => {
    autoUpdater.checkForUpdatesAndNotify().catch(() => {});
  }, 4000);

  // macOS: re-create the window when the dock icon is clicked and no windows are open.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Quit when all windows are closed (except on macOS where the app stays in the dock).
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
