'use strict';

const { app, BrowserWindow, shell } = require('electron');
const path = require('path');

const APP_URL = 'https://eesoftware.app/screener';

// Keep a global reference so the window isn't garbage-collected.
let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    title: 'EE Software Screener',
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

app.whenReady().then(() => {
  createWindow();

  // macOS: re-create the window when the dock icon is clicked and no windows are open.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Quit when all windows are closed (except on macOS where the app stays in the dock).
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
