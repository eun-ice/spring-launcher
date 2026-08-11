'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { promisify } = require('util');

const execFile = promisify(childProcess.execFile);

const EXTENSION = '.sdfz';
const FILE_CLASS = 'Spring Replay';
const MIME_TYPE = 'application/x-spring-replay';
const LINUX_DESKTOP_FILE = 'spring-launcher-sdfz.desktop';
const WINDOWS_APPLICATION_NAME = 'BAR Spring Launcher';

function quoteDesktopValue(value) {
	return `"${value.replace(/([\\"`$])/g, '\\$1').replace(/%/g, '%%')}"`;
}

function getHandlerPath(env = process.env, executablePath = process.execPath) {
	return env.PORTABLE_EXECUTABLE_FILE || env.APPIMAGE || executablePath;
}

class ReplayFileAssociation {
	constructor(options = {}) {
		this.platform = options.platform || process.platform;
		this.executablePath = options.executablePath || getHandlerPath();
		this.homePath = options.homePath || os.homedir();
		this.environment = options.environment || process.env;
		this.execFile = options.execFile || execFile;
		this.fs = options.fs || fs.promises;
		this.log = options.log || console;
	}

	getExecutableName() {
		return this.platform === 'win32'
			? path.win32.basename(this.executablePath)
			: path.basename(this.executablePath);
	}

	async isRegistered() {
		if (this.platform === 'win32') {
			return this.isRegisteredWindows();
		}
		if (this.platform === 'linux') {
			return this.isRegisteredLinux();
		}
		return false;
	}

	async register() {
		if (this.platform === 'win32') {
			await this.registerWindows();
		} else if (this.platform === 'linux') {
			await this.registerLinux();
		}
	}

	async unregister() {
		if (this.platform === 'win32') {
			await this.unregisterWindows();
		} else if (this.platform === 'linux') {
			await this.unregisterLinux();
		}
	}

	async run(command, args, ignoreFailure = false) {
		try {
			return await this.execFile(command, args, { windowsHide: true });
		} catch (error) {
			if (ignoreFailure) {
				return null;
			}
			throw error;
		}
	}

	async queryWindowsValue(key, valueName) {
		const args = ['query', key];
		if (valueName === '') {
			args.push('/ve');
		} else {
			args.push('/v', valueName);
		}
		const result = await this.run('reg.exe', args, true);
		if (!result) {
			return null;
		}
		const line = result.stdout.split(/\r?\n/).find(candidate => candidate.includes('REG_SZ'));
		return line ? line.split(/\s+REG_SZ\s+/)[1] || '' : null;
	}

	async setWindowsValue(key, valueName, value, type = 'REG_SZ') {
		const args = ['add', key];
		if (valueName === '') {
			args.push('/ve');
		} else {
			args.push('/v', valueName);
		}
		args.push('/t', type, '/d', value, '/f');
		await this.run('reg.exe', args);
	}

	async deleteWindowsValue(key, valueName) {
		const args = ['delete', key];
		if (valueName === '') {
			args.push('/ve');
		} else {
			args.push('/v', valueName);
		}
		args.push('/f');
		await this.run('reg.exe', args, true);
	}

	async isRegisteredWindows() {
		const classesKey = 'HKCU\\Software\\Classes';
		const capabilitiesPath = `Software\\${WINDOWS_APPLICATION_NAME}\\Capabilities`;
		const expectedCommand = `"${this.executablePath}" "%1"`;
		const [registeredCapabilities, command] = await Promise.all([
			this.queryWindowsValue('HKCU\\Software\\RegisteredApplications', WINDOWS_APPLICATION_NAME),
			this.queryWindowsValue(`${classesKey}\\${FILE_CLASS}\\shell\\open\\command`, ''),
		]);
		return registeredCapabilities === capabilitiesPath && command === expectedCommand;
	}

	async registerWindows() {
		const classesKey = 'HKCU\\Software\\Classes';
		const extensionKey = `${classesKey}\\${EXTENSION}`;
		const fileClassKey = `${classesKey}\\${FILE_CLASS}`;
		const applicationKey = `${classesKey}\\Applications\\${this.getExecutableName()}`;
		const capabilitiesPath = `Software\\${WINDOWS_APPLICATION_NAME}\\Capabilities`;
		const capabilitiesKey = `HKCU\\${capabilitiesPath}`;

		await this.setWindowsValue(`${extensionKey}\\OpenWithProgids`, FILE_CLASS, '', 'REG_NONE');
		await this.setWindowsValue(fileClassKey, '', 'Spring replay file');
		await this.setWindowsValue(`${fileClassKey}\\DefaultIcon`, '', `"${this.executablePath}",0`);
		await this.setWindowsValue(`${fileClassKey}\\shell`, '', 'open');
		await this.setWindowsValue(`${fileClassKey}\\shell\\open`, '', 'Open with BAR');
		await this.setWindowsValue(
			`${fileClassKey}\\shell\\open\\command`, '', `"${this.executablePath}" "%1"`
		);
		await this.setWindowsValue(
			`${applicationKey}\\shell\\open\\command`, '', `"${this.executablePath}" "%1"`
		);
		await this.setWindowsValue(`${applicationKey}\\SupportedTypes`, EXTENSION, '', 'REG_NONE');
		await this.setWindowsValue(capabilitiesKey, 'ApplicationName', WINDOWS_APPLICATION_NAME);
		await this.setWindowsValue(
			capabilitiesKey, 'ApplicationDescription', 'Open Spring replay files with BAR'
		);
		await this.setWindowsValue(`${capabilitiesKey}\\FileAssociations`, EXTENSION, FILE_CLASS);
		await this.setWindowsValue(
			'HKCU\\Software\\RegisteredApplications', WINDOWS_APPLICATION_NAME, capabilitiesPath
		);
	}

	async unregisterWindows() {
		const classesKey = 'HKCU\\Software\\Classes';
		const extensionKey = `${classesKey}\\${EXTENSION}`;
		const currentClass = await this.queryWindowsValue(extensionKey, '');
		if (currentClass === FILE_CLASS) {
			const backupName = `${FILE_CLASS}_backup`;
			const backupClass = await this.queryWindowsValue(extensionKey, backupName);
			if (backupClass) {
				await this.setWindowsValue(extensionKey, '', backupClass);
			} else {
				await this.deleteWindowsValue(extensionKey, '');
			}
			await this.deleteWindowsValue(extensionKey, backupName);
		}
		await this.deleteWindowsValue(`${extensionKey}\\OpenWithProgids`, FILE_CLASS);
		await this.run('reg.exe', ['delete', `${classesKey}\\${FILE_CLASS}`, '/f'], true);
		await this.run(
			'reg.exe',
			['delete', `${classesKey}\\Applications\\${this.getExecutableName()}`, '/f'],
			true
		);
		await this.deleteWindowsValue(
			'HKCU\\Software\\RegisteredApplications', WINDOWS_APPLICATION_NAME
		);
		await this.run(
			'reg.exe', ['delete', `HKCU\\Software\\${WINDOWS_APPLICATION_NAME}`, '/f'], true
		);
	}

	getLinuxPaths() {
		const configHome = this.environment.XDG_CONFIG_HOME || path.join(this.homePath, '.config');
		const dataHome = this.environment.XDG_DATA_HOME || path.join(this.homePath, '.local', 'share');
		return {
			desktopDirectory: path.join(dataHome, 'applications'),
			desktopPath: path.join(dataHome, 'applications', LINUX_DESKTOP_FILE),
			mimeDirectory: path.join(dataHome, 'mime'),
			mimePackageDirectory: path.join(dataHome, 'mime', 'packages'),
			mimePackagePath: path.join(dataHome, 'mime', 'packages', 'spring-launcher-sdfz.xml'),
			mimeAppsPaths: [
				path.join(configHome, 'mimeapps.list'),
				path.join(dataHome, 'applications', 'mimeapps.list'),
				path.join(dataHome, 'applications', 'defaults.list'),
			],
		};
	}

	getLinuxDesktopEntry() {
		return [
			'[Desktop Entry]',
			'Type=Application',
			'Name=BAR Spring Launcher',
			'Comment=Open Spring replay files with BAR',
			`Exec=${quoteDesktopValue(this.executablePath)} %f`,
			'Terminal=false',
			'Categories=Game;',
			`MimeType=${MIME_TYPE};`,
			'',
		].join('\n');
	}

	getLinuxMimePackage() {
		return [
			'<?xml version="1.0" encoding="UTF-8"?>',
			'<mime-info xmlns="http://www.freedesktop.org/standards/shared-mime-info">',
			`  <mime-type type="${MIME_TYPE}">`,
			'    <comment>Spring replay file</comment>',
			'    <glob pattern="*.sdfz"/>',
			'  </mime-type>',
			'</mime-info>',
			'',
		].join('\n');
	}

	async isRegisteredLinux() {
		const { desktopPath } = this.getLinuxPaths();
		let desktopEntry;
		try {
			desktopEntry = await this.fs.readFile(desktopPath, 'utf8');
		} catch (error) {
			if (error.code === 'ENOENT') {
				return false;
			}
			throw error;
		}
		if (desktopEntry !== this.getLinuxDesktopEntry()) {
			return false;
		}
		const result = await this.run('xdg-mime', ['query', 'default', MIME_TYPE], true);
		return result && result.stdout.trim() === LINUX_DESKTOP_FILE;
	}

	async registerLinux() {
		const paths = this.getLinuxPaths();
		await Promise.all([
			this.fs.mkdir(paths.desktopDirectory, { recursive: true }),
			this.fs.mkdir(paths.mimePackageDirectory, { recursive: true }),
		]);
		await Promise.all([
			this.fs.writeFile(paths.desktopPath, this.getLinuxDesktopEntry()),
			this.fs.writeFile(paths.mimePackagePath, this.getLinuxMimePackage()),
		]);
		await this.run('update-mime-database', [paths.mimeDirectory], true);
		await this.run('update-desktop-database', [paths.desktopDirectory], true);
		await this.run('xdg-mime', ['default', LINUX_DESKTOP_FILE, MIME_TYPE]);
	}

	async unregisterLinux() {
		const paths = this.getLinuxPaths();
		await Promise.all(paths.mimeAppsPaths.map(filePath => this.removeLinuxMimeAssociation(filePath)));
		await Promise.all([
			this.fs.rm(paths.desktopPath, { force: true }),
			this.fs.rm(paths.mimePackagePath, { force: true }),
		]);
		await this.run('update-mime-database', [paths.mimeDirectory], true);
		await this.run('update-desktop-database', [paths.desktopDirectory], true);
	}

	async removeLinuxMimeAssociation(filePath) {
		let contents;
		try {
			contents = await this.fs.readFile(filePath, 'utf8');
		} catch (error) {
			if (error.code === 'ENOENT') {
				return;
			}
			throw error;
		}

		const prefix = `${MIME_TYPE}=`;
		const updatedLines = contents.split('\n').flatMap(line => {
			if (!line.startsWith(prefix)) {
				return [line];
			}
			const handlers = line.slice(prefix.length)
				.split(';')
				.filter(handler => handler && handler !== LINUX_DESKTOP_FILE);
			return handlers.length > 0 ? [`${prefix}${handlers.join(';')};`] : [];
		});
		const updatedContents = updatedLines.join('\n');
		if (updatedContents !== contents) {
			await this.fs.writeFile(filePath, updatedContents);
		}
	}
}

module.exports = {
	FILE_CLASS,
	LINUX_DESKTOP_FILE,
	MIME_TYPE,
	ReplayFileAssociation,
	getHandlerPath,
};
