'use strict';

const { app, dialog, ipcMain } = require('electron');
const path = require('path');

require('@electron/remote/main').initialize();

const settings = require('electron-settings');

const isFirstInstance = app.requestSingleInstanceLock();
if (!isFirstInstance) {
	app.quit();
	return;
}

// This is a hacky temporary workaround for bug in pr-downloader:
// https://github.com/beyond-all-reason/pr-downloader/issues/48
// Once it's resolved, the commit that added this piece of code
// can be fully reverted.
if (process.platform == 'win32' && !('PRD_SSL_CERT_FILE' in process.env)) {
	const path = require('path');
	const fs = require('fs');
	let cacertPath = path.resolve(`${__dirname}/../bin/cacert.pem`);
	if (!fs.existsSync(cacertPath)) {
		cacertPath = path.resolve(`${process.resourcesPath}/../bin/cacert.pem`);
	}
	process.env['PRD_SSL_CERT_FILE'] = cacertPath;
}

// Enable happy eyeballs for IPv6/IPv4 dual stack.
const net = require('node:net');
net.setDefaultAutoSelectFamily(true);

const { log } = require('./spring_log');
// Setup error handling
require('./error_handling');
const { config } = require('./launcher_config');
const { gui } = require('./launcher_gui');
require('./worker/window');
const { wizard } = require('./launcher_wizard');
// Setup downloader bindings
require('./launcher_downloader');
const { generateAndBroadcastWizard } = require('./launcher_wizard_util');
const { bridge } = require('./spring_api');
const { launcher } = require('./engine_launcher');
const { writePath } = require('./spring_platform');
const log_uploader = require('./log_uploader');
const file_opener = require('./file_opener');
const { ReplayOpenHandler } = require('./replay_open_handler');
const { ReplayFileAssociation } = require('./replay_file_association');

const REPLAY_ASSOCIATION_SETTING = 'sdfzDefaultApplication';

async function confirmReplayOverwrite(source, destination) {
	const mainWindow = gui.getMainWindow();
	const options = {
		type: 'warning',
		title: 'Replay already exists',
		message: `A different replay named "${path.basename(destination)}" already exists.`,
		detail: `Overwrite it with ${source}?`,
		buttons: ['Cancel', 'Overwrite'],
		defaultId: 0,
		cancelId: 0,
		noLink: true,
	};
	const result = mainWindow && mainWindow.isVisible()
		? await dialog.showMessageBox(mainWindow, options)
		: await dialog.showMessageBox(options);
	return result.response === 1;
}

const replayOpenHandler = new ReplayOpenHandler(
	bridge, writePath, log, confirmReplayOverwrite
);
const replayFileAssociation = new ReplayFileAssociation({ log });
let replayAssociationUpdate = Promise.resolve();

function getReplayAssociationEnabled() {
	if (!settings.hasSync(REPLAY_ASSOCIATION_SETTING)) {
		return true;
	}
	return settings.getSync(REPLAY_ASSOCIATION_SETTING) !== false;
}

function sendReplayAssociationState() {
	gui.send('replay-file-association-state', getReplayAssociationEnabled());
}

async function syncReplayFileAssociation() {
	if (!app.isPackaged || !['linux', 'win32'].includes(process.platform)) {
		return;
	}
	const enabled = getReplayAssociationEnabled();
	try {
		const registered = await replayFileAssociation.isRegistered();
		if (enabled && !registered) {
			await replayFileAssociation.register();
			log.info('Registered the launcher as a handler for .sdfz files');
		} else if (!enabled) {
			await replayFileAssociation.unregister();
			if (registered) {
				log.info('Unregistered the launcher as a handler for .sdfz files');
			}
		}
	} catch (error) {
		log.error(`Failed to update the .sdfz file association: ${error.stack || error}`);
		gui.send('error', `Failed to update the .sdfz file association: ${error.message}`);
	}
}

function queueReplayFileAssociationUpdate() {
	replayAssociationUpdate = replayAssociationUpdate.then(syncReplayFileAssociation);
	return replayAssociationUpdate;
}

async function openReplayArgs(argv, workingDirectory) {
	try {
		const replayCount = await replayOpenHandler.openArgs(argv, workingDirectory);
		if (replayCount > 0 && launcher.state !== 'running') {
			wizard.requestStart();
		}
	} catch (error) {
		log.error(`Failed to import replay: ${error.stack || error}`);
		gui.send('error', `Failed to import replay: ${error.message}`);
	}
}

bridge.on('ReplayHandlerReady', () => replayOpenHandler.setChobbyReady());

app.on('second-instance', (_event, argv, workingDirectory) => {
	openReplayArgs(argv, workingDirectory);
});

launcher.on('stdout', (text) => {
	log.info(text);
});

launcher.on('stderr', (text) => {
	log.warn(text);
});

launcher.on('finished', (code) => {
	log.info(`Spring finished with code: ${code}`);
	app.quit();
	setTimeout(() => {
		gui.send('launch-finished');
	}, 100);
});

launcher.on('failed', (error) => {
	log.error(error);
	const mainWindow = gui.getMainWindow();
	mainWindow.show();
	setTimeout(() => {
		gui.send('launch-failed', error);
	}, 100);
});

function maybeSetConfig(cfgName) {
	if (!config.setConfig(cfgName)) {
		return false;
	}

	settings.setSync('config', cfgName);
	generateAndBroadcastWizard();

	return true;
}

ipcMain.on('change-cfg', (_, cfgName) => {
	settings.setSync('checkForUpdates', undefined);
	if (maybeSetConfig(cfgName)) {
		wizard.setEnabled(true);
	}
});

ipcMain.on('log-upload-ask', () => {
	log_uploader.upload_ask();
});

ipcMain.on('open-install-dir', () => {
	if (file_opener.open(writePath)) {
		log.info(`User opened install directory: ${writePath}`);
	} else {
		log.error(`Failed to open install directory: ${writePath}`);
	}
});

ipcMain.on('open-replay', async () => {
	const result = await dialog.showOpenDialog(gui.getMainWindow(), {
		properties: ['openFile'],
		filters: [
			{ name: 'Spring replays', extensions: ['sdfz'] },
			{ name: 'All files', extensions: ['*'] },
		],
	});
	if (!result.canceled && result.filePaths.length > 0) {
		openReplayArgs(result.filePaths, process.cwd());
	}
});

ipcMain.on('open-replay-paths', (_event, replayPaths) => {
	if (Array.isArray(replayPaths)) {
		openReplayArgs(replayPaths, process.cwd());
	}
});

ipcMain.on('set-replay-file-association', async (_event, enabled) => {
	settings.setSync(REPLAY_ASSOCIATION_SETTING, Boolean(enabled));
	await queueReplayFileAssociationUpdate();
	sendReplayAssociationState();
});

ipcMain.on('get-replay-file-association', () => {
	sendReplayAssociationState();
});

ipcMain.on('wizard-next', () => {
	wizard.nextStep(true);
});

ipcMain.on('wizard-check-for-updates', (_, checkForUpdates) => {
	if (checkForUpdates === settings.getSync('checkForUpdates')) {
		return;
	}
	log.info('wizard-check-for-updates', checkForUpdates);
	settings.setSync('checkForUpdates', checkForUpdates);
	generateAndBroadcastWizard();
});

app.on('ready', () => {
	if (!gui) {
		return;
	}
	// Use local settings file
	settings.configure({
		dir: writePath,
		fileName: 'launcher_cfg.json',
		prettify: true
	});
	const oldConfig = settings.getSync('config');
	if (oldConfig) {
		if (!maybeSetConfig(oldConfig)) {
			// forget invalid configs
			settings.unsetSync('config');
		}
	}
	sendReplayAssociationState();
	queueReplayFileAssociationUpdate();
	openReplayArgs(process.argv, process.cwd());
});

app.on('window-all-closed', () => {
	log.info('All windows closed. Quitting...');
});
